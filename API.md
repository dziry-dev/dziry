# dziri — API surface & status

Planning + tracking file for the authoring API. Snippets are the spec; prose is kept out.
Update the status column when something lands.

**Build status:** `done` verified in code · `partial` exists but incomplete · `planned` not built

**Provenance:** everything here is a **proposal** unless listed under Decided below. Proposals are
Claude's output from a brainstorm session, not agreed design. Do not treat them as settled.

### Decided (by Med)

- **Routing.** Identity is the path from project root. `<a href="about.tsx">` / `navigate("app.tsx")`;
  bare = root-relative, `./` `../` = relative to the referring file; `.tsx` `.jsx` `.html`.
  Bare name resolves at the project root; not found → not-found. Filenames are **not** globally
  unique — the path already is. No screens/regions folder; file location does not determine the
  route. Nesting is `<Outlet dir="…">`.
- **Styling.** dziri ships a **full UA stylesheet**, unconditionally — same as a browser. Tailwind
  is not the only supported way to write CSS; plain CSS is first-class. A Tailwind user gets a
  reset because Preflight is author CSS that undoes the UA sheet, exactly as in a browser. No
  template switch, no opt-in/opt-out sheets.
- **Browser-compatibility rule.** The audience is web devs, so: **match the browser's observable
  contract; do not match its known defects.** Diverge only when all three hold — the behaviour is
  obscure enough that devs have not formed an expectation, every major library works around it,
  and it is an accessibility defect. Every divergence gets a numbered entry in a
  *differences from the browser* list. Measurements go in `BROWSER-FACTS.md`, never recollection.
- **Focus clears when a node becomes unreachable** — collapsed, `<Show>` closed, navigated away,
  removed. Focus lands on the window root, so Tab restarts from the top (matching `BODY`).
  **Retained** across scroll-out, because the item still exists and only its row was recycled.

  Divergence from Chromium — **one**, deliberate, passing the three-part test:
  1. Chromium leaves focus on a `display:none` element (measured — `BROWSER-FACTS.md`). We clear.
     Theirs is a WCAG 2.4.3/2.4.7 defect that Radix, React Aria and Reach all work around by
     managing focus manually.

  *A second divergence was recorded here and then withdrawn: Chromium does fire `blur`/`focusout`
  on removal. The earlier "fires nothing" measurement came from a backgrounded tab, where Chrome
  suppresses focus events. So we match the browser and emit the events — matching is free here.*

  Not a divergence, despite appearances: dziri's collapse is a `hidden` byte, but the developer
  wrote *"collapse this node"*, not `display:none`. The browser's contract for **the thing went
  away** is `activeElement === BODY`, which is what we do.

### Agreed (Claude — robustness only, low risk)

Marked agreed because each makes the system *harder to get wrong* and none expands scope.
Anything that trades robustness for capability stays a proposal.

- **Recursion detector.** A component re-entered during build expansion must produce a named
  compile error. Today recursive JSX stack-overflows or hangs the build — this is strictly
  better regardless of whether pooled templates ever ship.
- **No `flattenVisible` helper in the framework API.** A tree today is *a list with a depth
  field* and needs no new surface. Shipping a helper makes it the de-facto tree API and
  manufactures a migration later.
- **If pooled templates are ever built, instances use keyed slot assignment, never a free
  list.** Node ids carry focus, `ref`s, and the sparse hover/active/focus table; a free list
  changes a logical node's id across collapse→expand and silently drops focus and dangles
  refs. List arenas already do keyed slots with never-invalidated ids — reuse that path.
- **Sequencing is a dependency, not a preference.** Pooled templates need M6 (disposal scopes)
  underneath and M10 (virtualization) to bound the pool to viewport size.

> Last brainstorm: 2026-07-31 (routing, data fetching, `source`, UA CSS, trees).
> Rationale lives in `framework-design.md` and `data-layer-design.md`. This file is the surface.

---

## Status

| API | Status | Milestone |
|---|---|---|
| `signal` `computed` `batch` `isSignal` | **done** — `src/runtime/signal.ts` | — |
| `cn(...)` conditional classes | **done** | — |
| `.map(fn, { key })` keyed lists | **done** | — |
| inline `style=` (string + object) | **done** | — |
| `ref()` | partial — `resolve-refs.ts` | C3 |
| `bindValue` | partial — append + backspace only | M12 |
| `effect` `untrack` `peek` cleanup, disposal scopes | planned | M6 |
| `Show` | planned | M3 |
| `source` | planned | M8 |
| `resource` / Suspense / error boundaries | planned | M8 |
| `token()` (context) | planned | — |
| `onFrame(dt)` | planned | — |
| `<Overlay>` | planned | M11 |
| `navigate` / `href` / `<Outlet>` / `defineScreen` | planned | M7 |
| `defineQuery` / `defineMutation` | planned | — |
| default stylesheet | planned | — |

---

## Reactivity

```ts
signal<T>(initial: T): Signal<T>                       // .value read/write, .peek(), .subscribe()
computed<T>(fn: () => T): Cell<T>
effect(fn: () => void | (() => void)): void            // no dep array; cleanup via return
batch<T>(fn: () => T): T
untrack<T>(fn: () => T): T

source<T>(subscribe: (set: (v: T) => void) => () => void, initial: T): Cell<T>
ref(): Ref                                             // .node .bounds() .focus() .on()
token<T>(defaultValue: T): Token<T>                    // build-time lexical scope, no runtime
onFrame(fn: (dt: number) => void): void
```

`source` = push, from outside the process. `resource` = pull, async, drives a boundary.

OS/window state (theme, focus, DPI) ships as **built-in cells** — it arrives via the engine
event ring, not a user `source`. `source` is for Bun-side externals:

```ts
export const configOnDisk = source<Config>(
  (set) => { const w = fs.watch("config.json", async () => set(await readConfig())); return () => w.close(); },
  readConfigSync(),
);
```

---

## Routing

Identity is the **path from project root**. Bare = root-relative; `./` `../` = relative to the
referring file. Extension required (`.tsx` `.jsx` `.html`), literal strings only.

```tsx
<a href="about.tsx" />
<a href="projects/detail.tsx" args={{ id }} />
<a href="./sibling.tsx" />

navigate("about.tsx")
navigate("projects/detail.tsx", { id })
```

```tsx
<Outlet dir="pages" fallback={<Spinner />} error={<Crash />} notFound={<NotFound />} grace={100} />
```

Outlet owns the boundaries. `dir` glob is non-recursive. Nesting = a child `<Outlet>`.
Deep-link paths compose from the Outlet chain. No `regions/`, no filename grammar,
no `layout.tsx` / `loading.tsx` / `error.tsx`, no `+screen.ts`.

```tsx
// pages/project.tsx
const { args, data } = defineScreen({
  load: ({ id }: { id: string }) => projectById(id),   // Args + data both inferred from here
});

export default function Project() {
  return <h1>{data.name}</h1>;
}
```

Ancestor loads run in parallel — args come from the navigation struct, so no waterfall unless
one query feeds another's args (build warning).

`<a href args>` doubles as the prefetch table: hover → `load` into the query cache.

---

## Data

```ts
defineQuery<A extends unknown[], R>(fn: (...a: A) => R, opts?: QueryOptions): Query<A, R>
defineMutation<A extends unknown[], R>(fn: (...a: A) => R, opts?: MutationOptions<A>): Mutation<A, R>

interface Query<A extends unknown[], R> {
  (...args: A): R;                       // execute — load(), handlers, tests
  live(...args: Cellish<A>): Bound<R>;   // reactive cell — construction scope only
  peek(...args: A): R | undefined;
  refetch(...args: A): void;             // -> "stale", never "pending"
  patch(...args: [...A, (prev: R) => R]): void;
}

interface Mutation<A extends unknown[], R> {
  (...args: A): R;
  readonly pending: Cell<boolean>;
  readonly error: Cell<Error | null>;
}

type QueryOptions = {
  keepAlive?: number;   // LRU capacity, default 1
  staleMs?: number;     // default Infinity (local) | 0 (network)
  page?: number;        // rows/fetch -> arena-backed Rows
  retry?: number;       // default 0 (local) | 3 (network)
  worker?: true;        // sync Drizzle off-thread
  reads?: Table[];      // REQUIRED when the fetcher has no analysable AST
};
type MutationOptions<A> = {
  optimistic?: (...a: A) => void;   // compile error on a sync mutation
  writes?: Table[];
};

type Bound<R> = R extends readonly (infer Row)[] ? Rows<Row> : Reactive<R>;

interface Rows<T> {
  map(render: (row: T) => Element, opts?: { key?: (row: T) => string }): Element;
  readonly length: Cell<number>;
  readonly isEmpty: Cell<boolean>;
  readonly status: Cell<"fresh" | "stale" | "pending" | "error">;
  readonly error: Cell<Error | null>;
  more(): void;
}
```

```ts
export const projectById = defineQuery(
  (id: string) => db.select().from(projects).where(eq(projects.id, id)).get(),
  { keepAlive: 8 },
);

export const renameProject = defineMutation(
  (id: string, name: string) => db.update(projects).set({ name }).where(eq(projects.id, id)).run(),
);
```

```tsx
const results = searchFiles.live(q, { debounce: 120 });   // debounce = only call-site option

<span>{results.length} matches</span>
<Show when={results.isEmpty}><p>Nothing found</p></Show>
{results.map((f) => <FileRow name={f.name} size={f.size} />)}

<button disabled={publishProject.pending} onClick={() => publishProject(id)}>Publish</button>
```

Key facts: query key is `(queryId, args)` from module identity — never written, never hashed.
Invalidation is derived from the Drizzle AST (`reads & writes`), not declared.
`bun:sqlite` is sync → no promise cell, no boundary, and sync queries resolve during the
construction pass so frame 1 has real data. No screen-level cache; the query cache is the only one.

---

## Trees / recursive structures

Recursion over **build-time** data unrolls into static nodes — fine, zero runtime cost:

```tsx
const MENU = {…} as const;
function MenuItem({ item }) {                    // fully unrolled by the compiler
  return <div>{item.label}{item.children.map((c) => <MenuItem item={c} />)}</div>;
}
```

Recursion over **runtime** data cannot compile. `.map` captures a template via the recording
proxy, so a self-referential template recurses forever at build time; and arenas are flat with
fixed stride, so nesting them C deep at capacity N is N^C nodes.

**Supported today — flatten to visible rows with a depth field.** Composes directly with
`dataOffset` virtualization; `flatten` is user-written (~15 lines), not framework API.

```tsx
const rows = computed(() => flatten(tree.value, expanded.value));

<div className="tree" overflow="auto">
  {rows.map(
    (r) => (
      <div className={cn("row", depthClass(r.depth))} onClick={() => toggle(r.id)}>
        <span className="twisty">{r.open ? "▾" : "▸"}</span>
        <span className="label">{r.name}</span>
      </div>
    ),
    { key: (r) => r.id },
  )}
</div>
```

Indent via **bounded compiled variants** (`.depth-0 … .depth-15`, clamped) — one int swap per
row — rather than a tier-4 `bind()` per slot, which would need a de-interned style slot per row.

**What this accepts:** a flat list cannot express a background/border on an intermediate
container, guide lines spanning a subtree, a nested scroll region, or clipping scoped to a
branch. Those need real parent/child in the node table.

### DECIDED (Med) — recursive templates + keyed instances

Committed, with performance treated as a requirement rather than a follow-up. Own milestone,
after M6 + M10.

**Built as an extension of the list arena, not a new subsystem.** The arena already has fixed
stride, keyed slot assignment, never-invalidated ids, append-only growth, per-row handlers and
relink-on-reorder. It lacks exactly two things: a row linking as a child of another *row* rather
than the container, and a template containing a self-reference.

Detection is a cycle check on the expansion stack. The compiler emits the template **once**,
with a self-reference where children splice in:

```ts
export const templates = [{
  id: 0, nodeCount: 4, root: 0,
  kind: …, style: …, parent: …, firstChild: …, nextSibling: …,   // RELATIVE to instance base
  childMount: 3,                                                  // where child instances link
  bindings: [{ node: 2, plane: TEXT, read: (r) => r.name }],
  handlers: [{ node: 0, fn: 0 }],
}];
```

```ts
const inst = pool.alloc(T.TreeNode, key);   // keyed slot, NOT a free list
pool.link(parent.childMount, inst);         // depth is free — links are just ints
pool.bind(inst, row);
```

Structure, style slots, binding shapes and handler sites stay compiled. Only instantiation and
linking are runtime — a generalization of what list arenas already do from "N siblings" to
"a tree of instances." `shapeHash` still covers the template; pooled regions are outside it.

**Capacity is pre-sized at the viewport bound and never grows during scroll.** ROADMAP records
that a full Taffy rebuild is "reserved for the first tick and a **capacity change**" — so pool
growth mid-scroll is a frame-time cliff. Growth is a rare amortized event (mount, window resize),
never expand/collapse or scroll.

Acceptance criteria:

- expand a 10-child folder → 10 allocs, O(delta) relinks, one frame, **zero** full Taffy rebuilds
  (assert via the compute counter exposed through `describe`)
- scroll a 100k-node tree at 120 Hz with instance count fixed at visible + overscan
- collapse → expand preserves focus and scroll (the keyed-slot payoff)
- `commit()` cost proportional to **live** instances, not pool capacity
- zero JS allocation in alloc/link/bind: index free-list, no per-instance closures, rebasing
  O(bindings-per-template)

Hard prerequisites — correctness, not polish:

- **M6 dep-set fix.** `signal.ts:86,159` add subscribers on read and never remove them. With
  instances churning this leaks without bound.
- **M2.** `Diff` answering a `hidden` change with `apply_all_styles()` makes every expand/collapse
  an O(n) restyle.

Open questions:

- ~~**`nodes.style` immutability.**~~ **CLOSED 2026-07-31 — no design change needed.**
  `nodes.style` is already runtime-mutable: `tables.rs:551` routes `STYLE|HIDDEN|FLAGS` changes
  into `diff.changed_nodes`, which `resync` feeds to `apply_styles_of`. Per-node, incremental.
  The `engine.rs:401` comment claiming style is "immutable by design" is inaccurate — 393-397
  says the opposite — and only justifies scanning the STYLE column instead of keeping a reverse
  index. **Reword it.**

  The constraint that *does* bind the pool is `layout.rs:304-312`: `relink_nodes` links rows
  **without styling them**, which is only safe because `apply_all_styles` walks **capacity**
  (not the reachable tree) and pre-styles spare slots. A row appended into a slot that already
  held the same style value produces no diff, so nothing restyles it — and if it was never
  styled while spare, it lays out with Taffy's `Style::default()` and no write to blame.
  → **`apply_all_styles` must keep walking capacity.** Belongs on `ARCHITECTURE-REVIEW.md` §4's
  do-not-clean-up list.
- **Disposal.** Freeing an instance must drop binding subscriptions and handler entries with no
  dangling edges.
- **State table + interactive set** updates as instances come and go. *Behaviour is decided —
  see the focus rule under Decided; what is open is the mechanism: focus is held as an item key
  and resolved to a node id on materialization, so the engine still receives a plain int via
  `setInputState`. Hover/active need the same treatment.*

---

## Cross-cutting rules

**Anything touching the outside world registers during the build pass and connects during
construction.** The compiler evaluates your modules, so:

```ts
if (!compiling) { const unsub = subscribe(set); currentScope().onDispose(unsub); }
```

`defineQuery` must not execute · `source` must not subscribe · `effect` must not run.

**That guard only protects framework primitives — user code at module scope runs at build time
too.** The rule for user code: reads are fine (compile-time constants, on-thesis); *persistent
handles and writes* are the bug.

| Class | Caught by |
|---|---|
| non-deterministic (`Date.now`, random, env) | `shapeHash` divergence → hard abort. Already covered. |
| build-time reads | nothing needed — this is a feature |
| persistent handles (timer, socket, watcher) | **planned:** active-handle diff per import |
| writes (fs, network, db) | framework wrappers only; **planned:** global stubs |

Planned diagnostics, one mechanism two phases:
```ts
const before = process.getActiveResourcesInfo();   // verify Bun implements this
await import(fileURL);                             // compiler imports sequentially -> exact attribution
// leaked -> "pages/x.tsx left 1 Timeout open during compilation"
```
Same diff per component during construction (dev only) →
`"Counter created a Timeout outside effect() — it will never be disposed."`
Plus throwing stubs for `fetch`/timers/`WebSocket` in the compile process.
A module-scope lint is the real fix but is blocked — the TSX AST isn't available (same
blocker as TSX source locations).

Compile errors that are part of the surface:

```
const rows = projectList()          at module scope -> a query ran during compilation
navigate("abuot.tsx")               -> no such file (dead links are a build failure)
navigate(`p/${id}.tsx`)             -> href/navigate take string literals only
defineQuery(() => db.run(sql`…`))   -> unanalysable; declare reads: []
defineMutation(syncFn, {optimistic})-> sync commits before the next frame; dead code
<Suspense> over only-sync queries   -> nothing here can pend
q.live(x) outside a component body  -> .live registers by ordinal; construction only
{data.name.toUpperCase()}           -> leaves are cells; wrap in computed()
```

---

## Open questions

- **UA stylesheet prerequisites.** The decision is made (see Decided); what's open is the parser
  work it implies. `css.ts` today has no `*`, no `:where()`, no `::before`/`::after`, and skips
  at-rules (`css.ts:127`). Real Preflight needs all four plus `box-sizing`. Also blocked behind
  the known nested-block bug: a `@media` body is dropped *and* the next rule fails to parse, so
  `@layer` handling must fix that first or importing Preflight corrupts the following rule.
  Needed for Tailwind at all, not just the reset — lands in A1 either way.
  Still to write: the UA sheet itself (~40 lines) + the ~10 missing properties (`font-style`,
  `text-decoration`, `list-style`, `font-family`, `line-height`, `text-align`, `white-space`,
  `vertical-align`, `content`, heading scale).
- **Screens root.** Root-relative + `<Outlet dir="pages">` means typing `pages/` everywhere.
  Either put screens at root or declare the base once (`<App screensRoot="pages">`).
- **Unmatched CSS selectors** — provably dead here (whole tree known at build). Warn, don't error.
- **Row-level invalidation** — table granularity over-invalidates; matters more as `async` grows.
- `Reactive<T>` over deep Drizzle relational types — measure `tsc` before committing.
