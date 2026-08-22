---
name: html-coverage
description: Compare how each HTML element renders in dziry versus Chrome, producing the difference table that specifies the default stylesheet. Use when writing or extending dziry's default/UA stylesheet, when adding an HTML element, when deciding which CSS properties STYLE_FIELDS still needs, and to check progress on HTML-ELEMENT-COVERAGE-RESEARCH.md's tiers. Runs `bun run html-coverage`. Requires `bun run mdn:sync` first.
---

# html-coverage

```bash
bun run html-coverage                  # the difference table
bun run html-coverage --only h1,ul,em  # a few elements
bun run html-coverage --same           # also list elements that already match
bun run html-coverage --known          # show accepted divergences and why
```

## Known divergences are subtracted from the backlog

The headline number used to be two unrelated things added together. `<p>` differs because dziry
has no default stylesheet yet — a real gap, and the reason this tool exists. `<address>` differs
because dziry has no block layout, deliberately and permanently. Printed identically, they forced
every reader to re-derive which was which.

`KNOWN` in the script names the second kind. Today two entries account for **37 findings across 17
elements**, which is why the count reads `42 differ · 17 known only` rather than `59 differ`. 42 is
the backlog.

Three properties keep it from rotting into a suppression list:

- **every entry carries a reason and the reason is printed** — `--known` shows them, and the
  accepted count is always in the summary, so the exemptions cannot go quiet;
- **an entry matching nothing fails the run** — this is the only way this tool exits non-zero, and
  it is deliberate: 59 differences are a report, a stale exemption is a defect in the report;
- **nothing goes in without being decided elsewhere first** — both current entries cite where
  (`src/ir.ts` for flex-column, the absent `font-family` field for the other). This table records
  decisions, it does not make them. A tool that can shrink its own backlog by fiat is worthless.

The stale check is skipped under `--only`, because a filtered corpus makes a live entry look unused.

Why an entry and not a comment: `layout-diff`'s box-sizing note was true when written, became false
hours later when the engine changed, and nothing noticed for an afternoon. An entry expires loudly.

Unlike `css-coverage`, this cannot be static analysis. dziry has no per-element table — it treats
elements as generic boxes — so "supported" is not a lookup, it is a **behaviour**: is `<h1>` bold
and larger, does `<ul>` indent, is `<strong>` distinguishable from `<span>`.

## The output is the default stylesheet's specification

Output is a difference table, not pass/fail, and that is deliberate: dziry ships no default
stylesheet, so a pass/fail run would be uniformly red and tell you nothing.

```
  <h1>
      display: chrome block · dziry FLEX
      font-weight: chrome 700 · dziry 400
      font-size: chrome 32px · dziry 16
      margin-block-start: chrome 21.44px · dziry 0
```

That is four CSS declarations, dictated. Write the rule, re-run, watch the row disappear.

At the time of writing: **59 differ · 22 already match · 29 out of scope · 22 not rendered.**

## `no field` means the property does not exist yet

A `no field · font-style=italic` line means dziry has no way to express the property at all — it
is not in `STYLE_FIELDS`, so no rule can set it. Those are the ~10 missing properties
`HTML-ELEMENT-COVERAGE-RESEARCH.md` lists, surfaced per element instead of as a flat list, so you
can see which elements each one unblocks.

Four properties are tracked this way: `font-style`, `font-family`, `list-style-type`,
`text-decoration-line`.

## Why some things are filtered out

Each filter exists because without it the table drowned in true-but-useless rows.

- **`inline` is counted once, not per element.** dziry has no inline layout — a committed
  non-goal — so `inline` vs `FLEX` would appear on ~40 elements as if it were 40 tasks. It is one
  architectural divergence, reported at the bottom. `block`, `list-item` and `none` stay
  per-element, because a stylesheet genuinely has to set those.
- **A `no field` property is only reported when Chrome's value differs from the CSS *initial*
  value.** `list-style-type` is `disc` on *every* element by initial value, but only renders a
  marker where `display: list-item` — so it is reported only there. Same idea for
  `font-style: normal` and `text-decoration-line: none`.

## Probe markup has real subtleties

- **Void elements** (`br`, `hr`, `img`, `input`) get no closing tag. `<br>x</br>` fails to parse.
- **Some elements need attributes.** `<a>` gets `href="#"` because Chrome's underline comes from
  `a:-webkit-any-link` — a bare `<a>` is not a link and reports no underline, which read as
  "already matches" until it was fixed.
- **`h1`–`h6` come from a `GROUPED` map** because MDN documents them in one `heading_elements`
  directory. Without it, headings were missing from the enumeration entirely — the single most
  important thing a default stylesheet sets.

If an element reports "already match" and you doubt it, check the markup first.

## Related

Enumeration comes from `guards/vendor/mdn` (`mdn:sync`). Measurement shares `cdp.ts` with `conformance`
and `browser-oracle` — installed Chrome or Edge, headless. `conformance` asks whether a *property*
is right; this asks whether an *element* looks right.
