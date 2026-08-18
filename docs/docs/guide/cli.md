---
title: The CLI
sidebar_position: 10
---

# The CLI

```bash
dziri compile [window]        # compile every window under ./windows, or just one
dziri dev [-- app flags]      # compile, then run the app
dziri build [options]         # package the app as one executable
```

In a framework checkout these are `bun run cli <command>`; in a scaffolded app the
`dziri` bin is on the path.

The CLI operates on the **working directory**. That sounds obvious and was not: the
compiler used to take its own location for the project's, which is true exactly once
and false for every scaffolded app.

## compile

```bash
dziri compile              # every window
dziri compile main         # just this one
dziri compile --dump       # ...and print the IR
```

Compiles each window — shell plus every route — into one tree, resolves the cascade,
and emits the artifact.

A window's stylesheets are the ones its modules `import`, in the order the module
graph evaluates them, exactly as a bundler would order them. If a stylesheet uses
Tailwind, the project's own Tailwind runs over it during the compile; nothing is
written to disk, so there is no generated stylesheet that can go stale.

Styles intern across every route in a window. That is the decided design and it was
measured: two pages of one design system shared six of eight style rows.

## dev

```bash
dziri dev
dziri dev --route products/new --size 520x700
dziri dev --screenshot shot.png
```

Compiles, then runs. Anything the CLI does not recognise is passed to the app:

| App flag | What it does |
| --- | --- |
| `--route <path>` | Start on a route other than the initial one. |
| `--window <id>` | Open a window other than the first. |
| `--size WxH` | Open at that size. |
| `--min-size WxH \| none` | Lift the engine's minimum window size. |
| `--screenshot <file>` | Render one frame headlessly and exit. |
| `--stats` | Print frame timings. |

You can also write `--` explicitly to separate them:
`dziri dev -- --route products/new`.

`--single` runs both halves in one thread — the pre-Worker path. It exists for
debugging and comparison; see [Threads](../internals/threads.md) for what it gives up.

### Hot reload

`dziri dev` watches `windows/` while the app runs. What happens on save depends on
what changed:

- **A `.css` save that only moves style *values*** — a colour, a padding, an
  animation's duration — swaps the new style table into the running window and
  repaints. Signals, focus, scroll position and text all survive. The compiler
  proves the swap is safe by hashing the artifact with the style values blanked;
  an equal fingerprint means every row, slot and binding is where the running
  window left it.
- **Anything else** — markup, handlers, or a CSS change that alters the *shape* of
  the interned style table (two rules merging into one row, a media condition
  coming or going) — recompiles and restarts the app. A compile is tens of
  milliseconds, so the fallback is a blink, not a build.
- **A save that does not compile** prints the error and keeps the running app.

Handler and markup changes that keep *application state* alive are stages 2 and 3
of ROADMAP D1 — not implemented; markup reload is cut from v1 entirely.

## build

```bash
dziri build
dziri build --out release --name Fabric
```

One executable. The app is bundled with `bun build --compile` over the same
`windows/entry.gen.ts` that `dziri dev` runs — so a bug that only appears in the
packaged app is a *packaging* bug, not a different code path.

| Flag | Default | What it does |
| --- | --- | --- |
| `--out <dir>` | `dist` | Where the executable goes. |
| `--name <name>` | folder name | The executable's name. |
| `--console` | off | Windows: keep the console window, to see output. |
| `--no-minify` | off | Leave the bundled JavaScript readable. |
| `--keep-scratch` | off | Leave the generated wrapper entry in place. |

### The engine is embedded and unpacked

The engine ships inside the binary as a file asset and is unpacked to a per-user cache
on first run. It cannot stay in the virtual filesystem, because `dlopen` will not
accept the `B:/~BUN/root/` path an embedded file reports.

The scratch wrapper entry exists for a narrow reason: the `with { type: "file" }`
import specifier has to be a literal, and the engine's path is platform- and
machine-dependent, so it cannot live in a checked-in source file.

:::warning No cross-compilation yet

`bun build --compile --target` can cross-build the JavaScript half, but the engine
embedded here is the one built for *this* machine, so a cross-built binary would carry
the wrong library. Shipping for another platform means building the engine there.

Code signing and notarization are also not done. Both are filed as CI work with a
pinned toolchain.
:::

## Why packaging needed measurements

Four Bun behaviours each produced a failure that appeared **only in the shipped app**,
which is the worst place to find one:

- A runtime plugin is not a bundler plugin — so the reactive rewrite never ran, and
  the binary threw on its first frame.
- A standalone binary honours the `bunfig.toml` in its working directory.
- An embedded `.ts` file is loaded untranspiled.
- `--windows-hide-console` leaves the PE subsystem at 3, so the app popped a terminal
  behind its window. Fixed by writing the field directly.

None of these are guesses recorded as lore; each was measured, and each is why the
build path looks the way it does.
