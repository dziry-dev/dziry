---
title: Lists
sidebar_position: 4
---

# Lists

A dynamic list is a keyed `.map` over a signal's array:

```tsx no-check
{
  todos.map((t) => <Row title={t.title} mark={t.mark} />, { key: (t) => t.id });
}
```

`key` is required.

## How a list compiles

The callback runs once, at build time, with a *recording proxy* in place of a
real item. Reading `t.title` records a path rather than producing a value.
What comes out is one template plus an arena of item slots; at run time, the
slots are filled by reading those paths out of your actual array.

A list of 500 rows therefore does not build 500 trees. It builds one template,
materializes slots, and writes text and style values into them. Adding,
removing and reordering items splices slots — nodes are never renumbered, so
the engine keeps holding stable indices into the same tables.

## Why `key` is required

The runtime needs to know which slot holds which item, both to update the
right one and to move a slot instead of rebuilding it when the array reorders.
There is no tree diff to infer identity from position.

## No conditionals in templates

Because the callback runs once with a proxy, an item template cannot contain a
conditional:

```tsx no-check
// Wrong: the proxy is always truthy, so every row takes the first branch.
todos.map((t) => <div>{t.done ? "x" : " "}</div>, { key: (t) => t.id });
```

This does not throw — every row renders the first branch, permanently.

Anything that varies per row must be expressed as **data**. Compute it where
real values exist:

```ts no-check
export const view = computed(() =>
  todos.map((t) => ({
    ...t,
    mark: t.done ? "[x]" : "[ ]",
  })),
);
```

The template then reads `t.mark` like any other property.

Note that the inner `.map` above takes no `key`, so it is an ordinary
build-time map over real values. Only a keyed call means "compile a dynamic
list" — `computed` bodies routinely map over arrays, and treating those as
list templates would turn derived data into a compile error.

## Per-row handlers

One compiled handler serves every row and receives the item that row currently
renders:

```ts no-check
export function toggleDone(item: Todo): void {
  todos.set((ts) => ts.map((t) => (t.id === item.id ? { ...t, done: !t.done } : t)));
}

export function deleteTodo(item: Todo): void {
  todos.set((ts) => ts.filter((t) => t.id !== item.id));
}
```

The runtime resolves the clicked node back to its slot, then looks up which
item the slot holds.

## Static snapshots

To render an array's current values without creating a live list, copy the
array first:

```ts no-check
const frozen = [...todos].map((t) => t.title);
```

A plain array has an ordinary `.map`, so the values are compiled in.

## Capacity

`.map` accepts a `capacity` option alongside `key`: the number of item slots
to materialize up front, defaulting to headroom over the initial length.
Exceeding it grows the arena rather than truncating — it is a tuning knob, not
a limit.
