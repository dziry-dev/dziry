---
title: dziry
sidebar_position: 0
slug: /
---

# dziry

dziry is a framework for building desktop applications in TypeScript, HTML and
CSS. Your components and stylesheets are compiled ahead of time, and a native
engine renders the result — there is no browser, no DOM, and no webview.

```tsx
const count = signal(0);

<button onClick={() => count.set(count + 1)}>
  clicked {count} times
</button>
```

Signals are read as plain identifiers — no `.value`, no dependency arrays.

## Installation

```bash
bun create dziry my-app
cd my-app
bun run dev
```

## Documentation

- **[What is dziry?](./learn/getting-started/what-is-dziry.md)** — the compilation model and what it means for your code.
- **[Quick start](./learn/getting-started/quick-start.md)** — create a project and open your first window.
- **[Core Concepts](./learn/concepts/reactivity.md)** — reactivity, routing, lists, styling, forms.
- **[Reference](./reference/index.mdx)** — every exported API, with its current status.
- **[Architecture](./architecture/index.mdx)** — how the compiler and the native engine fit together.
- **[Contributing](./contributing/index.mdx)** — building the project and running its checks.

## Project status

dziry is in beta. Each API in the [Reference](./reference/index.mdx) is marked
**done**, **partial** or **planned**, and the badges are generated from the
project's tracking table at build time — a page cannot claim a feature works
when the tracking table says otherwise.

`dziry build` produces a single executable with the engine embedded.
Cross-compilation, code signing and notarization are not available yet.
