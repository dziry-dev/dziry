---
title: What is Dziry?
sidebar_position: 1
---

# What is Dziry?

Dziry is a framework for building desktop applications in TypeScript, HTML and
CSS. It looks like a web framework when you write it, but it does not run in a
browser: your code is compiled ahead of time, and a native engine — Rust, with
Skia for painting and Taffy for layout — draws the window.

If you want a desktop app with the authoring experience of the web and none of
its runtime, Dziry is for you. If you need a document renderer — arbitrary
HTML from the network, floats, print — it is not: Dziry renders applications,
not documents.

## The compilation model

Most UI frameworks do their work while the app runs: build a tree, diff it,
match selectors, resolve the cascade, lay out boxes. Dziry does that work once,
on your machine, before the app ships.

When you build, the compiler imports your modules. That import runs your
components — once. The tree they return is compiled: selectors are matched,
specificity is sorted, inheritance is applied, shorthands are expanded, units
are converted. The result is a set of numbers, written out as a TypeScript
module of typed arrays.

At run time, the engine reads those arrays and draws. It never parses CSS,
never matches a selector, and never sees your components — by then they no
longer exist.

## What this means for your code

Because components are gone before the app runs, one rule governs almost every
constraint you will meet:

> Anything the runtime reaches by name must have a name at build time.

In practice:

- Signals and handlers are usually module-level exports, because the generated
  module imports them by name. (Component-local `signal()` also works — the
  compiler registers it in a slot. See [Reactivity](../concepts/reactivity.md).)
- An inline `style` value must be static. A signal there is a build error,
  because there is no component left to re-run when it changes.
- A list item template cannot contain a conditional, because the template is
  compiled once and reused for every row. Per-row differences are expressed as
  data. See [Lists](../concepts/lists.md).

These constraints are checked at build time, and the errors name what to do
instead.

## Reading state

The one place Dziry asks nothing of you is reading state:

```tsx
const count = signal(0);
const doubled = computed(() => count * 2);            // no .value
const parity = computed(() => (count % 2 === 0 ? "even" : "odd"));
```

`count * 2`, `===`, ternaries, and template literals all work on signals
directly. A build-time rewrite turns `count * 2` into `$(count) * 2`, where
`$` unwraps a signal and passes any other value through. `Signal<T>` is typed
as `T & Ops<T>`, so the same expression also type-checks.

The rewrite runs on your code, under `windows/`. It does not run on the
framework's own modules, which is why you may see `.value` inside Dziry's
source and will not need it in yours.

## Performance

A signal write is not a render. It is a small number of integer writes into
shared memory, followed by a repaint of what changed. There is no tree to walk,
no diff, and no selector to re-match — and an idle frame costs nothing.

For the full pipeline, from your TSX to pixels, see
[Architecture](../../architecture/index.mdx).

## Next steps

- **[Quick start](./quick-start.md)** — create a project and run it.
- **[Project structure](./project-structure.md)** — what the scaffolder generated and why.
