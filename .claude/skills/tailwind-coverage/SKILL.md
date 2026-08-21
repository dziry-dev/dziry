---
name: tailwind-coverage
description: Measure what fraction of Tailwind works in dziry and rank what is blocking the rest by number of classes unblocked. Use when planning A1, when deciding which CSS parser feature to build next, before claiming any Tailwind support level, and after adding a CSS property or value syntax. Runs `bun run tailwind-coverage`.
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

**`getClassList()` is the authority on what a class is, and `rulesByClass` now enforces it.** Three
bugs lived in the gap between the class list and the scraped stylesheet, all fixed 2026-08-02:

- v4 nests `@supports` *inside* a rule, with declarations before it. Slicing the selector from the
  last brace swept those declarations in, and `\.[\w-]+` then read `oklch(63.7% 0.237 25.331)` as the
  classes `.7`, `.237`, `.331` — **349 phantom entries**, and the reason `color-mix()` looked like
  +333. The selector is now cut at the last `;` or `}`.
- A nested block's own selector often names no class — `.divide-y` wraps
  `:where(& > :not(:last-child))` — so its declarations were dropped and the class looked clean.
  Attribution now walks up to the nearest class-bearing ancestor selector. That recovered **872
  classes** previously missing from the denominator entirely.
- Keys are intersected against `getClassList()`, so a scrape artifact cannot enter the corpus again.

The denominator is now the full 23,286 with nothing silently excluded, and the count of classes that
emit no rule alone is printed rather than dropped. Correcting all three *raised* the honest figure
(the recovered classes outnumbered the phantoms), which is a reminder that a broken measurement is
not conservatively wrong — it is just wrong.

## Ranked by classes unblocked

Most of the 23k classes fail for the same handful of reasons, so a per-property list would be a
grind of hundreds of equal-looking items. One parser feature moves thousands at once, and that is
what the ordering is for.

Current, 2026-08-02, tailwindcss 4.3.3:

```
  properties   93/273 supported (34.1%)
  classes      9019/23286 work today (38.7%)
               0 of 23286 emit no rule alone and are not counted

     6268  property: mask-composite
     6265  property: mask-image
     1162  calc() over percentages / viewport units
      580  percentage length
      444  property: translate
      292  property: fill / stroke / accent-color
      291  property: border-inline-color, border-block-color, … (6 logical colour names)
      125  property: inset
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
  +   4  ->   9023/23286 (38.7%)  after property: mask-composite
  +5887  ->  14910/23286 (64.0%)  after property: mask-image
  + 650  ->  15560/23286 (66.8%)  after calc() over percentages / viewport units
  + 469  ->  16029/23286 (68.8%)  after percentage length
  + 444  ->  16473/23286 (70.7%)  after property: translate
```

`--what-if` walks the ranked list cumulatively and reports the classes left with *no* blockers,
which is the only figure a plan can be built on. `--what-if "a,b"` handles the combinations that
are not rank prefixes — "var() and calc(), but not masks" is the shape of a real plan and cannot be
read off the ranking.

## Why `var()` and most of `color-mix()` are no longer on the list

The first run (2026-07-31) measured 469/22759 — 2.1% — with `var()` blocking 20,432 classes on its
own, because v4 routes every spacing, colour and shadow utility through `--tw-*`. That was the
ceiling, and it is why the early number looked hopeless.

`var()` and foldable `calc()` have since landed: the compiler resolves custom properties through
the cascade and folds `calc()` to a number, which is most of the distance from 2.1% to 36.3%.

`color-mix()` went the same way on 2026-08-02, though it moved **no real classes** — the +333 it
appeared to unblock were all scrape artifacts, which is what exposed the corpus bug described under
*The corpus is Tailwind's, not ours*. It is still the right implementation: opacity modifiers like
`bg-red-500/50` need it, and `getClassList()` simply does not enumerate modifiers, so the corpus
cannot show the win. Only one form is implemented —
against a `transparent` operand, which is how v4 spells every opacity modifier, so `bg-red-500/50`
is `color-mix(in oklab, … 50%, transparent)`. That form folds exactly and needs no colour-space
conversion: CSS interpolates premultiplied, a zero-alpha operand contributes nothing but its weight,
so the result is the other colour with a scaled alpha *in any interpolation space*. Chrome confirms
it in `scripts/conformance.ts`, which is where that claim is asserted rather than assumed. The entry
narrowed to `color-mix() with currentcolor`, the one spelling left that `parseColor` has no value
for.

**How that was recorded matters more than the number.** The `calc()` entry was *narrowed* to the
part that genuinely cannot be folded — a length not knowable until layout runs — rather than
deleted (`scripts/tailwind-coverage.ts:145-152`). Two entries survive for the same reason:
`@property / registered custom properties` still fires on `--tw-*`, because typing, initial values
and animatability are not supplied by substitution alone. The number moved because the feature
landed, not because the measuring stick got shorter. Keep it that way.

Note the matching hazard on the other side: `dzirySupported()` detects support by scanning for
`case "name":` in `expandDeclaration()`, so an empty case arm raises coverage while rendering
nothing. `/tw-loop` bans it outright.

## Property support and value support are different questions

Support is detected per *property*, but a property's parser can reject whole classes of *value*.
Where `VALUE_FEATURES` does not model one of those rejections, the tool overcounts.

That was not hypothetical. Until 2026-08-02 there was no entry for a bare percentage, only for
percentages inside `calc()`, so every class Tailwind emits as a plain `%` length counted as working.
`parseLength` throws on all of them (`css.ts:1044`) and `compile.ts:290` rethrows it as fatal — so
`w-full` and `h-full`, which are `width: 100%` and `height: 100%`, were reported as supported while
the compiler refused to build them. 91 classes, and two of the most-used in Tailwind.

The fix lowered the reported number from 36.3% to 35.9%, which is the direction an honest correction
goes. The regex is `/:[^;(){}]*\d%/`, and the `[^;(){}]*` is the whole trick: forbidding an opening
paren between the colon and the `%` is what separates a percentage used as a length from one used as
a component inside a function. `width: 50%` matches; `oklch(70% 0.1 200)` does not, because its `%`
is a lightness, and gradient stops and `color-mix()` ratios do not either.

The general rule when adding a property: run the values Tailwind actually emits for it through
`parseLength`/`parseColor` in a scratch script first. If they throw, implementing the property makes
the class go from silently inert to breaking the build, and the coverage number rises anyway.

## Judgement the tool does not make

It does not apply ROADMAP's non-goals. Masking is ~6,000 classes and sits near the top, but if
masks are out of scope then those classes are a *feature boundary*, not a backlog — and the
ranking should be read with them removed. Deciding that is a scope call; `css-coverage` has an
explicit out-of-scope list and this one deliberately does not, so the raw numbers stay honest.

## Related

`css-coverage` asks which properties exist versus which dziry parses, against a curated
denominator. This asks the question users actually care about — *does `p-4` work* — and derives
its denominator from Tailwind itself. When they disagree, this one is closer to the promise.
