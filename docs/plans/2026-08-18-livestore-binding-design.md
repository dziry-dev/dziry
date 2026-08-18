# dziri × LiveStore — the `dziri/livestore` binding design

Date: 2026-08-18 · Status: design (approved in conversation; this doc precedes implementation)

## Purpose

Make LiveStore (`@livestore/livestore`) usable in dziri with the same ergonomics as its React
binding `@livestore/react`: one call turns a LiveStore query into a dziri signal that
`{todos.length}`-style bindings re-render from. The store engine stays LiveStore; dziri
contributes only the reactive glue.

## The ruling that constrains everything

`dziri/livestore` mirrors **`@livestore/react`**, not `@livestore/livestore`. It:

- imports `@livestore/livestore` **type-only** — zero runtime bytes, the same seam as
  `src/effect.ts` (`export type { Effect } from "effect"`),
- takes the store **as an explicit argument** — dziri has no component tree, so there is no
  `StoreProvider`/context and no `provideStore` registry; the module graph is the wiring,
- returns **signals**, not plain values — the entire point is that `{todos.length}` re-renders
  on commit, which only a signal does.

## The surface (two exports)

```ts
// dziri/livestore
liveQuery(store, query)      → ReadonlySignal<TResult>    // the useQuery analog
useSyncStatus(store)         → ReadonlySignal<SyncStatus> // sync UI
```

Everything else in `@livestore/react` is deliberately absent:

| React name | dziri | why |
|---|---|---|
| `useQuery` | `liveQuery` | `useQuery` collides with TanStack Query; dziri's `use*` are build-time hooks, this is a runtime source |
| `useStore` | *dropped* | you already hold the store — you passed it in |
| `StoreRegistryContext` / `<StoreProvider>` | *dropped* | no React tree; the store is an explicit argument |
| `useSyncStatus` | `useSyncStatus` | kept verbatim — no collision, and name-parity aids discovery |
| `useClientDocument` / `useRcResource` | *dropped* | experimental |

## `liveQuery` — a query, as a signal

```ts
import type { Store, Queryable } from "@livestore/livestore";
import { source, type ReadonlySignal } from "./runtime/source.ts";

export function liveQuery<TResult>(
  store: Store<any, any> | Promise<Store<any, any>>,
  query: Queryable<TResult>,
): ReadonlySignal<TResult> {
  return source(
    (set) => {
      let unsub: (() => void) | undefined;
      let closed = false;
      void Promise.resolve(store).then((s) => {
        if (closed) return;
        set(s.query(query));
        unsub = s.subscribe(query, (value) => set(value));
      });
      return () => { closed = true; unsub?.(); };
    },
    [] as unknown as TResult,
  );
}
```

Mechanics, mapped to existing dziri machinery:

- **`source()` unchanged.** `liveQuery` is a plain `source()`; its subscribe returns a
  synchronous unsubscribe (kept for quit by `disposeWindowRuntime`). No change to
  `source.ts` / `effects.ts`.
- **The async store.** `createStorePromise` returns `Promise<Store>`; dziri forbids top-level
  `await` (the compiler imports these modules synchronously). `liveQuery` resolves the promise
  *inside* the subscribe, which `startSources` runs at launch — the compiler never touches the
  store, and resolution happens while the first frame paints (the "built at launch" rule the
  window layer already follows).
- **The seed.** `[] as unknown as TResult` — correct for the dominant shape (a table query whose
  result is `Row[]`); the first paint shows the empty list until the store opens. Deliberately
  *list-specialized*: for scalar/single-row results, authors use `source()` directly (documented).
  This keeps `liveQuery`'s bindings clean (`{todos.length}`, not `{todos?.length ?? 0}`) instead
  of paying an `| undefined` tax on every read.
- **The store thunk.** `createStorePromise` starts *eagerly* the moment it is called, so a store
  the compiler must not open is passed as `() => …` rather than a resolved Promise — the thunk
  runs inside the subscribe, at launch. The template's `store()` memoizes it, so `liveQuery` and
  the window layer share one store.

## `useSyncStatus` — the sync indicator, as a signal

```ts
import type { SyncStatus } from "@livestore/livestore";

export function useSyncStatus(
  store: Store<any, any> | Promise<Store<any, any>>,
): ReadonlySignal<SyncStatus> {
  return source(
    (set) => {
      let unsub: (() => void) | undefined;
      let closed = false;
      void Promise.resolve(store).then((s) => {
        if (closed) return;
        set(s.syncStatus());
        unsub = s.subscribeSyncStatus((status) => set(status));
      });
      return () => { closed = true; unsub?.(); };
    },
    { localHead: "", upstreamHead: "", pendingCount: 0, isSynced: false },
  );
}
```

`SyncStatus` is the store's own type (verified against `@livestore/livestore@0.4.0`):
`{ localHead: string; upstreamHead: string; pendingCount: number; isSynced: boolean }`. The seed is
an exact literal (the type is imported, so it is not a cast) and is shown only for the first frame
before the store resolves. `subscribeSyncStatus` fires immediately with the current status, then on
each change — the "render sync UI" this exists for.

## Typing

- **`Queryable<TResult>`** (not `Query`): the store's query type is
  `LiveQueryDef<TResult> | SignalDef<TResult> | LiveQuery<TResult> | QueryBuilder<TResult, any, any>`.
  Because `queryDb(...)` returns `LiveQueryDef<Todo[]>`, `TResult` infers as `Todo[]` — so
  `liveQuery(store, todosQuery)` yields `ReadonlySignal<Todo[]>`, no annotation, exactly like React.
- **`Store<any, any>`** is deliberate. `Store<TSchema>` is contravariant in `TSchema` (its
  `commit` narrows to the schema's events), so `Store<MySchema>` is *not* assignable to
  `Store<LiveStoreSchema.Any>`. `any` is the bivariant escape hatch that accepts any concrete
  store while still requiring an actual `Store`. `TResult` infers from `query`, so the row type
  is never lost. (Refinement candidate: a generic `TSchema`/`TContext` pair if `any` is judged
  too loose in review.)
- **Type-only import** means `@livestore/livestore` is a *devDependency* of dziri (for its own
  `tsc`/tests — installed today via `bun add -d`) and an *optional peerDependency* for consumers —
  required only by an app that imports `dziri/livestore`, which is precisely the app that creates a
  store anyway.

## Author usage

```ts
// store.ts
import { createStorePromise } from "@livestore/livestore";
import { makeAdapter } from "@livestore/adapter-node";
export const store = createStorePromise({ schema, adapter: makeAdapter({ storage: { type: "fs" } }), storeId });

// state.ts
import { store } from "./store.ts";
import { liveQuery, useSyncStatus } from "dziri/livestore";
export const todos = liveQuery(store, todosQuery);
export const sync  = useSyncStatus(store);

// page
<span>{todos.length} loaded</span>                 {/* re-renders on commit */}
<span>{sync.isSynced ? "Synced" : "Syncing…"}</span>
```

## Files

- new `src/livestore.ts`
- new `src/livestore.test.ts` (fake structural store; tests the dziri half — seed → subscribe →
  `set` → unsubscribe on close)
- `package.json`: add `"./livestore": "./src/livestore.ts"` to `exports`
- `docs/docs/guide/livestore.md` (author guide) — follow-up, not this pass

## Out of scope / noted for later

- `useClientDocument` / `useRcResource` (experimental React hooks).
- Scalar/single-row queries in `liveQuery` (seed is `[]`); `source()` covers them today.
- Re-wiring the simplified todo template back to LiveStore — a separate, opt-in step if wanted;
  the todo template currently uses plain signals + a JSON file by design.

## Verification

- `bunx tsc --noEmit` — types resolve against the installed `@livestore/livestore@0.4.0`.
- `bun test src/livestore.test.ts` — signal plumbing with a fake store.
- the user's `bun run window` smoke against a real store.
