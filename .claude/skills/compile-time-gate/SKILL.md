---
name: compile-time-gate
description: Apply dziry's governing principle before adding anything to the runtime. Use whenever a feature is proposed, designed or implemented that would add runtime code, runtime state, a per-frame cost or a new dynamic capability — including anything in src/runtime/, the engine's tick path, or a new entry in the shared-memory schema. Also use when reviewing a design doc or an API proposal, and when someone says a feature "needs" to be dynamic.
---

# compile-time-gate

> Every runtime feature is assumed to be compile-time unless it can be proven that it must
> remain dynamic.

This is a **scope containment** strategy first and a performance one second. It is the only thing
preventing slow drift into building a browser, which is the failure mode that would make the
project pointless. Nothing enforces it automatically. That is what this is for.

## The four questions, in order

For every proposed feature, answer each one out loud before writing code:

1. **Can the compiler resolve this?** — Is the answer already known at build time?
2. **Can the compiler precompute this?** — Not the answer, but the work leading to it.
3. **Can the compiler emit variants?** — Enumerate the possibilities and let the runtime pick an
   integer. `:hover` is a second style id, not a computation.
4. **Does the runtime really need to know about this?** — Often the answer reduces to a few bytes
   of status, not the feature.

**State which question was answered "no", and why.** That sentence goes in the commit message, the
design doc, or the doc comment. A feature that lands without it has skipped the gate.

## What counts as proof

Not "it would be easier", not "other frameworks do it at runtime", not "we might need
flexibility later". Proof looks like:

- **It depends on data that does not exist at build time** — the OS, the user, the network, the
  window, the clock.
- **It is unbounded** — the set of possibilities cannot be enumerated, so variants would be
  infinite.
- **It was measured** — a compile-time version was tried and lost. The engine exists because Taffy
  measured faster than the hand-written TS layout, not because Rust sounded better.

## The ledger

`NOTES.md` keeps the list of what is irreducibly runtime. It is short on purpose:

current state values · list cardinality and order · text advance widths · hit-testing · window
size · the dirty mask and changed-node list · async resolution state · the active navigation frame
per region · the OS-supplied deep-link string

**Adding an entry is a real event.** If a feature needs one, say so explicitly and justify it in
the same terms as the entries already there. If it does not need one, it should leave no runtime
trace at all.

## Recognising a bad answer

- *"We'll make it configurable at runtime"* → can the config be enumerated? Then it is variants.
- *"The user might change it"* → is the set of things they can change into finite? Then it is
  variants plus an integer.
- *"It's only a small runtime cost"* → cost is not the objection; scope is. Small runtime features
  are how a UI framework becomes a browser.
- *"CSS does it at runtime"* → CSS is a document format resolving against an unknown document. We
  have the document at build time. That is the whole thesis.

## Worked examples from this codebase

| Feature | Question answered "no" | What shipped |
|---|---|---|
| `:hover` / `:focus` | 3 — variants are enumerable | a precomputed variant table; the runtime picks an int |
| Conditional classes (`cn`) | 3 | style-table patches; `.light` is 46 writes, paint-only |
| CSS transitions | 3 | animation records interpolated in Rust between two precomputed variant slots; no JS at 120 Hz |
| Media queries | 1 — the window size is not known at build | predicates plus patch entries, evaluated **engine-side** so a resize never routes through Bun |
| Text measurement | 1 — depends on font, DPI and shaping | measured next to Skia, so it never crosses FFI |
| Query invalidation | 2 — the Drizzle AST is analysable | `reads & writes` precomputed into a bitmask at build |
| Routing | 1 for the cursor only | the screen set, tree, reveal chains and matcher are static; only the active frame is runtime |

The pattern worth noticing: the answer is almost never "make it runtime". It is "make the
*decision* compile-time and leave the runtime an integer."
