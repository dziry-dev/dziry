---
description: Grow the UA stylesheet until html-coverage stops improving
---

Grow dziry's UA stylesheet until `html-coverage` stops improving.

Run this with `/loop /ua-loop` to self-pace it, or plain `/ua-loop` for a single pass.

## Each pass

1. Run `bun run html-coverage` and note the `N differ` count.
2. Pick the element with the most findings that are **not** `no field` lines. A `no field`
   finding needs a `STYLE_FIELDS` entry that does not exist, and adding one touches `src/ir.ts`,
   the wire protocol and Rust paint code — out of scope here.
3. Add the minimal rules to `src/compiler/ua-sheet.ts`, using the exact Chrome values
   `html-coverage` reports, grouped under a comment naming the element and the finding count.
4. Re-run `html-coverage`. **If `N differ` did not drop, revert the edit** and try the next
   element. A rule that does not move the number is a rule nobody asked for.
5. Verify: `bun run check`, `bun test src/compiler/`, `bun run characterize`, `bun run golden`.
   Drift in characterize or golden is allowed but must be re-blessed deliberately and called out —
   never regenerated on autopilot.
6. Commit with a pathspec: `git commit -- src/compiler/ua-sheet.ts <any re-blessed baselines>`.

## Hard constraints

- **Only edit `src/compiler/ua-sheet.ts`** and baseline files you deliberately re-bless. Other
  sessions work in `src/`, `native-src/` and `src/compiler/*.ts`; touching those collides.
- **Always commit with a pathspec.** The git index is shared with other sessions — a bare
  `git add` has already swept another session's staged work into a commit once.
- **Never** add a rule for a property `html-coverage` reports as `no field`.
- **Never** add an entry to any `KNOWN` table to make a run green. That table records decisions
  already made elsewhere; using it to silence a finding is the one thing it must not do.

## Stop condition

Stop when the differ count fails to drop for two consecutive passes. Report the starting count,
the final count, and which elements remain and why.

## Watch for

- **`em` does not mean what Chrome means.** `css.ts:1056-1059` resolves `em` against the root's 16px,
  not the element's own font-size. Chrome's sheet writes headings as `2em` with `0.67em` margins;
  copying that computes 10.72px where Chrome computes 21.44px. Use px, and remember px values
  encode a 16px root.
- **An element can leave `differ` for `known only`** rather than `already match`, when its last
  remaining difference is an accepted one. That still counts as progress.
- **Style interning shifts indices.** Giving an element a non-inherited property can stop it
  sharing a style slot with its own text run, which renumbers every later slot and will fail
  `cascade.test.ts`. That is the interner working; explain it in the snapshot rather than
  renumbering silently.

## History

| Pass | Result |
|---|---|
| mechanism (`94e1457`) | 45 → 42 |
| headings (`6b9fbe2`) | 42 → 36 |
