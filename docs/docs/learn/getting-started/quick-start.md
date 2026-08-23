---
title: Quick start
sidebar_position: 2
---

# Quick start

## Prerequisites

- **[Bun](https://bun.com) 1.4 or later.** The compiler, the CLI and the app
  host all run on it.
- **Windows, macOS or Linux.** Each release ships a prebuilt engine binary per
  platform as an optional dependency, so no Rust toolchain is needed.

## Create a project

```bash
bun create dziry my-app
cd my-app
bun run dev
```

`bun create dziry` scaffolds the project, installs dependencies, and compiles
it once. `bun run dev` opens the window with hot reload.

## What the template contains

The starter is a working application, not a minimal hello-world: eleven routes
demonstrating the Tailwind utility families, conditional classes, a keyed
list, component-local state, forms, and nested routing. Each page shows one
feature working, so you can open the corresponding source file and copy the
pattern. The template always compiles against the version of Dziry it ships
with.

```
my-app/
  package.json
  tsconfig.json      # sets jsxImportSource: "dziry" — no per-file pragma needed
  bunfig.toml
  windows/
    env.d.ts         # type declarations for CSS imports
    main/
      index.tsx      # the window
      app.css        # the stylesheet, imported by index.tsx
      Nav.tsx
      router.ts      # the route signal and navigation handlers
      state.ts       # signals and handlers, exported by name
      pages/         # one file per route
```

## Next steps

- **[Project structure](./project-structure.md)** — what each file is for, and a page walkthrough.
- **[CLI reference](../../reference/cli.md)** — every command and flag, including `dziry build`.
