---
title: The CLI
sidebar_position: 10
---

# The CLI

```bash
dziry compile [window]        # compile every window under ./windows, or just one
dziry dev [-- app flags]      # compile, then run the app
dziry build [options]         # package the app as one executable
```

In a framework checkout these are `bun run cli <command>`; in a scaffolded app the
`dziry` bin is on the path.

The CLI operates on the **working directory**. That sounds obvious and was not: the
compiler used to take its own location for the project's, which is true exactly once
and false for every scaffolded app.

## compile

```bash
dziry compile              # every window
dziry compile main         # just this one
dziry compile --dump       # ...and print the IR
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
dziry dev
dziry dev --route products/new --size 520x700
dziry dev --screenshot shot.png
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
`dziry dev -- --route products/new`.

`--single` runs both halves in one thread — the pre-Worker path. It exists for
debugging and comparison; see [Threads](../internals/threads.md) for what it gives up.

### Hot reload

`dziry dev` watches `windows/` while the app runs. What happens on save depends on
what changed:

- **A `.css` save that only moves style *values*** — a colour, a padding, an
  animation's duration — swaps the new style table into the running window and
  repaints. Signals, focus, scroll position and text all survive. The compiler
  proves the swap is safe by hashing the artifact with the style values blanked;
  an equal fingerprint means every row, slot and binding is where the running
  window left it.
- **Anything else** — markup, handlers, state shape — swaps the *app thread*
  under the live window: the old worker dumps its module-level signals and
  current route, a fresh worker boots the recompiled artifact with them, and the
  engine rebuilds its tree in place. The window never closes, and state whose
  export names survived the edit survives the reload. (A renamed signal starts
  fresh — there is no mapping to guess from. Class instances and functions are
  not carried; they cannot cross a worker boundary as themselves.)
- **A save that does not compile** prints the error and keeps the running app.

Compiles are warm. `dziry dev` runs the compiler as a persistent process, so a
save re-imports only the files that changed and whatever imports them — the rest
of the module graph (the compiler itself, Tailwind, Effect, LiveStore, your
untouched modules) stays loaded. Measured on a small LiveStore app: 2.8s cold,
**~50ms per save** after.

What still resets on a structural reload: focus, scroll position and text carets
(engine state keyed by node id — meaningless against a new tree), and anything
held outside module-level signals. A full process restart remains as the
fallback when the IPC channel itself is gone.

## build

```bash
dziry build
dziry build --out release --name Fabric
```

One executable. The app is bundled with `bun build --compile` over the same
`windows/entry.gen.ts` that `dziry dev` runs — so a bug that only appears in the
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
