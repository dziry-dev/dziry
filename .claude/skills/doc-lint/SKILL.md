---
name: doc-lint
description: Verify that `file.ext:LINE` citations in the Markdown docs still resolve. Use after deleting, renaming or moving any source file; after a refactor that shifts line numbers; before committing changes to ARCHITECTURE-REVIEW.md, ROADMAP.md, NOTES.md, API.md or framework-design.md; and whenever a doc's claim about code is being relied on for a decision. Runs `bun run doc-lint`.
---

# doc-lint

This repo's docs are unusually citation-dense — 1,800+ references like `engine.rs:402`,
`signal.ts:86,159`, `app.ts:115-118`. They rot silently, and a stale citation is worse than no
citation: on 2026-07-31 a cited comment turned out to state the *opposite* of what the doc
claimed, and an API design was built on it before anyone read the code.

```bash
bun run doc-lint          # full report, exit 1 if anything is broken
bun run doc-lint --quiet  # failures only
```

## Reading the output

**ROT** — the path was tracked by git and no longer resolves. Always a real problem: the file was
deleted or moved and the doc was not updated. Fix the doc, or delete the claim if it no longer
applies.

**OUT OF RANGE** — the file exists but is shorter than the cited line. Usually means code moved;
find where it went and update the number.

**outside the repo** — citations into dependency source (`taffy-0.9.2/…`, `skia-safe-0.87.0/…`,
`blitz-dom/…`, SDL3 internals). These are research references and were never in this repo, so they
are reported for information and never fail the run. Git history is what separates these from rot.

**resolved by basename with >1 match** — `compile.ts` is both `src/compile.ts` and
`src/compiler/compile.ts`. When ambiguous the linter prefers a candidate the cited line actually
fits inside, which is right almost always but is a heuristic. If a citation looks wrong and the
basename is ambiguous, check by hand.

## What it cannot do

It verifies the citation *resolves*, not that the cited line still says what the prose claims.
That is the failure that actually caused damage, and it needs a human reading both. Treat a clean
doc-lint as "no dangling references", not "the docs are accurate."

## When you fix rot

Prefer updating the citation to deleting it — the line number is usually the most valuable part of
these docs. If the code genuinely no longer exists, say so in the prose rather than silently
dropping the reference, since a future reader may need to know the claim was once true.
