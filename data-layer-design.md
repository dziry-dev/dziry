# dziri — the data layer

**Status:** imagined API, not implemented. Written against the pre-A0 research doc
`framework-design.md` §3–4 (screens, `Reactive<T>`, boundaries, planes) and ROADMAP A4
(`dataOffset`). Nothing here needs new engine symbols; it lands on M7/M8 machinery that is
already specified. §4's loader subsections (three shapes, exits as navigation, failure views)
added 2026-08-15, and `load` is renamed `loader` throughout as of the same date.

> `framework-design.md` was deleted on 2026-08-02 — it was research, and enough had changed
> that it read as current design when it was not. Its section numbers are still cited below;
> the file is at `12b3903^` in git. Treat those citations as provenance, not as something to
> go and check.

The brief was "a component renders JSX, does data fetching, uses React Query and Drizzle." The
answer below keeps every semantic TanStack Query has and deletes almost all of its runtime,
because the two facts it spends its runtime discovering — *which query is this* and *what does
this write invalidate* — are both statically knowable here.

---

## 1. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Query identity** | A query is a **module export**. Its key is `(queryId: u16, args)` recovered by module identity at build. **A query key is never written by hand and never hashed.** | Same identity trick as `params/uuid.ts` and the window directory name. TanStack hashes `['project', id]` because it has no compiler; restating an identity the build already knows is the one thing a compiler makes indefensible. |
| **Invalidation** | **Derived, never declared.** A Drizzle query *is* an AST, so its table read-set is extractable at build; a mutation's write-set likewise. `invalidates[m] = reads & writes` is a precomputed bitmask. | Exactly the shape of planes-from-`affectsLayout`. Fuzzy prefix-matching over key arrays is TanStack's #1 bug source, and it exists only because the fetcher is an opaque closure. Drizzle's is not. |
| **Sync is the default** | `bun:sqlite` is synchronous. A sync query emits **no promise cell, no boundary node, no pending subtree**. The `mode` column is `sync \| async \| worker`, decided at build. | The rule already exists for screen `load` (§3.3). Extending it means a local-first app has no loading states *structurally* — and the compiler proves it rather than the author asserting it. |
| **Cold start has data** | Sync queries resolve **during the construction pass**, so frame 1 paints real rows. | The construction pass runs at process start anyway. A skeleton screen on a local SQLite read is latency theatre. |
| **`staleTime`** | Defaults to `Infinity` for local queries, `0` for network. | Time-based staleness is a proxy for "I cannot observe the writer." In-process, the writer is *right there* and notifies exactly. |
| **`gcTime`** | **Rejected.** Replaced by `keepAlive: n` — an integer LRU capacity per query, same word and same meaning as a screen's `keepAlive`. | Timer-driven eviction on a process that runs for days is unbounded by construction. A capacity is sized at build and reported in the stats line. |
| **Query keys at call sites, `select`, `enabled`, observers, structural sharing** | **Rejected.** `select` is `computed`. `enabled` is an effect gate, which exists. Observers are the binding graph. Structural sharing is the mandatory `key` function on `.map`. | Each is React-shaped runtime machinery for a fact this architecture holds statically. Nothing mounts, so there is nothing for an observer to attach to. |
| **Optimistic updates** | Kept for `async`/`worker`; a **compile error** on a `sync` mutation. | Optimism hides network latency. A local write completes before the next frame boundary, so the rollback path would be dead code that can still be wrong. |
| **`useInfiniteQuery`** | **Rejected as a primitive.** A cursor query plus the list arena's `dataOffset` (ROADMAP A4) *is* infinite scroll. | Pages-array-then-flatten is a workaround for having no windowing. We have windowing, and it is the better half of the pattern. |
| **RPC / server layer** | **None.** Bun is the backend, in-process. A remote database or HTTP service is just `mode: async`. | There is no client/server split to bridge. Inventing one would add a codec vocabulary for a boundary that does not exist. |
| **The loader** | `export const loader` on a screen — a **sync function**, an **async function**, or an **Effect**, detected structurally at run time. One exit contract underneath; `Redirect`/`Cancel` are exported tags, not a middleware API. | The shapes are a gradient: the more the loader can say, the more UI the build can prove. Effect buys typed failure views, interruption on supersede, and route-chain DI through the R channel — with `effect` imported lazily, so dziri depends on nothing (the `validate={}` ruling, `forms.ts`). |
| **TanStack Query itself** | **Not imported.** Semantics adopted; runtime replaced. ROADMAP's "TanStack Query core works" should be narrowed to "would run, and would duplicate the binding graph." | Same ruling as `react-reconciler`: it works and costs a parallel registry, an observer model with no mount to hook, and key hashing for keys we already have as integers. ~500 lines of runtime against 12–40 KB and a second source of truth. |

---

## 2. Files

```
db/
  schema.ts          Drizzle tables. The source of truth for invalidation.
  client.ts          the Drizzle instance. Throws if read while `compiling`.
  queries.ts         defineQuery / defineMutation. Or colocate per feature.
  queries.gen.ts     GENERATED. Query table, invalidation matrix, cache sizes.
  migrations/        drizzle-kit output, applied on onLaunch.
```

Queries may be colocated (`windows/main/regions/main/projects/queries.ts`) — the generator globs
`**/queries.ts` plus any module that imports `dziri/data`. Location is convention; identity comes
from the module path, so moving a file is a rename, not a key change.

---

## 3. Defining data

```ts
// db/queries.ts
import { defineQuery, defineMutation } from "dziri/data";
import { db } from "./client.ts";
import { projects, files } from "./schema.ts";
import { eq, desc } from "drizzle-orm";

export const projectById = defineQuery(
  (id: string) => db.select().from(projects).where(eq(projects.id, id)).get(),
  { keepAlive: 8 },
);

export const projectFiles = defineQuery(
  (id: string, offset = 0) =>
    db.select().from(files).where(eq(files.projectId, id))
      .orderBy(desc(files.mtime)).limit(200).offset(offset).all(),
  { keepAlive: 4, page: 200 },
);

export const renameProject = defineMutation(
  (id: string, name: string) =>
    db.update(projects).set({ name }).where(eq(projects.id, id)).run(),
);
```

No key. No `queryFn` wrapper. No options at the call site — options describe the *query*, and a
per-call-site option is a per-mount concept in a system where nothing mounts.

`projectById` is callable three ways, and the difference is deliberate rather than magic:

| Form | Where | What it does |
|---|---|---|
| `projectById(id)` | anywhere — `load`, a handler, a mutation, a test | executes and returns the value (sync) or a promise (async). Goes through the cache. |
| `projectById.bind(idCell)` | component body, construction scope only | registers a **reactive query cell** by ordinal. Args are tracked; a new args tuple re-resolves. |
| `projectById.peek(id)` | anywhere | cache read, no fetch, no subscription. `undefined` on a miss. |

`.bind` is the project's existing word for "make this a compiled dynamic hole" — the same word
`style={{ width: bind(doubled) }}` uses. Calling `.bind` outside construction is a compile error
naming the construction pass.

### The trap that is specific to this architecture

**The compiler imports and evaluates every screen module** (`§5 stage 2`). So:

```ts
const rows = projectList();          // at module top level of a screen
```

would run against the developer's database *at build time* and bake the result into the arena as
constant data. It would look like it worked. `db/client.ts` therefore throws whenever
`compiling === true`, with the message *"a query ran during compilation; queries execute in
loader(), in a handler, or via .bind() during construction."* This is the data-layer sibling of
the `.value`-at-construction guard, and it is equally non-negotiable.

`loader` is never invoked by the build pass — only its existence and its inferred return type are
read, which is what `+screen.ts` types `data` from.

---

## 4. A screen

The primary path is unchanged from the research doc's §3.3 — `loader` (spelled `load` there;
renamed 2026-08-15 to the word every router already uses) takes the args tuple and nothing else,
because the args tuple *is* the cache key.

```tsx
// windows/main/regions/main/projects/[id=uuid]/index.tsx
import { args, data } from "./+screen.ts";
import { projectById, projectFiles, renameProject } from "../../../../../../db/queries.ts";
import { FileRow } from "../../_FileRow.tsx";

export const screen = {
  title: "Project",
  keepAlive: 3,
  // Not async. bun:sqlite is synchronous, so the compiler emits no boundary,
  // no promise cell and no pending subtree — and `loading.tsx` beside this
  // file is a compile error.
  loader: ({ id }) => ({
    project: projectById(id),
    files:   projectFiles(id),
  }),
} satisfies Screen<Args>;

export default function Project() {
  return (
    <div className="page">
      <h1 className="title">{data.project.name}</h1>
      <p  className="meta">{data.files.length} files</p>

      <div className="list">
        {data.files.map((f) => <FileRow name={f.name} size={f.size} />)}
      </div>

      <button onClick={() => renameProject(args.peek().id, "Renamed")}>Rename</button>
    </div>
  );
}
```

Two things the schema buys the compiler here:

- **`{ key }` is inferred.** `.map` requires a key function (`jsx-runtime.ts:36`). When the element
  type traces back to a Drizzle table, the compiler defaults it to that table's primary key.
  Non-table rows still require it explicitly.
- **`data.files.length`** is a cell fed by the arena's live row count, not a JS array read.

`{data.project.name}` is legal in child position and `data.project.name.toUpperCase()` is a compile
error, under the same `Reactive<T>` rule that already rejects `style={{ color: signal }}`.

### A component-scoped query

For data that is not the screen's subject — a sidebar count, a search field, anything whose
lifetime is the window rather than the navigation frame:

```tsx
import { signal } from "dziri";
import { searchFiles } from "../../db/queries.ts";

export function Search() {
  const q       = signal("");
  const results = searchFiles.bind(q, { debounce: 120 });

  return (
    <div className="search">
      <input bindValue={q} />
      <span className="count">{results.length} matches</span>
      {results.map((f) => <FileRow name={f.name} size={f.size} />)}
    </div>
  );
}
```

`debounce` is a compiled integer on the cell, not a userland `useDeferredValue`. It is the one
call-site option that survives, because it is a property of *this* binding rather than of the query.

### The loader's three shapes *(added 2026-08-15)*

A screen's `loader` may be a plain function, an async function, or an **Effect**:

```ts
export const loader = ({ id }: Args) => ({ project: projectById(id) });   // sync
export const loader = async ({ id }: Args) => api.project(id);            // async
export const loader = ({ id }: Args) =>                                   // Effect
  requireAuth.pipe(Effect.andThen(projectById(id)), Effect.timeout("3 seconds"));
```

Detected at run time, structurally, in a load-bearing order — Effect first, because an Effect is
the one shape that must not be `await`ed. Every Effect value carries `Symbol.for("effect/Effect")`,
a *registered* symbol, so the test needs no import (measured, effect 3.22). Then thenable, then
plain value. `effect` itself is imported lazily only to actually run one — the same dance
`validate={}` documents in `forms.ts`, under the same ruling: dziri depends on none of them.

The shapes are a gradient — the more the loader can say, the more UI the build can prove:

| shape | boundary | failure views | cancellation | route-chain context |
|---|---|---|---|---|
| sync fn | none — frame 1 has data | none typed; a throw is a defect | n/a | — |
| async fn | emitted | `failure.tsx` default export only | `AbortSignal` passed in, best-effort | — |
| Effect | emitted | per-tag views, tsc-exhaustive | real interruption, finalizers run | R channel |

One honesty note, because the compiler is deliberately type-blind (REACTIVITY.md §2): it cannot
see `Effect<A, never>` or prove that no instruction suspends, so **an Effect loader always emits a
boundary**. The zero-boundary frame-1 path is the plain sync function's privilege. An author who
wants both writes the sync function — the shape *is* the declaration.

### Exits drive navigation — there is no middleware API

Middleware is what routers invent because their loaders are opaque async functions that can only
return data or throw. An Effect loader already *is* the composition — guards, retries, timeouts
are combinators the author applies — so the router's entire contract is interpreting the exit:

| exit | interpretation |
|---|---|
| `Success<A>` | show the screen; `A` lands in `data` |
| `Fail<E>`, tagged | show the matching failure view |
| `Fail<Redirect>` / `Fail<Cancel>` | **control flow, not error** — navigate elsewhere / stay put. Two tags dziri exports; an auth guard is `Effect.fail(new Redirect("login"))`. Thrown from a function loader, they mean the same. |
| defect | the crash screen — a bug, distinguishable from a designed failure |
| interruption | nothing; a superseded navigation |

Supersession is structural: navigating again interrupts the in-flight fiber, finalizers run, and a
stale response can never write into a screen that was already left. `Effect.retry` runs *inside*
the loader, so the UI never flickers through failure states while a schedule is still trying — the
boundary leaves `pending` only on the final exit.

Navigation timing is configured by presence, like everything else here: `loading.tsx` beside the
screen means navigate immediately and show it; absent means stay on the current screen until the
exit arrives.

**The R channel is the nested-screen story.** A parent's loader *provides* a service; a child's
*requires* it — `Effect<FileDetail, DbError, ProjectContext>`. The matched chain is a static file
path, so `tsc` proves every requirement is satisfied by an ancestor: a screen moved under the
wrong parent is a type error at build, not a "missing context" crash at run time. No runtime
router can make that promise; it falls out of routes-as-files.

### Failure views are files

No `<Boundary>` component exists — a component whose one job is routing visibility is exactly the
runtime-shaped ceremony this design keeps deleting. A screen's failure states are screens, and the
framework's word for a screen is a file:

```
projects/[id]/
  index.tsx        the screen; exports loader
  loading.tsx      optional — presence decides navigation timing (above)
  failure.tsx      views named by error tag
```

```tsx
// failure.tsx
export function DbError(e: DbError)  { return <div>db is down: {e.path}</div>; }
export function NetworkError()       { return <Offline retry={reload} />; }
export default function Crash()      { return <SomethingBroke />; }   // defects, unmatched tags
```

Exhaustiveness is `tsc`'s job, not the compiler's — a type-blind compiler cannot enumerate `E`.
A `satisfies FailureViews<typeof loader>` on the module makes a missing tag a red squiggle; at run
time an unmatched tag falls through to the default export. The compiler only reads which files
exist and emits one hidden subtree per exported view — the same machinery as routes, switched by
the same kind of int.

### Provision — the window layer *(added 2026-08-15)*

DI has one root: the window. There is no component-tree injection because there is no component
tree at run time — components are erased at build, so the consumers of services are the things
that survive: loaders, handlers, and (eventually) route-scoped effects. The app's contribution to
startup is a **Layer**, not a `main` — the framework owns startup, and if the layer fails to
build, that is a typed exit like any loader's: a launch-failure view rather than a white window.

```ts
// windows/main/runtime.ts — services and the layer
export class Store extends Context.Tag("app/Store")<Store, LiveStore>() {}

export const StoreLive = Layer.scoped(
  Store,
  Effect.acquireRelease(
    Effect.promise(() => createStorePromise({ schema, adapter, storeId: "local" })),
    (store) => Effect.promise(() => store.shutdownPromise()),
  ),
);

export const layer = Layer.mergeAll(StoreLive, AuthLive);
```

```tsx
// windows/main/index.tsx — attached where the window is declared
<Window title="my app" width={1040} height={700} layer={layer}>
```

`layer={layer}` rides existing machinery: the compiler reverse-maps the object to the export it
came from — exactly how `bind:value={sig}` records a signal's name — and emits the import into
the artifact. At launch the runtime builds a `ManagedRuntime` from it; on window close it is
disposed, so `Store`'s release runs and the store shuts down. Scoped resources for free.

Consumers `yield*` the tag. A handler (module-level, as all handlers are):

```ts
export const onAddTodo = () =>
  Effect.gen(function* () {
    const store = yield* Store;                                   // ← the DI
    yield* Effect.sync(() => store.commit(events.todoCreated({ text: draft })));
    draft.set("");                                                // bare reads, .set writes — dziri rules hold inside
  });
```

A loader, with the guard that makes middleware unnecessary:

```ts
export const loader = ({ id }: Args) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    if (!auth.currentUser()) return yield* Effect.fail(new Redirect("login"));
    const project = (yield* Store).query(project$(id));
    return project ?? (yield* Effect.fail(new NotFound({ id })));
  });
// Effect<Project, Redirect | NotFound, Store | Auth> — requirements met by the window layer, tsc-checked
```

A parent screen provides to its descendants with a `provides` export — its loader's success value
is registered under the tag, so a child never refetches what its layout already loaded:

```ts
// pages/projects/$id.tsx
export class CurrentProject extends Context.Tag("screen/CurrentProject")<CurrentProject, Project>() {}
export const provides = CurrentProject;

// pages/projects/$id/files.tsx
export const loader = () =>
  Effect.gen(function* () {
    const project = yield* CurrentProject;      // from the ancestor; wrong nesting = type error
    return (yield* Store).query(filesOf$(project.id));
  });
```

**Without `effect`, everything still works.** This is a constraint, not an aspiration: `loader`
degrades to a sync or async function through the same exits, a guard is `throw new
Redirect("login")`, handlers stay ordinary functions, and an absent `layer={}` builds nothing.
dziri never imports `effect` at module scope — an Effect value is recognised by its registered
symbol and the package is imported lazily only when the app handed one over (the `validate={}`
ruling). An app without `effect` in its manifest never loads a byte of it, and `runtime-surface`
keeps that honest.

Open edge, deliberately unresolved: a store's *reactive* queries feeding cells directly
(`store.subscribe(query$) → cell`) is §8's `source()` primitive, and it wants a store instance at
module level — which the layer deliberately does not give you. A `provides`-style export or
loader-returned streams could close it; it is a real design decision, not a footnote.

---

## 5. Mutations and invalidation

```ts
// derived, not declared:
//   renameProject writes {projects}
//   projectById   reads  {projects}   -> invalidated
//   projectFiles  reads  {files}      -> untouched
renameProject(id, "New name");
```

The write set comes out of the Drizzle builder chain. A raw `sql\`` \`` query is opaque, so it must
declare `reads: [projects]` / `writes: [files]` — omitting it is a compile error rather than a
silent no-invalidation, which is the failure mode worth engineering against.

Granularity is **table-level**. Row-level would need the compiler to prove a mutation's `where`
and a query's `where` key on the same primary value; that is a v2 narrowing, opt-in, and table
granularity is what TanStack users hand-write anyway.

Sequence, in full:

```
handler runs
  -> renameProject(id, name)          sync write, inside a transaction
  -> commit                            write set = union of the transaction
  -> invalidates[Q.projectById] -> mark those cache entries stale
  -> stale cells are signals; their bindings ENQUEUE (they do not run)
  -> frame boundary: sync queries re-execute, flush() writes cells,
     plane mask = TEXT for a name change
  -> one upload, one tick, one repaint of one text node
```

A mutation invalidating forty queries still costs exactly one frame. `batch()` is unnecessary
here for the same reason it is elsewhere.

**Optimistic updates, async only:**

```ts
export const publishProject = defineMutation(
  async (id: string) => api.publish(id),
  { optimistic: (id) => projectById.patch(id, (p) => ({ ...p, published: true })) },
);
```

`patch` writes the cached value and records the previous one on the mutation frame; a throw rolls
it back and routes to the handler's `nodeBoundary`. Because the cached object's leaves are cells,
flipping one field enqueues one binding — an optimistic update repaints one node, with no diffing
anywhere in the path.

---

## 6. Async, and what it costs

`mode` is picked at build: `sync` unless the fetcher is `async` or the definition says
`worker: true`.

| mode | Source | Boundary emitted | Blocks Bun |
|---|---|---|---|
| `sync` | `bun:sqlite` on the Bun thread | no | yes, for the query's duration |
| `async` | network, remote Postgres, HTTP | yes | no |
| `worker` | sync Drizzle in a Worker, WAL, results transferred | yes | no |

Blocking Bun is not blocking the window. Post-M9 the engine owns the loop and repaints from
`live`, so a slow query makes the UI **responsive but stale** rather than frozen — hover, resize
and scroll all keep working. That is a strictly better failure mode than the one Electron has, and
it should be documented as a property rather than discovered as a surprise.

It is still a budget. Dev builds time every sync query and warn past 2 ms, naming the file and
suggesting `worker: true`. Same channel as the materialized/live ratio warning.

Suspense wiring needs nothing new: `sources` is already "the set of resource ordinals any binding
under `content` depends on," and a query cell is a resource ordinal. `refetch()` sets `"stale"`,
not `"pending"`, so revalidation does not flash the fallback — the behaviour React needs
`useTransition` for.

**`<Suspense>` wrapping only sync queries is a compile error**: *"nothing under this boundary can
pend."*

---

## 7. Long lists

A query with `page: n` feeds a windowed arena rather than a materialized array:

```tsx
<div className="list" overflow="auto">
  {projectFiles.bind(args.id).map((f) => <FileRow name={f.name} size={f.size} />)}
</div>
```

- The arena's capacity is the visible window plus overscan (ROADMAP A4), not the row count.
- Scrolling writes `dataOffset` — one integer.
- When `dataOffset` approaches the loaded range's tail, the cell fetches the next page. That is the
  whole of `useInfiniteQuery`, and it is two existing mechanisms rather than a primitive.
- 50k rows cost O(visible) slots and O(page) resident JS objects.

Blocked on M10, like everything else that needs clipping.

---

## 8. Live data

Three writers, three answers:

| Writer | Mechanism |
|---|---|
| This process | The mutation path. Exact, synchronous, free — invalidation is a compile-time graph, not cache coherence. |
| Another process / a sync engine | `source(subscribe, initial)` — the `useSyncExternalStore` replacement, already a decided primitive. A SQLite update hook or a file watcher writes it; it marks the same cells stale. |
| A server push | `source()` over the websocket. Identical downstream. |

The framing worth keeping: TanStack's entire invalidation apparatus exists because the server is
remote and unobservable. For a local-first desktop app it is not a cache-coherence problem at all.

---

## 9. Generated artifact

```ts
// db/queries.gen.ts (GENERATED)
// 4 queries · 2 mutations · 3 tables · 0 async  <- the async substrate is dead code
export const enum Q { projectById=0, projectFiles=1, projectList=2, unread=3 }
export const enum M { renameProject=0, deleteFile=1 }
export const enum T { projects=0, files=1, tags=2 }

/** Table read-set per query, write-set per mutation. Derived from the Drizzle AST. */
export const reads  = new Uint32Array([0b001, 0b010, 0b001, 0b110]);
export const writes = new Uint32Array([0b001, 0b010]);

/** Precomputed at build: reads[q] & writes[m]. Invalidation is an array index. */
export const invalidates = [
  new Uint16Array([Q.projectById, Q.projectList]),
  new Uint16Array([Q.projectFiles, Q.unread]),
];

export const mode      = new Uint8Array  ([0, 0, 0, 0]);          // sync|async|worker
export const keepAlive = new Uint8Array  ([8, 4, 1, 1]);
export const staleMs   = new Float64Array([Inf, Inf, Inf, Inf]);
export const page      = new Uint16Array ([0, 200, 0, 0]);
export const retry     = new Uint8Array  ([0, 0, 0, 0]);
export const fn        = [projectById, projectFiles, projectList, unread] as const;
```

`--explain query` prints the invalidation matrix. That is most of what TanStack Devtools is for,
as static output.

---

## 10. Ledger

`NOTES.md`'s ledger gains **one** entry, not a section:

> **Query resolution state.** A status word per resident cache entry (`fresh | stale | pending |
> error`), the resolved row cardinality, the LRU cursor, and a retry counter. Everything else —
> which queries exist, their argument arity and types, their cache capacity, their read sets, which
> mutations invalidate which, whether a boundary is needed at all — is compile-time.
>
> The loader adds one word per screen: its status (`idle | pending | ready | failed`, the failed
> case carrying a small int into the emitted view list) plus the in-flight fiber handle while one
> runs. Which shapes exist, which failure views exist and what each tag shows are all compile-time.

Applying the four questions to the rest of TanStack Query:

1. *Can the compiler resolve it?* Keys, identity, options, retry policy, boundary structure. Yes.
2. *Can it precompute it?* The invalidation matrix. Yes — from the schema, so it cannot drift.
3. *Can it emit variants?* Sync and async are different emitted programs, not a runtime branch.
4. *Does the runtime need to know?* Only when the I/O finished and how many rows came back.

---

## 11. Compile errors

```
const rows = projectList();  at module scope of a screen
  -> a query ran during compilation. Queries execute in loader(), in a handler,
     or via .bind() during construction.

defineQuery(() => db.run(sql`select * from projects`))
  -> a raw SQL query cannot be analysed. Declare reads: [projects].

<Suspense> around only-synchronous queries
  -> nothing under this boundary can pend.

loading.tsx beside a screen whose loader is a plain sync function
  -> this screen cannot pend; delete loading.tsx.

failure.tsx beside a screen whose loader is a plain sync function
  -> nothing here can fail typed; a sync throw is a defect and gets the crash screen.

defineMutation(syncFn, { optimistic })
  -> a synchronous mutation commits before the next frame; optimistic is dead code.

projectById.bind(id) outside a component body
  -> .bind registers a cell by ordinal and is only legal during construction.

{data.project.name.toUpperCase()}
  -> data leaves are cells. Wrap it in computed(), or interpolate the cell.
```

---

## 12. Risks

1. **Drizzle AST extraction is the load-bearing assumption.** The builder chain is analysable for
   `select`/`insert`/`update`/`delete` and for the relational API's `with`, but it is a private
   shape that can change between minor versions. Mitigation: extract in one module, with a test
   corpus pinned per Drizzle version, and fail the build loudly on an unrecognised node rather than
   inferring an empty read set. **An empty read set silently disables invalidation**, which is the
   worst available failure and must be unrepresentable.
2. **Table granularity over-invalidates.** Renaming one project re-runs every `projects` query.
   Cheap at sync-local speeds and wrong at network speeds — so the row-level narrowing matters more
   as `mode: async` usage grows, not less.
3. **Sync queries on the Bun thread are a budget nobody enforces.** The 2 ms warning is a dev-mode
   measurement; a query that is fast on the author's 200-row database is not fast on a user's
   200k-row one. Wants an index-usage check (`EXPLAIN QUERY PLAN` for a `SCAN`) in the same pass.
4. **`Reactive<T>` over an inferred Drizzle row type is a lot of type machinery.** Leaf-mapping a
   deeply-nested relational result multiplies conditional types, and TypeScript gives up quietly
   before it errors. Needs a depth cap and a measured `tsc` time before it is committed to.
5. **The construction pass now does I/O.** Sync queries resolving at startup is what buys a
   data-complete frame 1, and it means startup time is now partly the database's. Measure and
   publish it alongside the construction-pass cost.
6. **Not importing TanStack Query means owning its edge cases.** Retry/backoff, in-flight dedupe,
   pause-on-offline and mutation ordering are individually small and collectively where that library
   earned its reputation. The ~500-line estimate is the happy path; budget the rest honestly.

---

## 13. Where this lands in the build order

Nothing here is new engine work. It is a compiler stage plus a runtime module, and it needs:

- **M5** (construction pass) — `.bind` registers by ordinal.
- **M7** (screens) — `loader`, `+screen.ts`, `Reactive<T>`.
- **M8** (`resource`, Suspense, boundaries) — the async half. The sync half needs none of it.
- The **Effect loader shape** is not a milestone of its own: it is one more producer of the same
  exits, recognised structurally and imported lazily. It rides M7 (the sync path) and M8 (the
  boundaries) unchanged.
- **M10** (clipping) — windowed lists, so `page` is real.

Which means the sync, local-first, no-loading-states path — the one that makes the strongest demo —
is reachable at **M7**, before the async substrate exists at all.
