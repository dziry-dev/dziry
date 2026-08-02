# Closing reactivity

**Status:** plan. Nothing here is built yet.
**Measured by:** `bun run signals` — every claim below is a row in that table.
**Written:** 2026-08-02.

The rule today is *"pass the signal, never its value"*, and it is enforced by the author
remembering it. Where it is forgotten, the page renders a value from build time, once,
correctly, and never again — while the build prints a success line. That is the failure this
project treats as worse than a crash, and it is the last place it still happens.

This plan closes it. It is deliberately not a proposal to build a parser; §5 explains why the
parser is a separate decision that this plan does not depend on.

---

## 1. What is actually broken

Two surfaces, and they fail for different reasons. Keeping them apart is most of the work.

### Surface A — a signal read in markup

`bun run signals` today:

```
  form                      want    got     compiles to
! {count.value}             bind    static  text "7"
! {label.value}             bind    static  text "hi"
! {isBig.value}             bind    static  (nothing)
! `n is ${count.value}`     bind    static  text "n is 7"
! {items.value.length}      bind    static  text "2"
```

Five forms, all silent. `{label.value}` renders `"hi"` — completely plausible. `{isBig.value}`
renders **nothing at all**, because a frozen boolean is a boolean and JSX drops booleans.

`{router.path.value}` is the same shape and already works, via the marker in `route.ts`'s
`guardedPath`. That fix was applied to one Proxy around one signal, so nothing else got it.

### Surface B — a bare signal inside a `computed` body

`tsc` already refuses most of these, which is better than it sounds:

| form | today | verdict |
|---|---|---|
| `count * 2` | `TS2362` at the line | **caught** |
| `count > 3` | `TS2365` at the line | **caught** |
| `count + 1` | `TS2365` at the line | **caught** |
| `count === 7` | `TS2367` at the line | **caught** |
| `` `${name}` `` | renders `"[object Object]"` | **silent** |
| `count ? a : b` | always truthy | **silent** |
| `!count` | always `false` | **silent** |

Three holes, not seven. And `.value` fixes all three:
`` `${name.value}` ``, `count.value ? a : b`, `!count.value` are each correct and reactive today
(verified — see §6).

---

## 2. The thing to decide first: should `count * 2` work?

You asked for both `computed(() => count.value * 2)` and `computed(() => count * 2)`.

The first works today. **My recommendation is not to make the second work**, and the reason is
specific rather than a matter of taste.

At runtime, `Symbol.toPrimitive` on the signal makes it work — measured, it does:

```
  count * 2       7->100   14 -> 200   reactive
  count > 3       7->1     true -> false   reactive
  `${count}`      7->1     7 -> 1      reactive
```

But `tsc` does not consult `Symbol.toPrimitive` for arithmetic. `Signal<number> * 2` stays
`TS2362` no matter what the object does at run time. To make the *type* allow it,
`Signal<number>` would have to be structurally a number:

```ts
type Signal<T> = T & { subscribe(...): ...; ... }   // what it would take
```

And that reopens the hole that is currently closed:

```ts
count === 7   // Signal<number> = number & {…}  →  comparable to 7  →  type-checks
              //                                 →  object === number  →  false, for ever
```

This is the same trap as the branded `RoutePath`, found the same way. TypeScript treats an
intersection containing `number` as comparable to a number literal, so making `count * 2`
type-check *necessarily* makes `count === 7` type-check, and `===` is the one operator no
runtime trick reaches.

**So the trade is: `count * 2` works, in exchange for `count === 7` silently always being
false.** Today `count * 2` is a clear error at the line and `count === 7` is also a clear error
at the line. Both caught beats one convenience and one silent lie.

`.value` stays mandatory inside a `computed` body, and `tsc` is what enforces it. That is not a
compromise — it is the better of the two positions.

> If you disagree, the change is small and reversible: widen `Signal<T>` to `T & {…}` and add
> `Symbol.toPrimitive`. Everything else in this plan is unaffected. But **§4.3 becomes
> mandatory** rather than optional, because `===` would need a different defence.

---

## 3. What the industry does, and why it matters here

Every library that solved this made the read **syntactically explicit**:

| library | the read | derived deps |
|---|---|---|
| Solid | `count()` | auto, by running |
| TanStack Store 0.11 | `count.get()` | auto, by running |
| Preact signals | `count.value` | auto, by running |
| Svelte 5 | `count` | auto — but the compiler rewrites **every read in the file** |

Verified against `@tanstack/store@0.11.0`: `createAtom(7)` for state,
`createAtom(() => count.get() * 2)` for derived, auto-tracked, read via `.get()`. The earlier
explicit-deps `Derived({ deps, fn })` API is gone.

Svelte is the only one where a bare `count` works in an expression, and it pays for it by owning
the whole file. Nobody makes a bare object work in arithmetic via coercion, and this is why —
it buys three operators and loses `===`.

dziri's `.value` is the Preact position. The plan keeps it, and makes it work in the one place it
currently does not.

---

## 4. The work

Ordered. Each step is independently landable and independently verifiable by `bun run signals`.

### 4.1 — `.value` in markup becomes a binding *(closes 5 of 5 in Surface A)*

Every `.value` read already funnels through one function, which already returns something else
at build time:

```ts
// src/runtime/signal.ts:253
function readValue<T>(owner: ReadonlySignal<unknown>, current: T): T {
  if (compiling && Array.isArray(current)) return compileTimeArray(owner, current);
  return current;
}
```

Add the case for a bare read:

```ts
function readValue<T>(owner: ReadonlySignal<unknown>, current: T): T {
  if (compiling && Array.isArray(current)) return compileTimeArray(owner, current);
  if (compiling && listener === null) return valueRecorder(owner) as unknown as T;
  return current;
}
```

`listener === null` is the discriminator, and it is already there: `listener` is non-null exactly
while a `computed` body evaluates (`signal.ts:150-156`). So `computed(() => count.value * 2)`
keeps receiving real numbers, untouched, and only a read during component expansion is recorded.

**A recorder, not a marker.** A marker string has a `.length`, so `{items.value.length}` would
silently render `27`. A recording Proxy captures `["length"]` and property paths come free:

```
{items.value.length}   records ["length"]   ✓
{user.value.name}      records ["name"]     ✓
{todo.value.done}      records ["done"]     ✓
```

That is `src/compiler/item-path.ts`'s recorder pointed at a signal instead of a row, and it
carries `owner`, so the binding knows its signal by identity with no scope lookup — better than
`route.ts`'s marker, which had to ask `currentRoute()` because it had none.

**Emit:** a recorded read becomes a `TextPart`. `{ source }` for a bare read; a new
`{ source, path }` for a property path, which the runtime resolves with `readPath` — the function
`list-runtime.ts` already owns and already uses for exactly this.

**Known cost.** `{count.value * 2}` moves from `text "14"` (silently frozen) to a build error.
That is a real authoring change: the expression has to move to `state.ts` as
`computed(() => count.value * 2)`. Same trade as `{args.id}` today, and the same reason.

**Also fold in:** `route.ts`'s `guardedPath` and `RoutePath` should collapse into this. The route
becomes an ordinary signal once every signal behaves this way, and `RouteValueLeakError`
generalises to all of them.

### 4.2 — the three silent holes for a bare signal *(closes 1 of 3 loudly, documents 2)*

`` `${count}` `` → `"[object Object]"` is fixable, because a template literal *does* call us:

```ts
[Symbol.toPrimitive](hint) {
  // A bare signal in a template literal is never what was meant — `.value` is one
  // character away and correct. Coercion is the only notice JavaScript gives us, so
  // it is where this has to be caught.
  throw new SignalCoercionError(hint);
}
```

Note this **throws** rather than returning the value. Returning it would make
`` `${count}` `` work and `count === 7` still fail — a worse state than either, because it
teaches that bare signals are fine in expressions.

`count ? a : b` and `!count` cannot be caught. `ToBoolean` calls nothing, and TypeScript has no
flag for truthiness on an object. They stay open, and this is the honest floor of the
evaluation-based approach:

```ts
count ? a : b     // ✗ always truthy, no defence exists
count.value ? a : b   // ✓ correct and reactive today
```

Documented in API.md as the one rule the compiler cannot enforce. It is a narrow surface — two
forms — and `.value` is the fix for both.

### 4.3 — *(optional; mandatory if §2 is overruled)* inline `computed()`

`{computed(() => count.value === 7)}` fails today at `resolve-refs`, not at JSX:

```
~ {computed(() => count.value === 7)}  bind  error
    resolve-refs: a signal interpolated into node 0 is not a module-level export
```

The binding holds a `computed` created inside a component, and `ui.gen.ts` can only contain a
name. But `Function.prototype.toString()` survives Bun's TSX transform intact — verified:

```
() => count.value === 3
() => count.value > 3 ? "big" : "small"
() => `${label.value}: ${count.value * 2}`
```

So the author supplies the function and `toString()` supplies the text. Dependencies come from
running it (already do). This is `matches()` generalised — `resolve-refs.ts:130` hand-assembles
`computed(() => route.value === "layout")` today; here there is nothing to assemble.

**Open problem:** free variables that are not signals.

```jsx
const threshold = 3;
{computed(() => count.value > threshold)}
// emits into ui.gen.ts → tsc: "Cannot find name 'threshold'"
```

Caught by `bun run check`, but the error points at generated code. Fixable by inlining primitive
constants, or by a cheap identifier scan. Also breaks under minification — does not apply (dziri
compiles from source) but worth writing down.

---

## 5. Why this plan does not include a parser

A source transform is the only way to make `{count.value === 7}` reactive, and it is a separate
decision for one reason: the boundary.

```jsx
{count.value === 7}                          // reactive, with a parser
const x = count.value === 7;  …  {x}         // frozen, silently
```

Reactive-in-a-brace but frozen-in-a-`const` is a *worse* rule than today's, which is uniform:
build-time reads are always frozen, and the compiler refuses the ones it can see. Half-reactivity
that depends on where you typed the expression is precisely the plausible-looking-wrong-answer
failure this codebase is organised against.

Svelte is the only version of this that does not lie, and it works because the compiler rewrites
every read in the file — no brace boundary exists. That is the biggest possible version of the
change, and it is incompatible with dziri's cross-module signals (`state.ts` exports, artifact
imports by name) in the same way Svelte 5 cannot do `export let count = $state(0)`.

Everything in §4 is worth doing whether or not that decision is ever taken, and none of it has to
be undone if it is.

---

## 6. Verification

`bun run signals` is the measure. Target state:

```
  {count}                  bind  bind    dyntext signal count
  {count.value}            bind  bind    dyntext signal count          ← 4.1
  {label.value}            bind  bind    dyntext signal label          ← 4.1
  {isBig.value}            bind  bind    dyntext signal isBig          ← 4.1
  `n is ${count.value}`    bind  bind    dyntext "n is " + signal count ← 4.1
  {items.value.length}     bind  bind    dyntext signal items.length   ← 4.1
  {count.value * 2}        error error   SignalExpressionError         ← 4.1, deliberate
  `${count}`               error error   SignalCoercionError           ← 4.2
```

Plus the existing sweep, all of which must stay green: `bun test`, `check`, `window`, `golden`,
`characterize`, `boundary-diff`, `conformance`, `runtime-surface`, `protocol-guard`, `doc-lint`.

`golden` is the one that matters most here — the demo's `{router.path}` and
`{`currently at ${router.path.value}`}` must render identical pixels before and after, since
§4.1 changes how both are produced.

### Measurements this plan rests on

Each was run, not assumed:

- `bun run signals` — 9 of 20 forms wrong, 5 of them silent.
- `Symbol.toPrimitive` does make `count * 2`, `count > 3`, `` `${count}` `` reactive inside a
  `computed` — and does not make them type-check.
- `tsc` already refuses `count * 2` / `> 3` / `+ 1` / `=== 7`; it does not refuse truthiness,
  negation, or template interpolation.
- `count.value ? a : b` and `!count.value` are correct and reactive today.
- `Function.prototype.toString()` survives Bun's `.tsx` transform, type annotations stripped.
- `@tanstack/store@0.11.0` auto-tracks and reads via `.get()`; explicit-deps `Derived` is gone.
