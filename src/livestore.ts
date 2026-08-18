/**
 * `dziri/livestore` — LiveStore's reactive binding, dziri's analog of
 * `@livestore/react`.
 *
 * Two exports, both plain `source()`s. The store engine stays `@livestore/livestore`;
 * this module imports its types *only* (erased at runtime, zero bytes) and turns a
 * query into a dziri signal that `{todos.length}` re-renders from on commit.
 *
 * The store is an explicit argument — dziri has no component tree, so there is no
 * `StoreProvider`/context. `useQuery` is renamed `liveQuery` (TanStack Query owns
 * `useQuery`, and dziri's `use*` names are build-time hooks; this is a runtime
 * source). `useSyncStatus` keeps its React name for parity.
 *
 * This is the seam `src/effect.ts` establishes for Effect, applied to LiveStore: the
 * type-only import keeps dziri dependency-free at runtime, so an app that never
 * imports `dziri/livestore` never loads a byte of `@livestore/livestore`.
 */
import type { Store, Queryable, SyncStatus } from "@livestore/livestore";
import { computed } from "./runtime/signal.ts";
import { source } from "./runtime/source.ts";
import type { ReadonlySignal } from "./runtime/signal.ts";

/**
 * What `liveQuery`/`useSyncStatus` accept as the store.
 *
 * Three shapes, all resolved at *launch* (inside the `source()` subscribe), never at
 * module eval — so the compiler importing a state module never opens a store. The
 * thunk form is how a store created with `createStorePromise` (which returns a
 * Promise and starts *eagerly*) is deferred: wrap it in `() => …` and it runs once
 * the window is live, not while the compiler reads the module.
 *
 * `Store<any, any>` is deliberate: `Store<TSchema>` is contravariant in `TSchema`
 * (its `commit` narrows to the schema's events), so a concrete `Store<MySchema>` is
 * not assignable to `Store<LiveStoreSchema.Any>`; `any` is the bivariant escape hatch
 * that accepts any concrete store while still requiring an actual `Store`. `TResult`
 * infers from `query`, so the row type is never lost.
 */
export type StoreInput =
  | Store<any, any>
  | Promise<Store<any, any>>
  | (() => Store<any, any> | Promise<Store<any, any>>);

function resolveStore(store: StoreInput): Store<any, any> | Promise<Store<any, any>> {
  return typeof store === "function" ? store() : store;
}

/**
 * A live query, as a signal.
 *
 * The store (or its thunk) resolves inside the subscribe, which `startSources` runs
 * at launch. The seed defaults to an empty list — correct for the dominant shape (a
 * table query whose result is `Row[]`), and the first frame shows it while the store
 * opens. Pass `initial` for any other shape — a scalar (`queryDb(..., { pluck })`),
 * a first-row query, a count — where an empty array would be a lie.
 *
 * The query may be a thunk, `() => query`. The thunk is tracked like a `computed`:
 * every signal it reads becomes a dependency, and when one changes the store is
 * re-subscribed with the fresh query. That is the filtered-list shape —
 * `liveQuery(store, () => todosQuery.where({ listId: currentList.value }))` —
 * which a fixed query cannot express. (`Queryable` is always an object, so
 * `typeof query === "function"` splits the two shapes without ambiguity.)
 *
 * A store that fails to resolve (a rejected `createStorePromise` — corrupt file,
 * bad adapter) is reported with the same contract `runDispatched` keeps: printed,
 * never an unobserved rejection. The signal keeps its seed.
 */
export function liveQuery<TResult>(
  store: StoreInput,
  query: Queryable<TResult> | (() => Queryable<TResult>),
  initial?: TResult,
): ReadonlySignal<TResult> {
  return source<TResult>(
    (set) => {
      let closed = false;
      let storeUnsub: (() => void) | undefined;
      let watchUnsub: (() => void) | undefined;
      void Promise.resolve(resolveStore(store))
        .then((s) => {
          if (closed) return;
          const run = (q: Queryable<TResult>) => {
            set(s.query(q));
            storeUnsub = s.subscribe(q, (value) => set(value));
          };
          if (typeof query === "function") {
            // The thunk's signal reads are captured by `computed`; priming is lazy,
            // so nothing evaluates until this subscribe runs at launch.
            const reactive = computed(query);
            run(reactive.value);
            watchUnsub = reactive.subscribe(() => {
              if (closed) return;
              storeUnsub?.();
              run(reactive.value);
            });
          } else {
            run(query);
          }
        })
        .catch((e: unknown) => {
          console.error(
            `  liveQuery's store failed to resolve:\n  ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      return () => {
        closed = true;
        watchUnsub?.();
        storeUnsub?.();
      };
    },
    initial ?? ([] as unknown as TResult),
  );
}

/**
 * The store's sync status, as a signal — for sync indicators.
 *
 * `SyncStatus` is the store's own type: `{ localHead, upstreamHead, pendingCount,
 * isSynced }`. The seed is an exact literal (not a cast) and is shown only for the
 * first frame before the store resolves. `subscribeSyncStatus` fires immediately with
 * the current status, then on each change.
 */
export function useSyncStatus(
  store: StoreInput,
): ReadonlySignal<SyncStatus> {
  return source<SyncStatus>(
    (set) => {
      let unsub: (() => void) | undefined;
      let closed = false;
      void Promise.resolve(resolveStore(store))
        .then((s) => {
          if (closed) return;
          set(s.syncStatus());
          unsub = s.subscribeSyncStatus((status) => set(status));
        })
        .catch((e: unknown) => {
          console.error(
            `  useSyncStatus's store failed to resolve:\n  ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      return () => {
        closed = true;
        unsub?.();
      };
    },
    { localHead: "", upstreamHead: "", pendingCount: 0, isSynced: false },
  );
}
