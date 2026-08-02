# Reactivity — one system

**Status:** §1–§2 built and shipping. §5.3–§5.5 outstanding.
**Measured by:** the `reactivity` golden and `src/compiler/reactive-transform.test.ts`.
**Written:** 2026-08-02.

## Built

```ts
const count = signal(0);
const doubled = computed(() => count * 2);      // no .value, no deps
count.set(5);
count.set((n) => n + 1);
```
```jsx
{count}  {count * 2}  {count === 7 ? "y" : "n"}  {`n is ${count}`}  {count ? "on" : "off"}
```

A `Bun.plugin` rewrite (`reactive-transform.ts`, `reactive-plugin.ts`) turns every
identifier read into `$(x)`, which unwraps a signal at run time and passes everything else
through — so it needs no type information, no module graph, and no scope analysis.
`Signal<T>` is `T & Ops<T>`, so the same expressions type-check. Installed via a
`bunfig.toml` preload, because three processes import authored modules: the compiler, the
window host, and `bun test`. `DZIRI_REACTIVE=0` turns it off.

The `reactivity` route in the demo renders every form, and the golden holds it.

**Still to do:** §5.3 (delete the route's private marker), §5.4 (`Source`), §5.5 (`args.id`),
and removing `.value` from the public type — `Ops` still carries it for framework code.

**Known limit, refused loudly:** an expression compiled into a cell reaches `ui.gen.ts` as
*text*, so it can only name module exports. `` {`at ${router.path}`} `` is a build error
naming the export it should have used, because `router` is a local from `useRouter()`.
`{router.path}` on its own compiles by identity and is fine.

---

The rest of this document is the design as decided, with the reasoning that got there.

Reactivity grew one feature at a time and each feature answered the same question its own way:
six brand symbols, three sentinel kinds, two recording proxies, a side-table `WeakMap`, an
unwrapping `Proxy`, and a `TextPart` union whose valid shapes depend on which compiler phase you
are in.

The design below deletes most of that. **`.value` is gone, and reads are bare identifiers
everywhere** — a build-time source rewrite unwraps them. The authoring surface is five things.

---

## 1. The API

```ts
// ── create ────────────────────────────────────────────────
const count = state(0);
const todos = state<Todo[]>([]);

// ── derive ────────────────────────────────────────────────
const doubled = derived(() => count * 2);
const isBig   = derived(() => count > 3);
const full    = derived(() => `${first} ${last}`);
const view    = derived(() => todos.map((t) => ({ ...t, mark: t.done ? "x" : "" })));

// ── write ─────────────────────────────────────────────────
count.set(5);
count.set((n) => n + 1);
todos.set((ts) => [...ts, item]);

// ── read ──────────────────────────────────────────────────
// Nothing. `count` is the read, everywhere — markup, derived bodies, handlers.
export const increment = () => count.set(count + 1);
```

```jsx
{count}                                     // render
{count * 2}                                 // render an expression
{count === 7 ? "seven" : "not"}             // === works
{`n is ${count}`}                           // interpolation works
className={cn("box", { big: count > 3 })}   // conditional class
bindValue={draft}                           // editable
onClick={increment}                         // handler
{todos.map(row, { key: (t) => t.id })}      // list
```

That is the whole surface: `state`, `derived`, `.set`, `.map`, `cn`.

**No `.value`. No `peek`. No `update`. No dependency arrays.** A read is the identifier.

### Naming

`state` and `derived` rather than `signal` and `computed`. Both of those are implementation
words — a signal is a graph node, a computed is a memoised call — and neither describes what the
author is doing. `state(0)` says what it is; `derived(() => …)` says where the value comes from.
The pairing also reads as one idea, which `signal`/`computed` never did.

Full renames, applied together:

| today | after |
|---|---|
| `signal(v)` | `state(v)` |
| `computed(fn)` | `derived(fn)` |
| `Signal<T>` | `State<T>` |
| `ReadonlySignal<T>` | `ReadonlyState<T>` |
| `isSignal(x)` | `isState(x)` |
| `src/runtime/signal.ts` | `src/runtime/state.ts` |

**Not renamed:** the `signal` *field* on `StylePatchRef`, `TextPart` and the `routeMatches`
entry. Those name a graph node in the IR, which is exactly what a signal is, and the emitted
artifact reads correctly as `{ signal: route }`. The authoring word changing does not make the
internal word wrong.

**Deferred.** The code still says `signal`/`computed` and will until §5.2, which changes the
shape of those same declarations anyway. Renaming first would churn 49 files twice. The rest of
this document uses the current names where it describes current code, and the new names where it
describes the target API.

`.set` takes a value or a function of the previous value — one method, not two. (Same shape as
`@tanstack/store`'s `Atom.set`: `((fn: (prev: T) => T) => void) & ((value: T) => void)`.) The
only ambiguity is a signal holding a function, which is rare enough to document rather than
design around.

---

## 2. How the magic works

Two rewrites, in a `Bun.plugin` `onLoad` hook. **Neither needs type information.**

### Inside a `computed` body — unwrap reads

```ts
computed(() => count * 2)
// →
computed(() => $(count) * 2)
```

`$(x)` is `isSignal(x) ? read(x) : x` — a *runtime* check. This is the load-bearing simplification:
the plugin rewrites every free identifier read and lets the runtime decide what was a signal. No
type checker, no module graph walk, no naming convention. That "which identifiers are signals"
problem is the hard part of the Svelte approach, and this sidesteps it entirely.

Every operator then works, because by the time it runs it has a plain value:

```
$(count) === 7      ✓        $(count) ? a : b    ✓
`${$(count)}`       ✓        $(count) * 2        ✓
```

### Inside a JSX brace — wrap in a thunk

```jsx
{count * 2}
// →
{computed(() => $(count) * 2)}
```

A lone identifier is left alone, so `{count}` keeps its identity and compiles to exactly the
binding it does today. That matters: it is what keeps `golden` green.

### The one non-obvious case: method calls

`count.set(5)` must not become `$(count).set(5)` — that is `0.set(5)`. But
`todos.filter(…)` inside a `computed` *must* unwrap, and `user.name` must too.

Resolved at run time, same as `$`:

```ts
$m(x, k)  =  isSignal(x) && SIGNAL_METHODS.has(k) ? x : $(x)
//           SIGNAL_METHODS = { set, subscribe }
```

```js
count.set(5)             → $m(count, "set").set(5)          // the signal
todos.filter(…)          → $m(todos, "filter").filter(…)    // the array
user.name                → $(user).name                     // the object
todos.map(fn, { key })   → $m(todos, "map").map(fn, {key})  // the array…
```

`map` deliberately resolves to the *value*, because `compileTimeArray` (`signal.ts:235`) already
does the right thing with it: keyed builds a dynamic list, unkeyed is an ordinary build-time map.
That mechanism survives; it was going to be deleted under the previous draft and earns its place
here.

---

## 3. What exists today, and what happens to it

| # | mechanism | where | fate |
|---|---|---|---|
| 1 | **identity** — the signal object | `isSignal`, `signal.ts:203` | **stays** — `{count}` and `cn({on: sig})` |
| 2 | **item recorder** | `item-path.ts` | **stays** — `{t.title}` in `.map` |
| 3 | **param recorder** | `route-args.ts` | stays; §5.5 makes it emit |
| 4 | **array proxy** | `compileTimeArray`, `signal.ts:235` | **stays** — §2 depends on it |
| 5 | **route proxy** | `guardedPath`, `route.ts:253` | **deletes** |
| 6 | **sentinels** ×3 | `sentinel.ts` | route kind deletes; item/param stay |
| 7 | **derived-cell memo** | `routeMatches`, `route.ts:159` | **deletes** — §5.4 |

**The inconsistency this fixes**, visible in the demo's own code today:

```jsx
{view.map(t => …, { key })}                 // features.tsx:134 — bare signal
computed(() => todos.value.map(t => …))     // state.ts:33      — .value
```

Both become `todos.map(…)`.

**Other redundancies.** #5 and #4 are the same trick twice — both make `.value` return something
that remembers its owner. #7 and `ResolvedRef.expression` are one idea in two files.
`TextPart.source`/`.export` is a phase smell: `source` is only valid before `resolve-refs`,
`export` only after, and the type admits both always.

---

## 4. The costs, stated

**A parser dependency.** `Bun.Transpiler` strips types but has no AST-rewrite API, so this is
oxc or Babel as a devDependency plus a `Bun.plugin` `onLoad` hook. First non-trivial build-time
dependency the compiler has taken on.

**The `const` boundary — the real one.**

```jsx
{count === 7}                        // ✓ reactive: the brace gets wrapped
const x = count === 7;  …  {x}       // ✗ frozen, silently
```

A JSX brace is wrapped; a bare `const` is not. This is the one hazard the explicit-deps design
did not have, and it is the *plausible-looking-wrong-answer* shape this codebase is organised
against — so it needs an answer before shipping, not after. Two candidates:

- **Auto-wrap.** A module-scope `const` whose initializer reads a signal becomes a `computed`.
  This is Svelte's `$derived`, and it removes the boundary entirely. Larger rewrite; scope it
  separately.
- **Refuse.** The plugin knows the initializer touched a signal and can emit a build error
  naming the line and suggesting `computed(() => …)`. Smaller, uniform, and loud.

Refusing first, auto-wrapping later, keeps the rule honest at every stage.

**Errors point at rewritten source** unless source maps are wired through the plugin.

**Reads cost a function call.** `$(x)` per read inside a computed body. Negligible — these run on
change, not per frame — but it is not free, and the runtime-surface ratchet will see `$` and
`$m` as new exported symbols.

**Inline `computed()` gets easier, not harder.** `{count * 2}` becomes a `computed` created
inside a component, which `resolve-refs` cannot name today. The plugin already holds the source
text, so it hands it over directly — no `Function.prototype.toString()` needed, though that was
verified to work as a fallback.

---

## 5. The work

Ordered. Each step lands and is verified by `bun run signals`.

### 5.1 — the plugin

`Bun.plugin` + oxc/Babel. Two rewrites (§2) plus `$` / `$m` in the runtime. Applies to
`windows/**` only at first — the framework's own sources keep writing the internal accessor.

**Spike this before committing to it.** One page, behind a flag, to find out whether the `const`
boundary bites in practice or stays theoretical, and what the rewrite does to error locations.

### 5.2 — `.value` removed, `.set` added

Remove `value` from `ReadonlySignal<T>` / `Signal<T>`; add `set(value | fn)`. Internal reads move
to a non-public accessor. Drop `peek` and `update` from the plan — neither has a job once reads
are bare.

With `value` gone from the type, any read the plugin missed is a `tsc` error at the author's own
line rather than a frozen value:

```
{count.value}   →  Property 'value' does not exist on type 'Signal<number>'
```

**Deleting a property is the backstop.** That is what makes the plugin safe to trust: if it fails
to rewrite something, the build fails loudly instead of rendering a stale number.

### 5.3 — the route stops being special

`guardedPath`, `UNWRAP`, `RoutePath`, `RouteValueLeakError`, `hasRouteSentinel`,
`splitRouteSentinel`, `sentinel("route")` all delete. `router.path` becomes an ordinary signal.
`router.matches(p)` becomes `computed(() => router.path.startsWith(p))` written by the author, or
stays as sugar — decide when §5.4 lands.

### 5.4 — unify on `Source`

```ts
export type Source =
  | { kind: "signal"; signal: unknown }                 // {count}
  | { kind: "item";   path: Step[] }                    // {t.title} in .map
  | { kind: "param";  name: string }                    // {args.id} — §5.5
  | { kind: "expr";   text: string; deps: unknown[] };  // {count * 2}
```

- `TextPart` → `{ literal } | { source: Source }`, valid in every phase
- `routeMatches` WeakMap and `ResolvedRef.expression` → `{kind:"expr"}`
- one `describe(source)` behind every diagnostic
- one leak check, replacing three in `checkAuthored` and four in `jsx-runtime.ts`

`{kind:"expr"}` stops being the route's special case and becomes the normal output of a wrapped
JSX brace.

### 5.5 — `args.id` becomes a binding

The last recorder that records and never emits. A `Source` kind once §5.4 lands. Needs the route
matcher, which is separate work.

---

## 6. What stays broken

Nothing, if the plugin covers every read site. That is the claim to verify in the §5.1 spike, and
the honest list of places it might not:

- a signal passed into a non-rewritten module (a `node_modules` helper) and read there
- dynamic access — `obj[k]` where `obj` is a signal-valued map
- the `const` boundary until §4's answer lands

Each fails loudly rather than silently, because `.value` no longer exists (§5.2).

---

## 7. What everyone else does

| library | the read | derived deps |
|---|---|---|
| Solid | `count()` | auto, by running |
| TanStack Store 0.11 | `count.get()` | auto, by running |
| Preact signals | `count.value` | auto, by running |
| Svelte 5 | `count` | auto — compiler rewrites every read in the file |
| **dziri (this)** | **`count`** | **auto — plugin rewrites reads, runtime decides** |

Verified against `@tanstack/store@0.11.0`: `createAtom(7)` for state,
`createAtom(() => count.get() * 2)` for derived, read via `.get()`; the explicit-deps
`Derived({ deps, fn })` API is gone.

Svelte is the closest, and the difference is where the knowledge lives. Svelte's compiler must
*know* an identifier is reactive, which is why `export let count = $state(0)` cannot work across
modules. Here the plugin knows nothing and `$()` decides at run time — so cross-module signals,
which dziri has by design, cost nothing.

---

## 8. Superseded

Two earlier drafts, kept because the reasoning still applies.

**A `.value` recorder** (Proxy on `.value` that captures the read) — moot. Deleting `.value` makes
those reads type errors, which is smaller and stricter.

**`derive(deps, fn)` with unwrapped arguments** — worked, and was measured to close every hole
(`===`, truthiness, `!`, `*`, `>`, interpolation all reactive; chains propagate three deep). Set
aside because a dependency array on every derived value is a permanent authoring tax paid for a
guarantee most code never needs. Its one genuine advantage over the plugin — no `const` boundary
— is what §4 must answer.

**`Symbol.toPrimitive` to make `count * 2` work without a rewrite** — rejected, and this one must
not be retried. `tsc` does not consult `Symbol.toPrimitive` for arithmetic, so the type must
become `number & {…}`, and an intersection containing `number` *is* comparable to a number
literal — so `count === 7` would type-check and be `false` for ever. Same trap as the branded
`RoutePath`.

---

## 9. Verification

`bun run signals` is the measure. Target after §5.2:

```
  {count}                bind   bind   source signal count
  {count * 2}            bind   bind   expr computed(() => $(count) * 2)
  {count === 7}          bind   bind   expr computed(() => $(count) === 7)
  `${count}`             bind   bind   expr computed(() => `${$(count)}`)
  {todos.map(…,{key})}   list   list   template + arena
  {count.value}          error  error  tsc: Property 'value' does not exist
```

Full sweep green: `bun test`, `check`, `window`, `golden`, `characterize`, `boundary-diff`,
`conformance`, `runtime-surface`, `protocol-guard`, `doc-lint`.

`golden` matters most — §5.1 and §5.3 change how every binding in the demo is produced, and the
pixels must not move. `runtime-surface` will need a re-bless for `$` and `$m`.

### Measurements this rests on

Each was run, not assumed:

- `bun run signals` — 9 of 20 forms wrong today; 5 silent, including `{isBig.value}` rendering
  nothing at all because a frozen boolean is a boolean and JSX drops booleans.
- Unwrapped values in a derived callback: `===`, truthiness, `!`, `*`, `>` and template
  interpolation all reactive; chains propagate three levels.
- `tsc` already refuses `count * 2` / `> 3` / `+ 1` / `=== 7` on a bare signal today. It does
  **not** refuse truthiness, negation, or template interpolation.
- `Symbol.toPrimitive` makes those reactive at run time and does **not** make them type-check.
- `Function.prototype.toString()` survives Bun's `.tsx` transform, type annotations stripped.
- `@tanstack/store@0.11.0` auto-tracks, reads via `.get()`, and `set` takes a value or a function.
- The demo writes `.map` two ways: `view.map(…)` in markup, `todos.value.map(…)` in a computed.
- Six `Symbol.for("skia-proto.*")` brands; `setCompiling` has two callers; `TextPart` has four
  shapes of which two are phase-exclusive.
