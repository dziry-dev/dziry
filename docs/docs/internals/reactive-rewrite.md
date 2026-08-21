---
title: The reactive rewrite
sidebar_position: 2
---

# The reactive rewrite

Why `count * 2` works when `count` is a signal, and what it costs.

## The problem

A signal has to be an object — it needs identity, subscribers, and a place to put the
current value. But authoring wants it to behave as its value:

```ts no-check
count * 2         // NaN, if count is an object
count === 3       // false, for ever
`at ${count}`     // "at [object Object]"
count ? a : b     // always the first branch
```

The usual answer is `.value` everywhere, or a proxy with `Symbol.toPrimitive`. dziry
does neither.

## The answer: rewrite the source

A Bun plugin rewrites your modules before they are transpiled. Every identifier read
becomes a call to `$`:

```ts no-check
// You write
const doubled = computed(() => count * 2);

// It compiles to
const doubled = computed(() => $(count) * 2);
```

`$` unwraps a signal and passes everything else through:

```ts no-check
export function $<T>(value: T) {
  if (isSignal(value)) return value.value;
  return value;
}
```

## Why this is decided at run time

That predicate is the whole design. The transform rewrites every identifier it sees
**without knowing which ones are signals** — and it cannot know, because that would
need type information and a resolved module graph.

Deciding at run time means the transform needs neither. No types, no scope analysis, no
module resolution. It is a syntactic rewrite.

Which makes over-rewriting *safe* rather than merely tolerable:

```ts no-check
todos.filter((t) => $(t).done);
```

`$(t)` returns `t`, because `t` is a plain parameter and that is the binding in scope.
A parameter shadowing a module-level signal resolves to the parameter, correctly. The
cost of a read that was never a signal is one predicate.

## Member expressions are the non-obvious case

A plain `$` would break writes:

```ts no-check
count.set(5);       // $(count).set(5)  ->  (0).set(5)  ->  crash
```

Unwrapping is exactly wrong when the property belongs to the *signal* rather than to
its value. So member reads use `$m`, which decides on the key:

```ts no-check
count.set(5); // -> the signal   (set is the signal's)
todos.filter(fn); // -> the array    (filter is the value's)
user.name; // -> the object   (name is the value's)
```

The signal-owned keys are `set`, `subscribe`, `value` and `peek`. Everything else
resolves to the value.

`map` deliberately resolves to the **value**, not the signal. During compilation a
signal's array is handed out as a recording proxy whose `map` builds a dynamic list
when given a key and behaves as `Array.prototype.map` otherwise. Routing `map` through
the signal would take that decision away from the one place with enough context to make
it.

## The type side

The rewrite makes the code *work*. It does not make it *type-check*, and a framework
that told you to write something `tsc` rejects is the worst of both.

So `Signal<T>` is declared as `T & Ops<T>` — the value's type, intersected with the
signal's methods.

That intersection was rejected once, for a real reason: an intersection containing
`number` is comparable to a number literal, so `count === 7` would type-check and be
`false` for ever. The transform is what changes the answer — `$(count) === 7` is simply
correct — so the type is no longer promising something the runtime fails to deliver.

That dependency runs one way and is worth stating plainly: **the type is only honest
where the rewrite runs.** Under `windows/`, it does. In framework code it does not,
which is why `Ops` still carries `.value` and why `src/` reads through it.

## Collecting reads

An inline expression in JSX reaches the generated artifact as *text*, and every signal
named in that text needs an import. `computed` already tracks dependencies — but only
well enough to invalidate: a signal adds the listener to its own subscribers and never
reports itself, so there is no list to read back.

`$` is the one door every rewritten read passes through, so it is the only place that
can answer. `collectReads(fn)` turns on collection, runs the expression, and returns the
set.

That is also why an inline expression can only name **module exports**: the artifact has
to import each signal by name, and a local has none.

## What this does not fix

The rewrite makes reads work. It does not make a `computed` created inside a component
placeable, it does not give a local a name, and it does not make an item template
capable of holding a conditional. Those all come from the same deeper constraint —
components are erased, so anything the runtime reaches must have a name at build time.

## Verifying it

```bash
bun test src/compiler/reactive-transform.test.ts
bun test src/compiler/reactive-runtime.test.ts
bun run characterize      # compiled output frozen as goldens
```

`characterize` is the one that matters when changing the transform: it freezes the
compiler's output so a refactor is provably behaviour-preserving.
