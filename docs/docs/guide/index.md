---
title: How dziry works
sidebar_position: 1
---

# How dziry works

Most UI frameworks do their work while the app runs. They build a tree, diff it,
match selectors, resolve a cascade, and lay out boxes — every frame, on the user's
machine.

dziry does that work once, on your machine, before the app ships.

## What "compiled" actually means here

When you run the build, dziry **imports your module**. That import *is* the component
pass: your functions run, they return a tree, and that tree is the one that gets
compiled. There is no renderer and no virtual DOM.

Then the cascade is resolved — selectors matched, specificity sorted, inheritance
applied, shorthands expanded, units converted. The answer is a set of numbers, and
those numbers are written out as a TypeScript module of typed arrays.

At run time a Rust engine reads those arrays and draws with Skia. It never parses
CSS, never matches a selector, and never sees your components — they no longer exist.

## What this buys, and what it costs

The gain is that a frame costs almost nothing, and an idle frame costs nothing at all.
There is no reconciliation to do, because there is no tree to reconcile.

The cost is a set of rules that will feel arbitrary until you see where they come
from. Nearly all of them are the same rule:

> Anything the runtime must reach by name has to *have* a name at build time.

That one constraint explains most of what is surprising about authoring in dziry:

- A signal is normally a module-level export, because the generated artifact imports
  it by name. (Component-local `signal()` also works — it is registered in a slot
  rather than named. See [Reactivity](./reactivity.md).)
- A click handler is a module-level export for the same reason — unless it is an
  inline arrow the compiler can lift.
- An inline `style` value must be static. A signal there is a build error, because
  there is no node left to attach it to once the compiler is gone.
- A list item template cannot contain a conditional, because the template is compiled
  once and reused for every row. Anything per-row has to be *data*.

None of these are checks bolted on afterwards. They are what it means for the
component to be gone by the time the app runs.

## The read is the name

The one place dziry refuses to make you pay for its architecture is reading state.

```tsx
const count = signal(0);
const doubled = computed(() => count * 2);            // no .value
const parity = computed(() => (count % 2 === 0 ? "even" : "odd"));
```

`count * 2` works. So do `===`, ternaries, `!`, and template literals. There is no
`.value` to write and no dependency array to maintain.

This works because of a build-time source rewrite: `count * 2` becomes `$(count) * 2`,
where `$` unwraps a signal and passes everything else through. The decision is made at
run time, which is why the transform needs no type information and no scope analysis.
And `Signal<T>` is typed as `T & Ops<T>`, so the same expression also type-checks.

The rewrite runs on your code, under `windows/`. It does **not** run on the framework's
own modules — that is where `$` is defined — which is why you may see `.value` inside
`src/` and should never need it in yours.

## Where to go next

- **[Installation](./installation.md)** — `bun create dziry`, and what the template contains.
- **[Getting started](./getting-started.md)** — the file layout, and a window that runs.
- **[Reactivity](./reactivity.md)** — signals, computeds, writes, and the rules above in detail.
- **[Styling](./styling.md)** — Tailwind, `cn`, conditional classes, inline styles.
- **[Lists](./lists.md)** — `.map` with keys, and why item templates are restricted.
- **[Forms](./forms.md)** — `bind:value`, validation, and named fields.
- **[Effect](./effect.md)** — handlers, the window layer, Effect schemas, and `source()`.
- **[Routing](./routing.md)** — file-based routes, `useRoute`, `useRouter`.
- **[The CLI](./cli.md)** — `compile`, `dev`, and shipping one executable.
