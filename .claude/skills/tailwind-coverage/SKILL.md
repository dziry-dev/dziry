---
name: tailwind-coverage
description: Measure what fraction of Tailwind works in dziri and rank what is blocking the rest by number of classes unblocked. Use when planning A1, when deciding which CSS parser feature to build next, before claiming any Tailwind support level, and after adding a CSS property or value syntax. Runs `bun run tailwind-coverage`.
---

# tailwind-coverage

```bash
bun run tailwind-coverage                    # summary + ranked blockers
bun run tailwind-coverage --what-if          # what each blocker actually unblocks  <- read this one
bun run tailwind-coverage --what-if "calc,translate"  # an arbitrary combination, not a rank prefix
bun run tailwind-coverage --missing          # every unsupported property, by spec group
bun run tailwind-coverage --sample p-        # inspect classes matching a prefix
```

A run compiles all 23k classes through the real Tailwind CLI and takes a minute or two.

`/tw-loop` is the loop built on this: pick the top `--what-if` item, implement, re-measure, revert
if the number did not move.

## The corpus is Tailwind's, not ours

`__unstable__loadDesignSystem` — the API IntelliSense and the Prettier plugin use — enumerates
every class the **installed** version can generate: 23,286 of them. Those are then compiled by the
real CLI, so the comparison is against what Tailwind *emits*, not what its docs *describe*.

That distinction is the whole reason this is built this way. The docs render `shadow-lg` as a tidy
`box-shadow`; v4 actually emits `--tw-shadow` plus a `color-mix()`. Implementing from the docs
would produce something that looks right and fails on the real class string.

Two things that look like corpus sources and are not:

- **`tailwindcss-docs-mcp`'s `list_utilities`** returns documentation *categories and page links*,
  not class names — verified 2026-07-31, it returned three links for "Spacing". Its `search_docs`
  is useful prose search; it is not data.
- **Agent knowledge.** v4 renamed things (`shadow` → `shadow-sm`, `outline-none` →
  `outline-hidden`), and recall cannot distinguish "I remember this" from "this is plausible".

## Ranked by classes unblocked

Most of the 23k classes fail for the same handful of reasons, so a per-property list would be a
grind of hundreds of equal-looking items. One parser feature moves thousands at once, and that is
what the ordering is for.

Current, 2026-08-02, tailwindcss 4.3.3:

```
  properties   93/273 supported (34.1%)
  classes      8253/22763 work today (36.3%)

     6268  property: mask-composite
     6265  property: mask-image
     1163  calc() over percentages / viewport units
      444  property: translate
      333  color-mix()
      292  property: fill / stroke / accent-color
      291  property: border-inline-color, border-block-color, … (6 logical colour names)
```

A class is blocked by *how a value is written* as well as by which property it sets, so the
blocker list mixes both: `property: mask-image` and `calc()` are the same kind of entry.

The denominator comes from the *installed* `tailwindcss`, so a version bump moves both numbers.
Record the version with any count.

## The ranked numbers overlap — use `--what-if`

A class usually has several blockers, so the ranked counts double-count and the top entry can be
worthless. `mask-composite` ranks first at 6,268 and unblocks **four** classes, because nearly
everything it blocks is also blocked by `mask-image`:

```
  +   4  ->   8257/22763 (36.3%)  after property: mask-composite
  +6265  ->  14522/22763 (63.8%)  after property: mask-image
  + 651  ->  15173/22763 (66.7%)  after calc() over percentages / viewport units
  + 444  ->  15617/22763 (68.6%)  after property: translate
  + 333  ->  15950/22763 (70.1%)  after color-mix()
```

`--what-if` walks the ranked list cumulatively and reports the classes left with *no* blockers,
which is the only figure a plan can be built on. `--what-if "a,b"` handles the combinations that
are not rank prefixes — "var() and calc(), but not masks" is the shape of a real plan and cannot be
read off the ranking.

## Why `var()` is no longer on the list

The first run (2026-07-31) measured 469/22759 — 2.1% — with `var()` blocking 20,432 classes on its
own, because v4 routes every spacing, colour and shadow utility through `--tw-*`. That was the
ceiling, and it is why the early number looked hopeless.

`var()` and foldable `calc()` have since landed: the compiler resolves custom properties through
the cascade and folds `calc()` to a number, which is most of the distance from 2.1% to 36.3%.

**How that was recorded matters more than the number.** The `calc()` entry was *narrowed* to the
part that genuinely cannot be folded — a length not knowable until layout runs — rather than
deleted (`scripts/tailwind-coverage.ts:145-152`). Two entries survive for the same reason:
`@property / registered custom properties` still fires on `--tw-*`, because typing, initial values
and animatability are not supplied by substitution alone. The number moved because the feature
landed, not because the measuring stick got shorter. Keep it that way.

Note the matching hazard on the other side: `dziriSupported()` detects support by scanning for
`case "name":` in `expandDeclaration()`, so an empty case arm raises coverage while rendering
nothing. `/tw-loop` bans it outright.

## Judgement the tool does not make

It does not apply ROADMAP's non-goals. Masking is ~6,000 classes and sits near the top, but if
masks are out of scope then those classes are a *feature boundary*, not a backlog — and the
ranking should be read with them removed. Deciding that is a scope call; `css-coverage` has an
explicit out-of-scope list and this one deliberately does not, so the raw numbers stay honest.

## Related

`css-coverage` asks which properties exist versus which dziri parses, against a curated
denominator. This asks the question users actually care about — *does `p-4` work* — and derives
its denominator from Tailwind itself. When they disagree, this one is closer to the promise.
