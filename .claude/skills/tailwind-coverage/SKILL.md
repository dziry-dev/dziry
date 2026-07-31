---
name: tailwind-coverage
description: Measure what fraction of Tailwind works in dziri and rank what is blocking the rest by number of classes unblocked. Use when planning A1, when deciding which CSS parser feature to build next, before claiming any Tailwind support level, and after adding a CSS property or value syntax. Runs `bun run tailwind-coverage`.
---

# tailwind-coverage

```bash
bun run tailwind-coverage             # summary + ranked blockers
bun run tailwind-coverage --missing   # every unsupported property, by spec group
bun run tailwind-coverage --sample p- # inspect classes matching a prefix
```

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

First run, 2026-07-31:

```
  properties   77/273 supported (28.2%)
  classes      469/22759 work today (2.1%)

    20432  var() / custom properties
     6268  property: mask-composite
     6265  property: mask-image
     5933  calc()
      444  property: translate
      333  color-mix()
```

**`var()` blocks 90% of Tailwind on its own.** v4 is built on custom properties — every spacing,
colour and shadow utility routes through `--tw-*`. Until the parser handles them, no amount of
per-property work moves the number, and the 2.1% is a ceiling rather than a starting point.

A class is blocked by *how a value is written* as well as by which property it sets, so the
blocker list mixes both: `property: mask-image` and `calc()` are the same kind of entry.

## Judgement the tool does not make

It does not apply ROADMAP's non-goals. Masking is ~6,000 classes and sits near the top, but if
masks are out of scope then those classes are a *feature boundary*, not a backlog — and the
ranking should be read with them removed. Deciding that is a scope call; `css-coverage` has an
explicit out-of-scope list and this one deliberately does not, so the raw numbers stay honest.

## Related

`css-coverage` asks which properties exist versus which dziri parses, against a curated
denominator. This asks the question users actually care about — *does `p-4` work* — and derives
its denominator from Tailwind itself. When they disagree, this one is closer to the promise.
