# Tailwind, compiled by dziri

Real Tailwind v4 output, through dziri's compiler, rendered by the Rust engine. No
browser, no DOM, no CSS parser at run time — the classes are resolved at build time
into a style table.

```
bun run tw          # build the CSS, compile every window, open this one
bun run tw:shot     # ...or render one frame to windows/tailwind/shot.png
```

One route per utility family: `layout`, `spacing`, `typography`, `colors`,
`borders`. Add utilities to the page they belong to as coverage grows — the point of
this window is that the coverage number has something to point at.

## What makes it honest

Every class here goes through real Tailwind — the project's own copy, run by the
compiler when `index.tsx` imports `app.css`. If a utility does not
compile, `bun run window` prints a warning naming the property, so a page that
renders is a page whose utilities work. Utilities that do **not** work are left off
rather than shown broken: a demo that renders a utility wrongly is worse than one
that omits it.

`bun run tailwind-coverage` is the measurement; this is the exhibit. They should
agree, and if they ever disagree the exhibit is wrong.

## Why `app.css` is not just `@import "tailwindcss"`

- **No preflight.** Tailwind's reset is a user-agent stylesheet written in selectors
  dziri does not have — `:host`, `*`, `::before`, `[hidden]`. It is optional by
  design, and dziri ships its own UA sheet, which is the same job done at the right
  origin. So: `theme.css` + `utilities.css`, not the umbrella import.
- **`source(none)` plus explicit `@source`.** Tailwind v4 otherwise scans the whole
  project, finds class-shaped strings inside the compiler's own TypeScript, and
  emits utilities for them. That inflates the sheet with rules no page uses and
  makes any coverage claim from this window meaningless.

## What this window has already caught

- **`oklch(98.5% 0 none)`** — Tailwind 4.3 emits `none` for the hue of every
  achromatic colour. CSS Color 4 §4.2 makes that a *missing component* computing to
  zero, and dziri rejected it, so every neutral in the palette failed to parse while
  the saturated ones worked. Fixed, with a test.

## Known gaps visible from here

`line-height` is unsupported, so `text-sm`/`text-lg` set their font size and warn
about the line height that comes with them. `@media (hover: hover)`, `@property` and
`@supports` are skipped at-rules. The largest blockers by class count are
`mask-image` and `mask-composite`, then `calc()` over percentages and viewport
units — see `bun run tailwind-coverage`.
