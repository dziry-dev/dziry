---
title: Reactivity
sidebar_position: 1
---

# Reactivity

State in Dziry is built from two primitives: `signal` holds a value, and
`computed` derives one. Reads are plain identifiers, writes go through `.set`,
and updates reach the screen as direct memory writes rather than re-renders.

## Reading a signal

A signal is read by naming it. There is no `.value` and no dependency array:

```ts
const count = signal(0);

const doubled = computed(() => count * 2);
const isBig = computed(() => count > 5);
const isThree = computed(() => count === 3);
const parity = computed(() => (count % 2 === 0 ? "even" : "odd"));
const shout = computed(() => `count is ${count}!`);
```

Arithmetic, comparison, `===`, ternaries and template literals all work. At
build time, Dziry rewrites each identifier read into a call — `count * 2`
becomes `$(count) * 2` — where `$` unwraps a signal and passes any other value
through unchanged. Because `$` decides at run time, the rewrite needs no type
information and is safe to apply everywhere: `$(t)` on a plain parameter simply
returns it.

On the type level, `Signal<T>` is declared as `T & Ops<T>`, so the same
expressions type-check.

:::note[Where the rewrite applies]

The rewrite runs on your code, under `windows/`. It does not run on the
framework's own modules — that is where `$` is defined — so you may see
`.value` inside Dziry's source. You will not need it in yours.
:::

## Writing a signal

```ts
const count = signal(0);

count.set(5);
count.set((n) => n + 1);
```

`.set` takes a value or a function of the previous value. Reads work inside
handlers too, so `count.set(count + 1)` is valid.

Method calls resolve to the right owner automatically: `.set`, `.subscribe`,
`.value` and `.peek` belong to the signal; everything else — `.filter`,
`.length`, `.trim` — belongs to its value.

```ts
const todos = signal<{ done: boolean }[]>([]);
const draft = signal("");

todos.filter((t) => !t.done); // the array's filter
draft.trim(); // the string's trim
todos.set([]); // the signal's set
```

## Signals in markup

```tsx no-check
<div>{count}</div>          // a signal, bound by identity
<div>{doubled}</div>        // a computed is a signal too
<div>{`at ${count}`}</div>  // an expression — see below
```

A JSX brace holding a **lone signal** is resolved by identity. A brace holding
an **expression** is compiled into a cell, and a cell reaches the generated
module as source text — so it can only refer to module exports.

This means a local variable cannot appear inside an inline expression. The
build reports it as an error naming the export to use instead:

```tsx no-check
{`at ${router.path}`}   // build error: router is not a module export
```

while the identity form compiles:

```tsx no-check
{router.path}
```

To interpolate, declare a `computed` in the module and reference that.

## Where state lives

Signals and handlers are normally module-level exports, so the compiler can
name them in the generated module. `{draft}` in JSX passes the signal object
itself, and the compiler maps it back to the export it came from.

```ts title="windows/main/state.ts" no-check
import { computed, signal } from "dziry";

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

The compiler registers the signal in a slot, declares it in the generated
module, and rewrites the inline arrows to use that slot. Because the component
body runs once — at build time — the signal is created once by construction;
there is no render cycle that could recreate it.

Two consequences: component-local state needs no state module, and it cannot
be shared — it belongs to this component alone.

## Derived state must be exported

A `computed()` created inside a component cannot be compiled: the generated
module imports every cell by name, and an anonymous computed has no name.
Declare derived state in a module, next to the signals it derives from:

```ts no-check
// In the window's module, not in a component.
export const onNewProduct = computed(() => route === "products/new");
```

This is a compiler constraint, not a style preference — the build error says
so when you hit it.

## Batching

```ts
const first = signal("");
const last = signal("");

batch(() => {
  first.set("Ada");
  last.set("Lovelace");
});
```

`batch` groups writes so subscribers run once at the end instead of once per
write. A single event handler already produces a single repaint; reach for
`batch` when making several related writes outside one.

## Update cost

A signal write is not a render. It is a small number of integer writes into
the style or text tables, followed by a repaint of the affected region. There
is no tree to walk, no diff, and no selector to re-match.

## See also

- **[Signals reference](../../reference/signals.mdx)** — `signal`, `computed`, `effect`, `batch`, `source`, `resource`, and the rest of the runtime API.
- **[The reactive rewrite](../../architecture/reactive-rewrite.md)** — how the identifier rewrite works.
