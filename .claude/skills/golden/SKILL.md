---
name: golden
description: Visual regression for the renderer — render scenarios headlessly and compare against blessed PNGs. Use after changing anything in native-src/dziry-engine/src/paint.rs, layout.rs or text.rs; after touching the cascade, style interning or variant/patch machinery; after upgrading skia-safe or Taffy; and before committing any change that could alter what a frame looks like. Runs `bun run golden`.
---

# golden

The failure class this catches is the one the architecture review keeps naming: **a wrong-looking
frame rather than a crash**. Nothing else in the repo notices it.

The pieces existed and were never connected — `app.ts` already renders one frame headlessly and
exits, and `--patch/--hover/--focus` already drive state without a window. What was missing was a
blessed baseline and a diff.

```bash
bun run golden            # render + compare, exit 1 on any change
bun run golden light      # one scenario
bun run golden --accept   # bless current output
bun run golden --keep     # keep .actual.png even when passing
```

## Scenarios

| name | flags | why |
|---|---|---|
| `base` | — | the default frame |
| `light` | `--patch 0` | `.light` — paint-only, ~46 style writes, no relayout |
| `compact` | `--patch 1` | `.compact` — triggers relayout |
| `light-compact` | `--patch 0,1` | both, where a patch-ordering bug would show |

Add a scenario by appending to `SCENARIOS` in `scripts/golden.ts`. `--hover N` and `--focus N`
take node ids and are available but unused, because a hard-coded id is a hidden dependency on the
tree not changing.

## Reading a failure

On a diff it writes `golden/<name>.actual.png` beside the expected one — **look at them**. The
report tells you which kind of change it is:

- **DIMENSIONS CHANGED** — a layout or window-size change, not a paint change. Usually the more
  serious of the two.
- **same dimensions** — a paint change. Could be one colour, could be everything.

Comparison is byte-exact on the PNG. That is sound because the encoder is deterministic for
identical input, and it means a one-hex-digit colour change is caught (verified 2026-07-31). It
does *not* quantify how much changed — there is no pixel-level diff yet, so "3 pixels moved" and
"the whole frame is wrong" report identically. Adding that would mean decoding the PNGs, most
cheaply via the `browser-oracle` Chrome harness.

## Blessing

Only after looking at the `.actual.png`. `--accept` on an unreviewed diff converts a regression
into a baseline, silently and permanently — which is worse than not having the tool.

`golden/*.png` belongs in git; `*.actual.png` does not (it is deleted automatically once a
scenario passes again).

## Related

Pairs with `characterize`: that one proves the **IR** did not change, this one proves the **pixels**
did not. Pixels changing while the IR did not is an engine bug. The IR changing while pixels did
not is usually interning or dead-slot churn — harmless, but worth understanding before blessing.
