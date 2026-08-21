---
title: dziry
sidebar_position: 0
slug: /
---

# dziry

A UI framework that does its work before the app runs.

You write TSX and Tailwind. At build time the components are evaluated once, the
cascade is resolved, and the answer is written out as typed arrays. At run time a
Rust engine reads those arrays and draws — with no DOM, no virtual DOM, no CSS
parser and no selector matching.

```tsx
const count = signal(0);

<button onClick={() => count.set(count + 1)}>
  clicked {count} times
</button>
```

That `count` is a bare read. There is no `.value`, and no dependency array.

## Start

```bash
bun create dziry my-app
cd my-app
bun run dev
```

## Where to go

- **[Guide](./guide/index.md)** — install, write a window, make it react.
- **[API](./api/index.mdx)** — every surface, each marked with what actually works today.
- **[Internals](./internals/index.mdx)** — the compile pipeline and the shared-memory boundary.
- **[Contributing](./contributing/index.mdx)** — the guard scripts, and how to keep docs true.

## This is pre-1.0

The API pages mark each surface **done**, **partial** or **planned**, and those badges
are read from `API.md` at build time rather than typed by hand — so a page cannot claim
a feature works while the tracking table says it does not.

`dziry build` produces a single executable with the engine embedded, but
cross-compilation, signing and notarization are not done yet.
