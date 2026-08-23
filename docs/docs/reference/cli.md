---
title: CLI
sidebar_position: 6
---

# CLI

```bash
dziry compile [window]        # compile every window under ./windows, or one
dziry dev [-- app flags]      # compile, then run the app
dziry build [options]         # package the app as one executable
```

The CLI operates on the current working directory.

## `dziry compile`

```bash
dziry compile              # every window
dziry compile main         # one window
dziry compile --dump       # also print the IR
```

Compiles each window — the shell plus every route — into one tree, resolves
the cascade, and emits the generated module.

A window's stylesheets are the ones its modules `import`, in the order the
module graph evaluates them, the same order a bundler would produce. If a
stylesheet uses Tailwind, the project's own Tailwind runs over it during the
compile; nothing is written to disk.

Styles are interned across all routes in a window, so routes that share a
design system share style rows.

## `dziry dev`

```bash
dziry dev
dziry dev --route products/new --size 520x700
dziry dev --screenshot shot.png
```

Compiles, then runs. Flags the CLI does not recognize are passed to the app;
you can also separate them explicitly with `--`:
`dziry dev -- --route products/new`.

| App flag | Description |
| --- | --- |
| `--route <path>` | Start on a route other than the initial one. |
| `--window <id>` | Open a window other than the first. |
| `--size WxH` | Open at the given size. |
| `--min-size WxH \| none` | Override or lift the minimum window size. |
| `--screenshot <file>` | Render one frame headlessly and exit. |
| `--stats` | Print frame timings. |
| `--single` | Run the app and the engine on one thread (for debugging; see [Two threads](../architecture/threads.md)). |

### Hot reload

`dziry dev` watches `windows/` while the app runs. What happens on save
depends on what changed:

- **A CSS save that only changes style values** — a color, a padding, an
  animation duration — swaps the new style table into the running window and
  repaints. Signals, focus, scroll position and text all survive. The compiler
  verifies the swap is safe by hashing the generated module with style values
  blanked; equal fingerprints mean every row, slot and binding is where the
  running window expects it.
- **Anything else** — markup, handlers, state shape — swaps the app thread
  under the live window. The old worker hands over its module-level signals
  and current route, a fresh worker boots the recompiled module with them, and
  the engine rebuilds its tree in place. The window never closes, and state
  whose export names survived the edit survives the reload. A renamed signal
  starts fresh, and class instances and functions are not carried across the
  worker boundary.
- **A save that does not compile** prints the error and keeps the running app.

Rebuilds are incremental: the compiler runs as a persistent process, so a save
re-imports only the changed files and their importers. Typical costs are a few
seconds for the first compile and tens of milliseconds per save after that.

What resets on a structural reload: focus, scroll position and text carets
(engine state keyed by node id, which a new tree invalidates), and anything
held outside module-level signals.

## `dziry build`

```bash
dziry build
dziry build --out release --name Fabric
```

Produces one executable. The app is bundled with `bun build --compile` over
the same generated entry that `dziry dev` runs, so the packaged app and the
dev app share one code path.

| Flag | Default | Description |
| --- | --- | --- |
| `--out <dir>` | `dist` | Output directory. |
| `--name <name>` | folder name | Executable name. |
| `--console` | off | Windows: keep the console window visible. |
| `--no-minify` | off | Leave the bundled JavaScript readable. |
| `--keep-scratch` | off | Keep the generated wrapper entry for inspection. |

The engine ships inside the executable as an embedded asset and is unpacked to
a per-user cache on first run — `dlopen` (and macOS code signing) require a
real file on disk, so it cannot be loaded from the embedded filesystem.

:::warning[No cross-compilation yet]

`bun build --compile --target` can cross-build the JavaScript half, but the
embedded engine is the one built for the current machine, so a cross-built
binary would carry the wrong library. Shipping for another platform currently
means building on that platform.

Code signing and notarization are not implemented yet.
:::
