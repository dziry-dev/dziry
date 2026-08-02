---
title: Lists
sidebar_position: 6
---

# Lists

Lists are the answer to the obvious objection: if the tree is decided at build time,
how does anything dynamic work?

## The shape

```tsx no-check
{
  todos.map((t) => <Row title={t.title} mark={t.mark} />, { key: (t) => t.id });
}
```

`key` is required.

## What actually happens

The callback runs **once**, at build time, with a *recording proxy* instead of a real
item. Reading `t.title` does not produce a value — it produces a path. What gets
compiled is a template plus an arena of item slots, and the runtime fills slots by
reading those paths out of your array.

So a list of 500 rows does not build 500 trees. It builds one template, materializes
some slots, and writes text and style values into them.

Adding, removing and reordering items splices slots. Nodes are never renumbered, which
is why the engine can keep holding indices into the same tables.

## Why the key is required

The runtime has to know which slot holds which item in order to update the right one,
and to move a slot rather than rebuild it when the array reorders. There is no tree to
diff, so identity cannot be inferred from position.

## The restriction that follows

Because the callback runs once with a proxy, **an item template cannot contain a
conditional**:

```tsx no-check
// Wrong. The proxy is always truthy, so every row takes the first branch.
todos.map((t) => <div>{t.done ? "x" : " "}</div>, { key: (t) => t.id });
```

Nothing throws. Every row renders the same thing, which is exactly the kind of quiet
wrongness that is worse than a crash.

Anything conditional per row has to be **data**. Compute it where real values exist:

```ts no-check
export const view = computed(() =>
  todos.map((t) => ({
    ...t,
    mark: t.done ? "[x]" : "[ ]",
  })),
);
```

Then the template just reads `t.mark`.

Note that this inner `.map` takes no `key`, so it is an ordinary build-time map over
real values. That distinction is deliberate: only a **keyed** call means "compile a
dynamic list", because `computed` bodies legitimately map over a signal's array and
hijacking those would turn derived data into a compile error.

## Per-row handlers

One compiled handler serves every row. It receives the item that row is currently
rendering:

```ts no-check
export function toggleDone(item: Todo): void {
  todos.set((ts) => ts.map((t) => (t.id === item.id ? { ...t, done: !t.done } : t)));
}

export function deleteTodo(item: Todo): void {
  todos.set((ts) => ts.filter((t) => t.id !== item.id));
}
```

The runtime turns the clicked node back into a (slot, offset) pair, then looks up which
item that slot holds.

## Snapshotting on purpose

To take the static path deliberately, copy the array first:

```ts no-check
const frozen = [...todos].map((t) => t.title);
```

A plain array has an ordinary `.map`, so this compiles the values in rather than
building a live list.

## Capacity

`.map` accepts a `capacity` alongside `key`. It is the number of item slots to
materialize up front, and it defaults to headroom over the initial length. Exceeding
it grows the arena rather than truncating, so it is a tuning knob, not a limit.
