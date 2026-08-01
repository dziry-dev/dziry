# Tailwind, compiled by dziri

Real Tailwind v4 output, through dziri's compiler, rendered by the Rust engine.
No browser, no DOM, no CSS parser at run time — the classes are resolved at build
time into a style table.

```
bun run tw          # build the CSS, compile, open a window
bun run tw:shot     # ...or render one frame to demo-tailwind/shot.png
```

Both write `app/ui.gen.ts` — the same artifact `bun run app` consumes and, more
importantly, the one `src/engine/upload.test.ts` loads to assert against. So both
scripts **recompile the real app afterwards**, with `;` rather than `&&` so it
happens even when the run is interrupted or the window is closed with an error.

That is not tidiness. Leaving the Tailwind IR in place made the engine test suite
assert against the wrong tree: its layout tests looked for a 4-track grid that the
Tailwind demo does not contain, and the arena-growth test looked for an empty
string slot, found none, and wrote through index `-1` — which ended in Bun
allocating 19 GB and dying with an illegal instruction rather than a failed
assertion.

## Why `in.css` is not just `@import "tailwindcss"`

Two deliberate exclusions, both of which are about what dziri is rather than what
it is missing:

- **No preflight.** Tailwind's reset is a UA stylesheet: `:host`, `*`,
  `::before`, `[hidden]`. dziri has no shadow DOM, no pseudo-elements and no
  attribute selectors, and its parser refuses selectors it cannot honour rather
  than silently matching something else. Preflight is optional, so it is left out.
- **`source(none)` plus an explicit `@source`.** Tailwind v4 scans the whole
  project by default, which here means it finds class-shaped strings inside the
  compiler's own TypeScript and emits utilities for them — including arbitrary
  values like `min-h-[calc(100vh-4rem)]`, whose escaped selectors the parser does
  not yet read.

## What this demo exercises

`@theme` tokens resolving through `var()`, `calc()` folded at compile time,
`oklch()` converted to sRGB, logical properties (`px-*`/`py-*`), flex layout,
radii, font weights and sizes.

## Known gaps, visible or not

- `@media` is skipped, so nothing here is responsive yet.
- `mask-image`/`mask-composite` are the largest remaining blockers by class count.
- `calc()` over percentages and viewport units is refused rather than guessed.
