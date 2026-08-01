# dziri — architecture

> Generated from `architecture/data.ts` by `bun run arch:check --emit`. Do not edit.
> Run `bun run arch` for the interactive version.

A UI framework that resolves CSS, the cascade and every interaction state before the app runs, then hands a native Rust engine a block of shared memory instead of a call surface.

## Layers

- **Authoring** — What a person writes: JSX, a stylesheet, and module-level signals. None of it ships — the compiler evaluates it and keeps the result.
  <br>`app/`
- **Compiler** — Selector matching, specificity, cascade, inheritance, shorthand expansion, unit resolution and interning — all of it at build time, ending in integer arrays.
  <br>`src/compiler/`, `src/compile.ts`, `src/ir.ts`, `src/variants.ts`
- **Runtime** — The only code that survives to run time: signals, and the three things they drive — text bindings, style patches, list arenas. No parser, no cascade, no diff of a tree.
  <br>`src/runtime/`
- **Protocol & host** — The boundary. One schema generates both sides' field identities; the engine reports byte offsets at run time. Everything else is a direct write into shared memory.
  <br>`src/protocol/`, `src/engine/`, `src/app.ts`, `native-src/dziri-engine/src/protocol.rs`, `native-src/dziri-engine/src/tables.rs`, `native-src/dziri-engine/src/lib.rs`
- **Engine** — Rust cdylib: Taffy lays out, Skia paints, SDL3 owns the window and input. It reads Bun-written memory as untrusted input and never lets a panic cross back.
  <br>`native-src/dziri-engine/src/`, `native-src/dziri-engine/examples/`, `native-src/dziri-engine/tests/`, `native-src/dziri-engine/build.rs`
- **Guards & oracles** — The scripts that keep claims honest — Chrome as an oracle for CSS and layout, golden frames for paint, generated-vs-source checks for the protocol.
  <br>`scripts/`, `native-src/skia-probe/`

## The animated tour

`bun run arch` → **How it works**. Six mechanisms, in the order the ideas depend on each other. Each answers one question:

1. **One div, end to end** — Where is the boundary, and what has already happened by the time you reach it?
2. **The cascade, resolved once** — Does resolving CSS early lose anything?
3. **Why struct-of-arrays** — Why is the boundary memory instead of a call surface?
4. **The frame loop** — What does a frame actually cost, and what does an idle one cost?
5. **Hover costs one u16** — How can interaction state work with no selector matching at run time?
6. **Lists that never renumber** — How does anything dynamic work when the tree was decided at build time?

## The pipeline

### Build time — runs once, and none of it ships

#### app.tsx + app.css

*JSX, a stylesheet, and signals declared at module scope*

The authoring surface is ordinary JSX and ordinary CSS. State is a signal created at module scope and exported; a handler is a function that assigns to one.

There are two front-ends — JSX and HTML — and they land on the same `Element` tree, so everything after the parse is shared. JSX is the default; the HTML path is what existed first.


`app/app.tsx`, `app/app.css`, `app/state.ts`, `src/compiler/html.ts`


#### Evaluate, don't render

*Importing the module is running the components — once, at build time*

Bun transpiles the JSX against `src/compiler/jsx-runtime.ts`, so `await import(entry)` *is* the component pass. There is no renderer and no virtual DOM; the tree that comes back is the tree the compiler compiles.

While that import runs, `setCompiling(true)` changes what reading a signal means. An array-valued signal hands back a recording proxy that remembers its owner, so `todos.value.map(…)` compiles to a dynamic list instead of silently freezing whatever the initial data happened to be.

- The entry module is imported as a file URL — a bare relative path would resolve against the compiler.

`src/compiler/jsx-runtime.ts`, `src/compiler/jsx-dev-runtime.ts`, `src/runtime/signal.ts`, `src/compiler/item-path.ts`


#### Resolve the cascade

*Selectors, specificity, inheritance and shorthands collapse to numbers*

Each node's style is resolved as a full cascade from scratch — including each pseudo-state, rather than as a patch over the finished base. That is what makes correct per-property `hover ∧ focus` merging cheap later: the machinery that computes it already exists.

Values become integers and floats with fixed encodings. `auto` is NaN, `unset` in a u8 enum is 255, and a grid line of 0 decodes to `Auto` engine-side — coercing unset to variant 0 is what silently collapsed grid items in the spike.

- 1215 nodes compile in ~28 ms.

`src/compiler/compile.ts`, `src/compiler/css.ts`, `src/ir.ts`

> **Do not undo.** Resolve each pseudo-state as a full cascade, not a diff over the base. The merge story depends on it.

#### Precompile the interaction states

*Every toggle and pseudo-state becomes a list of style-table writes*

A conditional class is not resolved at run time. The compiler runs one extra full compilation per toggle and diffs it, so `.light` becomes 46 writes and `.compact` becomes 6 — each a `(field, slot)` pair, with slots interned over the *vector* of values across all variants rather than per-variant.

That interning is what makes conflict detection possible: two toggles writing the same `(field, slot)` cannot both be correct, because the result would depend on apply order rather than on specificity. The compiler exits non-zero rather than shipping it.


`src/compiler/variants.ts`, `src/compiler/variant-compile.ts`, `src/variants.ts`

> **Do not undo.** Patch the style table per (field, slot). Do not 'simplify' to swapping per-node style pointers — conflict detection and the predicate-mask table both depend on it.

#### Map live objects back to exports

*`{count}` and `onClick={increment}` become named imports*

Bindings and handlers reached the tree as live JavaScript objects. They are matched back to the exports they came from by *identity* — not by a naming convention — so the generated module can import them by name.

Object identity is the only mechanism that answers 'is this a signal?' at build time without asking the author to follow a rule.


`src/compiler/resolve-refs.ts`


#### Emit app/ui.gen.ts

*Typed arrays, `satisfies CompiledUi` — the artifact is the IR*

The output is a TypeScript module of typed arrays plus the imports resolved above. It is not serialized data that something parses; it is the in-memory representation already.

It declares `satisfies` against the runtime's own types, so a field the compiler renames is a compile error in the artifact rather than a `TypeError` in whichever test touches it first.

- Untracked by git — a build artifact; tracked would mean an 18 KB integer diff per style change.

`src/compile.ts`, `src/ir.ts`


### The boundary — shared memory, described at startup

#### dlopen and describe

*The engine allocates; Bun wraps each field span as a typed-array view*

Layout is struct-of-arrays: every field is its own contiguous span. The engine owns the allocation and reports a `(byteOffset, elementSize, capacity)` descriptor per field; Bun calls `toArrayBuffer` over each one with **no finalizer**, because the memory is Rust's.

Field *identity* is generated into both sides from one schema, and the engine also reports a schema hash. Neither side hardcodes the other's layout — a startup handshake detects a wrong layout, but generation is what prevents 'field inserted, offset forgotten, release build, silent corruption'.

The handle is a `u32` — an index plus a generation into a table the engine owns — so a handle used after `close()` is a lookup miss rather than a dereference of freed memory.

- The descriptor reports absolute pointers, not (base, offset) — there are three arenas.

`src/protocol/schema.ts`, `src/protocol/generated.ts`, `src/engine/host.ts`, `native-src/dziri-engine/src/protocol.rs`, `native-src/dziri-engine/src/lib.rs`

> **Do not undo.** The arena stays a bare `*mut u8`, with slices materialised only inside function bodies. No Rust reference into shared memory may be live across a return to Bun.

#### Write into the staged arena

*A style patch is a memory write, not a call*

This is the point of the whole design: a style patch, a list relink, a `hidden` byte and a string are all direct writes through typed-array views. The FFI surface is `host.ts` and nothing else.

The uploader is deliberately unconditional about *which* tables it writes, because the engine's commit compares span by span and reports what changed — a second diff on this side would be the same work with less information. Strings are the exception, uploaded incrementally, because re-encoding every row of a long list per keystroke is not free.


`src/engine/upload.ts`, `src/app.ts`

> **Do not undo.** Keep the staged/live/bounds split and span-wise commit. This — not monomorphism — is the real argument for struct-of-arrays. Do not collapse to one arena; do not go AoS.

### Every frame — the loop

#### tick()

*The one FFI call per frame*

Bun drives the loop and calls `tick()`. Everything the frame needs is already in memory; the call carries no arguments beyond the handle.

A panic inside is caught and *poisons* the engine — every later call returns `POISONED` — because `catch_unwind` needs `AssertUnwindSafe` over `&mut Engine`, and that assertion is only honest if nobody can then observe half-updated state.


`native-src/dziri-engine/src/lib.rs`, `native-src/dziri-engine/src/error.rs`

> **Do not undo.** Keep the FFI boundary shape in full: catch_unwind, i32 status never a value, out-pointers, poisoning, and `panic = "unwind"` pinned in both Cargo profiles.

#### Input, then commit

*Span-by-span diff turns 'some bytes changed' into a narrow patch*

Input is pumped first, so a click staged by Bun last frame and a click arriving this frame are never resolved against different layouts.

`commit` compares the staged arena against the live one span by span and classifies what moved. This is what makes a `hidden` toggle a patch rather than a rebuild — under array-of-structs it would be neither cheap nor local.


`native-src/dziri-engine/src/tables.rs`, `native-src/dziri-engine/src/engine.rs`


#### Taffy

*Flex and grid, rounded to whole pixels, bounds published back*

The tree is walked with an explicit stack rather than recursion, child ids are range-checked, and traversals carry a budget — Bun-written memory is untrusted input, and a malformed table must be an error rather than a hang or a crash.

Taffy rounds layout to whole pixels by default, which is what stops boxes landing on half-pixel edges. Computed bounds are written back into the `layout` table, which Bun reads for hit-testing and the imperative API.


`native-src/dziri-engine/src/layout.rs`

> **Do not undo.** Keep the systematic distrust of host-written table contents: budgeted walks, range-checked ids, and a bad string slot reading as "".

#### Skia

*Raster paint; an idle tick presents nothing at all*

Paint reads the style table out of live memory as it draws, which is why a paint-only field needs no bookkeeping — the repaint that every non-empty commit already schedules is the whole response.

When nothing changed there is no draw and no present. The window keeps the last frame it was given, and not presenting is not the same as presenting nothing.


`native-src/dziri-engine/src/paint.rs`, `native-src/dziri-engine/src/text.rs`


#### Drain events → signals

*A click writes a signal; batching makes it one repaint*

Events come back through the same shared memory. A row's handler is found by decomposing the node into `(slot, offset)`; a plain handler is looked up by node.

Focus lives in the engine, because the engine owns input and is the thing that knows what was clicked. It rides along on the event rather than being mirrored on the Bun side.

Writes batch, so one click costs one repaint however many signals it touches — and the loop closes: signals → bindings, patches and lists mutate the IR in place → upload → tick.


`src/runtime/bindings.ts`, `src/runtime/patches.ts`, `src/runtime/list-runtime.ts`, `src/runtime/signal.ts`

> **Do not undo.** Append-and-abandon list growth: no node id is ever invalidated, which is the only reason focus survives a reorder.

A signal changing closes the loop: it mutates the IR in place, and the next upload carries it.

## The shared-memory boundary

Protocol version 6. Struct-of-arrays: every field is its own contiguous span.

| Table | Fields | Bytes/elem | Sized by | Written by | Read by |
| --- | --- | --- | --- | --- | --- |
| `nodes` | 9 | 23 | nodes | compiler, then list relinking and `hidden` | engine |
| `styles` | 52 | 156 | styles | compiler, then variant patches | engine, every frame |
| `variants` | 3 | 12 | own | compiler | engine painter |
| `variantSlots` | 1 | 2 | own | compiler | engine painter |
| `lists` | 7 | 28 | own | list runtime | engine |
| `layout` | 4 | 16 | nodes | engine | Bun — hit-testing and the imperative API |
| `strings` | 2 | 8 | strings | Bun, incrementally | engine |

- **`nodes`** — Link fields are prefilled to -1: zero is a valid node id, so zeroed memory would say every node is its own first child.
- **`styles`** — Style values stay zeroed, and there zero is real — `width: 0`, not auto. Auto is NaN.
- **`variants`** — Per interactive node: a bitmask of the predicates its styling reads, and where its style run begins.
- **`variantSlots`** — Entry runStart+i is the style for the predicate combination whose compacted bits equal i; entry 0 is the base style.
- **`lists`** — The one place node count is a run-time value. Arenas grow by appending; ids are never reused.
- **`layout`** — The only table that flows the other way.
- **`strings`** — JS strings cannot be shared, so Bun writes UTF-8 into an arena and records (offset, length) here.

## The six bets

### Compile-time CSS and cascade → integer IR — KEEP

> Nothing that can be resolved before the app runs should be resolved while it runs.

Every failure found was an implementation bug in an untested compiler, not a consequence of resolving early.

### Shared-memory SoA tables instead of FFI calls — KEEP

> The boundary should be memory both sides can address, not a call surface.

The mechanism is right and its real justification is stronger than the stated one: span-wise commit is what turns 'some bytes changed' into a narrow patch, and AoS would make a `hidden` toggle a full rebuild.

### Rust cdylib — SDL3 + Taffy + Skia — loaded from Bun — KEEP

> The engine belongs in a native library, not in JavaScript.

Taffy and Skia were chosen on measurements and both hold.

### Signal object identity + module-export reverse mapping — KEEP

> Identity answers 'is this a signal?' at compile time without a naming convention.

The 'per-instance state is unrepresentable' objection was refuted. What needs work is the diagnostic layer around it, not the mechanism.

### Precompiled interaction-state variants — KEEP WITH CHANGES

> Hover, focus and conditional classes are style-table patches computed at build time.

The single best idea in the compiler. The three fixed roles were the wrong shape and are being replaced by a predicate mask — the `variants` / `variantSlots` tables are that replacement.

### Fixed-stride arenas for dynamic lists — KEEP WITH CHANGES

> A list is a homogeneous subtree repeated at a stride, grown by appending.

Never invalidating a node id is exactly right. The wrapper node broke grid, the engine threw away link granularity, and `dataOffset` — the virtualization story — existed only in the IR.

## Roadmap

- **A0 · The engine** — *partial*. Crate landed: window, Taffy, Skia, structured errors, descriptor + tick, staging buffer, and the three old runtime files deleted. IME proof and the window-chrome decision remain; the render thread was withdrawn.
- **A1 · Tailwind conformance** — *planned*. Tailwind defines the CSS subset. Attribute selectors and `data-[state=]` are on the critical path.
- **A2 · Text** — *next*. There is no text wrapping. It is what makes a narrow window look broken, and the window floor only keeps you away from the worst of it.
- **A3 · Input system** — *planned*
- **A4 · Scrolling** — *partial*. Landed: per-axis overflow with clipping, wheel scrolling with nested-scroll escape, hit-testing that follows the offset, and a grabbable overlay scrollbar.
- **A5 · Images, icons, single-line input** — *planned*
- **B · Interactive surfaces** — *planned*. Layering and dismissal, positioning, animation.
- **C · The component system** — *planned*. Primitives, shadcn-compatible components, refs rather than selectors.
- **D · Product readiness** — *planned*. CLI, hot reload, packaging, published measurements, docs and an API freeze.

## What keeps the claims honest

- `bun run protocol-guard` — Proves the shared-memory protocol's two halves still agree — offsets, field identity, enums, FFI symbols.
- `bun run boundary-diff` — Validates the tables Bun is about to hand the engine: link consistency, index ranges, sibling cycles, arena bounds.
- `bun run characterize` — Golden files of compiled output, so a refactor is provably behaviour-preserving.
- `bun run golden` — Renders scenarios headlessly and compares against blessed PNGs.
- `bun run conformance` — Compiles a declaration and compares the emitted value with what the browser computes. *(oracle: headless Chrome)*
- `bun run layout-diff` — Lays out the same html+css in dziri and in the browser at the same viewport, then compares every box. *(oracle: headless Chrome)*
- `bun run spec-audit` — Checks computed-style defaults and inheritance flags for every style field. *(oracle: mdn-data)*
- `bun run css-coverage` — What CSS exists versus what dziri supports, bucketed as supported / unsupported / committed non-goal. *(oracle: mdn-data)*
- `bun run tailwind-coverage` — What fraction of Tailwind works, and what is blocking the rest ranked by classes unblocked.
- `bun run html-coverage` — How each HTML element renders in dziri versus the browser — the table that specifies the UA stylesheet. *(oracle: headless Chrome)*
- `bun run doc-lint` — Verifies that every `file.ext:LINE` citation in the Markdown docs still points at something.
- `bun run probe` — Measures what a browser actually does over CDP, so behaviour claims are recorded rather than remembered. *(oracle: headless Chrome)*

## Long-form sources

- `ROADMAP.md` — Phases, decisions and the critical path.
- `ARCHITECTURE-REVIEW.md` — The fix-order authority. Part 1 §4 lists what a refactor must not touch.
- `API.md` — The authoring API as planned, with status per surface.
- `NOTES.md` — Working notes and measurements.
- `BROWSER-FACTS.md` — Browser behaviour that was measured rather than remembered.
- `framework-design.md` — The long-form design argument.
- `data-layer-design.md` — The data layer, designed but not built.
