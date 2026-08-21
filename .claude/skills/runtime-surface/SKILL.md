---
name: runtime-surface
description: Hold dziry's runtime to a ratchet — exported symbols and bundled bytes may fall freely and may not rise without editing the baseline in the same commit. Use before adding anything to src/runtime/, when reviewing a design that would add runtime state or a per-frame cost, when a feature is claimed to "need" to be dynamic, and to check whether the runtime is actually shrinking. Runs `bun run runtime-surface`.
---

# runtime-surface

The governing rule is that nothing stays dynamic unless it is proven it must. Until this, that rule
was enforced only by `compile-time-gate` — a text skill, applied by judgement, one decision at a
time, with no memory. Nothing noticed a runtime growing fifty lines a week, because no single week
looked like a violation.

This is the same rule with a memory.

```bash
bun run runtime-surface           # check against the ratchet
bun run runtime-surface --list    # name every exported symbol
bun run runtime-surface --bless   # record current numbers as the new limit
```

## The ratchet

Two numbers are committed to `runtime-surface/baseline.json`. They may **fall freely**. They may
**not rise** without re-blessing in the same commit — which forces the growth into a diff someone
can argue with. That is the entire mechanism, and it is the point: a principle you cannot regress
against is an aspiration, not a rule.

| Number | Tolerance | Why |
|---|---|---|
| exported symbols | **zero** | what the rest of the system can reach at runtime; cannot be gamed by reformatting |
| bundled bytes | +2% | catches a flat symbol count hiding doubled code, but is not purely ours — a Bun upgrade moves it |

The Bun version is recorded beside the bytes, so a jump explains itself instead of reading as a
regression. If bytes fail and the version differs, check the bundler before blaming the design.

`SLACK` is not a failure. It means the numbers fell and the ratchet is now looser than reality —
re-bless to tighten it, or the next regression has room to hide.

## What counts

- `src/runtime/*.ts`, excluding `*.test.ts`. Tests never ship, and counting them would make writing
  a test look like a violation of the rule, which teaches exactly the wrong lesson.
- **Type-only exports do not count**, because they are erased and are therefore not runtime surface.
  That falls out of using Bun's transpiler scan rather than a regex over the word `export` —
  verified by adding `export type` alongside two real exports and watching the count rise by 2.

## Bytes are measured through one barrel, not four bundles

Building each runtime module as its own entrypoint inlines the shared ones into every output —
`signal.ts` lands inside `bindings.js` *and* `list-runtime.js` *and* `patches.js`. Summing those
outputs reported **15,556 bytes** against a real figure of **10,050**: a 55% overcount of the
thing the tool exists to hold down. One synthetic barrel makes the bundler resolve the graph once,
which is what an app importing the runtime actually gets.

## Per-frame allocations are missing, deliberately

They are the closest measurement to the actual principle — work done on every tick that could have
been done once — and they need instrumentation inside the engine. That is not being added while
the engine is under active change, because it would measure the scaffolding. Left as a stated hole
rather than approximated: a bad proxy for the most important number is worse than an admitted gap.

Revisit when `text.rs` / `paint.rs` settle.

## Current state (2026-08-01)

20 exported symbols, 10,050 bytes, across `bindings.ts`, `list-runtime.ts`, `patches.ts`,
`signal.ts`. Worth knowing while reading that number: `list-runtime.ts` imports real values from
`../ir.ts` and `../compiler/item-path.ts`, so the runtime reaches into the compiler and those bytes
ship too.

## Verified by

Four injected faults, four correct outcomes: a new runtime export fails and is named; an
`export type` alongside it is correctly ignored; a baseline left loose reports `SLACK` without
failing; bytes pushed past the tolerance fail and cite the limit.

## Related

`compile-time-gate` is the judgement half of this rule and still applies to the design question
this cannot answer — whether a given thing *should* be dynamic. This only answers whether the total
went up. `bench` measures what the dynamic parts cost per frame.
