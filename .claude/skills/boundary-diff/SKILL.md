---
name: boundary-diff
description: Validate the shared-memory tables Bun is about to hand the engine — link consistency, index ranges, sibling-chain cycles, list arena bounds — and optionally cross-check against the engine's computed geometry. Use when a frame looks wrong with no error, when the engine reports a malformed table or a traversal-budget abort, after changing the emitter, list splicing, relinking or `hidden`, and when debugging anything that crosses the TS/Rust boundary. Runs `bun run boundary-diff`.
---

# boundary-diff

Debugging across the TS↔Rust boundary is the worst part of this project, and cross-language
corruption presents as **a wrong-looking frame with nothing to grep for**.

The engine already treats Bun-written memory as untrusted input — traversal budget, explicit
stack, a bad string slot reading as `""` — so a malformed table is an error over there rather than
a hang. But that error is about *the engine's traversal*, not about which node the compiler
mislinked. This says which node.

```bash
bun run boundary-diff                              # validate app/ui.gen.ts
bun run boundary-diff guards/characterize/golden/x.gen.ts # any emitted module
bun run boundary-diff --live                       # also start the engine and compare
```

## Static checks (verified)

- `parent` / `firstChild` / `nextSibling` in range
- `style` slot within the style table; `text` slot within the string table
- every child's `parent` points back at the node whose chain it is in
- sibling chains do not cycle and are not longer than the table
- list arenas fit inside the node table; `active <= capacity`; `dataOffset >= 0`
- unreachable rows that still claim a parent

## Dormant arena rows are not a bug

Rows inside a list arena are unreachable **by design** until spliced in, and they carry a parent
the whole time. That is what lets `relink_nodes` link them without styling them, and it is why
`apply_all_styles` walks table *capacity* rather than the reachable tree.

The first version of this checker did not know that and reported 48 "problems" against a perfectly
healthy app. Arena spans are now excluded and counted separately — `77/125 reachable, 48 dormant
arena rows` is the healthy state, not a warning.

If you are adding a check here, assume the codebase is right and your check is wrong until proven
otherwise. This one was.

## `--live` checks (verified)

Starts the engine on the same tables and compares its computed geometry against what the tables
claim: a `hidden` node with non-zero bounds, or a reachable visible node laid out at 0x0.

It follows `app.ts`'s exact sequence — `Engine.open(capacitiesFor(ui), …)`, `new Uploader(…)
.uploadAll()`, `tick()` — because a differently-initialised engine would make any disagreement
meaningless. Offscreen (`windowed: false`), so it opens no window.

If the engine is not built it reports `live skipped — <reason>` and exits on the static result. It
fails closed and cannot produce a false pass.

**What a live failure actually means.** Both sides read the same tables, so they agree unless
something wrote to the Bun-side arrays *without re-uploading*. That is the real bug class: a
binding, patch or list relink that mutates the IR and does not mark dirty. Verified 2026-07-31 by
injecting exactly that — set `nodes.hidden[n] = 1` after `uploadAll()`, and the check reports the
engine still giving that node 1004x523.

Dormant arena rows are excluded from the 0x0 check for the same reason as the static half: they
have no geometry because they are not linked in yet.

## Related

`protocol-guard` proves the two sides agree about the table *layout*. This proves the *contents*
are well-formed. Both failures look identical from the outside — wrong pixels — so when one is
clean, run the other.
