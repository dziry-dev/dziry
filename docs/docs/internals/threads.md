---
title: Two threads
sidebar_position: 3
---

# Two threads

The window cannot be frozen by the app. That is the whole reason this exists, and
everything below follows from it.

## The split

**The engine thread** owns the engine handle and does nothing but service the OS: pump
SDL, drain input, repaint, resize. It never runs application code.

**The app thread** — a Worker — holds the whole application: signals, handlers,
bindings, lists, patches. It never touches the engine handle. The registry pins that to
the thread that created it, because SDL pins its window and event pump there, so this
side cannot tick, cannot drain events, and cannot grow the tables.

What it *can* do is write the tables, which is the part that matters.

## Zero-copy survives the split

This is the part that could easily have been lost. The Worker writes **the same engine
memory**, not a copy of it: the engine thread sends addresses across, and the Worker
wraps them with `toArrayBuffer`.

So a style patch and a list relink cost exactly what they cost single-threaded. The
boundary is still memory, and moving app code off the main thread did not turn it into
a message protocol.

## What it buys, measured

A handler that takes 400 ms no longer freezes the window. Before, a slow handler meant
no `tick()`, which meant no `SDL_PumpEvents`, which meant the OS marked the window
unresponsive — the grey overlay on Windows, the beachball on macOS.

With the app thread deliberately wedged for 2 seconds of a 3-second run:

| | Frames rendered |
| --- | --- |
| Single-threaded | 62 |
| Worker | 190 |

All 14 visual goldens render pixel-identically through the Worker path.

This had been filed in `ROADMAP.md` as "only worth doing if the event watcher turns out
to be insufficient". It was: the watcher saves a live-resize drag and does nothing at
all for a slow handler, which is the common case.

## The lock, and the one asymmetry

The two threads share one thing outside the tables: a lock and two flags, in a
`SharedArrayBuffer`.

A `SharedArrayBuffer` rather than messages because both threads have to decide *now*,
mid-frame, and a `postMessage` round trip is not available to a synchronous frame loop.

The acquisition is deliberately **asymmetric**:

- The **writer** (the Worker) may block. Nothing is waiting on it, and the wait is
  bounded in practice by one `tick`.
- The **engine thread** may only *try*. When it fails, it **pumps instead of ticking** —
  servicing input, resize and repaint while leaving the staged tables strictly alone.

A main thread that waited for the lock would have reintroduced the exact freeze this
design exists to prevent, one level down.

That is what `Engine::pump` is: `tick` minus the commit.

## Why the commit must be skippable, not delayed

The staged/live split already protects the engine's *paint* from the host's writes.
What it does not protect is the commit itself — `Tables::commit` compares and copies
staged over live, and a copy taken mid-batch captures a half-applied state.

For a style value, that is one frame of wrong colour, and it self-corrects.

For a **link** column it is not. A list splice writes `firstChild` and `nextSibling`
across several nodes, and a copy taken between two of those writes can describe a chain
that **loops**. The engine catches it with a traversal budget and reports a malformed
table, which poisons the engine.

So this is a correctness boundary, not a tearing-artefact one — which is why a missed
commit has to be genuinely skipped rather than queued and applied late.

## The rule the app thread obeys

> Every write to the tables happens between `acquire` and `release`.

Not for mutual exclusion between two writers — there is only one — but so the engine
thread's commit can never land in the middle of a batch.

## Debugging

`dziri dev --single` runs both halves in one thread, on the pre-Worker path. If
something behaves differently under `--single`, the difference is in the threading
rather than in your app.

```bash
bun run cli dev --single
bun run boundary-diff     # validates the tables before they are handed over
```

## Two Bun behaviours worth knowing

Both were wrong in the optimistic direction, and both had to be measured rather than
assumed:

- A Worker inherits **neither** the parent's loader plugins **nor** its `process.argv`.

The first is why the reactive rewrite has to be installed on the Worker side
explicitly; the second is why app flags are passed across rather than read.
