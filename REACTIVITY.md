# Reactivity — one system

**Status:** design, decided. Nothing in §5 is built.
**Measured by:** `bun run signals`. Every claim here is a command that was run — see §9.
**Written:** 2026-08-02.

Reactivity grew one feature at a time and each feature answered the same question its own way.
There are now six brand symbols, three sentinel kinds, two recording proxies, a side-table
`WeakMap`, an unwrapping `Proxy`, and a `TextPart` union whose valid shapes depend on which
compiler phase you are in.

The decision below removes most of that rather than organising it. **`.value` is deleted.** One
authoring form, and the holes close because a signal object never appears in an expression.

---

## 1. What exists today

Every mechanism below answers: *a value the build cannot know — how does the compiler learn
where it comes from at run time?*

| # | mechanism | where | used by |
|---|---|---|---|
| 1 | **identity** — the signal object itself | `isSignal`, `signal.ts:203` | `{count}`, `cn({on: sig})`, `bindValue`, `onClick` |
| 2 | **item recorder** — Proxy records a path | `item-path.ts` | `{t.title}` inside `.map` |
| 3 | **param recorder** — Proxy records a name | `route-args.ts` | `args.id` — *records, never emits* |
| 4 | **array proxy** — `.value` returns a Proxy remembering its owner | `compileTimeArray`, `signal.ts:235` | `todos.value.map(…)` |
| 5 | **route proxy** — `.value` returns a marker; `UNWRAP` recovers the signal | `guardedPath`, `route.ts:253` | `router.path.value` |
| 6 | **sentinels** ×3 | `sentinel.ts` | a recorder or route read that escaped into a string |
| 7 | **derived-cell memo** — `WeakMap` of how a cell was built | `routeMatches`, `route.ts:159` | `router.matches(p)` |

**The inconsistency, in the demo's own code.** The same operation, written two ways:

```jsx
{view.map(t => …, { key })}                 // features.tsx:134 — bare signal
computed(() => todos.value.map(t => …))     // state.ts:33      — .value
```

**The redundancies.** #4 and #5 are the same trick twice — both make `.value` return something
that remembers its owner, one for arrays and one for the route. #7 and `ResolvedRef.expression`
are one idea in two files. `TextPart.source`/`.export` is a phase smell: `source` is only valid
before `resolve-refs`, `export` only after, and the type admits both always.

---

## 2. The decision

> **`.value` does not exist. A signal is passed, never unwrapped by the author.**

The invariant that follows is the whole point:

> **A signal object never appears in an expression.**

Every hole in reactivity is a signal object sitting somewhere JavaScript evaluates it —
`count === 7`, `count ? a : b`, `` `${count}` ``, `count * 2`. Remove every context where that
can happen and the holes are not patched, they are unreachable.

---

## 3. The API

```ts
const count = signal(0);          // state
const items = signal<Todo[]>([]);

derive(count, (c) => c * 2);           // derived — the callback gets VALUES
derive([first, last], (f, l) => …);    // several deps

count.peek();                     // read now, untracked — handlers only
count.set(5);                     // write
count.update((n) => n + 1);       // write from current
items.map(render, { key });       // list
```

```jsx
{count}                                   // render
{isBig}                                   // render a derived
className={cn("box", { big: isBig })}     // conditional class
bindValue={draft}                         // editable
onClick={submit}                          // handler
{items.map(row, { key: (t) => t.id })}    // list
```

**No `.value` anywhere.** Reads in markup are the signal itself. Reads in derived code arrive as
plain arguments. Reads in handlers are `peek()`, which names exactly what a handler wants — the
value at this instant, untracked.

### Why the callback takes values, not signals

Measured. Every form that was broken is reactive when the body receives a plain value:

```
  c === 7        true       -> false      reactive
  c ? 'y':'n'    y          -> n          reactive
  !c             false      -> true       reactive
  c * 2          14         -> 0          reactive
  c > 3          true       -> false      reactive
  `${f} ${l}`    ada lovelace -> grace hopper  reactive
```

And chains propagate:

```
  before: 14 15 deep:15
  after:  200 201 deep:201
```

`===` works because `c` is a number. Truthiness works because `c` is a number. There is no trick
here and nothing to defend — the body never holds a signal.

### What enforces it

**The type.** With `value` removed from `ReadonlySignal<T>`, every broken form in
`bun run signals` becomes a `tsc` error at the author's own line:

```ts
{count.value}          // Property 'value' does not exist on type 'Signal<number>'
{items.value.length}   // same
{isBig.value}          // same
count.value = 5        // same
```

No marker, no recorder, no sentinel. **Deleting a property is the enforcement.** This is why the
decision shrinks the system instead of adding to it.

### Migration — the whole demo

| today | after |
|---|---|
| `computed(() => route.value === "products/new")` | `derive(route, (r) => r === "products/new")` |
| `computed(() => todos.value.map(t => …))` | `derive(todos, (ts) => ts.map(t => …))` |
| `computed(() => todos.value.filter(t => !t.done).length)` | `derive(todos, (ts) => ts.filter(t => !t.done).length)` |
| `if (path === route.value) return` | `if (path === route.peek()) return` |
| `route.value = path` | `route.set(path)` |
| `const title = draft.value.trim()` | `const title = draft.peek().trim()` |
| `todos.value = [...todos.value, t]` | `todos.update((ts) => [...ts, t])` |
| `isLight.value = !isLight.value` | `isLight.update((v) => !v)` |

Roughly twenty lines across `state.ts` and `router.ts`. Three of them get shorter: `update`
removes the read entirely.

---

## 4. The costs, stated

**Deps are explicit.** `derive(count, (c) => c * 2)` is more to type than
`computed(() => count.value * 2)`. In exchange the dep list is *complete by construction* — there
is no way to read an undeclared signal inside the body, because no signal is in scope as a
readable thing. That is strictly stronger than React's `useMemo`, whose dep list can be wrong and
is policed by a lint rule.

**Conditional deps evaluate eagerly.** `derive([a, b, c], (a, b, c) => a ? b : c)` subscribes to
all three. Correct for dziri, where the dependency table in the IR is static anyway.

**`peek()` in markup is a snapshot.** `{count.peek()}` renders a constant. That is a deliberate
escape hatch rather than a trap, because the name says so — the same treatment
`[...todos.value].map(…)` already has as the documented way to opt out of a dynamic list.

**One residual hole.** A signal held in a boolean position in *handler* code:

```ts
if (isLight) { … }        // ✗ always truthy, and tsc has no flag for it
if (isLight.peek()) { … } // ✓
```

`ToBoolean` invokes no user code and TypeScript cannot refuse truthiness on an object, so nothing
can catch this. It is the honest floor. Note how much smaller it is than today's: markup and
derived bodies are both immune, because neither can hold a signal.

---

## 5. The work

Ordered. Each step lands and is verified by `bun run signals`.

### 5.1 — `derive(deps, fn)`, and `.value` removed from the type

Add `derive`, `peek`, `set`, `update`. Remove `value` from `ReadonlySignal<T>` and `Signal<T>`.
Migrate `windows/` per §3. The runtime's own reads move to an internal accessor.

**Consequence worth verifying rather than assuming:** with explicit deps, ambient dependency
tracking may become unnecessary — `derive` subscribes to its deps directly, so the `listener`
global (`signal.ts:48`) and the tracking scope in `computed` (`signal.ts:150-156`) may have no
remaining callers. If so, that deletes as well. Check `subscribeBindings` and
`subscribeStylePatches` before removing anything.

### 5.2 — a bare signal cannot be coerced

`` `${count}` `` renders `"[object Object]"` today, and `tsc` does not refuse it. A template
literal *does* call us:

```ts
[Symbol.toPrimitive](hint) {
  throw new SignalCoercionError(hint);   // not: return the value
}
```

Throwing rather than returning is deliberate. Returning would make `` `${count}` `` work while
leaving `if (isLight)` silently broken — teaching that bare signals are fine in expressions,
which is the opposite of §2.

### 5.3 — the route stops being special

`guardedPath`, `UNWRAP`, `RoutePath`, `RouteValueLeakError`, `hasRouteSentinel`,
`splitRouteSentinel` and `sentinel("route")` all delete. `router.path` becomes an ordinary
signal; `{router.path}` is the only form and already works. `router.matches(p)` stays — it is a
derived cell with no export name, which is §5.4's problem.

`compileTimeArray` (#4) also goes: `todos.value.map(…)` is unreachable once `.value` is gone, and
`todos.map(…)` is the only form.

### 5.4 — unify on `Source`

What remains after the deletions still needs one vocabulary:

```ts
export type Source =
  | { kind: "signal"; signal: unknown }        // {count}
  | { kind: "item";   path: Step[] }           // {t.title} inside .map
  | { kind: "param";  name: string }           // {args.id}  — §5.5
  | { kind: "expr";   text: string; deps: unknown[] };  // router.matches("x")
```

Note it is four kinds, not the five an earlier draft needed — the `path` kind existed only to
serve `{user.value.name}`, which is now `derive(user, (u) => u.name)`.

- `TextPart` → `{ literal } | { source: Source }`, valid in every phase
- `routeMatches` WeakMap and `ResolvedRef.expression` → `{kind:"expr"}`
- one `describe(source)` behind every diagnostic
- one leak check, replacing three in `checkAuthored` and four in `jsx-runtime.ts`

### 5.5 — `args.id` becomes a binding

The last recorder that records and never emits. A fifth kind of bespoke mechanism today; a
`Source` kind once §5.4 lands. Needs the route matcher, which is separate work.

---

## 6. On a parser or Babel plugin

**Not needed for this.** That is the measured result in §3: every form that a parser was going to
rescue — `===`, truthiness, arithmetic, interpolation — is already reactive when the derived
callback receives values. The signal-pattern change does the whole job.

A transform would only buy dropping the word `derive`:

```jsx
{count === 7}         // would need a parser
{isSeven}             // works, with `export const isSeven = derive(count, c => c === 7)`
```

And it carries a boundary problem the current design does not have:

```jsx
{count === 7}                        // reactive, with a parser
const x = count === 7;  …  {x}       // frozen, silently
```

Reactive-in-a-brace but frozen-in-a-`const` is worse than a uniform rule. Svelte is the only
version that does not lie, and it works by rewriting every read in the file — incompatible with
cross-module signals in the same way Svelte 5 cannot do `export let count = $state(0)`.

Nothing in §5 has to be undone if a transform is taken up later.

---

## 7. What everyone else does

| library | the read | derived deps |
|---|---|---|
| Solid | `count()` | auto, by running |
| TanStack Store 0.11 | `count.get()` | auto, by running |
| Preact signals | `count.value` | auto, by running |
| Svelte 5 | `count` | auto — compiler rewrites every read in the file |
| **dziri (this)** | **`count`** | **explicit, unwrapped into the callback** |

Verified against `@tanstack/store@0.11.0`: `createAtom(7)` for state,
`createAtom(() => count.get() * 2)` for derived, read via `.get()`; the explicit-deps
`Derived({ deps, fn })` API is gone.

Everyone else makes the read syntactically explicit — `count()`, `.get()`, `.value` — because
their derived bodies hold signals and need a way to unwrap them. dziri does not need one: the
body never holds a signal. That is what buys the bare `{count}` in markup *and* a working `===`,
which no library in that table has at the same time.

---

## 8. Superseded

An earlier draft proposed making `.value` record via a Proxy, and separately asked whether
`computed(() => count * 2)` should work via `Symbol.toPrimitive`.

Both are moot. The recorder existed to make `{count.value}` bind; deleting `.value` makes it a
type error instead, which is better and smaller. And the `count * 2` question dissolves — the
answer is `derive(count, (c) => c * 2)`, with no type widening and therefore without reopening
`count === 7`.

Recorded because the reasoning still applies if `.value` is ever reinstated: `tsc` does not
consult `Symbol.toPrimitive` for arithmetic, so making `count * 2` type-check requires
`Signal<number> = number & {…}`, and an intersection containing `number` is comparable to a
number literal — so `count === 7` would type-check and be false for ever. Same trap as the
branded `RoutePath`.

---

## 9. Verification

`bun run signals` is the measure. After §5.1 the five silent rows should be `tsc` errors rather
than table rows at all, and the table should read:

```
  {count}                bind   bind   source signal count
  {isBig}                bind   bind   source signal isBig
  {items.map(…,{key})}   list   list   template + arena
  {router.path}          bind   bind   source signal route
  {router.matches("x")}  bind   bind   expr computed(() => …)
  `${count}`             error  error  SignalCoercionError        ← 5.2
```

Full sweep green: `bun test`, `check`, `window`, `golden`, `characterize`, `boundary-diff`,
`conformance`, `runtime-surface`, `protocol-guard`, `doc-lint`.

`golden` matters most — §5.1 and §5.3 change how every binding in the demo is produced, and the
pixels must not move.

### Measurements this rests on

Each was run, not assumed:

- `bun run signals` — 9 of 20 forms wrong today; 5 silent.
- `derive(deps, fn)` with unwrapped arguments: `===`, truthiness, `!`, `*`, `>`, and template
  interpolation all reactive. Chains propagate through three levels.
- `tsc` already refuses `count * 2` / `> 3` / `+ 1` / `=== 7` on a bare signal. It does **not**
  refuse truthiness, negation, or template interpolation.
- `Symbol.toPrimitive` makes those reactive at run time and does **not** make them type-check.
- `@tanstack/store@0.11.0` auto-tracks and reads via `.get()`.
- The demo writes `.map` two ways: `view.map(…)` in markup, `todos.value.map(…)` in a computed.
- Six `Symbol.for("skia-proto.*")` brands; `setCompiling` has two callers; `TextPart` has four
  shapes of which two are phase-exclusive.
