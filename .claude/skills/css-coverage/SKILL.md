---
name: css-coverage
description: Report what CSS exists versus what dziry supports, bucketed as supported / unsupported / committed non-goal. Use when planning A1, when asked "how much CSS do we support", before publishing any coverage claim, and when deciding which property to implement next. Runs `bun run css-coverage`.
---

# css-coverage

```bash
bun run css-coverage                # the counts
bun run css-coverage --missing      # unsupported, grouped by spec area
bun run css-coverage --group grid   # filter by mdn-data group
```

Enumeration comes from `mdn-data` (666 properties, 493 standard). The supported set is read out
of `expandDeclaration()`'s `case` labels in `src/compiler/css.ts` rather than a hand-kept list,
because a hand-kept list is a second source of truth that drifts the first time someone adds a
property.

## It refuses to print a percentage, on purpose

**The denominator is the whole point.** A raw diff against standard CSS leaves ~376 unsupported
properties, including `anchor-name`, `view-transition-name` and `scroll-timeline` — things a UI
framework will never want. A percentage against that is not merely useless; it makes deliberate
non-goals read as unfinished work, which is the opposite of what ROADMAP says to communicate.

So until `guards/css-coverage/in-scope.txt` exists, the tool prints counts and **no percentage**. A made-up
denominator is worse than no number.

ROADMAP A1 defines the real denominator: Tailwind's utility surface, curated to ~200 cases. When
that corpus is written, put its properties in `guards/css-coverage/in-scope.txt` (one per line, `#` comments)
and the percentage appears — the same denominator `conformance` uses, so the two cannot disagree.

## Buckets

- **supported** — parsed today. 53 at the time of writing.
- **unsupported** — everything else that is standard and not a committed non-goal.
- **out of scope** — floats, tables, writing modes, fragmentation, multi-column, print, ruby,
  speech. ROADMAP commits to these as non-goals; they are listed as *features*, not gaps.

Also reported: properties dziry parses that `mdn-data` does not list as standard. That number
should stay near zero — if it grows, either the compiler is accepting something invented, or the
extraction regex has started matching a different switch statement. It did exactly that once,
counting `px`, `rem` and `auto` as supported CSS properties.

## Related

`conformance` measures whether a supported property is *correct*. This measures whether it exists
at all. A high coverage number with a low conformance number is worse than the reverse.
