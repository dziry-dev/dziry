# skia-proto

Proving that HTML and CSS can be a **compile-time UI description language** rather than a
runtime document format. One Bun process, TypeScript only, Skia via FFI. Not a browser.

## Governing principle

> Every runtime feature is assumed to be compile-time unless it can be proven that it must
> remain dynamic.

For every feature, in order: can the compiler **resolve** it? **precompute** it? **emit
variants** for it? does the runtime **really need to know** about it?

This is the filter that keeps the runtime from quietly growing into a browser. Anything
that lands in the runtime should come with a note saying which question was answered "no".

### Ledger of what must stay dynamic

| Concern | Verdict | Why |
| --- | --- | --- |
| Selector matching, specificity, cascade, inheritance | compile-time | fully static |
| `:hover` / `:active` / conditional `className` | compile-time **variants** | compiler emits N styles, runtime swaps an `int` |
| Node tree, style table, string table | compile-time | emitted as a JS module |
| Text advance widths | **dynamic**, provisionally | depends on typeface, size, DPI, shaping. Escape hatch: embed the font and precompute advances for static strings — then this moves to compile-time too |
| Hit-testing | **dynamic** | needs final layout bounds |
| Layout | **dynamic** in part | window size is a runtime input; everything else about it is precomputed |

## The Rust engine — what exists (2026-07-30)

`native-src/dziri-engine` is a `cdylib` + `rlib`: SDL3 (built from source, statically
linked), `skia-safe` 0.87 with `textlayout`, and Taffy 0.9. It opens a window, lays out,
paints and reports events. `bun run engine:test` is 112 tests; `bun run engine:shot`
renders a frame with no window at all.

```
src/protocol.rs   GENERATED — field identity, enum encodings, elem sizes
src/tables.rs     the shared arenas, the descriptor, the staged->live commit + diff
src/layout.rs     Taffy tree over the tables; absolute bounds
src/paint.rs      Skia draw calls; state resolution; hit-testing
src/anim.rs       transitions and keyframes: the curve, the tween state, the blend
src/text.rs       font resolution + measurement (the seam SkParagraph slots into)
src/window.rs     SDL3 window, event pump, present
src/engine.rs     one frame, start to finish
src/error.rs      catch_unwind, panic location capture, poisoning
src/lib.rs        the C ABI
```

**Three arenas, not one.** `staged` is what Bun writes; `live` is what the engine reads;
`bounds` is layout output flowing the other way. `commit()` memcmps span by span, copies
staged over live, and returns a **diff** — and that diff is what earns the memory.
Without the split there would be nothing to compare against.

**The diff carries index sets, not verbs.** A style patch names the *slots* that moved,
and only nodes wearing them are restyled; a list relink names the *nodes* whose chain
description moved, and only they and the parents the engine last linked them under are
re-linked. The parents come from the engine's own record rather than from `nodes.parent`,
which nothing here reads: letting host memory choose which node to relink would turn one
wrong integer into a Taffy tree silently disagreeing with the chains.

**And it knows which fields can move a box.** A colour-only theme patch schedules *no
Taffy work at all* — paint reads the styles table out of live memory, so recolouring is
finished the moment `commit` copies the bytes. Every styles field is tagged `paint` or
`layout` in `schema.ts` and the classification is generated to both sides; `classify`
skips a paint-only span entirely. Measured on 2,000 nodes, a recolour went from 1.22 ms —
exactly what a geometry patch cost, which was the bug — to 0.43 ms, all of it the repaint
the frame genuinely needs.

`layout` is the safe default and `paint` is the claim that has to be earned: over-tagging
costs time, under-tagging is a stale frame with no write to blame. The generator refuses a
table where only some fields carry a tag, so a new field stops the build rather than
inheriting a guess.

**The obvious follow-on is a trap, and it is worth not rediscovering.** Guarding
`apply_style` with `Style: PartialEq` looks free and is wrong: `set_style` is also what
marks a node dirty, and three things that change a node's laid-out size never appear in
Taffy's `Style` — `fontSize`, `fontWeight` and the `MEASURABLE` flag all reach layout
through the measure callback instead. A no-op guard would skip exactly those and lay text
out at the old size. The saving that is safe lives upstream in `classify`, where the call
never happens at all.

This started as three booleans, and a boolean leaves only one answer — redo everything,
over table *capacity*. A full rebuild is now reserved for the first tick and for a
capacity change, which appends a fresh larger arena and so needs ids that do not exist
yet. Measured on twenty routes of 500 nodes with nineteen hidden, dropping one row from
the visible one: 6.04 ms → 1.39 ms.

Two columns turned out to be filed under the expensive answer for no reason: `kind` is
read by paint and by nothing in layout, and `list` is read by nobody at all, yet both
cost a whole new Taffy tree. Neither schedules any work now; the repaint they need is the
one every non-empty commit already gets.

**The descriptor reports absolute pointers.** Three arenas means three bases, so
`(base, byteOffset)` would add one more thing for the two sides to agree about. Bun wraps
each span with `toArrayBuffer(ptr, 0, elemSize * capacity)` and **passes no finalizer** —
the memory is Rust's, and attaching one would be a double free.

**Enum encodings are generated too**, which is new. Field identity was already generated;
`justify-content: center` being `1` on one side and `2` on the other is exactly the same
class of silent corruption, and it was still hand-copied. `schema.ts` now emits
`NodeKind`, `Display`, `FlexDirection`, `FlexWrap`, `Justify`, `Align`, `Position`,
`Overflow`, `EventKind` and `Status` to both sides.

**Two encoding rules worth knowing**, both learned by getting them wrong:

- `255` in a `u8` enum field means *unset*, and the engine leaves Taffy's default. The
  spike found that coercing unset to `0` silently collapsed grid items, whose default is
  `stretch` rather than `flex-start`.
- Link fields (`text`, `parent`, `firstChild`, `nextSibling`, `list`) are **prefilled to
  `-1`** at allocation, because `0` is a valid node id and zeroed memory would otherwise
  claim every node is its own first child. Style *values* stay zeroed and there zero is
  real — `width: 0`, not `auto`. `auto` is `NaN`, so every style field the compiler emits
  must actually be written.

**Bun-written memory is untrusted input.** It can say anything, and the render thread must
survive all of it: child-chain traversal is budgeted so a cycle is a reported error rather
than a hang, tree walks use an explicit stack rather than recursion so depth cannot blow
the stack, and a bad `(offset, length)` string slot reads as `""`. `catch_unwind` at every
entry point is the backstop, not the plan.

**A caught panic poisons the engine.** `catch_unwind` requires `UnwindSafe` and
`&mut Engine` is not; asserting it is only honest if nobody can then observe half-updated
state, so every later call returns `POISONED` rather than rendering. `tests/boundary.rs`
asserts the whole path: panic → status code → message with a source location → poisoned.

**The bug the tests caught.** Typed views resolved a span's *offset* correctly but always
read the `live` arena, so every read of the layout table returned unrelated bytes from the
shared arena. Not a crash — the offset was in range — just the wrong values, surfacing as
`NaN` bounds. That is precisely the failure mode the generate-both-sides design exists to
prevent, arriving from the one direction codegen doesn't cover, and it survived about ten
minutes because integration tests were written before the Bun side.

### What the compiler now emits

The IR grew from 25 style fields to **46** so the compiler can reach what the engine
already does: grid tracks and placement, `flex-wrap`, `flex-grow`/`shrink`/`basis`,
`align-self`, `justify-items`/`self`, separate row and column gaps, `aspect-ratio`,
`position` and insets. `lineClamp` and `overflow` stay schema-only until the engine
implements clipping.

Two things worth knowing about that change:

- **Encodings are derived, not restated.** `ir.ts` now builds `Direction`, `Justify` and
  `Align` *from* `protocol/generated.ts` rather than declaring its own copies. A compiler
  that thought `center` was 1 while the engine thought 2 would be a wrong-looking frame,
  not a type error — the same class as a wrong byte offset, and the same fix.
- **A list has no node of its own.** Rows are ordinary children of the container,
  spliced into its chain between two compile-time anchors. There *was* a pass-through
  `LIST` node that copied the container's direction, gaps, alignment and grid tracks —
  a hand-rolled `display: contents`, since Taffy has no such thing — and it was right
  for a flex column and wrong for everything else. In a grid it was one item in one
  cell re-declaring the same tracks inside it, so every row landed in that cell; on
  the main axis a `justify-content` had exactly one shrink-wrapped child to
  distribute; and it silently became the containing block for an absolutely
  positioned row. The sample never showed any of it because its one list is a flex
  column. Deleting the node left the render byte-identical with one node fewer, which
  is the same fact stated twice.

**Inline styles**, both forms, resolved at build time:

```tsx
<div style="color: red; padding: 8px" />
<div style={{ color: "red", padding: 8, fontWeight: 600 }} />
```

They beat every selector including the state cascades, which is what a browser does. The
object form normalises to CSS text in the JSX runtime, so the parser and cascade never
learn about it. A number means pixels except for `fontWeight`, `flexGrow`, `flexShrink`,
`aspectRatio` and grid line numbers. A non-static value is a **compile error** with a
message pointing at conditional classes — the previous behaviour, silently ignoring an
unknown attribute, is exactly what this project rejects for unknown *properties*.

### The handshake checks identity, not shape

`SCHEMA_HASH` is a structural fingerprint of every table name, field name and element type,
in order, generated into both sides and compared before anything is allocated.

It exists because the previous handshake compared field *counts*, and a count is exactly the
property a dangerous change preserves. Renaming a field, swapping two `u32`s, or retyping an
`i32` to `f32` all leave the count — and `PROTOCOL_VERSION` — untouched while changing what
the bytes mean. `elemSize` was read from the descriptor and never validated, so a column
could be wrapped by the wrong typed array and simply read every value as a denormal.

Now: the hash refuses to start on drift, `elemSize` is asserted per span against generated
`FIELD_SIZES`, and the field-count check is demoted to what it actually is — a check that
the engine built its own descriptor correctly.

The `(table, field)` lookup stride is generated too. It was hand-written as `64` with
`styles` already at 48, and because the span plan is table-major, exceeding it would not have
overflowed anything: `plan_of(Styles, 64)` would have returned `states.node`'s span, aliasing
two tables at a valid offset, with only the last table panicking. It is now
`protocol::MAX_FIELD_COUNT` with a `const` assert per table, so outgrowing it is a build
failure.

### Four ways the compiler used to be confidently wrong

All four produced a *plausible* artifact and a success line, which is why none of them had
been noticed. Each now has a regression test that fails without its fix.

**Cascade order was carried by `Map` insertion position.** `Map.set` on an existing key
updates the value and keeps the key's original position, and `applyDecls` expands in
iteration order — so a shorthand expanded where it *first appeared*, not where it won.
Given `.card{padding:14px}`, `.card{padding-left:4px}`, `.x .card{padding:2px}`, the answer
was `padL = 4`: `padding` expanded at position 0 and the longhand overwrote it, inverting
specificity. `delete` then `set` moves the key to its winning position. The same bug made an
inline `padding: 0` lose to a longhand from the sheet, which is the opposite of what inline
precedence means.

**A stringified list item interned as an ordinary literal.** The recording proxy returned
`"[item.title]"` for `` `${t.title}` ``, on the theory that a visible marker beats
`[object Object]`. It does not — the marker interns, renders in every row forever, and tells
nobody. The marker is now un-internable (NUL-delimited), `internString` refuses it, and the
error names the path and the fix. A keyed template that yields no bindings *and* no handlers
is also an error now, which catches the ternary — the one shape the proxy cannot see at all,
because the branch is taken at build time and a recorder is always truthy.

**Toggle-introduced state styles were emitted onto nodes that could not be interacted with.**
`buildInteractive` read `hover`/`active`/`focus` off the *baseline* node, but when a toggle
introduces a state (`body.light .btn:hover`) the real pointers live in the variant table. The
slot was correct; the node was never in the interactive set, so it could never be hovered.

**A variant conflict printed a warning and exited 0.** Two toggles writing the same
`(field, slot)` means the value depends on apply order rather than the cascade — the
composition guarantee the whole variant design rests on. That is a build failure now.

### Host-written integers the engine used to believe

**A parent/child cycle aborted the process.** The existing budgeted walks catch a cycle
*along a chain*, because such a chain never ends. They cannot catch one through the parent
relation: `firstChild[root] = root` gives every node a chain of length one, so `relink`
completes and hands Taffy a tree where the root is its own child. `compute_layout` then
recurses until the stack is gone — and a stack overflow is not a panic, so `catch_unwind`
cannot contain it, poisoning never happens, and the host simply loses the process. A DFS from
the root that visits each node at most once now runs before `relink`, which also rules out a
node appearing under two parents.

**Grid track counts were believed.** `gridColumns` is a `u16`, so `grid-cols-65535` is
expressible from one bad write and allocated 65,535 tracks per grid node — measured single
frames of 181 ms and 1.41 s, and arithmetic large enough to overflow inside Taffy, which
panics in debug and **wraps silently in release**, which is how this ships. Tracks and line
indices are clamped to 1024.

**`SDL_StartTextInput` was never called.** So SDL delivered no `TextInput` events at all —
the handler in `poll` had never fired once, and typing into an editable has been broken since
the engine landed. It also means the argument that chose SDL3 over winit, which was IME, had
never been exercised. `SDL_SetTextInputArea` still needs the focused editable's rect and
belongs with the caret in A5.

### How much memory a compiled UI actually is

Measured on the sample (126 nodes, 48 style slots, 48 strings), because the answer
decides whether lazy-loading routes is worth building:

| | |
| --- | --- |
| JS-side IR — the imported module's typed arrays + strings | 10.9 KB |
| Engine `staged` arena | 18.4 KB |
| Engine `live` arena | 18.4 KB |
| Layout output (`bounds`) | 3.2 KB |
| **Everything, three copies** | **~51 KB** |
| One 1040×560 pixel buffer, for scale | **2.22 MB** |

The whole document is **2 % of a single window's pixels**. Per node it is 23 bytes
in `nodes` plus 16 in `layout` — about 100 bytes across all three copies — so
10,000 nodes is ~1 MB and it would take roughly 300,000 before the tables cost as
much as one window at 1040×560.

The style table does **not** scale with nodes: it is one entry per *interned*
style, and interning is over the value-vector across variants, which was measured
at 16→16 slots on a 1215-node page. It is the largest table here (6.8 KB) purely
because an entry is 146 bytes wide.

Three copies is deliberate, not waste. The JS side is the source of truth that
`bindings.ts`, `patches.ts` and `list-runtime.ts` mutate; `staged` is what Bun
writes; `live` is what the engine reads on its own schedule. Comparing the last
two is also what turns "some bytes changed" into a narrow patch.

### The Bun side of the protocol

`src/engine/host.ts` opens the library, reads the descriptor, and hands back typed arrays
over the engine's own memory. `bun run engine:smoke` writes a tree from TypeScript and
asserts what the engine lays out, which is the half the Rust tests cannot cover.

**`toArrayBuffer` attaches no deallocator** — the roadmap flagged this as *verify, do not
assume*. The three-argument form `toArrayBuffer(ptr, byteOffset, byteLength)` takes no
finalizer callback, so there is nothing to free Rust's memory. The smoke test checks it
empirically as well: drop every reference to the views, `Bun.gc(true)`, keep rendering. It
still renders, and the tables still hold what was written.

**Never cache `ptr()`.** A pointer taken once at module load goes stale — JavaScriptCore
can relocate a typed array's backing store, and the engine then writes its out-parameter
into memory the process no longer owns. The symptom is quiet: `bounds()`, `hitTest()` and
`lastFrameMs()` all returned `0` while `surfaceInfo()`, which allocated its buffer per
call, worked perfectly. Take the address at the call site; JS is single-threaded and the
FFI call is synchronous, so nothing can move underneath it. This is a *worse* bug than it
looks, because writing to a stale address corrupts whatever now lives there.

**`EngineConfig`'s pointer field sits at byte 48, not 44.** `#[repr(C)]` aligns a pointer
to 8, so there are four bytes of padding after the `_reserved` array. Struct layout across
the boundary is hand-written on the Bun side and is the obvious next candidate for
generation if it grows.

Measured on the first landing:

| | |
| --- | --- |
| `measure_str("Hello")` @16px, Segoe UI | **36.85 px** — identical to the libSkiaSharp path |
| Published bound for the same node | **37 px** — Taffy rounds layout to whole pixels by default |
| Headless tick, 5 nodes, cold | 5.9 ms first frame, 1.6 ms warm |
| `dziri_engine.dll` | **7.4 MB** |

That size number needs a caveat, because it is smaller than the roadmap's 20+ MB estimate
for a reason that will not last: **SkParagraph is not called yet**, so the linker drops
ICU and the 9.98 MB `icudtl.dat` never loads. Measurement is currently single-line
`Font::measure_str`, which is exactly what `text.ts` does — like-for-like on purpose.
Wiring paragraphs in A2 should add roughly 10 MB.

**Deliberately not done yet**: the engine does not own a render thread, so Bun still
drives `tick()`. The staged/live split is the mechanism that makes the move safe and it is
already in place; what is missing is a thread-safe handle and a published-snapshot swap.
Text input is decoded but no IME work has been done, and that is the one thing in A0 that
can still invalidate SDL3 over winit.

## Superseded: the runtime is moving to a Rust engine

Everything below describes the TypeScript runtime as built and measured. It works, and it proved
the architecture. It is being replaced — see `ROADMAP.md` A0. Recorded here because the *reasons*
are measurements, not preferences.

**The A0 spike** wrapped Taffy in a C ABI and measured it against our engine on a 1203-node
page. The crate is deleted — its conversion rules had drifted from `layout.rs`'s (only NaN
treated as auto, no `BASELINE`, unset coerced to `flex-start`), so what survived was a second,
wrong copy of the thing it helped decide. The measurements are the part worth keeping:

| | Taffy over FFI | Ours |
| --- | --- | --- |
| Startup, 1203 nodes | 3.4 ms | n/a |
| Relayout, text dirty, measure callback | 2.9–3.4 ms (2,703 callbacks) | 0.69 ms cold |
| Relayout, text dirty, sizes precomputed | 1.39 ms | 0.16 ms incremental |
| Relayout, nothing dirty / resize | **0.050 ms** | 0.16 ms |
| Bulk read-back of all bounds | 0.005 ms | free |
| CSS Grid | **yes** | no |

Two things decided it. Taffy's caching **beats ours** when nothing is dirty, and the *only* thing
making it slow is the text-measure callback — 2,703 crossings at ~1.1 µs each. FFI call *count*
was never the issue: one call uploads all styles, one reads all bounds at 0.005 ms.

Move measurement next to Skia and the callback disappears. Hence: **`winit` + `skia-safe` + Taffy
in Rust**, with shared-memory tables and one `tick()` per frame. `skia-safe`'s `textlayout`
feature exposes SkParagraph, which also collapses most of the text milestone.

What this retires beyond layout and paint: `sk_imageinfo_t` field-order archaeology, chasing
renamed `sk_*` symbols across SkiaSharp versions, `ptr()`-on-empty-buffer crashes, BigInt
`size_t` marshalling, and keeping `pixels` alive so the GC doesn't collect memory Skia holds.
All of it becomes Rust ownership.

What it buys back as a risk: **shared-memory layout is a silent-corruption surface**. A stride
disagreement between Bun and the engine gives wrong pixels rather than a type error — the same
lesson as `bun run probe`, so the engine reports strides at startup and Bun asserts them.

Build floor discovered the hard way: `skia-safe` needs **MSVC 14.4x**. VS 2022 17.6 (MSVC
14.36.32532) fails to *link* with missing `__std_find_last_trivial_2`, `__std_search_1`, and the
`__std_{min,max,minmax}_element_f` STL intrinsics — the prebuilt Skia was compiled with a newer
toolset. Verified working on **MSVC 14.44.35207 / VS 17.14.37516**. Windows also needs `advapi32`,
`shell32`, `oleaut32` and `version` linked explicitly; `skia-bindings` does not add them, and
without `advapi32` you get unresolved `__imp_Reg*` from Skia's ICU time-zone code.

**`native-src/skia-probe` confirms the engine's foundations** (`cargo run --release`):

```
ok  raster surface + rounded rect
ok  font manager + measure_str("Hello") = 36.85px
ok  SkParagraph: 3 lines, height 57.0px, longest line 276.0px
ok  ellipsis: 1 line, height 19.0px, exceeded max lines = true
```

Two conclusions. **SkParagraph is real and usable**, so wrapping, line breaking, ellipsis, bidi and
font fallback come from Skia rather than being hand-rolled — that was the largest risk in the text
milestone. And `measure_str("Hello")` returns **36.85px, identical to what the libSkiaSharp path
measured through `bun:ffi`** — same Skia, same DirectWrite typeface, same metrics. So the migration
should be pixel-identical for text, and the existing screenshots remain valid golden images for
verifying the engine against the TypeScript runtime it replaces.

## Architecture

```
HTML + CSS ──▶ Bun plugin ──▶ IR (JS module: nodes, styles, strings as typed arrays)
                                    │
                                    ▼
                          TS runtime: layout ─▶ paint ─▶ input
                                    │
                                    ▼
                     libSkiaSharp (C ABI) + SDL3, both via bun:ffi
```

**Why libSkiaSharp** — Skia is C++ and building it means depot_tools + GN + ninja. Skia's
own C API is minimal and stale. The SkiaSharp project publishes prebuilt binaries exposing
a broad pure-C `sk_*` ABI, shipped inside NuGet "native assets" packages that are ordinary
zips. No .NET involved; we just unpack the `.dll`/`.dylib`/`.so`.

**Why CPU raster first** — the pixel buffer is allocated in JS, its pointer handed to
`sk_surface_new_raster_direct`, and the *same* buffer handed to `SDL_UpdateTexture`. No
readback, no swizzle (Skia's BGRA_8888 is byte-identical to SDL's packed ARGB8888 on
little-endian). This removes GL context interop from M1's failure surface. GPU
(`gr_direct_context_make_gl` over an SDL GL context) is a later milestone.

**Why the IR is a JS module, not JSON** — single process means there is no deserialize step
to write. Bun parses and caches the module; style tables are flat typed arrays so paint
loops stay monomorphic. JSON is kept only as a debug artifact.

## The compiler

`bun run compile --dump` turns `app/app.html` + `app/app.css` into `app/ui.gen.ts`.

Supported selectors: type, `.class`, `#id`, the descendant combinator, and `:hover` /
`:active`. Child and sibling combinators are a compile error rather than a silent
mismatch. Supported properties: `background`/`background-color`, `color`, `border`(+
longhands), `border-radius`, `padding`/`margin` (1–4 value shorthands + longhands),
`display: flex`, `flex-direction`, `justify-content`, `align-items`, `gap`, `width`,
`height`, `min/max-width`, `min/max-height`, `font-size`, `font-weight`.

Decisions worth knowing:

- **`body` becomes the root node**, not a child of one. It receives the window rect, so
  `body { background: … }` fills the window the way an author expects.
- **No `display` means COLUMN**, matching HTML's block default of stacking children
  vertically. `display: flex` with no explicit `flex-direction` means ROW, matching CSS.
- **Pseudo-class states are resolved as full cascades, not patches.** While hovering,
  `.btn:hover` (0,2,0) and `.btn.primary` (0,2,0) tie on specificity and source order
  decides — so hover declarations do *not* automatically win. Computing hover as a patch
  over the finished base style gets this backwards; it was a real bug caught by `--dump`.
- **`:active` cascades `none + hover + active`**, since pressing implies hovering. The
  runtime resolves pressed → `active`, else `hover`, else base.
- **Children inherit from their parent's base style**, not its hover style. Real CSS
  re-inherits when an ancestor is hovered; that's a deliberate simplification.
- Percentage lengths, at-rules, and unknown properties are rejected or warned, never
  silently misinterpreted.

The parser is hand-written and dependency-free. Specificity and cascade had to be written
either way, and the tokenizer for this subset is short; `css-tree` would slot in if the
subset grows. A compile-time dependency wouldn't violate the thesis — nothing here ships
to the runtime.

## Layout

```
scripts/fetch-natives.ts   downloads SDL3 + libSkiaSharp into native/<target>/
src/ffi/loader.ts          library path resolution, C string helpers
src/ffi/skia-symbols.ts    symbol table as data (so probe can test names individually)
src/ffi/skia.ts            Skia bindings
src/ffi/sdl.ts             SDL3 bindings
src/ir.ts                  IR shape + style field schema, shared by both halves
src/compiler/html.ts       strict HTML subset parser
src/compiler/css.ts        CSS parser, specificity, colors, lengths, shorthands
src/compiler/compile.ts    selector matching, cascade, inheritance, emit, dump
src/compile.ts             compiler CLI
src/runtime/layout.ts      single-line flexbox over typed arrays + hit-testing
src/runtime/layout.test.ts bounds assertions against hand-computed numbers
src/runtime/text.ts        font cache + text measurement (the one dynamic bit)
src/runtime/paint.ts       IR + bounds -> Skia draw calls
src/runtime/png.ts         PNG encoder, for headless verification
src/app.ts                 the runtime host: load IR, layout, paint, input
src/probe.ts               verifies the ABI, writes native/<target>/probe.json
src/m1.ts                  Milestone 1 demo (hardcoded tree, kept for reference)
app/app.html, app/app.css  sample input
app/ui.gen.ts              generated IR (do not edit)
```

## The runtime

```
bun run app                      # window, hover, press, click
bun run app --stats              # layout/paint timings per frame
bun run app --screenshot out.png # render one frame and exit
bun test                         # layout bounds assertions
```

The layout engine is hand-written: single-line flex covering exactly the properties the
compiler emits. No `flex-grow`/`flex-shrink`, no wrapping, no percentages — which is why
the CSS parser rejects `width: 100%` rather than approximating it. Yoga (WASM) is the
upgrade path when authoring starts to hurt; layout is isolated behind one function and
takes text measurement by injection, so swapping it is contained.

Two properties of the runtime worth preserving:

- **Nothing is allocated per frame.** Bounds *and* the measure-pass scratch arrays live on a
  reused `Layout`; the `sk_rect_t` buffer and both paint objects are reused. (An earlier
  version of this file claimed this while `layout()` was still allocating two
  `Float32Array`s per call — it isn't, now.)
- **Only interactive nodes are hit-tested**, from a sorted `interactive` array the compiler
  emits. It used to be *inferred* from `hover >= 0`, which excluded clickable list rows with
  no `:hover` rule — the list spike hit-tested a row to `-1` until this was fixed.

## Dynamic state

Decided after evaluating React, Preact, Svelte 5, Solid, Web Components and a bespoke model
(11 + 2 agents, research then adversarial verification). Every framework was verified to
require the runtime to own a **mutable navigable node tree** and to hand it a **class string**
at a point where the compiler no longer exists — and since `nodes.style[i]` is an index
resolved over the *ancestor path*, recovering it from a string needs either compile-time
enumeration or a cascade in the runtime. There is no third option, so a framework buys
nothing but the tree mutation we didn't want.

**Authoring is JSX with no framework.** `src/compiler/jsx-runtime.ts` (~120 lines, zero
dependencies) emits the same `Element` tree `html.ts` produces, so both front-ends share every
downstream stage. Components are functions called at build time; `.map()` over a constant
expands during compilation. `app/app.tsx` compiles to **byte-identical IR** to `app/app.html`.
Adjacent text children are coalesced, because JSX splits `Count: {n}` into two children and two
IR text nodes would be laid out as two flex items — stacked vertically, since a box with no
`display` defaults to COLUMN.

**Dynamic lists are arenas, not reconciliation.** Each list owns a contiguous run of
homogeneous item subtrees with their internal links materialized once, spliced into its
container's child chain. `src/runtime/list-runtime.ts` only rewrites the child chain, so
layout, paint and hit-testing need no knowledge of lists at all. Relinking 1000 items is
0.005 ms, reversing them 0.004 ms, and scrolling a 30-row window over 2000 items 0.052 ms —
independent of the total, which is what makes `dataOffset` virtualization the same mechanism
rather than a second one. *(Those three were taken in `src/spike-list.ts`, deleted with the
old runtime in A0. The mechanism survives in `list-runtime.ts`; the numbers have not been
re-taken against it.)*

**Virtualization is required above ~4000 live nodes, not ~1000.** The old figure — "2000 live
rows = 9.5 ms" — was the deleted TypeScript runtime measured cold-cold, as the layout section
below already notes: it included populating the advance cache with 306 `sk_font_measure_text`
FFI calls. The Rust engine does 2000 nodes in **1.20 ms**. Measured 2026-08-01,
`bun run bench --sizes 1000,2000,4000,8000,16000`:

| nodes | idle | paint | layout | µs/node (layout) |
| ---: | ---: | ---: | ---: | ---: |
| 1000 | 0.002 ms | 0.135 ms | **0.618 ms** | 0.62 |
| 2000 | 0.003 ms | 0.161 ms | **1.202 ms** | 0.60 |
| 4000 | 0.006 ms | 0.213 ms | **2.437 ms** | 0.61 |
| 8000 | 0.014 ms | 0.333 ms | **7.461 ms** | 0.93 |
| 16000 | 0.029 ms | 0.545 ms | **18.898 ms** | 1.18 |

Layout is flat at **0.60 µs/node up to 4000**, then the per-node constant rises. The shape is
linear work with a growing constant, not a quadratic term — a doubling costs 2.5–2.9×, not 4×.
It is the working set leaving cache. A `TaffyTree` holds **1267 B/node** of real heap — counted
with a global allocator, so it includes SlotMap slack and the children `Vec`s that summing
`size_of` misses. The split: `Style` 536, `Cache` 448, two `Layout`s 168 (`NodeData` keeps
unrounded *and* final, to avoid double-rounding), ~115 of slot and parent/context overhead.
Against that, all of our own per-node tables together are ~100 B. Taffy is 93% of it.

The machine these were taken on has a 16 MB L3 (2 MB L2, i7-10700K), and the *touched* set is
5.07 MB at 4000 nodes, 10.14 MB at 8000 and 20.27 MB at 16000 — the per-node cost bends exactly
across that boundary.

**Reducing capacity does not help layout.** Setting `NODE_HEADROOM` to 1.0 cuts the allocation
33% (15.15 MB → 10.14 MB at 8000 nodes) and moves layout by **+1%** — allocated-but-untouched
slots are never walked, so they never enter cache. The same change cuts *idle* by **34%**,
because `commit()`'s memcmp is over capacity-sized spans. So the two are not interchangeable:
headroom is an idle lever, not a layout one.

The only thing that moves layout is shrinking the **per-live-node** footprint: letting Taffy
borrow styles from the shared tables through `LayoutPartialTree` instead of storing a 536-byte
`Style` per node — a duplicate, AoS copy of styles we already hold as SoA. Retaining `Cache`
and both `Layout`s, that projects to 616 B/node, which would put 8000 nodes at 4.93 MB —
roughly today's 4000-node footprint — and by the curve above should return them to ~0.61 µs/node
(≈4.9 ms, from 7.1). Not done, and that projection is unverified.

Rejected: **capacity reservation** (`max={N}` in markup) — it exists only to avoid an
allocator, costs wasted traversal, and has a truncation cliff. Append-only growth avoids the
allocator too, since the slot-aliasing failure modes come from *recycling* ids, not from
growing.

### Dynamic styles: patch the style table

Three strategies were implemented and measured on a 1215-node todo page with four toggles
(`bun run variants`). Results:

| Strategy | Theme flip | IR | Collisions |
| --- | --- | --- | --- |
| Precomputed combinations | 1,215 writes | 38.0 KB | n/a |
| Per-node write lists | 1,211 writes | 24.2 KB | with every other toggle |
| **Style-table patches** | **32 writes** | **9.5 KB** | **none** |

The winning form: intern styles over the *vector* of their values across every variant, so
two nodes share a slot only if they agree in all of them; then a toggle rewrites entries of
the **style table** rather than node style ids. `nodes.style` becomes immutable, layout and
paint are untouched, and there is no indirection — the style table was already the level of
indirection we were failing to use.

Measured consequences, all initially counter to my predictions:

- **No style-table growth.** I predicted ~2× (18→39 entries); it was 16→16 for base slots.
  Nodes sharing a computed style also share how toggles affect them, because both follow from
  classes plus ancestor context.
- **Zero field-level collisions.** Toggles conflict only when they write the same *field* of
  the same style, and real toggles touch disjoint properties — `light` writes colours,
  `compact` writes padding. They overlapped on 301 *nodes* and 0 fields.
- **Composition is correct**: all 16 combinations reproduce the compiler's own output exactly.
  This is asserted, not assumed — a genuine conflict would fail the check rather than silently
  mis-style.
- IR is roughly **flat in toggle count** (~10 bytes per write), against `nodes × 2^toggles`.

A palette/value-indirection layer was considered and dropped: it is subsumed, since a theme is
just a patch whose fields happen to be colours, and patches keep themes loadable as data
without adding an array read per colour to paint.

### Interaction states

`:hover`, `:active` and `:focus` compile to precomputed variants. They live in a **sparse**
state table (sorted node ids + one style column per state) rather than dense per-node arrays,
which were 1,212/1,215 empty. Sparse costs nothing because at most one node is hovered, one
pressed and one focused, so `Painter.styleFor` early-returns for every other node and the
binary search runs ~3 times per frame.

Resolution is pressed → hover → focus → base. Note this **picks** one precomputed style rather
than merging: CSS would combine `:hover` and `:focus` per-property when both apply. Correct
merging needs compiled state combinations — the same combinatorial problem in miniature — and
is deliberately deferred.

`:focus` is **styling only**. There is no keyboard input at all yet (`sdl.ts` decodes only
mouse fields), no Tab traversal, no Enter/Space activation, no focus trapping, and no
`:focus-visible`. Focus can currently only be acquired by clicking. `:focus-within` is
rejected outright, since it propagates to ancestors and would reintroduce the
descendant-selector problem.

One case worth knowing: a toggle can *introduce* a state style the baseline lacks
(`body.light .todo:hover`). Those node state pointers must then exist in every variant so the
pointer itself stays immutable — 300 of them on the todo page, sharing just 2 style slots.
That is also the second reason interactivity must be an explicit compiler output.

### Ledger: what must stay dynamic

Everything not listed here is a compiler bug if it happens at run time.

| Irreducibly runtime | Why |
| --- | --- |
| Current values of state | It's the definition of state |
| List cardinality + order | Data-dependent; handled by relinking an arena |
| Text advance widths | Font/DPI/shaping dependent — unless the compiler embeds the font |
| Hit-testing | Needs final layout bounds |
| Window size | An OS input |
| One dirty bit | Drives event-driven repaint |
| Scroll offset, and the target it is gliding to | Where the user left a box, plus the clock. Question 1 of the gate: neither the wheel nor the time exists at build time. Two `[f32; 2]` per node and one `exp` in `tick`; the curve and its time constant are compile-time constants and the host is never told a scroll happened |
| A transition or animation in flight: which two interned rows, and how far between them | Question 1 again, and it answers the same way: the clock does not exist at build time. Everything *else* about a tween does — both endpoints are style rows the cascade already resolved, the mask is a compile-time bitmask, the curve is four control points in a table. So the runtime trace is one `Live` per *animating* node (not per node), holding a from, a to, a `t` and a direction, plus one `u16` per node recording the row it last resolved to — which is the whole change-detection mechanism, since a transition can only start when a node's slot changes. `runtime-surface` is unchanged at 7333 bytes: none of this is in `src/runtime/`, and Bun's per-frame cost is the `tick()` it was already calling. The list changes when a **predicate** changes, never when a frame passes, and a finished tween is dropped rather than kept settled — which is also what makes a reversal take the full duration when the first transition had completed and the shortened one when it had not, measured. See `native-src/dziri-engine/src/anim.rs` |

Known open problems: a dynamic class on a *container* restyles its descendants (measured: one
root boolean changed 11 of 12 nodes on the sample app), so conditional classes are not a
per-node integer swap and need a subtree-invariance pruning pass. Nested arenas make stride
variable. Recursive structures (trees) need an arena per node, i.e. an allocator — that's the
boundary where a runtime-reconciled *island* would earn its place.

Not adopted, kept as named escape hatches: `@preact/signals-core` (2 KB gzip, no DOM
references) if hand-written invalidation profiles hot — though a compiler that topologically
sorts declared computeds does the same work at build time; and Yoga for layout fidelity.

### Also not a goal, and worth stating

There is **no accessibility**. A Skia-painted surface has no accessibility tree — no
UIAutomation, NSAccessibility, or AT-SPI. Flutter had to build platform bridges per OS. Fine
for a prototype, a large project for anything shipped. Relatedly, npm UI libraries (Radix, MUI,
Lit) are unusable because they need a DOM, not because React is absent; framework-agnostic
*logic* cores (`@tanstack/query-core`, XState, zod) work fine. That means the widget set —
every dropdown, combobox, dialog, focus ring — is ours to build.

Layout uses each node's *base* style, so a `:hover` variant that changes geometry currently
affects paint but not layout.

## Running

```
bun install
bun run engine         # build the Rust engine (needs MSVC 14.4x — see the floor above)

bun run dev            # compile app/app.tsx + app/app.css, then run it on the engine
bun run shot           # the same, headless, to engine-demo.png
bun test               # 12 tests: the compiled app through the engine
bun run engine:test    # 26 Rust tests: tables, text, bounds, FFI boundary
bun run engine:smoke   # Bun writes the tables directly; the engine renders them
bun run engine:window  # the engine driven by tables written by hand, no compiler
```

`bun run natives`, `bun run probe` and `bun run m1` are gone: nothing fetches
`libSkiaSharp` or `SDL3.dll` any more, because the engine links its own.

## Verified ABI facts

Measured on win32-x64 against **SkiaSharp.NativeAssets.Win32 4.150.1** (Skia **150.0**) and
**SDL3 3.4.12**. These were the project's main unknowns; `bun run probe` re-verifies them
after any dependency bump.

| Question | Answer |
| --- | --- |
| `sk_*` symbols bound | 26/26 stable names resolved |
| Default font manager | `sk_fontmgr_create_default` — **not** `sk_fontmgr_ref_default`, which upstream Skia removed around m116 |
| Typeface from file | `sk_fontmgr_create_from_file(mgr, path, index)` — moved onto the font manager, gaining a leading arg |
| Clip | only `sk_canvas_clip_rect_with_operation(canvas, rect, op, aa)` is exported |
| `sk_imageinfo_t` field order | **colorspace-first**: `colorspace*, width, height, colorType, alphaType` (24 bytes) |
| `sk_colortype_get_default_8888()` | `6` = BGRA_8888 — byte-identical to SDL's packed ARGB8888, so presenting needs no swizzle |
| `sk_fontmetrics_t` offsets | confirmed: ascent @8, descent @12 (Segoe UI @16px → −17.27 / 4.02) |
| Text measurement | `sk_font_measure_text` works; "Hello" @16px = 36.85px |
| SDL3 event offsets | confirmed: `type @0`, mouse `x @28`, `y @32`; `QUIT=0x100`, `MOUSE_MOTION=0x400`, `MOUSE_BUTTON_DOWN/UP=0x401/0x402` |

Because these differ across SkiaSharp generations, the renamed ones are resolved at load
time from candidate lists in `SKIA_VARIANTS` rather than hardcoded, and call sites go
through adapter functions in `skia.ts` (the arities differ, so they aren't plain renames).

Window resize deliberately avoids `SDL_EVENT_WINDOW_RESIZED` — `m1.ts` polls
`SDL_GetWindowSizeInPixels` instead, so one fewer constant has to be right.

## Deliberately deferred

- HiDPI: M1 assumes `scale = 1` and ignores Windows display scaling.
- Damage-rect / partial repaint: M1 and M3 use whole-surface repaint, but **event-driven**
  (blocking in `SDL_WaitEvent`, rasterizing only when dirty). Real damage tracking only
  after a measurement says full repaint is too slow.
- React/TSX authoring: M2 compiles a plain `.html` + `.css` pair. Evaluating components to
  obtain a tree is a separate problem from the compile-time-CSS thesis.
- GPU backend, text shaping beyond single-run Latin, CSS Grid, animations, media queries.

## Milestones

- **M1** — SDL3 window, Skia CPU surface, rounded rect + text, mouse clicks. **Done**:
  antialiased rounded rects, DirectWrite text via the platform font manager, hover/pressed
  variants, event-driven repaint, clicks dispatched by node id.
- **M2a** — compiler: HTML/CSS into a JS module exporting node tree, style table, string
  table. **Done** — `bun run compile --dump`. Sample app compiles to 12 nodes / 15 unique
  styles / 5 strings / ~3 KB in ~5ms.
- **M2b** — layout engine over the IR + paint. **Done** — `bun run app`. 9 layout tests
  assert hand-computed bounds; `--screenshot` renders one frame headlessly so the pipeline
  is verifiable without a human looking at a window.
- **M3** — interaction states as compile-time variants. **Done for styling** — `:hover`,
  `:active`, `:focus` compile to variants held in a sparse state table; the runtime picks an
  integer. Focus *behaviour* is not done (see P3).

## Status: shipped vs validated vs not started

The distinction matters — two designs are measured and proven but not yet wired into the
compiler's output, so the app cannot use them.

| Area | State |
| --- | --- |
| Skia + SDL3 FFI, CPU raster, ABI probe | **shipped** |
| Compiler: HTML *and* JSX → IR, cascade, specificity, inheritance, interning | **shipped** |
| Layout (flex subset), paint, mouse input, event-driven repaint | **shipped** |
| `:hover` / `:active` / `:focus` variants, sparse state table, explicit interactive set | **shipped** |
| Verification: `probe`, `--dump`, `--variants`, `--screenshot`, 9 layout tests | **shipped** |
| Dynamic lists — `.map` with keys, arena + keyed slot assignment | **shipped** — see P2 |
| Dynamic styles — style-table patches | **shipped** — `classWhen={{ light: isLight }}` compiles to style-table writes; see P2 below |
| Dynamic text, signals, click handlers | **shipped** — see below |

## Roadmap

### P1 — Bindings and state — **done**

State is **signals** (`src/runtime/signal.ts`, ~120 lines, ours so the compiler can recognise
them by identity; `@preact/signals-core` remains the swap-in if wanted).

```ts
// app/state.ts — module level, so there is one slot and the compiler can name it
export const count = signal(0);
export const label = computed(() => (count.value === 1 ? "item" : "items"));
export function increment() { count.value++ }
```

```tsx
<div className="readout">{count} {label} · clicks: {clicks}</div>
<button onClick={increment}>Add</button>
```

**How `{count}` is recognised.** The JSX transform evaluates expressions at build time, so
`{count.value}` would hand the compiler a number with no route back to the dependency. A
*signal object* passes through as an object, and `flatten` spots it. Identity does the work a
string key would have done — no `bind("count")`, no typos, full type checking.

**How the reference survives the file boundary.** `ui.gen.ts` is a module, not data, so it can
`import { count } from "./state.ts"`. `resolve-refs.ts` imports the app's modules, walks their
exports, and matches by reference to recover the name. The same pass turns `onClick={increment}`
into an imported function reference. Emitted output:

```ts
import { clicks, count, increment, label } from "./state.ts";
export const textBindings = [
  { node: 5, slot: 1, parts: [{ signal: count }, { literal: " " }, { signal: label }, …] },
];
export const handlers = [{ node: 7, fn: increment }, …];
```

**And it declares what it satisfies.** Being a module rather than data means `tsc` can check
it, so every export ends `satisfies StyleTable` / `NodeTable` / `ListTable` / `StylePatchRef[]`
and the consumer takes it without a cast. That was the one interface in a project built on
generated identity that nothing checked: `as unknown as CompiledUi` told the compiler to trust
both ends, and renaming an IR field surfaced as a `TypeError` in whichever test touched it
first. It now fails in `ui.gen.ts` itself, naming the field.

One thing the change turned up, which is the argument for doing it at all: the cast was
covering exactly one real mismatch — `field: "bg"` in a style patch widened to `string`
instead of the `StyleField` union — and nine casts' worth of collateral that had never been
needed at all.

**Consequences of that design, worth knowing:**

- Signals and handlers **must be module-level exports**. Unresolvable references are a compile
  error that states the rule. A signal created inside a component has nowhere to live: components
  are erased at build time, so there are no instances to hold per-instance state.
- **Bare `let count = 0` cannot be reactive**, unlike Svelte. Svelte *parses* component source
  and rewrites assignments; we *evaluate* it and observe the resulting tree, so the declaration
  is never visible. Making it work would need a TypeScript AST transform plus component
  instances — and Svelte itself moved toward explicit `$state()` for clarity anyway.
- A dynamic run is **one** text node with interleaved literal and signal parts. Two nodes would
  be two flex items, stacked vertically.
- Dynamic text gets a **reserved string slot**, never shared with an interned literal, since the
  runtime overwrites it.

**Batching.** `dispatch()` wraps a handler in `batch()`, so one click costs one repaint however
many signals it writes. That needed a subtlety: a `computed`'s invalidation must fire
*synchronously* even inside a batch — it is bookkeeping, not an effect. Queuing it made an
effect subscribed to both a signal and a computed derived from it run twice. Measured: 5 clicks
→ 5 repaints (was 15 before batching, 10 with naive batching).

**Incremental measuring.** `Layout` carries a `dirty` flag per node; `measure` returns early for
clean subtrees and reuses their cached `mw`/`mh`, while `arrange` always runs (pure arithmetic,
and a resize changes positions without changing any intrinsic size). A text change marks only
its own node and the ancestors above it, stopping at the first node with both an explicit width
and height, since nothing above that can change size.

Measured on the 1215-node todo page (`bun run bench`):

| Case | Cost |
| --- | --- |
| Cold — everything dirty | 0.694 ms |
| Text change — one node + ancestors | 0.156 ms (**4.5× cheaper**) |
| Resize — nothing dirty, arrange only | 0.162 ms (**4.3× cheaper**) |

A resize re-measuring nothing is the nicer half of that: intrinsic sizes don't depend on the
window, so the whole measure pass is skipped. (Note the earlier "layout 9.5 ms" figure for this
page was *cold-cold* — it included populating the advance cache with 306 `sk_font_measure_text`
FFI calls. Warm, a full measure is 0.69 ms.)

The remaining 0.16 ms is `arrange`, which still runs the whole tree. Dirty-arrange is the next
lever if it ever matters; at this size it does not.

**Bounded advance cache.** `FontCache.advances` is now LRU-capped (4096 entries by default),
since dynamic text makes the key space unbounded — a counter alone mints a new string per
increment. `Map` preserves insertion order, so delete-and-reinsert on a hit gives LRU for free.
Verified: 20,000 unique strings leaves exactly 4,096 entries.

Still outstanding: a brace/quote-aware tag scanner in `html.ts` if dynamic attributes are ever
wanted in *HTML* authoring (JSX doesn't need it — TypeScript parses those expressions).

### P2 — Integrate the validated designs

**Style patches — done.** Conditional classes are authored as
`classWhen={{ light: isLight }}` and compiled by `src/compiler/variant-compile.ts`:

- One extra compile per toggle (`k+1` total, not `2^k`), diffed against the baseline.
- Styles interned over the *vector* of their values across all variants, so two nodes share a
  slot only if they agree in every one. On the demo app that was 19 slots from 19 baseline
  styles — no growth, matching what the probe measured at 1215 nodes.
- Emitted as `stylePatches`: `(field, slots, on, off)` writes plus an `affectsLayout` flag.
  `nodes.style` is never touched; the *style table* is mutated in place.
- Conflicts are detected per `(field, slot)` and reported as a compile warning.

Demo: `.light` → 31 writes, **paint-only**; `.compact` → 45 writes, **relayout**. Verified that
toggling both off restores the style table exactly, and that a colour-only patch reports `PAINT`
so measure and arrange are skipped.

State variants multiply writes: `.panel.compact .btn` touches four padding fields across each
button's base/hover/active/focus slots, which is why a two-rule change is 45 writes.

**Two kinds of `.map`, distinguished by what you call it on.** This is the core mental model:

| Authoring | Which `map` | Compiles to | Runtime cost |
| --- | --- | --- | --- |
| `[1,2,3].map(fn)` | `Array.prototype.map` | literal nodes (todo fixture: 1215) | none |
| `todos.map(fn, { key })` | ours, on the signal | template + arena (39 nodes + 8 slots) | slot writes |

A known array is precompiled and never touches the arena; a fetched one cannot be, and gets it.
You cannot pick the wrong path by accident, because a plain array has no `map` of ours — and keys
are required only for the signal form, since the static form has no reconciliation to do.

**`.value.map(…)` works too.** While the compiler evaluates the document module, reading `.value`
on an array-valued signal returns a *proxy* over the array that remembers its owner and traps
`map`; everything else (`length`, indexing, `filter`, iteration) passes through. So
`todos.value.map(fn, { key })` compiles to the same dynamic list rather than silently taking
`Array.prototype.map` and freezing the initial data into the IR. To snapshot deliberately, copy
first: `[...todos.value].map(…)` is a plain array and takes the static path.

One wart: `.value.map(fn, { key })` typechecks only because `Array.prototype.map`'s second
parameter is `thisArg: any`, so the *declared* type is `Node[]` while the value is a list node.
It works, but `todos.map(…)` has honest types and is the form to prefer.

**Scalar `.value` is a different problem.** `<h1>{count.value}</h1>` hands the compiler a number
with no provenance, and a primitive cannot be proxied. Boxing it would break `===` and make
`if (flag.value)` always truthy, so it is not done. Writing `{count}` already works and is
shorter. Making `.value` work for scalars would need a real AST transform (a Bun plugin rewriting
`X.value` in JSX child position to `X`), which is not built.

**Dynamic lists — done, via `.map` on a signal.** Because signals are ours, `.map` is a method
on them, so authoring stays what you would write anyway:

```tsx
{todos.map((t: Todo) => <div className="todo">{t.title}</div>, {
  key: (t: Todo) => t.id,
  capacity: 16,
})}
```

**Template capture.** The callback runs *once*, at build time, with a **recording proxy** as the
item, so `t.title` yields the path `["title"]` instead of a value (`src/compiler/item-path.ts`).
The subtree it returns is the template; the compiler materializes it `capacity` times into a
contiguous arena, each replica pointing at its own string slots. There are no component
instances and nothing renders at run time.

**Keys are mandatory** — a type error *and* a compile error, not a warning like React's. Two
checks: no `key` at all, and a `key` that reads nothing (`key: t => t`). The reason is specific:
item nodes are interchangeable for painting, so a reorder needs no structural work — but focus is
a *node id*, so without keys a reorder would move focus to a different logical row. Verified: a
row keeps node 15 across a reverse while the chain order flips from `15,17,19` to `19,17,15`.

**Reconciliation is slot assignment, not tree diffing.** `src/runtime/list-runtime.ts` keeps each
item in the slot that already held its key, gives new items free slots, rewrites the child chain
in data order, and refreshes bound strings. No node moves, nothing is allocated, no id is
invalidated, and every style id in the arena was resolved at compile time. Slots off the chain
are unreachable, so they cost nothing to traverse.

**Capacity is not the author's problem.** It starts at 8 and the arena grows on demand — the
author writes no `max` and no `capacity`. Growth appends a *fresh, larger* arena past the end of
the node arrays and re-points the list at it, leaving the old region unreachable. That is
deliberate: no existing node id changes, so focus, the state table, the interactive set and
cached layout all stay valid. Growing in place would shift every later node and renumber the
document. Wasted slots are the price of never recycling an id, and growth is rare because
capacity doubles. The sparse state and interactive tables are extended too — new ids are always
larger, so appending keeps them sorted.

Measured, with no capacity declared: 3 → 8 items in the initial arena; 9 items grows to 16
(nodes 39 → 71); 1000 items reaches capacity 1000 (nodes 2335). Shrinking back to 0 reuses the
arena. Key identity survives growth.

**The compiled list is a function of the array.** `updateList(ui, list, array)` takes the array
directly — the signal is just the default source. Same array in, same rows out. The one piece of
memory is a key → slot map, which exists solely so an item keeps its slot across a reorder;
without it the function would be trivially pure (`slot i ← items[i]`) at the cost of focus
following a *position* rather than a row. A fully pure alternative exists — derive the slot from
the key by hashing with deterministic probing — and would matter if snapshot/resume or hot reload
ever needed to preserve rows.

`src/runtime/list.ts` and `src/spike-list.ts` *were* the standalone measurement of the arena
mechanism (relink 1000 items in 0.005 ms, scroll cost independent of total). Both were deleted
with the old runtime in A0; `src/runtime/list-runtime.ts` carries the mechanism forward, and
the numbers have not been re-taken against it.

**Still open:** `<When cond>` driving `hidden` for conditional visibility — `hidden` is already
honoured by layout, paint and hit-testing, so it is a small compiler addition — and per-row event
handlers, which need the click dispatcher to map a node back to its arena slot
(`slotOfNode` exists for that).

### P3 — Input and focus behaviour
Decode `SDL_EVENT_KEY_DOWN` (no keyboard input exists at all today), Tab/Shift-Tab over the
`interactive` array in tree order skipping hidden subtrees, Enter/Space activation, Escape,
focus trapping, and `:focus-visible`. This gates every real widget.

### P4 — Fidelity
Text clipping and ellipsis (long labels currently just spill), scrolling as a first-class
concept, HiDPI (still pinned at `scale = 1`), and percentages / `flex-grow` / wrapping — which
is the point where Yoga becomes the sane answer instead of extending our engine.

### P5 — Measure (was M4)
Cold start, IR bytes, steady-state frame cost, and memory, against an Electron or Tauri app
rendering the same UI. Note the runtime currently minifies to ~20 KB. Without numbers the
prototype convinces nobody.

### P6 — Widgets
The set that has to be built rather than installed, because npm UI libraries need a DOM:
dropdown, select, combobox, dialog, tooltip, scroll area, text input. Plausibly larger than
the compiler and runtime combined. Depends on P3.

### Candidates worth considering
- **CSS hot reload** — the compiler does 1215 nodes in ~28 ms, so recompiling the style table
  and hot-swapping it on file change is cheap and a strong demo.
- **Runtime-loadable themes** — a patch list is just data, so user themes need no compiler.
- **Devtools overlay** — draw layout bounds and node ids over the live UI.
- **Binary IR + `bun build --compile`** — single executable; natives must be extracted to a
  temp path on first run because `dlopen` needs a real file.
- **GPU backend** — `gr_direct_context_make_gl` on an SDL GL context; deliberately deferred
  since CPU raster removed GL interop from every earlier risk.
- **Islands** for recursive structures (trees, outliners), which arenas cannot express.
- **Damage rectangles** — only after a measurement says full repaint is too slow.
