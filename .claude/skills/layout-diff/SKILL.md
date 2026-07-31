---
name: layout-diff
description: Use Chrome as an oracle for laid-out geometry — feed the same html+css to dziri and to headless Chrome, lay both out at the same viewport, and compare every box. Use when a frame is arranged wrongly rather than styled wrongly, after changing anything in layout.rs or Taffy style construction, when working on text wrapping, sizing, padding, flex distribution or the box model, and before claiming a layout behaviour matches CSS. Runs `bun run layout-diff`.
---

# layout-diff

`conformance` asks Chrome what a declaration **computes to**. That cannot catch a box in the wrong
place, because every input can compute correctly and still be arranged wrongly. Text wrapping is
the whole of that class: `width: 200px` computes to `200px` on both sides and then one of them puts
the sentence on three lines and the other on one.

So this compares **geometry**, not values. Same html+css to both engines, same viewport, walk both
trees, compare `x`/`y`/`w`/`h`.

```bash
bun run layout-diff                    # whole corpus
bun run layout-diff --only wrap        # substring filter on the scenario name
bun run layout-diff --verbose          # print scenarios that agree too
bun run layout-diff --tolerance 1.5    # px; default 0.5
```

Requires a built engine (`bun run engine`) — it drives the real `Engine.open` / `Uploader` /
`tick()` path, not a simulation. Exits non-zero if anything differs.

## Reading the output

| Line | Means |
|---|---|
| `ok` | agrees within tolerance (`--verbose` only) |
| `DIFFER` | same tree, different geometry — the finding you want |
| `SHAPE` | the two walks are not walks of the same tree; that scenario stops |
| `BROKE` | the scenario never produced two walks (compile failed, CDP failed) |

`SHAPE` stops the scenario deliberately. Comparing geometry across trees that are not the same tree
produces confident nonsense — every row after the misalignment is garbage that looks like data.

Each `DIFFER` prints the scenario's `asks` line, so a failure explains what it was for without
reading the corpus. `[chrome 3 lines]` on a text row is Chrome's line-box count — the fastest way
to see that a wrap difference is a wrap difference.

## Chrome gets a reset; dziri does not

dziri ships no default stylesheet, so `RESET` spells out dziri's own `INITIAL_STYLE` as CSS —
flex-column defaults, zero margin/padding/border, pinned font. Chrome needs the rules because they
are not its defaults; dziri needs none because they *are* its defaults. `RESET` is injected only
into Chrome and is never part of a scenario's css, so a scenario cannot accidentally test the reset.

**The reset is itself capable of faking a bug.** It scopes to `body, body *` and not `*` because
`*` also matches `head`, `style` and `meta`, whose `display: none` comes from the UA stylesheet —
`* { display: flex }` overrides it and Chrome renders the scenario's own CSS as visible text above
the body. That reads as an 84px offset on every box in the document and looks exactly like a layout
bug. If you widen the reset, check node 0 first.

## Text rows are compared on `y` and `h` only

Never on `x`/`w`. dziri makes a text run a real node that stretches to its container; Chrome makes
it an anonymous flex item with no box you can measure. Their heights and positions are the same
question; their widths are not the same measurement.

Do not "fix" this by comparing widths with a loose tolerance. That is a lenient normaliser, and it
turns a real bug into a pass. The container is an ordinary element one row up and its width *is*
compared directly — which is what "was the text given the right space" actually means.

`line-height` is deliberately left alone on both sides. Both compute `normal` from font metrics,
and if they disagree about what `normal` means, that is a finding, not noise to normalise away.

## `boxes-no-text` is the control

It is first and it has no text. If the control disagrees, the harness or the reset is wrong and
every other row in the run is untrustworthy — read it before reading anything else.

## Current state (2026-07-31)

`3/7 agree, 4 differ`. All four differ on `h` only, and all four are **one** bug: there is no text
wrapping (commit `bfb67df`). Chrome puts the sentence on 2–3 lines, dziri keeps it on one, so every
text row and every ancestor is short by the missing lines. When wrapping lands, all four should go
green together — if only some do, the rest are separate bugs.

## Traps found while building and running it

**The engine it measures is the built one, not the source.** `layout-diff` loads the compiled
`target/release` engine. On 2026-07-31 it reported a `w 424 vs 400` box-sizing divergence on the
control that the Rust source had *already fixed* — the dll was stale. Run `bun run engine` before
believing a geometry finding, especially one that contradicts a comment in `layout.rs`.

**Bun's error excerpt contains the word `Error`.** Extracting a compile failure with
`/error|Error/` matches the source line `throw new Error(...)` that Bun prints in its excerpt, so
the tool reports the compiler's own source instead of what it said. Match `^error:` — Bun's actual
message marker. This produced a `BROKE` line reading `167 | throw new Error(...)`, which is
maximally unhelpful and cost real time.

## Not yet supported

There is no way to mark a scenario as a **known** divergence. Every difference is scored as a fresh
failure, so the four wrapping rows will read as failures until wrapping lands, and a known
divergence that silently starts passing looks like noise reduction rather than news. If the corpus
grows past the point where the whole output can be read at once, add it.

## Related

`conformance` covers computed values, `golden` covers pixels, `html-coverage` covers per-element
defaults. This covers arrangement — the gap between "the right style" and "the right picture".
Failures here and in `golden` look identical from the outside; when one is clean, run the other.
