---
name: spec-audit
description: Check dziry's computed-style defaults against the CSS spec using mdn-data — initial values and inheritance flags for every field in STYLE_FIELDS. Use after adding or changing a style field, after editing INITIAL_STYLE or INHERITED_FIELDS in src/ir.ts, when a property behaves oddly with no rule setting it, and before claiming CSS conformance. Runs `bun run spec-audit`.
---

# spec-audit

`INITIAL_STYLE` is a spec artifact — it is meant to hold each property's CSS **initial value**.
A wrong initial value or a wrong inheritance flag produces a wrong-looking frame with nothing to
blame, the same silent class as a wrong byte offset, and nothing else in the repo checks it.

The oracle is **`mdn-data`** — the JSON that MDN's own "Formal definition" tables are generated
from. Pinned in `package.json`, offline, no scraping. Note this is upstream of MDN's prose: the
docset or the website would be a *rendering* of this data.

```bash
bun run spec-audit         # report, exit 1 on an unexplained divergence
bun run spec-audit --all   # also list the fields that agree
```

## Three buckets

**agree** — dziry matches the spec. Nothing to do.

**deliberate** — a divergence that is a decision, listed with its reasoning in the `DELIBERATE`
table in `scripts/spec-audit.ts`. These are **listed, not skipped**, on purpose: the point of an
audit is that a *new* divergence cannot hide among the known ones. If you skip them they stop
being visible and start being folklore.

**to explain** — either a bug, or a divergence that has not been written down yet. Exit 1.

## Resolving a "to explain"

Ask in this order:

1. **Is the comparator wrong?** dziry stores integers and sentinels; the spec says keywords. Two
   of the first four findings were this — `nowrap` is `FlexWrap.NO_WRAP` (0) and `normal` is
   font-weight 400. Keyword mappings live in `KEYWORD`, deliberately **field-scoped**, because
   `normal` means 400 for font-weight and 0 for a gap; one global table would have made one of
   those a silent false pass.
2. **Is it a real divergence we accept?** Add it to `DELIBERATE` with the reason and where the
   reasoning lives. `display: inline` → `FLEX` is one: there is no inline layout, so every box is
   a flex container.
3. **Otherwise it is a bug.** Record it in `BROWSER-FACTS.md` before fixing — the measurement is
   the durable part.

## It found a real one on its first run

`borderColor`'s initial value is `currentcolor` — the element's own `color` — and dziry had it as
transparent. So `border: 2px solid` with no colour is invisible in dziry and text-coloured in a
browser. Confirmed against Chromium 151 and recorded in `BROWSER-FACTS.md`.

Worth noticing *why* that fix is cheap: `currentcolor` looks dynamic and is not. The cascade
already resolves `color` per node at build time, so it is just that node's `fg`. Compile-time gate,
question 1, answered yes.

## Scope

Initial values and inheritance only. It does **not** check value parsing, shorthand expansion or
computed-value rules — those need `conformance`, which measures against Chrome rather than reading
the spec. The two are complementary: this catches what you never set, that catches what you set
wrongly.
