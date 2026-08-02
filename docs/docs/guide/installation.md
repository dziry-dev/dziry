---
title: Installation
sidebar_position: 2
---

# Installation

```bash
bun create dziri my-app
cd my-app
bun run dev
```

That is the whole of it. `bun create dziri` writes the project, installs
dependencies, and leaves you with a window that runs.

## Options

| Flag | What it does |
| --- | --- |
| `--local <path>` | Depend on a dziri checkout instead of the published package. |
| `--no-install` | Write the files and stop. |

`--local` is what you want when working on the framework itself:

```bash
bun create dziri my-app --local ../dziri
```

## What you get

The template is **not** a reduced hello-window. It is the same window the framework's
own visual goldens render: eleven routes covering Tailwind utility families,
conditional classes compiled to style-table patches, a keyed list in an arena,
component-local state, and nested routing.

That is deliberate. A starter that exercises one feature teaches nothing about the
ones with sharp edges — and the sharp edges here (signals are module-level exports,
CSS resolves at build time) are exactly what a new project trips over.

```
my-app/
  package.json
  tsconfig.json      # jsxImportSource: "dziri" — no per-file pragma
  bunfig.toml
  windows/
    main/
      index.tsx      # the window
      app.css        # the stylesheet, imported by index.tsx
    env.d.ts         # types for `import "./app.css"` — keep it
      Nav.tsx
      router.ts      # the route signal and navigation handlers
      state.ts       # signals and handlers, exported by name
      reactivity.ts
      pages/         # one file per route
```

## The template cannot rot

The window sources are **derived from the framework's own demo** by
`bun run template:sync`, not maintained by hand, and `bun run template:check` fails if
the two have drifted.

A hand-maintained template rots into one that will not compile against the framework
that produced it, and it rots quietly — nobody runs the starter until a newcomer does.
Deriving it means the demo the framework is developed against *is* the template.

## Requirements

- **Bun.** The compiler, the CLI and the host all run on it.
- **A built engine.** The engine is Rust; the published package ships it, but in a
  checkout you build it once with `bun run engine`.

## Next

- **[Getting started](./getting-started.md)** — the layout, and what each file does.
- **[The CLI](./cli.md)** — `compile`, `dev`, `build`, and shipping an executable.
