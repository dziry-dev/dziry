---
name: protocol-guard
description: Prove the shared-memory protocol's two halves still agree. Use after any edit to src/protocol/schema.ts, before committing changes that touch the protocol, FFI symbols, style fields or enums, whenever the Rust side fails to find a constant that exists in schema.ts, before any release or packaging step, and when debugging wrong-looking pixels or values that appear at valid offsets. Runs `bun run protocol-guard`.
---

# protocol-guard

Risk #1 in ROADMAP is shared-memory layout drift: a stride or field-order disagreement corrupts
**silently** rather than raising a type error, and shows up as inexplicably wrong pixels.

`gen-protocol.ts` removes the authoring half of that by generating both sides from `schema.ts`.
What it never removed is the *regenerate-and-forget* hole — the generated files can sit stale in
the tree while `schema.ts` moves on. That happened on 2026-07-31: `schema.ts` was at v5 while
`generated.ts` and `protocol.rs` were still v4, and Rust could not find a newly added enum
constant. **If Rust cannot find something that plainly exists in `schema.ts`, this is why.**

```bash
bun run protocol-guard          # check, exit 1 on drift
bun run protocol-guard --fix    # regenerate in place, then re-check
```

## The four checks

1. **`PROTOCOL_VERSION` agrees** across `schema.ts`, `generated.ts` and `protocol.rs`.
2. **`SCHEMA_HASH` agrees** between `generated.ts` and `protocol.rs`. The hash is structural —
   field names, order and types — so it catches a rename or a retype that keeps the field *count*
   identical, which is exactly the change a count-based handshake misses.
3. **Regenerating is a no-op.** Anything else means someone forgot to run codegen, or hand-edited
   a generated file.
4. **The built binary agrees with the source.** Loads the engine and calls
   `dziry_protocol_version` / `dziry_schema_hash`. This is the one that catches a stale
   `dziry_engine.dll` — source can be perfectly self-consistent while the binary was built before
   the last schema change, which is the same corruption arriving by a different route.

Check 4 resolves the library exactly as `engine/host.ts` does — cargo's `target/release` first,
the packaged `native/<platform>-<arch>/` copy second. Checking a different path than the app loads
would make the check a lie. If the engine is not built it is skipped, not failed.

## It never mutates without `--fix`

Generation writes in place, so the guard snapshots both files, regenerates, compares, and restores.
A checker that changes the tree as a side effect of checking would be its own hazard. Only `--fix`
keeps the regenerated output.

## Wire it in

Belongs in `bun run check` and in CI. It is fast, has no dependencies, and the failure it prevents
is the one the whole shared-memory design is betting against.

Verified 2026-07-31 against three deliberate drifts — a version mismatch, a hand-edited generated
file, and a source/binary hash mismatch — all detected, with the tree left byte-identical after
each run.
