---
name: characterize
description: Freeze the compiler's current output as golden files so refactors are provably behaviour-preserving. Use BEFORE refactoring anything in src/compiler/ or src/ir.ts, before milestones M1-M5, after changing the cascade, variants, list arenas, style interning or the emitter, and whenever you need to know whether a change altered compiled output. Runs `bun run characterize`.
---

# characterize

~4,000 lines of compiler have no unit tests, and the review found bugs there that **ship a wrong
artifact and print a success line**. Writing correctness tests for all of it is a large job.
Freezing its current output is a small one, and it is what makes a refactor safe.

```bash
bun run characterize            # compile every case, diff against golden
bun run characterize cascade    # one case
bun run characterize --accept   # bless current output as the new golden
```

## What it does and does not claim

It asserts the output **has not changed**. It does not assert the output is **correct** — a
blessed golden can happily encode a bug. That is the deliberate trade, and it is what makes the
tool cheap enough to exist.

So a diff is a **question**, not a verdict: *did you mean to change this?* Read it. If the change
is intended, `--accept`. If it is a surprise, you just caught a silent miscompile — which is the
whole point.

## Cases

- `app` — the real application. Highest value: grid with spans, flex with grow/shrink/basis, a
  keyed list with per-row handlers, conditional classes compiled to patches, derived values,
  inline styles.
- `characterize/cases/<name>.{tsx,html}` + `<name>.css` — focused cases. `cascade.html` covers
  specificity, inheritance, shorthand expansion and a deliberate specificity tie that source order
  has to break.

Add a case whenever you fix a compiler bug: the case that reproduced it becomes the case that
stops it coming back, and it costs two files.

## Goldens are committed

`characterize/golden/*.gen.ts` belongs in git. The diff in a pull request *is* the review artifact
— it shows exactly which style slots, node links or bindings a change moved. Verified deterministic
2026-07-31: compiling the same input twice is byte-identical.

## Reading a diff

Output is generated TypeScript full of typed arrays, so the diff points at the first divergent
line with context:

```
  -21  fg: new Uint32Array([4293190887,4294243573,4288782762,…])
  +21  fg: new Uint32Array([4293190887,4294243573,4294901760,…])
```

Index positions in these arrays are node or slot indices, so the position tells you *which* node
changed, not just that something did.

## Related

Pairs with `golden` (visual regression): characterize proves the **IR** did not change, golden
proves the **pixels** did not. A change that alters pixels without altering the IR is an engine
bug; one that alters the IR without altering pixels is usually interning or dead-slot churn.
