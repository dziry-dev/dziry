# guards/architecture/

An interactive map of dziry, and a Markdown rendering of the same map for
whoever — or whatever — is reading rather than clicking.

```
bun run arch                  # dev server, http://localhost:4321
bun run arch:check            # validate data.ts against the repo
bun run arch:check --emit     # ...and regenerate ARCHITECTURE.md
```

## Why it is not just a diagram

A diagram is wrong within a month and is read with the same confidence as one
that is right. So this one is built the way the rest of the repo is built:
whatever can be derived is derived, and whatever cannot is checked.

| Half | Where it lives | How it stays true |
| --- | --- | --- |
| Line counts, file lists, per-layer totals | measured by `metrics.ts` | recomputed on every request |
| The shared-memory tables and their fields | imported from `src/protocol/schema.ts` | it *is* the schema — there is no copy |
| Protocol version, style-field count | imported from the same place | same |
| What each stage is for, and why | hand-written in `data.ts` | every claim that names a file is verified by `check.ts` |
| The animated figures | `figures/*.tsx` | geometry checked at every step by `check.ts` |

`bun run arch:check` fails if a cited file has moved, a guard script has been
renamed, a shared table has no documented writer and reader, or a source file
in the tree belongs to no layer. That last one is the important one: a new
subsystem cannot be added without the map noticing.

## The figures

`How it works` is six animated figures, each a pure function of `(step,
progress)`:

| Figure | The question it answers |
| --- | --- |
| One div, end to end | Where is the boundary, and what has already happened by the time you reach it? |
| The cascade, resolved once | Does resolving CSS early lose anything? |
| Why struct-of-arrays | Why is the boundary memory instead of a call surface? |
| The frame loop | What does a frame cost, and what does an idle one cost? |
| Hover costs one u16 | How can interaction state work with no run-time selector matching? |
| Lists that never renumber | How does anything dynamic work when the tree was decided at build time? |

Each is a `FigureSpec` — data plus a `draw(step, progress)` that returns SVG and
uses no hooks. That purity is what makes `figures/geometry.ts` possible: it
walks every figure's element tree at every step, outside a browser, and fails
the build if anything is drawn outside the viewBox or if two pieces of text
collide on the same baseline.

That check exists because both of those shipped. A `text-anchor: middle` rule in
`theme.css` silently outranked every `textAnchor="start"` in the figures —
author CSS beats presentation attributes — so labels sat outside their boxes and
two captions printed on top of each other. Nothing threw; it just read as
nonsense. The first run of the checker then found two more: a payload chip
hanging off the frame, and a rejected cascade rule sliding underneath the rule
that was rising past it.

When adding or moving anything in a figure, run `bun run arch:check`. It is
faster than looking, and it looks at all 29 steps.

Animation rules the figures inherit from `figures/timeline.ts`: nothing plays
until it is in the middle band of the viewport (so one figure animates at a
time), every step is clickable, and `prefers-reduced-motion` disables the clock
and pins each step to its finished state.

## Files

| File | What it is |
| --- | --- |
| `data.ts` | **The one you edit.** Layers, pipeline stages, table roles, the six bets, roadmap, guards. |
| `metrics.ts` | Walks the repo and counts. Server-side only. |
| `Architecture.tsx` | The view. Contains no facts — if you are typing a number into it, it belongs in `data.ts`. |
| `theme.css` | Tokens and component styles. The six layer colours are a validated categorical set. |
| `check.ts` | The validator, and the `ARCHITECTURE.md` generator. |
| `serve.ts`, `main.tsx`, `index.html` | The harness that makes it run. |
| `ARCHITECTURE.md` | Generated. Do not edit — `bun run arch:check --emit` rewrites it. |

## Maintaining it

Most changes to the repo need nothing here: rename a function, add a style
field, refactor a module, and the view follows.

You need to edit `data.ts` when:

- **a file a stage cites moves or disappears** — `arch:check` will name it
- **a new directory appears** — `arch:check` will list the files that belong to no layer
- **a new shared table lands** — `arch:check` will ask for its writer and reader
- **a stage's story changes** — nothing will catch this; it is the one part that is
  genuinely hand-maintained, which is why it is only thirteen entries

After editing, run `bun run arch:check --emit` so the Markdown matches.

## The colours

Six layers, assigned in a fixed order and validated as an adjacent-pair set for
colour-vision separation, lightness band, chroma floor and contrast against both
the light and the dark surface. Both modes are selected — the dark column is the
same six hues re-stepped for the dark surface, not an automatic inversion.

Re-ordering the layers in `data.ts`, or substituting a hue in `theme.css`, means
re-running that validation rather than eyeballing it. Identity is never carried
by colour alone: every swatch, bar and card also carries its label.

## Is it worth keeping?

The test is whether `bun run arch:check` keeps passing without anyone nursing
it. If it starts failing for reasons nobody cares about, delete the directory —
`package.json` loses two scripts, `tsconfig.json` loses one line, and nothing
else in the repo imports from here.
