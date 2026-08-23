---
title: Two threads
sidebar_position: 3
---

# Two threads

dziry runs application code and window servicing on separate threads so the
app can never freeze the window. Everything on this page follows from that
requirement.

## The split

**The engine thread** owns the engine handle and does nothing but service the OS: pump
SDL, drain input, repaint, resize. It never runs application code.

**The app thread** — a Worker — holds the whole application: signals, handlers,
bindings, lists, patches. It never touches the engine handle. The registry pins that to
the thread that created it, because SDL pins its window and event pump there, so this
side cannot tick, cannot drain events, and cannot grow the tables.

What it *can* do is write the tables, which is the part that matters.

## Zero-copy survives the split

The worker writes **the same engine memory**, not a copy of it: the engine
thread sends addresses across, and the worker wraps them with `toArrayBuffer`.
A style patch or a list relink therefore costs exactly what it costs
single-threaded — moving app code off the main thread did not turn the memory
boundary into a message protocol.

## What the split is worth

Without it, a slow handler means no `tick()`, which means no
`SDL_PumpEvents`, which means the OS marks the window unresponsive — the grey
overlay on Windows, the beach ball on macOS.

Measured with the app thread deliberately wedged for 2 seconds of a 3-second
run:

| | Frames rendered |
| --- | --- |
| Single-threaded | 62 |
| Worker | 190 |

All visual regression goldens render pixel-identically through the worker
path.

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

`dziry dev --single` runs both halves in one thread, on the pre-Worker path. If
something behaves differently under `--single`, the difference is in the threading
rather than in your app.

```bash
bun run cli dev --single
bun run boundary-diff     # validates the tables before they are handed over
```

## Two Bun behaviors worth knowing

A worker inherits **neither** the parent's loader plugins **nor** its
`process.argv`. The first is why the reactive rewrite is installed on the
worker side explicitly; the second is why app flags are passed across rather
than read.
