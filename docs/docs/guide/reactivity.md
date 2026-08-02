---
title: Reactivity
sidebar_position: 4
---

# Reactivity

Five things: `signal`, `computed`, `.set`, `.map`, `cn`. And a read is just the name.

## A read is the identifier

```ts
const count = signal(0);

const doubled = computed(() => count * 2);
const isBig = computed(() => count > 5);
const isThree = computed(() => count === 3);
const parity = computed(() => (count % 2 === 0 ? "even" : "odd"));
const shout = computed(() => `count is ${count}!`);
```

Every one of these was broken before the build-time rewrite landed. `===` compared a
signal object to a number and was false for ever; a ternary saw an object and was
always truthy; a template literal printed `[object Object]`.

Now `count * 2` is compiled to `$(count) * 2`. `$` unwraps a signal and passes
everything else through, and it decides **at run time** — which is why the transform
needs no type information, no module graph and no scope analysis. Over-rewriting is
harmless: `$(t)` where `t` is a plain parameter returns `t`.

The type side matches. `Signal<T>` is `T & Ops<T>`, so `count * 2` also type-checks.

:::note Where the rewrite runs

On your code, under `windows/`. **Not** on the framework's own modules under `src/` —
that is where `$` is defined. So you will see `.value` inside the framework and should
never need it in your own code.
:::

## Writes

```ts
const count = signal(0);

count.set(5);
count.set((n) => n + 1);
```

One method, taking a value or a function of the previous one. Reads work in handlers
too, so `count.set(count + 1)` is fine.

Method calls on a signal resolve correctly without you thinking about it: `.set`,
`.subscribe`, `.value` and `.peek` belong to the *signal*, while `.filter`, `.length`,
`.trim` and the rest belong to its value.

```ts
const todos = signal<{ done: boolean }[]>([]);
const draft = signal("");

todos.filter((t) => !t.done); // the array's filter
draft.trim(); // the string's trim
todos.set([]); // the signal's set
```

## In markup

```tsx no-check
<div>{count}</div>          // the signal itself, by identity
<div>{doubled}</div>        // a computed is a signal too
<div>{`at ${count}`}</div>  // an expression — see below
```

There is one rule worth knowing. A brace holding a **lone signal** is resolved by
identity. A brace holding an **expression** is compiled into a cell, and a cell reaches
the generated module as text — so it can only name module exports.

That means a local cannot be written into an inline expression. This is a build error
naming the export you should have used:

```tsx no-check
{`at ${router.path}`}
```

while this compiles fine, by identity:

```tsx no-check
{router.path}
```

If you want the interpolated version, declare it as a `computed` in the module and
interpolate that.

## Where state lives

Signals and handlers are normally module-level exports, so the compiler can name them.
`{draft}` in JSX passes the signal object itself, and the compiler reverse-maps it to
the export it came from.

```ts title="windows/main/state.ts" no-check
import { computed, signal } from "dziri";

export const draft = signal("");
export const todos = signal<Todo[]>([]);

export const remaining = computed(() => todos.filter((t) => !t.done).length);

export function addTodo(): void {
  const title = draft.trim();
  if (title === "") return;
  todos.set([...todos, { id: nextId++, title, done: false }]);
  draft.set("");
}
```

## Component-local state

State that belongs to one component can be declared where it is used:

```tsx no-check
function LocalCounter() {
  const n = signal(0);

  return (
    <div>
      <div>{n}</div>
      <button onClick={() => n.set(n - 1)}>−</button>
      <button onClick={() => n.set(n + 1)}>+</button>
    </div>
  );
}
```

This works even though the artifact can only hold names. The compiler registers the
signal and declares `const locals = [signal(0)]` in the generated module, then rewrites
the inline arrow with `n` substituted for its registry slot.

There is no render and no unmount here — the component body runs **once**, at build
time — so "created once" comes for free. The only missing piece was a name, and the
registry supplies it.

Two consequences follow. It needs no state module, and it cannot be shared: this
component's state is its own. Rendering the component twice is not a thing that
happens, because there is no run-time rendering.

## Derived state must be named

A `computed()` created inside a component has nowhere to live: the generated module
imports every cell by name, and an anonymous one has no name. Declare it beside the
signal it derives from.

```ts no-check
// In the window's module, not in a component.
export const onNewProduct = computed(() => route === "products/new");
```

This is a constraint the compiler imposes, not a style preference.

## Batching

```ts
const first = signal("");
const last = signal("");

batch(() => {
  first.set("Ada");
  last.set("Lovelace");
});
```

Subscribers run once at the end rather than once per write. A single event handler
already produces one repaint; `batch` is for when you are making several related
writes from elsewhere.

## What this costs

A change to a signal is not a render. It is a small number of integer writes into the
style or text tables, followed by a repaint of what changed. There is no tree to walk,
no diff, and no selector to re-match.

An idle frame costs nothing at all.
