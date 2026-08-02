# Reactivity — one system

**Status:** design. Nothing in §4–§6 is built.
**Measured by:** `bun run signals`. Every claim here is a command that was run — see §8.
**Written:** 2026-08-02.

Reactivity in dziri grew one feature at a time, and each feature answered the same question its
own way. There are now six brand symbols, three sentinel kinds, two recording proxies, a
side-table `WeakMap`, an unwrapping `Proxy`, and a `TextPart` union whose valid shapes depend on
which compiler phase you are in. None of it is wrong. All of it is the same idea.

This document names the one idea, states the authoring API, and lists the work that follows.

---

## 1. What exists today

Everything below is a mechanism for the *same* question: **a value the build cannot know — how
does the compiler learn where it comes from at run time?**

### How a read announces itself

| # | mechanism | where | used by |
|---|---|---|---|
| 1 | **identity** — the signal object itself | `isSignal`, `signal.ts:203` | `{count}`, `cn({active: sig})`, `bindValue`, `onClick` |
| 2 | **item recorder** — Proxy records a property path | `item-path.ts`, `Symbol.for("skia-proto.itemPath")` | `{t.title}` inside `.map` |
| 3 | **param recorder** — Proxy records a name | `route-args.ts`, `Symbol.for("skia-proto.routeParam")` | `args.id` — *records, never emits* |
| 4 | **array proxy** — `.value` returns a Proxy that remembers its owner | `compileTimeArray`, `signal.ts:235` | `todos.value.map(…)` |
| 5 | **route proxy** — `.value` returns a marker; `UNWRAP` gets back the signal | `guardedPath`, `route.ts:253` | `router.path.value` |
| 6 | **sentinels** ×3 — un-internable markers | `sentinel.ts` | a recorder or route read that escaped into a string |
| 7 | **derived-cell memo** — `WeakMap` remembering how a cell was built | `routeMatches`, `route.ts:159` | `router.matches(p)` |

### What the compiler emits

| sink | shape | runtime |
|---|---|---|
| text binding | `TextPart[]` — `literal \| source \| export \| item` | `applyTextBindings` |
| list | template + arena + `keyPath` | `list-runtime.ts` |
| style patch | boolean signal → field writes | `applyStylePatches` |
| editable | signal ↔ node | `typeInto` |
| handler | name (not reactive, same resolution) | `dispatch` |

### The redundancies, named

- **#4 and #5 are the same trick.** Both make `.value` return something that remembers its
  owning signal. One does it for arrays, one for the route, neither for anything else.
- **#7 and `ResolvedRef.expression` are one idea in two places** — `route.ts` remembers
  `{signal, path}`, `resolve-refs.ts:130` rebuilds the comparison from it by hand.
- **`TextPart.source` vs `.export` is a phase smell.** `source` is only valid before
  `resolve-refs`, `export` only after. The type admits both at all times, so every consumer
  handles a state that cannot occur.
- **#5 exists only because the route needed it first.** Once every signal's `.value` records
  (§4.1), `guardedPath`, `UNWRAP`, `RoutePath` and `RouteValueLeakError` all delete.
- **#2 and #3 stay separate on purpose.** A row path and a matcher-bound name mean different
  things at the same call site. `sentinel.ts` already shares their plumbing without merging
  their identity; that is the correct treatment and it is the model for the rest.

---

## 2. The one idea: a `Source`

Every mechanism above produces one of four things. Name that, and the rest collapses.

```ts
/** Where a runtime value comes from. The compiler's only vocabulary for "not known yet". */
export type Source =
  /** A signal, by identity. `{count}` */
  | { kind: "signal"; signal: unknown }
  /** A property path off a signal. `{user.value.name}`, `{items.value.length}` */
  | { kind: "path"; signal: unknown; path: Step[] }
  /** A path into the current row. `{t.title}` inside `.map` */
  | { kind: "item"; path: Step[] }
  /** An expression the artifact contains rather than names. `router.matches("x")` */
  | { kind: "expr"; text: string; deps: unknown[] };

type Step = string | number;
```

Four facts about it:

- **`{kind:"signal"}` is `{kind:"path"}` with an empty path.** They are separate because the
  emitted binding differs — one reads the slot, one calls `readPath` — not because the authoring
  differs.
- **`{kind:"expr"}` is what a value with no name looks like.** `router.matches("x")` today;
  anything derived inline tomorrow. `deps` is what `resolve-refs` must be able to name;
  `text` is what `ui.gen.ts` contains.
- **Every sink takes a `Source`.** Text parts, patch sources, list keys, editables. One shape.
- **One resolver, one error, one leak check.** `resolve-refs` turns any `Source` into an
  emittable form. `describe(source)` produces every diagnostic. Today those are spread across
  three sentinel classes and four call sites in `jsx-runtime.ts`.

`TextPart` becomes two shapes, valid in every phase:

```ts
type TextPart = { literal: string } | { source: Source };
```

`Source` gains a resolved form in place (`{kind:"signal", signal, name?}`) rather than the union
switching shape between phases.

---

## 3. The authoring API — decided

> **In markup, pass the signal. In code, read `.value`. Both work in markup.**

```ts
// state.ts — signals and derived values are module-level exports, always.
export const count  = signal(0);
export const items  = signal<Todo[]>([]);
export const isBig  = computed(() => count.value > 3);
```

```jsx
{count}                                   // identity        → binding
{count.value}                             // path, empty     → binding      (§4.1)
{user.value.name}                         // path            → binding      (§4.1)
{`n is ${count.value}`}                   // literal + path  → binding      (§4.1)
{items.map(row, { key: t => t.id })}      // list
className={cn("box", { big: isBig })}     // patch
bindValue={draft}                         // editable
onClick={submit}                          // handler
```

**Why both forms.** `{count}` is the clean one. `{count.value}` is the explicit one, and readers
who want to see the machinery should not be punished for it. After §4.1 they compile to the same
IR — which is already true for the route, and `bun run signals` proves it byte for byte.

**Why `.value` stays mandatory in a `computed` body.** `computed(() => count * 2)` cannot be
made to work without harm; §7 has the measurement. `tsc` already refuses it at the line.

**What is not in the API.** No `effect()`, no `watch()`, no `untrack()`, no inline `computed()`
in a component (§6). Each would need somewhere to live at run time, and components are erased.

### The rules, and who enforces them

| rule | enforced by | today |
|---|---|---|
| signals and derived values are module-level exports | `resolve-refs`, build error | ✅ |
| `.value` in markup binds | §4.1 | ❌ silently frozen |
| a computed expression cannot be written inline in markup | `tsc` (TS2362/2365/2367) | ✅ |
| a bare signal cannot be coerced | §4.2, build error | ❌ `"[object Object]"` |
| a bare signal cannot be tested for truthiness | **nobody — see §5** | ❌ |

---

## 4. The work

Ordered. Each step lands and is verified by `bun run signals` on its own.

### 4.1 — `.value` records, everywhere

One case, at the door every `.value` read already goes through:

```ts
// src/runtime/signal.ts:253
function readValue<T>(owner: ReadonlySignal<unknown>, current: T): T {
  if (compiling && Array.isArray(current)) return compileTimeArray(owner, current);
  if (compiling && listener === null) return valueRecorder(owner) as unknown as T;
  return current;
}
```

`listener === null` is the discriminator and it already exists: `listener` is non-null exactly
while a `computed` body evaluates (`signal.ts:150-156`). So `computed(() => count.value * 2)` is
untouched, and only a read during component expansion records.

**A recorder, not a marker.** A marker string has a `.length`, so `{items.value.length}` would
silently render `27`. A recording Proxy captures `["length"]`, and property paths come free:
`{user.value.name}`, `{todo.value.done}`.

It carries `owner`, so it produces `{kind:"path", signal, path}` directly — no scope lookup. That
is strictly better than `route.ts`'s marker, which had to ask `currentRoute()` because it had no
identity of its own.

**Deletes:** `guardedPath`, `UNWRAP`, `RoutePath`, `RouteValueLeakError`, `hasRouteSentinel`,
`splitRouteSentinel`, and `sentinel("route")`. The route becomes an ordinary signal.

**Folds in:** `compileTimeArray` becomes the array case of the same recorder — it already carries
`owner` for exactly this reason.

**Cost:** `{count.value * 2}` moves from `text "14"` (silently frozen) to a build error. Real
authoring change; same trade as `{args.id}`.

### 4.2 — a bare signal cannot be coerced

`` `${count}` `` renders `"[object Object]"` today. A template literal *does* call us:

```ts
[Symbol.toPrimitive](hint) {
  throw new SignalCoercionError(hint);   // not: return current
}
```

Throwing rather than returning the value is deliberate. Returning it would make `` `${count}` ``
work while `count === 7` still silently fails — teaching that bare signals are fine in
expressions, which is the opposite of the rule.

### 4.3 — unify on `Source`

Mechanical, once 4.1 lands and the route mechanisms are gone:

- `TextPart` → `{ literal } | { source: Source }`
- `routeMatches` WeakMap → `matches()` returns a cell carrying `{kind:"expr"}`
- `ResolvedRef.expression` → the resolved form of `{kind:"expr"}`
- one `describe(source)` behind every diagnostic
- one leak check, replacing the three in `checkAuthored` and the four in `jsx-runtime.ts`

### 4.4 — `args.id` becomes a binding

The last recorder that records and never emits. `{kind:"item"}` has a sibling — a matcher-bound
name — and once `Source` exists it is a fifth kind rather than a fourth bespoke mechanism.
Needs the route matcher, which is separate work.

---

## 5. What stays broken, and why that is the floor

```jsx
count ? a : b        // ✗ always truthy — ToBoolean calls nothing
!count               // ✗ always false
count.value ? a : b  // ✓ correct and reactive today
!count.value         // ✓ correct and reactive today
```

`ToBoolean` invokes no user code, and TypeScript has no flag for truthiness on an object. Two
forms, no defence, `.value` fixes both. This is the honest floor of an evaluation-based compiler
and it goes in API.md as the one rule the compiler cannot enforce.

---

## 6. Deliberately excluded

**Inline `computed()` in a component.** `{computed(() => count.value === 7)}` fails at
`resolve-refs` — the cell has no export name. `Function.prototype.toString()` survives Bun's TSX
transform intact (verified), so the author's own text could be emitted, which is `matches()`
generalised. Excluded because free variables that are not signals produce a `tsc` error pointing
at generated code. Revisit after §4.3, when `{kind:"expr"}` makes it a two-line change.

**A source transform.** The only way to make `{count.value === 7}` reactive, and a *boundary*
decision rather than a work item:

```jsx
{count.value === 7}                     // reactive, with a parser
const x = count.value === 7;  …  {x}    // frozen, silently
```

Reactive-in-a-brace but frozen-in-a-`const` is a worse rule than today's uniform "always frozen,
and refused where visible". Svelte is the only version that does not lie, and it works by
rewriting every read in the file — incompatible with cross-module signals in the same way
Svelte 5 cannot do `export let count = $state(0)`. Nothing in §4 has to be undone if this is
taken up later.

---

## 7. Decided: `computed(() => count * 2)` will not be supported

`Symbol.toPrimitive` makes it work at run time — measured:

```
count * 2     7->100   14 -> 200      reactive
count > 3     7->1     true -> false  reactive
`${count}`    7->1     7 -> 1         reactive
```

But `tsc` does not consult `Symbol.toPrimitive` for arithmetic. `Signal<number> * 2` stays
`TS2362` regardless of run-time behaviour. For the *line to compile*, `Signal<number>` must be
structurally a number:

```ts
type Signal<T> = T & { subscribe(…): …; … }
```

which reopens the hole currently closed:

```ts
count === 7   // number & {…} IS comparable to 7 → type-checks → false, for ever
```

Same trap as the branded `RoutePath`, found the same way: TypeScript treats an intersection
containing `number` as comparable to a number literal. **Making `count * 2` type-check
necessarily makes `count === 7` type-check.** Today both are errors at the line.

Both caught beats one convenience and one silent lie.

> Reversible: widen `Signal<T>` and add `Symbol.toPrimitive`. Everything else here is unaffected,
> but §4.2 changes meaning and `===` needs a different defence.

### What everyone else does

| library | the read | derived deps |
|---|---|---|
| Solid | `count()` | auto, by running |
| TanStack Store 0.11 | `count.get()` | auto, by running |
| Preact signals | `count.value` | auto, by running |
| Svelte 5 | `count` | auto — compiler rewrites every read in the file |

Verified against `@tanstack/store@0.11.0`: `createAtom(7)` for state,
`createAtom(() => count.get() * 2)` for derived, read via `.get()`. The explicit-deps
`Derived({ deps, fn })` API is gone.

Svelte is the only one where a bare signal works in an expression, and it pays by having no brace
boundary at all. Nobody makes coercion carry it.

---

## 8. Verification

`bun run signals` is the measure. Target:

```
  {count}                  bind  bind    source signal count
  {count.value}            bind  bind    source signal count             ← 4.1
  {label.value}            bind  bind    source signal label             ← 4.1
  {isBig.value}            bind  bind    source signal isBig             ← 4.1
  `n is ${count.value}`    bind  bind    "n is " + source signal count   ← 4.1
  {items.value.length}     bind  bind    source path items.length        ← 4.1
  {count.value * 2}        error error   SignalExpressionError           ← 4.1, deliberate
  `${count}`               error error   SignalCoercionError             ← 4.2
```

Plus the full sweep, all green: `bun test`, `check`, `window`, `golden`, `characterize`,
`boundary-diff`, `conformance`, `runtime-surface`, `protocol-guard`, `doc-lint`.

`golden` matters most — the demo's `{router.path}` and `` {`currently at ${router.path.value}`} ``
must render identical pixels, since §4.1 changes how both are produced.

### Measurements this rests on

Each was run, not assumed:

- `bun run signals` — 9 of 20 forms wrong; 5 silent.
- `Symbol.toPrimitive` makes `count * 2`, `count > 3`, `` `${count}` `` reactive inside a
  `computed` — and does **not** make them type-check.
- `tsc` already refuses `count * 2` / `> 3` / `+ 1` / `=== 7`. It does not refuse truthiness,
  negation, or template interpolation.
- `count.value ? a : b` and `!count.value` are correct and reactive today.
- `Function.prototype.toString()` survives Bun's `.tsx` transform, type annotations stripped.
- `@tanstack/store@0.11.0` auto-tracks and reads via `.get()`.
- Six `Symbol.for("skia-proto.*")` brands exist; `setCompiling` has two callers; `TextPart` has
  four shapes of which two are phase-exclusive.
