---
name: arch-diagram
description: Generate and query architecture diagrams — C4 context/container/component plus a module graph derived from the imports. Use when onboarding to a subsystem, before planning a refactor (blast radius, cycles, coupling hotspots), when explaining how a change flows through the system, and after moving or adding any module. Runs `bun run arch-diagram`.
---

# arch-diagram

Diagrams of dziry in Mermaid, at four C4 levels. The top three answer *what is this for*
and are hand-written; the bottom one is parsed out of the source on every run and is never
written down.

```bash
bun run arch-diagram              # validate the model, regenerate guards/diagrams/
bun run arch-diagram --check      # validate only; exit 1 on drift, cycles or violations
bun run arch-diagram context      # one diagram to stdout
bun run arch-diagram blast src/ir.ts   # what breaks if I change this
```

## Which view answers which question

| You want to know | Command | File |
| --- | --- | --- |
| Who uses this and what it touches | `context` | `guards/diagrams/01-context.md` |
| What processes/threads exist, what is shared | `containers` | `guards/diagrams/02-containers.md` |
| What is inside the compiler / app thread / engine | `components [id]` | `guards/diagrams/03-components.md` |
| Which layers depend on which, how heavily | `layers` | `guards/diagrams/04-layers.md` |
| Every file and every import edge | `modules <layer>` | `guards/diagrams/05-modules.md` |
| What crosses into shared memory | `boundary` | `guards/diagrams/06-boundary.md` |
| What happens over time | `flow build\|frame\|contended` | `guards/diagrams/07-flows.md` |
| Cycles, layering violations, hotspots | — | `guards/diagrams/08-health.md` |

Refactor queries, which print prose plus a Mermaid graph:

```bash
bun run arch-diagram blast src/compiler/css.ts --depth=2   # reverse cone: who breaks
bun run arch-diagram deps src/host/worker.ts               # forward cone: what it needs
bun run arch-diagram cycles
bun run arch-diagram hotspots --top=25
bun run arch-diagram violations
bun run arch-diagram json                                  # the whole graph, for tooling
```

## Reading the output

**Solid edge, dashed edge.** Dashed is `import type`, which disappears at erasure. This
distinction is why the cycle report is trustworthy: `src/engine/bind.ts ↔ host.ts ↔
upload.ts` looks like a cycle and is not one — the back-edges are type-only, nothing loads
in a circle at run time, and breaking it buys nothing. Only cycles that survive erasure
fail `--check`.

**Instability** in the hotspot table is Martin's `Ce/(Ca+Ce)`. Near 0 means many things
depend on it and it depends on little — expensive to change, and where the design should be
stable. Near 1 means it is a leaf, safe to rewrite. `src/ir.ts` sits at 0.10 with a fan-in
of 19: it is the build/run contract, and that number is the argument for why it is its own
layer rather than a file inside the compiler.

**Blast radius counts tests separately.** They are marked `· test` and drawn dashed. A
change reaching 40 files of which 15 are tests is a much smaller change than one reaching 40
source files.

## What it checks, and what that buys

`--check` fails on:

1. a C4 element citing a file that no longer exists
2. a source file that falls into no layer — a new subsystem nobody put on the map
3. an import that breaks a rule in `RULES`
4. an import cycle that survives type erasure

Rule 3 is the interesting one. `RULES` in `scripts/lib/arch-model.ts` lists *forbidden*
layer pairs, each with the reason it exists — `runtime ⇏ compiler` because the runtime is
the only code that ships, `ir ⇏ runtime` (values) because the contract must not depend on
either side of it. Stated as forbidden pairs rather than an allowed matrix, because an
allowed matrix changes whenever a module moves and a rule nobody can explain gets deleted
the first time it is inconvenient.

## When you need to edit the model

Most changes need nothing: rename a function, add a file, refactor a module, and the derived
half follows. Edit `scripts/lib/arch-model.ts` when:

- **`--check` names a missing citation** — a cited file moved
- **`--check` lists orphan files** — a new directory appeared; give it a layer, or extend one
- **a rule is violated and the code is right** — the rule was wrong, or the layer boundary
  was drawn in the wrong place. Both happened when this was first run: `src/cli/` was inside
  the compiler layer, and `src/ir.ts` was too. The violations were the model's fault, not
  the code's, and the fix was two new layers.
- **a container's story changes** — nothing will catch this. It is the genuinely
  hand-maintained part, which is why it is nine containers and eighteen components.

Then regenerate: `bun run arch-diagram`.

## Using this with an agent

`guards/diagrams/04-layers.md` and `guards/diagrams/08-health.md` are the two cheapest files to put in
context — they are small, derived, and current. For a task scoped to one subsystem, prefer
`bun run arch-diagram modules <layer>` over pasting source.

Before proposing a refactor, run `blast` on every file the plan touches. The prose header
alone (`reaches N files across M layers, K are tests`) is usually enough to tell a
one-afternoon change from a week.

`bun run arch-diagram json` emits nodes, edges, cycles and violations for anything that
wants to compute over the graph rather than read it.

## Limits

- **Rust is parsed by regex**, not a compiler — `mod x;` and `use crate::x`. The crate is
  nine flat modules so this is exact today, but a nested module tree would need real
  parsing.
- **The cross-language edge is not an import.** Bun and the engine meet through shared
  memory and `bun:ffi`, so no import graph can see it. That boundary is `06-boundary.md`,
  read straight from `src/protocol/schema.ts` — which is why it cannot disagree with the
  protocol.
- **Mermaid syntax is not validated on every run.** It was validated once against
  `mermaid.parse` (19 diagrams, 0 failures) and the renderers escape the characters that
  broke it — `"` in labels, `;` in sequence text, which silently truncates a label and then
  fails to parse two lines later. If you add a renderer, check it.
- **A green run does not mean the prose is true.** It means every citation resolves and no
  forbidden edge exists. Whether a container's description still describes it is a question
  for a person.

## Relationship to `guards/architecture/`

`guards/architecture/` is a separate interactive web app with its own hand-written `data.ts`. This
skill deliberately shares nothing with it — no imports either way — so deleting
`guards/architecture/` costs nothing here. The one thing both read is `src/protocol/schema.ts`,
which is source rather than documentation.
