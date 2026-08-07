# dziri — roadmap

A framework for building **real desktop products** with HTML, CSS and TypeScript. The compiler
and your app run on Bun; layout, painting and the window are a native Rust engine. No browser
engine, no DOM, no webview.

Open source, with `create-dziri` scaffolding and a `dziri` CLI.

Revised after two independent reviews and the A0 spike. Where the reviewers disagreed, the
disagreement is recorded rather than smoothed over — see *Compatibility: the experiment, not the
layer*.

**What the developer writes is TypeScript, HTML and CSS.** What the engine is written in is an
implementation detail, and choosing Rust for it buys spec-conformant layout, real text shaping,
and the removal of a whole category of FFI hazards.

---

## P0 · Prerequisites — before any public work

**Name — decided: `dziri`.** The earlier working name `bun-native` would not have survived Oven's
trademark policy, and `bun create bun-native` resolves to a package called `create-bun-native`,
which reads as officially affiliated. `dziri` carries no such exposure; the README says "powered by
Bun" and gets the association without borrowing the mark.

Remaining checks, none blocking design work: npm availability for both `dziri` and `create-dziri`,
the GitHub org, and a trademark search for existing software marks.

Naming conventions that follow:

| | |
| --- | --- |
| CLI | `dziri dev`, `dziri build`, `dziri compile` |
| Scaffold | `bun create dziri my-app` |
| Packages | `dziri` (CLI), `dziri/compiler`, `dziri/runtime`, `dziri/primitives`, `dziri/components` |
| Engine binary | `dziri_engine.{dll,dylib,so}` |
| Generated IR | `ui.gen.ts`, unchanged |

**Toolchain floor — resolved.** `skia-safe`'s prebuilt Skia needs **MSVC 14.4x**; 17.6
(MSVC 14.36) fails to link with missing `__std_*` STL intrinsics. Verified working on
**MSVC 14.44.35207 / VS 17.14**. Windows also needs `advapi32`, `shell32`, `oleaut32` and `version`
linked explicitly, which `skia-bindings` does not add. This belongs in CONTRIBUTING with a pinned CI
image — it is a distribution risk, not a local annoyance.

**`skia-safe` + SkParagraph — verified.** `native-src/skia-probe` confirms a raster surface, the
platform font manager, paragraph layout (wrapping to 3 lines at 280 px) and ellipsis truncation.
Crucially `measure_str("Hello")` returns **36.85 px, identical to the libSkiaSharp path measured
through `bun:ffi`** — so text metrics are preserved across the migration and the existing
screenshots stay usable as golden images for verifying the engine against the runtime it replaces.

---

## A0 · The engine *(crate landed; steps 3–6 remain)*

**Status, 2026-07-30.** `native-src/dziri-engine` builds, opens a window, lays out with
Taffy, paints with Skia and reports events. 26 tests pass — 9 unit, 9 bounds, 8 boundary.
`cargo run --release --example window` shows a window; `-- --screenshot out.png` renders
a frame headlessly with no window at all.

| A0 step | State |
| --- | --- |
| 1 · crate skeleton, SDL3 window, Skia surface, Taffy tree, `catch_unwind`, structured errors | **done** |
| 2 · descriptor + `tick()` | **done**, both sides. `toArrayBuffer` verified to attach **no deallocator** |
| 3 · staging buffer | **done as far as it should go** — staged/live arenas and the commit diff exist, and Bun keeps driving `tick()` on purpose. The render thread this step asked for is **withdrawn**; see "Live resize" below |
| 4 · Bun side — replace the three runtime files | **done**. `bun run dev` runs the compiled app on the engine; `layout.ts`, `paint.ts`, `text.ts`, `png.ts`, `src/ffi/*`, the probe and the natives scripts are **deleted** |
| 5 · IME proof | not started |
| 6 · window chrome decision | plumbed (`decorated` is fixed at window creation), not decided |

Landed decisions worth not re-deriving:

- **The descriptor reports absolute pointers**, not `(base, byteOffset)`. There are three
  arenas — staged, live, and layout output — so "which base" would be one more thing for
  the two sides to agree about. Bun calls `toArrayBuffer(ptr, 0, elemSize * capacity)`
  and passes **no finalizer**, because the memory is Rust's.
- **Enum encodings are generated too.** `justify-content: center` being `1` on one side
  and `2` on the other is the same class of bug as a wrong offset, so `schema.ts` now
  emits `NodeKind`, `Display`, `Justify`, `Align`, `EventKind`, `Status` and the rest to
  both sides. Values carry no layout, so adding one does not bump `PROTOCOL_VERSION`.
- **`255` means "unset"** in a `u8` enum field, and the engine then leaves Taffy's own
  default. Coercing unset to variant `0` is what silently collapsed grid items in the
  spike, whose default is `stretch` rather than `flex-start`.
- **Link fields are prefilled to `-1`.** Zero is a valid node id, so zeroed memory would
  say every node is its own first child. Style *values* stay zeroed, and there zero is
  real: `width: 0`, not `auto`. `auto` is `NaN`.
- **A malformed table is an error, never a hang or a crash.** Cycles in
  `firstChild`/`nextSibling` are caught by a traversal budget, tree walks use an explicit
  stack rather than recursion, and a bad string slot reads as `""`. Bun-written memory is
  untrusted input.
- **Taffy rounds layout to whole pixels** by default, so Skia's 36.85 px for "Hello"
  publishes as 37. Kept: it is what stops boxes landing on half-pixel edges.
  `disable_rounding` is the switch if HiDPI needs sub-pixel bounds.
- **The engine is `panic`-contained but not yet thread-safe.** A caught panic *poisons*
  the engine and every later call returns `POISONED`, because `catch_unwind` needs
  `AssertUnwindSafe` over `&mut Engine` and that assertion is only honest if nobody can
  then observe half-updated state.
- **Binary size, measured**: `dziri_engine.dll` is **7.4 MB** — *but only because
  SkParagraph is not called yet*, so the linker drops ICU entirely and the 9.98 MB
  `icudtl.dat` never loads. Expect ~17 MB once A2 uses paragraphs. The 20+ MB figure
  below is still the one to plan around.

### The architecture *(decided; spike done)*

The spike measured Taffy over a C ABI and produced a clear answer, then a clearer one.

| | Taffy over FFI | Our TS engine |
| --- | --- | --- |
| Startup, 1203 nodes | 3.4 ms | n/a |
| Relayout, text dirty, **measure callback** | **2.9–3.4 ms** (2,703 callbacks) | 0.69 ms cold |
| Relayout, text dirty, sizes precomputed | 1.39 ms | 0.16 ms incremental |
| Relayout, nothing dirty / resize | **0.050 ms** | 0.16 ms |
| Bulk read-back, all bounds | 0.005 ms | free |
| CSS Grid | **yes** (placement and spans verified) | no |

Two findings decided the architecture. Taffy's caching **beats ours** when nothing is dirty
(0.05 ms vs 0.16 ms), and the *only* thing making it slow is the text-measure callback — 2,703
crossings at ~1.1 µs each. FFI call *count* was never the problem: styles upload in one call and
bounds read back in one, at 0.005 ms.

The callback disappears entirely if measurement happens next to Skia. So:

**The engine is Rust: `winit` + `skia-safe` + Taffy, one binary.**

- **Owns**: layout, paint, window and event loop, text shaping and measurement, hit-testing,
  damage tracking, the animation frame loop, image decode.
- **Bun owns**: the compiler (build time), signals, app logic, handlers.
- `skia-safe`'s `textlayout` feature exposes **SkParagraph**, which is most of A2 — line
  breaking, ellipsis, bidi, font fallback.
- **SDL3, not winit.** Reversed after review. winit links statically, which is a real
  distribution win, but its IME is documented as unstable for CJK across platforms (winit #3761,
  fcitx crashes). The asymmetry decides it: static linking is an optimization, whereas CJK users
  being unable to type is a catastrophe that would be invisible from a machine that only types
  Latin. SDL3's IME and event model are already validated end to end in the prototype. The
  "reversible because A3 abstracts it" argument was weak — **an abstraction cannot fix events that
  never arrive.** Revisit winit only once its IME is proven, as a v2 optimization.

### Panics must not cross the boundary
A Rust panic aborts the process, so a bad grid definition becomes a segfault Bun cannot report.
Every FFI entry point wraps in `catch_unwind` and reports a structured error. `panic = "abort"` is
forbidden in the engine's release profile.

### The protocol is shared memory, not FFI calls

Rust allocates the tables and hands Bun raw pointers; `bun:ffi`'s `toArrayBuffer` wraps them as
typed-array views. Then a style patch, a list relink, a dirty flag and a hidden byte are all
**direct memory writes with no FFI at all**, and a frame is *one* call.

```
Rust owns:  nodes{kind,style,text,parent,firstChild,nextSibling,hidden,list}
            styles{…44 fields}   layout{x,y,w,h}
            string arena (UTF-8 bytes + slot offset/len table)
            event ring buffer

Bun:  writes tables directly  →  engine_tick()  →  drains events from the ring
```

- **The engine owns rendering; Bun owns state and events.** An earlier draft had Bun driving with
  `wait_event` → `tick()`, which is wrong: if Bun is blocked in a long computation it cannot render
  *or* service a frame request, so a resize stalls and the window flashes white. The engine already
  owns the tables, layout and Skia, so it can repaint current state at any moment — for resize,
  animation ticks, caret blink and IME composition — with no involvement from Bun at all.
- **Which introduces concurrency, handled by a staging buffer.** If Bun writes a style patch while
  the engine is mid-paint, the result is a torn read: half-old, half-new. So Bun writes into
  *staged* tables and the engine applies them atomically at frame start. Smooth repaint, no torn
  reads, no locks in the paint path, at the cost of some memory and one memcpy per frame.
  Event-driven repaint survives as an optimisation: with nothing staged and nothing animating, the
  engine simply does not draw.
- **Offsets are generated from one schema, not asserted at startup.** This was the strongest point
  in both reviews. A handshake *detects* a wrong layout; it does not prevent *field inserted →
  offset forgotten → release build → silent corruption.* One definition generates both the Rust
  struct offsets and the TypeScript constants. A startup assert stays as a cheap backstop.
- Strings: Bun writes UTF-8 into the shared arena; the slot table holds `(offset, len)`.
- **Verify** that `toArrayBuffer` attaches no deallocator to Rust-owned memory. Rust allocating and
  Bun viewing is the safe direction — the reverse would risk a dangling pointer — but the wrapper's
  finalizer semantics need confirming rather than assuming.

### What survives, what retires

**Survives** — and it is the bulk of the value: the whole compiler, the IR design, the variant
and style-patch machinery, signals, list arenas and keyed slot assignment, and every measured
finding.

**Retires**: `src/runtime/layout.ts`, `paint.ts`, `text.ts`, the Skia and SDL TS bindings, plus
`libSkiaSharp.dll` and `SDL3.dll` as shipped artifacts. Roughly 800 lines of ~6,000.

**One honest consequence**: the *"~20 KB runtime"* headline dies. It becomes binary size and
memory instead — likely 10–15 MB with Skia bundled, against Electron's ~150 MB and Tauri's
~5–10 MB atop a system webview. Memory-per-window is where we beat both, and that becomes the
number to lead with.

---

## The governing principle

> Every runtime feature is assumed to be compile-time unless it can be proven that it must
> remain dynamic.

This is a **scope containment** strategy as much as a performance one: it is what prevents slow
drift into building a browser. Every change should answer *can this disappear at compile time?*
before adding runtime code. See `NOTES.md` for the ledger of what is irreducibly runtime.

## The scope boundary is layout, not parsing

| Concern | Cost | Does Skia help? |
| --- | --- | --- |
| Parsing | cheap, incremental | no |
| Cascade, specificity, computed values | done; new properties are linear work | no |
| Painting | mostly free — rounded rects, gradients, shadows, filters, blends | **yes, substantially** |
| **Layout** | the actual wall | **no** |

Properties are mechanical. **Layout algorithms are what cost engineer-years** — grid, floats
(which drag in inline layout), tables, writing modes, fragmentation.

Committed non-goals, stated as features rather than apologies: **floats, tables, writing modes,
fragmentation, multi-column, print.** Those are document-layout features. This is a UI framework.

## Tailwind defines the CSS subset

"Full CSS" cannot be finished and would destroy the pitch. Tailwind's utility surface is a
curated subset people actually ship products with — and unlike "CSS support" it is finite,
enumerable and testable. Coverage becomes a percentage, not a vibe.

---

## Where we are today

**Proven and staying**: the compiler — HTML *and* JSX → IR, with selector matching, specificity,
cascade, inheritance, shorthand expansion, unit resolution and style interning; 1215 nodes in
~28 ms. Signals with correct batching. Dynamic text bindings. Conditional classes via `cn`
compiled to style-table patches (`.light` 46 writes, paint-only; `.compact` 6 writes, relayout).
Dynamic keyed lists: recording-proxy template capture, arenas with append-only growth, keyed slot
assignment that survives reorders, per-row handlers. A working todo app driving all of it.

**Proven and being replaced by the engine**: single-line flex layout, Skia paint via hand-written
FFI, text measurement, mouse and keyboard input, event-driven repaint, incremental measure. These
validated the architecture and are what the Rust engine now implements properly.

**Landed in the engine since**: per-axis `overflow` with clipping, wheel scrolling with
nested-scroll escape, hit-testing that follows the offset, and an overlay scrollbar you can
grab, drag, page and hover — see A4.

**Text wrapping landed 2026-08-01** — see A2. A narrow window reflows instead of running its text
off the right edge, and `layout-diff` agrees with Chrome on 6 of 7 layout scenarios.

**Not started**: text *editing*, images, SVG, animation, widgets, windowing, packaging, hot
reload, CLI, diagnostics.

---

## Cross-cutting concerns

These are not phases. They accrue continuously, and neglecting them is how adoption fails.

### Versioning and compatibility
Absent from every earlier draft, and it becomes load-bearing the moment anyone else builds on this.

- **IR version** stamped into generated modules, checked by the engine at load.
- **Compiler ↔ engine compatibility**: which engine versions accept which IR versions, and what
  happens on mismatch (refuse to start with a clear message, never render garbage).
- **Schema version** for the shared-memory tables, generated alongside the offsets.
- A stated policy on what is public API versus internal, before adoption rather than after.

### Failure containment
- **`catch_unwind` at every FFI entry point.** A Rust panic otherwise aborts the process and Bun
  reports nothing useful. Structured errors cross the boundary; panics do not.
- **Memory pressure is invisible to Bun's GC.** Images and font caches live in Rust, so Bun sees a
  stable JS heap and never collects. The engine reports its heap size and owns eviction policy,
  with a hook Bun can trigger; otherwise long-running apps OOM.
- Compiler diagnostics point at the author's TSX, never at generated code.

### Developer experience and diagnostics
Answer, for every failure: what happens when the compiler meets an unsupported property; when a
signal throws inside an effect; when an image fails to load; when Skia crashes — a stack trace or
a segfault?

- Compiler diagnostics with **source locations pointing at the author's TSX**, never generated code.
  **Stylesheets: done.** `CssError` carries a byte offset and the CLI renders
  `former windows/main/index.css line 415:1`, the offending line and a caret — `stripComments` blanks comments in place
  rather than deleting them, so the offsets survive.
  **TSX: blocked, not deferred.** The only channel is `jsxDEV`'s `_source`, and Bun emits a literal
  `undefined` there (measured, 1.3.14) — so the "one field and one argument" estimate is void until
  either Bun populates it or we own the TSX transform, which is ruled out elsewhere. See the note in
  `jsx-dev-runtime.ts`.
- **Runtime error overlay — a red box, as React Native has.** Catch the failure and paint it
  instead of dying. Today both drivers abort on a non-OK `tick()`, so the window simply
  disappears, which is the failure mode this whole boundary was built to avoid.

  Its prerequisite is done: `EngineError` carries `{status, detail}`, so the overlay has a
  category to title itself with and a message to render. Two sources feed it — engine failures
  crossing FFI as a status, and host failures (a signal throwing inside a handler) that never
  reach the engine at all. Both should land in the same surface.

  One thing it still needs: a decision on dev-versus-production behaviour — React Native's red box
  is a development affordance and a shipped app wants something quieter. The other blocker, text
  wrapping for a detail longer than the window is wide, landed 2026-08-01.
- A `--explain` mode that shows why a node got the style it did (which rules matched, which won).

### Testing strategy
The Chrome conformance harness tests the compiler. Also needed, and the pieces already exist:

- **Screenshot tests** — the PNG encoder is already a golden-image harness.
- **Interaction tests** — click → signal → repaint, asserting bounds. `--focus`/`--hover`/`--patch`
  flags already drive state headlessly.
- **Performance regression tests** — text measure stays 4.5× cheaper than cold; 1200 nodes compile
  under 50 ms; steady-state frame budget holds.
- **Layout unit tests** against hand-computed bounds (9 exist).

### Memory model
Electron's weakness is memory, so this is a headline, and headlines must be documented:
bytes per node, when images are evicted, glyph and advance cache bounds, and the long-running-app
story. Desktop apps run for days.

### Compiler plugin API — deferred to v2
Removed from v1 after review. Plugin APIs get designed too early: we don't yet know where people
will extend the compiler, which hooks they need, or whether the IR is stable. **Freeze the IR
first.** Hardcoding icons and markdown for our own dogfooding is faster than designing an API
we would regret.

### Testing the engine
The existing screenshot and bounds tests exercise the TypeScript runtime, which is being replaced.
The Rust engine needs its own harness, not a port: feed it an IR, assert on output bounds and
pixels. Rust unit tests are necessary but nowhere near sufficient — the interesting failures are in
the shared-memory protocol and the layout/paint pipeline, both of which are integration surfaces.

---

## Phase A — foundations every app needs

### A1 · Tailwind conformance
- **Conformance harness first, over a curated corpus.** Headless Chrome as a build-time oracle:
  compile a utility, diff computed values against `getComputedStyle`. But "generate every utility"
  is infinite — Tailwind v4's JIT produces arbitrary values like `min-h-[calc(100vh-4rem)]` that we
  cannot test because we don't support `calc`. So the corpus is **~200 curated utilities covering
  the common cases**, tested exhaustively, with everything else documented as best-effort.
  Coverage-as-a-percentage is only meaningful against a defined denominator.
- `oklch()`/`oklab()` parsing (Tailwind v4's default). Verify the converted values survive Skia's
  colour pipeline without gamut clipping — Skia has its own colour-space handling.
- CSS custom properties, statically resolved. Tailwind v4 leans on `--tw-*` heavily; static
  resolution suits the thesis exactly.
- **Attribute selectors and `data-state`.** shadcn uses `data-[state=open]:` throughout. Needs
  attribute selectors in the parser, a way for primitives to expose state as attributes, and those
  compiling to variants. Invisible today and on the critical path for Tier 2.
- **Media queries — real `@media` blocks, not only Tailwind variants.** *This is now the thing
  standing between dziri and a narrow window that looks right.* Reported 2026-08-01 from the real
  window at ~400 px as "even buttons are out of container", and measured rather than assumed:
  `layout-diff`'s `row-too-narrow` reproduces `app.css`'s `.newrow` — a `flex: 1` field and two
  content-sized buttons in a container too small for their combined minimum — and **Chrome
  overflows it by the same amount dziri does**, to within 0.05 px. A flex row past its minimum
  overflows; that is CSS, not a bug, and no engine fix would change it.

  What a browser would do instead is *stop being a row* below some width, and dziri cannot
  express that: `parseCss` warn-and-skips every at-rule, so the demo's two-column layout can
  never reflow to one column and its rows can never wrap. Text wrapping was the first obvious
  bug at narrow widths; this is the second, and it is the last big one that is about layout
  rather than about content.

  An earlier draft said
  "media queries compile to signals", meaning `md:flex` became a conditional class over a
  `windowWidth >= 768` predicate. That covers Tailwind's *variant* syntax and nothing else:
  an author writing `@media (min-width: 768px) { .card { padding: 8px } }` in a stylesheet
  must get the same result. Both forms compile to the same thing — a style-table patch plus a
  predicate — so this is one mechanism with two front-ends, not two features.

  **They evaluate at startup and on every resize, on the same path as layout.** That has one
  consequence worth stating before it is built: **the patches must be applied engine-side.**
  The engine owns the window and repaints a resize on its own schedule — that is the whole
  point of A0 step 3 — so routing a resize through Bun to re-apply patches would lag a frame
  and stall entirely whenever Bun is busy, which is exactly the failure the render thread
  exists to prevent. So the compiler emits the predicates and their `(field, slot, value)`
  writes into a table the engine reads, and the engine re-evaluates them between the resize
  and the relayout. Bun never participates.

  This needs a **schema addition** (a `media` table: predicate kind, threshold, and a run of
  patch entries) and it needs `parseCss` to handle nested blocks first — today a `@media`
  body is silently dropped *and* the next rule fails to parse, which is one of the review's
  findings. Same predicate machinery then covers `dark:`, `prefers-reduced-motion` and high
  contrast, whose inputs are OS state rather than window size.
- `group-*`/`peer-*` variants — a pseudo-class on a **non-subject** compound, which the parser
  currently rejects. Real work: hovering `.group` patches its subtree's style pointers.
- Property sweep: gradients, shadows, transforms, opacity, overflow, `space-*`, `divide-*`,
  aspect ratio, object fit.
- **Grid is in scope**, via Taffy — placement and spans are verified working. It is *not* among the
  committed non-goals, and refusing it would make the Tailwind claim false since shadcn itself uses
  `grid-cols-*` and `col-span-*`. Scope it as **explicit tracks and spans; no subgrid.** One thing
  to verify before claiming coverage: `repeat(auto-fit, minmax(200px, 1fr))` needs intrinsic sizing,
  which is the hardest part of Grid and may not be complete in Taffy.
- **Animation frame-loop design waits for A0**, contrary to an earlier draft. Designing it now would
  mean inventing constraints before we know the engine's threading model or Skia's surface
  semantics. Measure frame timings on a real engine first.

### A2 · Text — much smaller than it was
Choosing `skia-safe` collapses most of this milestone, because **SkParagraph** ships in it.

> **Wrapping landed 2026-08-01.** Reported 2026-07-31 from the real window as "text is not
> wrapping up with container, that's the first obvious bug": `Measurer::measure` took an
> `available_width` and ignored it, so a string longer than its box overflowed at any width.
> `text.rs` is now `ParagraphBuilder` + `layout(width)`, and `layout-diff` puts dziri at **6 of 7
> scenarios agreeing with Chrome within 0.5 px**, up from 2 of 7 before the work started.
>
> What it actually cost, against what was priced:
> - **As priced:** `text.rs` moved to SkParagraph; the cache re-keyed on width; `paint.rs` lost its
>   ascent/baseline arithmetic; button labels centre by `TextAlign::Center` rather than by
>   arithmetic on an advance, so a label that wraps now centres line by line.
> - **Not priced — `paragraph.paint` cannot be used.** SkParagraph builds its own `SkFont` per run
>   and exposes no edging control, so it draws greyscale-antialiased text and silently discards the
>   subpixel AA that `e590649` deliberately added. `tests/paint_geometry.rs` caught it: coloured
>   glyph edges went to exactly 0. `text::paint_paragraph` therefore walks `Paragraph::visit` and
>   redraws each run's glyphs through a font this engine configures.
> - **Not priced — Taffy's rounding breaks words.** Taffy rounds boxes as `round(x+w) - round(x)`,
>   which for fractional `w` lands on `floor` or `ceil` depending on where the box sits. One pixel
>   short is enough to push a glyph onto a second line, in a box sized for one — "Clear" rendered
>   as "Clea/r", and so did every short label in the demo. `measure` now returns integral sizes,
>   which the rounding pass preserves exactly.
> - **`white-space: nowrap` was not needed.** The prediction was that things which must stay on one
>   line would start breaking, and they did — but the cause was the rounding above, not the absence
>   of the property. It is still missing and still worth having; it is no longer urgent.
> - **`styles.lineClamp` is now one field away.** It is in the wire schema and is exactly
>   SkParagraph's `maxLines`; what it lacks is an entry in the IR's `STYLE_FIELDS`, so
>   `schema.test.ts` still pins it as unmapped.
> - **One divergence remains, and it is Skia's.** A token with no break opportunity is broken
>   mid-word rather than overflowed, where CSS and Chrome leave it on one line. Not settable from
>   `ParagraphStyle`; measured from both sides and written up in BROWSER-FACTS.md. This is why
>   `layout-diff` reports 6/7 rather than 7/7, and a red `wrap-unbreakable` is the status quo.
>
> `skia-safe`'s `textlayout` feature was already on, so nothing new was pulled in.

- Wrapping, line breaking, ellipsis, bidi and font fallback come from SkParagraph rather than
  being hand-rolled. This was the single largest risk in the previous plan; text layout is a
  multi-month detour when written from scratch.
- Clipping and overflow, now a native clip push.
- Glyph and paragraph caching inside the engine, so measurement never crosses a boundary.
- HiDPI (currently pinned at `scale = 1`), which also covers OS text scaling.
- Font loading from files, weights, fallback chains.

Text *editing* remains deliberately late — see B4.

### A3 · Input system
Not "keyboard support" — an input abstraction, so the windowing library stays an implementation
detail. `winit` supplies mouse, keyboard, touch and IME; gamepad would be `gilrs` and clipboard is
`arboard`. Abstracting now is cheap and painful to retrofit, and it is what makes the
winit-versus-SDL3 choice reversible.

- Tab / Shift-Tab walking the **live tree**, not the sorted `interactive` array — arena rows are
  numbered by slot, so after a reorder those diverge and tab order must follow what the user sees.

  Worth sharpening, because the obvious design gets it half right: the **set** of focusable
  nodes is still compile-time and still a table — enumerable, and a set cannot be invalidated
  by a reorder — while only the **order** has to be a live walk. Node ids *are* strictly
  document order (measured: 0 of 984 nodes on the demo has a child id below its parent), which
  makes a sorted focus-order table look correct and makes it wrong for exactly the case this
  bullet names. Same division `hit_test` already lives by: the compiler says which nodes are
  hittable, the chains say in what order.
- Enter/Space activation through the same dispatch as a click, including `dispatchItem`.
- `onSubmit` on `bind:value`; distinct `onChange` vs `onInput` semantics.
- `:focus-visible` — ring for keyboard focus only, which is the difference between polished and
  broken.
- Skip hidden subtrees; autofocus.
- Tab order over spatial navigation: it is the desktop convention and what Radix implements.
- ~~**One tab stop, arrows inside it**~~ — **built**, for the two controls that exist. The walk
  is `focus::step_within`, one function over a slice; what varies per control is
  `controls::arrow_nav`, a two-field row keyed on `ControlKind`. The picker's hand-rolled clamp
  is gone, folded into the shared walk, which was the point of building this rather than
  reaching for a fourth copy.

  Having measured both, the *only* thing that differs between the two walks is **wrap**: a radio
  group wraps and a picker clamps under the same arrow keys. The second field is whether landing
  selects — a radio group changes its value as you arrow through it, a picker does not, which is
  what lets Escape throw a picker's highlight away and why the two cannot share one answer.

  A tab strip or a menu is now an arm plus a source of members. Still owed: the members for a
  radio group come from the focus walk and for a picker from `open_options`, which is a match at
  the call site rather than part of the table — fine for two, worth a column at four.
- Activation is **already kind-dispatched and simply unreachable from the keyboard**:
  `Controls::activate` handles checkbox, radio and option, and a focused checkbox does nothing
  on Space only because nothing calls it. Enter/Space is wiring, not new behaviour.

**A3 alone unblocks most of forms.** Tier 1a below — Checkbox, Radio, Switch, Toggle, Tabs — needs
nothing from A5: no text buffer, no IME, no clipboard. Only `Input` waits for A5.

**Pointer activation has landed** (protocol v13, `controls.rs`): a click ticks a checkbox, a radio
sets itself and clears its group, a disabled control swallows the press entirely, and a press on a
label — or on the words beside a box — reaches the control. `:checked` and `:disabled` are live
predicates, so the variants the compiler had been emitting since C2 phase 0 are finally selectable.
The engine owns that state, and `controls.rs` opens with why that is the gate answered honestly
rather than a shortcut: nobody declared the answer, so there is no signal to be the authority.

**Keyboard traversal and activation have landed** (protocol v19 and v20, `focus.rs`). Tab and
Shift+Tab walk the live tree over a compile-time set (`NodeFlags.TAB_STOP`); a radio group is one
stop on its checked member; `disabled`, `display:none` and route-hidden subtrees drop out at run
time; Enter activates a button or a link on the press and Space activates a button, checkbox or
radio on the **release**, through `Controls::activate` and the same `CLICK` the pointer emits.

Three things that landed with it and were not in the plan:

- **`Engine::key_up` had to exist.** Space activates on the release, measured, and the engine
  could only see presses. One entry point, and without it every Space would have been a press
  and every one of them a different control from the one browsers ship.
- **`ControlKind::BUTTON` and `LINK`.** The pointer never needed them — a click is emitted on
  whatever was hit — so "activation is already kind-dispatched" was true only for the kinds that
  change state. Enter and Space have no "whatever was hit"; they have a focused node and a
  question, and the measured answers differ per kind in a way nothing else encoded.
- **A click now focuses the control, not the node it landed on.** Measured on 2026-08-04 for
  labels and unimplemented because nothing made it visible. Giving `<button>` a control row
  propagated `activates` into its own text run, so a click on a button's words focused the
  *run* while Tab focused the button — and `:focus` is an exact node match, so `button:focus`
  matched only one of the two ways of getting there.

**`:focus-visible` has landed too** (protocol v21), and it is a *modality* bit rather than a focus
one — measured. It goes true on any keystroke, which covers both arriving by Tab and typing while
something is already focused; it goes false on a pointer press unless that press placed a caret,
which is the engine's way of asking the measured question, *does typing go here*. The UA sheet
hangs a 2px ring on it, scoped to the focusable tags: universal, as Chromium writes it, that one
rule would give all 986 demo nodes a variant run instead of 62. Scoped it still costs 101 style
slots, which is the standing price of precomputing states and is recorded in `ua-sheet.ts` rather
than absorbed quietly.

**`onChange` reaches a handler** (protocol v22). The `CHANGE` queue had been filled since v13 and
drained by nobody, so a checkbox could flip its own bit and tell the app nothing — the event
existed and the subscriber did not, which is the quietest kind of missing feature. `handlers`
gained a `kind` column rather than a second table, because everything except the *argument* is
shared; the argument is what forced two dispatch functions.

Two things fell out of finally reading the queue. A select's `CHANGE` **named the option and
carried a constant 1**, where a browser reports the change of the *select* — measured, and wrong
here since v18 without anything failing, because a wrong event in a queue nobody reads is
indistinguishable from a right one. It now names the select and carries the chosen **index**,
which is the position in the list the author wrote rather than a node id they never see. And the
integer is converted per kind at the boundary, so `onChange` on a checkbox hands over a boolean:
the wire encoding is a protocol detail and should not reach app code.

Still missing: `onInput` (only `CHANGE` is emitted — the measured `input`-then-`change` pair is
half implemented), a focus/blur event kind at all (`EventKind::FOCUS` is the *window*'s),
`autofocus`, `tabindex` in any form, implicit form submission, `onChange` inside a list row (the
click path has `dispatchItem`; the change path does not), and a way for a control to *become*
disabled at run time. Also unimplemented and now named: a keyboard activation has no press/release
pairing, so holding Space and tabbing away activates whatever is focused at release — a browser
cancels.

**Probe before writing Rust.** This was followed for activation and it paid for itself immediately —
`probes/control-activation.html` found four things that would have been implemented backwards, the
sharpest being that `:active` follows a label to its control from anywhere in the chain while
`:hover` only does so from the label itself. Focus and blur ordering, and what `:focus-visible`
actually resolves to, are the same kind of question and nobody should assert them from memory.
Run the probes, record the answers in BROWSER-FACTS.md, then implement against that.

#### Done, 2026-08-06 — and it changed the plan in four places

`probes/tab-order.html`, `probes/focus-visible.html` and `probes/keyboard-activation.html`, all in
BROWSER-FACTS.md. What they settled, in the order it bears on the work:

1. **Space activates on `keyup`; Enter and the arrows on `keydown`.** A button, a checkbox and a
   radio all wait for the release. `Engine::key_down` is the engine's only key entry point, so
   **`Engine::key_up` has to exist before Enter/Space wiring can be faithful** — and this is not
   trivia: press-then-move-away cancelling an activation is the keyboard twin of the mouse rule
   already measured and already implemented. The bullet above called Enter/Space "wiring, not new
   behaviour". It is wiring plus one new entry point.
2. **The focusable set is a compile-time table with one run-time exception, and it is not
   `:disabled`.** `disabled` leaves the tab order and `readonly` stays in it — both already known
   to the engine as predicate bits, so both are free. `display:none` and `visibility:hidden` also
   remove a node, and *those* the compiler cannot see. The out is that the walk skips what has no
   box, which is the test `hit_test` already makes. `tabindex="-1"` is the one thing that splits
   focusable from tabbable, so the table needs two bits rather than one.
3. **A `<select>` is one tab stop, and a radio group is one tab stop landing on the checked
   member.** dziri builds a select's `<button>` as a real compile-time node, so it would be a
   second stop by default. The rule to write is "UA-generated parts of a control are not tab
   stops", not a special case for `select`.
4. **`:focus-visible` is a modality bit, not a focus bit** — set when focus arrives from the
   keyboard, *and* re-set on any keystroke for whatever is focused, *and* set by a pointer press on
   a control that takes text. One bool and two assignments, because `mouse_down` and `key_down` are
   already the only two entry points. The UA ring hangs off it rather than off `:focus`, so it is a
   `ua-sheet.ts` rule and stays overridable in the ordinary cascade.

And one constraint on the generalisation below: **a radio group wraps at both ends, a `<select>`
picker clamps.** Same arrow keys, different rule, both measured. So "one tab stop, arrows inside
it" carries a per-kind wrap flag — cheap, since it sits on the arm that already dispatches on
`ControlKind`, but it had to be known before the shared code was written rather than discovered
by the second caller.

Two more that are smaller but would each have been guessed wrong. **A `<div tabindex="0">` gets no
activation from either key** — so keyboard activation is a property of the kind, not of being
focusable, which confirms the shape of `Controls::activate`'s dispatch. And **implicit submission
crosses elements**: Enter in a text field clicks its form's submit button, a node nothing touched,
so `onSubmit` is a lookup from field to form and cannot be a row in the per-kind table.

### A4 · Scrolling
- Scroll model, wheel and trackpad, scrollbars, `overflow` semantics, clipping to the container.
- **Nested scroll containers** — a scrollable list inside a scrollable panel is where layout
  engines break.
- **Virtualization is a property of a scroll container, and `dataOffset` is how it is spelled.**
  Decided, closing the review's "wire it or delete it": wire it. A scrollable container caps its
  list's materialized capacity at the visible window plus overscan, and scrolling becomes an
  integer write, because slots are recomputed from `items[dataOffset + i]` regardless. Long lists
  then cost O(visible) — worth marketing, since most desktop frameworks still struggle at 100k
  rows.

  This is what the arena has been reaching for all along. Today it materializes `capacity` item
  subtrees whether or not they are on screen, which makes it "render everything, reuse nothing";
  capping it at the window makes it view recycling, which is the proven form of the pattern —
  `RecyclerView`, `UITableView`, and VS Code's editor, which renders only the visible line range
  plus a small overscan. Nothing about the arena changes: the same slot-assignment path, the same
  never-invalidated ids, one more integer.

  Order matters: this needs the scroll container to exist first, so it lands *with* A4 rather than
  before it. Wiring `dataOffset` while nothing can scroll would be a field with no consumer, which
  is what it is today.
- Inertia and rubber-banding are OS expectations; budget polish time. **A wheel glides**, which
  is the first half of that: notches aim a per-node target and the offset approaches it
  exponentially with a 70 ms time constant. A drag deliberately does *not* glide — direct
  manipulation must track the cursor exactly, and easing a thumb the user is holding reads as a
  broken scrollbar rather than a smooth one. Still missing: velocity carried past the last notch,
  which is what "inertia" actually means, and a rubber-band overshoot at the ends.
- `scroll-behavior: smooth` is parsed by nobody yet. Note it is *not* what makes the wheel smooth
  — per spec it governs programmatic and anchor scrolls only, and browsers smooth the wheel
  regardless. It becomes relevant with `scrollIntoView`.

#### Scrollbars are overlay, and that is measured rather than provisional

A thumb is drawn over the content, reserving no layout room, which is why `style_of` leaves
Taffy's `scrollbar_width` at 0. Chromium 151 reserves a 15 px gutter instead — but *conditionally*:
only when the content overflows if the keyword was `auto`, and unconditionally if it was `scroll`
(measured, BROWSER-FACTS.md, "What a scrollbar costs in layout room"). Two things stand between
dziri and that gutter, and they have to land together or not at all:

1. `auto` and `scroll` collapse into one `SCROLL` wire value in `overflowKeyword`, so the engine
   cannot tell which of the two behaviours was asked for.
2. `scrollbar_width` is a *static* Taffy input. Reserving room only when the content overflows means
   laying out, asking whether it did, and laying out again — which is how Chromium does it.

Buying both gets one case: content that fits inside a box declared `overflow: scroll`. Not worth
two layout passes yet, so it is deferred rather than half-done.

#### The scrollbar is a control, not an indicator

Grab it, drag it, click the track to page, and it thickens under the pointer. Three things had to
exist for that, and they are worth naming because each has an obvious wrong version:

- **A hit region that is not a node.** `hit_test` walks the tree and a scrollbar has no row in it,
  so `Painter::bar_at` is its own walk, consulted *before* the tree — an overlay bar is on top of
  the content, so a press that lands on it is aimed at it, and the row underneath must not also be
  clicked. The grab region is 16 px, wider than the 8 px the thumb is drawn at: an 8 px target is
  a miss most of the time. Both come out of `bars_of` together, so what you can see and what you
  can grab cannot drift apart.
- **Pointer capture**, which is just the drag being state: while `Engine::drag` is set the pointer
  means "where the thumb goes" and nothing else, whether or not it is still over the bar or even
  in the window.
- **The grab offset.** A drag keeps the point the thumb was picked up by. Centring the thumb on
  the cursor instead is the classic wrong version — the content lurches the instant you touch the
  bar.

Still to do: **held-button auto-repeat** on a track click (one click, one page today), and a
`scroll-behavior`-style animated jump for the page rather than a hard cut.

### A5 · Images, icons, and single-line text input — **text input done**, protocol v17

A `<input type="text">` behaves like the browser one now: click to place the caret, arrows and
Home/End to move it, type/Backspace/Delete to edit at it, drag or Shift+Arrow or Shift+click to
select, double click for a word, triple click or Ctrl+A for all of it, and every editing key
replaces a live range. `::selection` styles the highlight and `focus:ring-*` the field.

**Every rule was probed before it was written**, and that is the part worth carrying forward: five
of the seventeen measured rows contradicted the obvious implementation. A click resolves to the
*nearest* boundary, not the character under the pointer. A plain arrow with a range live collapses
to the matching end and does not then step. A double click uses the boundary rather than the
pointer, which is why one in the right half of a hyphen selects the word after it. Backspace and
Delete are *identical* over a range. And the selection is `(anchor, focus)`, because a Shift
reversal keeps the anchor while the ends cross. See BROWSER-FACTS.md.

What is left of A5 is images and icons, plus the clipboard and IME below.

- Image decode, async load, cache, eviction. Decode off the main thread.
- **Icons.** Lucide SVGs are what shadcn uses, so Tier 0 needs *something*. Full SVG is not
  fundamental — ship a built-in icon set (paths baked at compile time, which suits the thesis) and
  move general SVG parsing behind demand.
- **Single-line text input**, moved forward from B4. Editing and selection ship; **IME and the
  clipboard do not**, and they are the two things still standing between this and "text input,
  finished". *Rich* editing — multi-line, undo, word navigation — stays deferred indefinitely.
  - **This is the one part of forms that fails the compile-time gate**, and it fails at question 3:
    the set of strings a user can type is unbounded, so there are no variants to emit. The *value*
    is already covered by the ledger's "current state values", but **caret index and selection range
    are a new NOTES.md ledger entry** — engine-internal editing state the app never declares,
    unbounded, and dependent on where the user clicked or arrowed.

    **Still owed.** Both are built and the argument for both is in `caret.rs`'s header, which for
    one commit claimed the entry already existed. It does not. Write it in the same terms as the
    ones already there.
  - **Caret blink is an engine-side timer, not a JS one.** Visible/not is two states and the phase
    derives from the clock, so it flips one bit and invalidates the caret rect only. Same shape as
    transitions, which interpolate in Rust precisely so nothing runs in JS at frame rate — and it is
    what makes the caret survive a long JS computation, the worry recorded under `pump_input` below.
  - `bind:value` was append-and-backspace when this was written, via the `editables` table
    (`compile.ts:801`). It now splices at the caret or over the selection — one splice for every
    editing key, which is what the measurement said those keys are.
  - **It had never worked, and the fix was one clause in `buildInteractive`.** Focus comes from a
    click, `hit_test` returns only `INTERACTIVE` nodes, and an editable was in no clause — so the
    keystroke was addressed to a node that could not hold focus. Recorded here because starting
    `SDL_StartTextInput` looked like the fix and changed nothing on its own; two dead links in one
    chain hid each other.
  - **A field is one line high when empty — done**, protocol v14's `NodeFlags.EDITABLE`. Measured
    first (`probes/text-field-box.html`): a field's height comes from its *font*, not its content, so
    empty, one character and forty are all 15.0px at 13.3333px Arial. It had been rendering as a bare
    line and jumping to full height on the first keystroke. The flag is what scopes it — an empty
    `<div>` is 0 high, so a floor on every empty run would have been wrong for every binding that
    happens to render `""`.
  - **`::placeholder` works — done**, protocol v15's `NodeFlags.PLACEHOLDER`. An ordinary generated
    box in an ordinary cascade, differing from `::before` in exactly two ways: its text comes from
    the attribute rather than from `content`, and paint draws it only while the field is empty. The
    UA sheet positions it absolutely, so it costs no layout room and hiding it invalidates nothing.
    The condition is engine-owned for the same reason checkedness is — the emptiness of a value
    nobody declared — and paint owning it means no stylesheet can show a placeholder underneath the
    user's own text.
  - **Every field now owns a text run**, bound or not. Written because the placeholder broke the
    field it was drawn in: the strut lived on the *element* for unbound fields, justified by "a node
    with a child is never measured", and a placeholder is a child. One shape for both kinds is the
    better answer rather than the smaller patch, and it is where an engine-owned buffer will write.
  - **The width is still content-driven and should not be.** `29 + 7 × size` px is measured and
    unimplemented, so `size="20"` does nothing and an `<input>` with no width class fills its
    container. Same treatment, inline axis.
  - **The caret, the selection and the editing model all landed**, in that order, because the
    editing model was the prerequisite the other two had no place to sit on: `typeInto` appended,
    so there was nowhere for a caret to be. All three are engine state (`caret.rs`), so an arrow
    key or a drag costs a repaint of one rect and no round trip to Bun.

    Every rule came from a probe before it was written, which is how three separate defaults that
    "everybody knows" turned out to be wrong. A click resolves to the **nearest** boundary rather
    than the character under the pointer. A plain arrow with a range live **collapses to the
    matching end and does not then step**. And a selection is `(anchor, focus)`, not
    `(start, end)`, because a Shift reversal keeps the anchor while the ends cross. Two more
    surfaced in the same pass: a double click uses the boundary rather than the pointer, and
    Backspace and Delete are *identical* over a range. See BROWSER-FACTS.md.

    `::selection` is protocol v17, and the one place a measurement was refused: Chromium does not
    expose its own highlight colour to script, so the default is a stated convention in dziri's UA
    sheet — the same admission `caret.rs` makes about the blink rate.
  - Still ahead: the clipboard, IME, and a double-click-then-drag that extends by word rather
    than by character.
- **Font discovery, not just font loading.** System fonts per platform (Segoe UI, San Francisco,
  Noto), a fallback chain, and an emoji font. Text without emoji fallback looks broken.

### Release gate: developer preview
**Ship Tier 0 components immediately after A1, then pause and gauge interest.** Button, Badge,
Card, Separator, Alert, Label, Skeleton, static Table need **no primitives** — markup plus
Tailwind classes. A compiler, static components and CSS hot reload is a credible preview.

Shipping early is the only real mitigation for single-maintainer risk: it attracts help before
Phases B and C, which together exceed the compiler and runtime combined.

---

## Phase B — interactive surfaces

### B1 · Layering and dismissal — **done for the `<select>` picker**, protocol v18

The layer exists and one thing uses it. What follows is what the plan got right, what it got
wrong, and what is left.

- **"An overlay layer painted after the main tree" — right, and smaller than expected.** It is
  one node flag, `NodeFlags.OVERLAY`. A `::picker(select)` box is an ordinary child of its
  select, so it inherits, cascades and lays out with no special case; the flag moves only its
  *turn* in the walk. The main pass skips a flagged node and a second pass starts *on* it,
  which is one condition — `node != root && OVERLAY` — serving both directions. No stacking
  contexts and no `z-index` arithmetic, as predicted.
- **Hit-testing must respect layers** — done, and the reason is stronger than "order". A click
  on an overlay must not reach nodes beneath it, *and* `hit_test` prunes a subtree whose
  parent's box does not contain the point — which a picker hanging below its select never does.
  So without the overlay walk the options are not merely hit-tested in the wrong order, they
  are unreachable.
- **Not anticipated, and it is the nicest part: opening costs no relayout.** The picker is
  `position: absolute` and laid out whether or not it shows, so showing it is a pure paint
  decision — the same split `::placeholder` uses. Which also settles who owns visibility: it is
  the engine's, not a `display` an author writes, or `display: block` on a picker would leave a
  dropdown hanging over the page with no way to close it. Committing *does* relayout, once,
  because the closed button's width comes from the chosen label.
- **A click *outside* the overlay dismisses it *and* activates what it hit.** Measured, 2026-08-04,
  BROWSER-FACTS.md — clicking a `<button>` beside an open picker closed the picker and fired that
  button's own `click`, leaving focus on it. This is a different rule from the bullet above, about a
  different click, and the two are easy to conflate: implementing "the overlay consumes the press"
  and assuming it covered dismissal makes every click that closes a dropdown mysteriously do
  nothing else. Both rules, not one.
- Dismissal: click-outside and Escape ship. **`scroll-outside` does not** — a wheel over the page
  leaves the picker up.
- Focus scopes: **restore focus to the trigger** ships, and is the only one of the three that
  turned out to be needed. Measured and slightly wider than written: focus moves *into* the
  picker while it is open (an `<option>` holds it, not the select), and **both** exits restore it
  to the trigger — Escape and Enter alike. So the restore is what closing does, not something
  specific to cancelling. A *trap* and a *focus stack* are unbuilt and currently unmotivated:
  there is nowhere else for focus to go while a picker is open, and one integer restores it.

**Measured before writing any of it** (`probes/select-picker.html`, and the probe runner gained key
injection to make it possible — a synthetic `KeyboardEvent` is untrusted and performs no default
action, so nothing about what a key *does* was measurable before). Three findings changed the
design, and all three are now built:

1. **A picker opens on `mousedown`, not on the click** — the opposite of a checkbox, whose bit flips
   during the click, after `mouseup`. So `Engine::mouse_down` opens a picker while `activate_control`
   stays on the release; they cannot share a trigger point. Built that way, and
   `ControlKind::SELECT` is the one kind `Controls::activate` deliberately declines.
2. ~~**A picker needs two pieces of state**: the committed selection and a *pending highlight*.~~
   **It needs neither, and that is the one thing the plan got wrong.** Both already existed. The
   committed selection is `CHECKED` on an option, because committing one *is* a radio set —
   `Controls::clear_group` is the code that runs. And the highlight is **focus**, which follows
   directly from the measurement in the bullet above: if `activeElement` is an `<option>` while
   the picker is open, then arrowing through the picker *is* moving focus. So `option:focus`
   draws the highlight and Escape discards it by doing what closing always does. The finding was
   right about the behaviour and wrong about the cost: zero new fields, not two integers.
3. **An arrow key on a closed, focused select opens the picker** rather than walking the value —
   which refutes the belief carried over from legacy selects. Keyboard opening is then the same path
   as the click rather than a second mechanism. Built as exactly that.

A fourth, measured later (2026-08-06) when Enter was asserted to open a closed select:
**ArrowDown, ArrowUp, Enter, Space, F4 and Alt+ArrowDown all open one.** All six are built;
Alt+ArrowDown needed no case of its own, because the branch that opens one ignores the modifier
mask, and Home/End were added at the same time — a picker is a list, and it answered arrows but
not Home.

**Enter was recorded here as *not* opening one, and that was wrong.** The probe dispatched Enter
with no `text`, so CDP sent a raw key event, Blink never ran its activation path, and three
Enters across three probes were inert. The wrong finding then acquired a justification — that
Enter is reserved for committing, so a key doing both would be ambiguous — which was invented to
fit it and is false: the two readings are separated by *state*, not by key, and `picker_key`
already branches on exactly that. Corrected the same day; BROWSER-FACTS.md keeps the original
table, the correction and what the mistake cost, because a deleted claim cannot be traced. The
user who said Enter should open a select was right, and was told otherwise with a fabricated
explanation. **Repeatability is not validity** — the bad measurement was identical across two
runs, as a broken instrument always is.

What is genuinely new state is one integer for which select is open — narrower than the plan's
"one integer each", because only one popover can be open at a time — plus one per-node **label
redirect**, so a closed button can read the chosen option's string without the engine writing
into Bun's tables. The redirect is consulted by paint *and by layout*, because a closed select's
width comes from its label as much as its pixels do.

**Owed:** the NOTES.md ledger entry for the open picker and the redirect, in the same terms as
the ones already there. The argument is in `select.rs`'s header; NOTES.md holds another session's
uncommitted work. This is now the second such debt — A5's caret and selection entry is still
owed too.

Still open, and none of it blocks a second overlay user:

- **Collision handling.** A picker near the window's bottom edge hangs off it rather than
  flipping above its select, and a wide one runs off the right. That is B2's, deliberately: a
  half-version here would be a second placement engine to delete. The anchor offset is computed
  from the two rects layout produced, because the spec's `top: anchor(bottom)` has no dziri
  spelling — `top: 100%` would be it, and `css.ts` refuses percentage lengths.
- **Nothing but a picker uses the layer yet.** A tooltip or a popover would be the test of
  whether the flag generalises; the design says it should, and that is untested.
- `<optgroup>` labels do not render, and there is no type-to-select.

### B2 · Positioning
Adapter for `@floating-ui/core`, which is platform-agnostic by design (built that way for React
Native). Implement its ~8 platform methods and get collision-aware placement for tooltips,
dropdowns and popovers. We are a *better* host than a DOM shim here — `happy-dom` returns zeros
from `getBoundingClientRect` because it has no layout. We have layout.

### B3 · Animation — **done for CSS**, protocol v12

`transition-*` and `@keyframes` both ship. What follows is what the plan got right, what it got
wrong, and what is left.

- **"A generic timeline is the primitive, not CSS" — reached from the other end.** The plan was to
  build a timeline and compile CSS *into* it. What actually happened is that the compiler's existing
  output turned out to *be* the primitive: a transition is interpolation between two rows of the
  style table the cascade already resolved, and a `@keyframes` block is a fixed set of such rows at
  fixed offsets. So one `tweens` table serves both, and `(from, to, t)` is the unification — reached
  by noticing what was already there rather than by building a layer above it. An imperative
  `animate()` still fits: it would mint a tween row and two style rows, which is the same shape.
- **Transitions before keyframes** — correct, and they turned out to be the same mechanism, so the
  second cost a keyframe table and no new engine path.
- **Compile-time precomputes endpoints; ticking is irreducibly runtime** — correct, and it is the
  whole design. `runtime-surface` is unchanged at 7333 bytes: nothing in `src/runtime/` knows
  animation exists.
- ~~The frame loop lives in the engine … Bun calls `tick()` on a timer while animations are
  active~~. **This was already out of date and needed no change at all.** `src/host/main.ts` runs a
  `while (running)` loop calling `engine.tick()` every iteration; it does not block in `wait_event`,
  and `tick` early-outs when `!needs_paint`, so an idle frame is an event drain. An animation simply
  keeps `needs_paint` set. No timer, no loop change.

Still open, and both are small:

- `prefers-reduced-motion` **disables** animation rather than slowing it. Accessibility requirement,
  not polish. It wants a *global predicate bit* rather than a media threshold, which is the one
  thing the `media` table cannot currently express — every row there is an axis and a number.
- Per-property transition timing (`transition: opacity 1s, transform 2s` really does compute two
  durations, measured), `animation-direction: alternate`, `animation-fill-mode`, and more than one
  animation per element. Each warns by name today rather than half-working. None is used by
  Tailwind, and each wants the same thing: more than one live blend per node.

### B4 · Rich text editing — not scheduled
Single-line input, selection, IME and clipboard moved forward to A5, because a framework that
cannot take a login is not shippable.

What remains here is *rich* editing: multi-line, undo/redo, word and paragraph navigation, rich
clipboard (images, formatted content). **This is not budgeted, deliberately.** "Budget 3×" is still
a budget, and this is where frameworks lose a year. Every framework from early iOS to Flutter
launched without a full text editor. Revisit only when users are actively demanding it.

---

## Phase C — the component system

### C1 · Primitives package
The real deliverable; components are a thin skin over it — shadcn's own architecture.

**Scope hard: 5–6 primitives for v1.** Dialog/Overlay, Listbox/Select, Tooltip, Tabs, Accordion.
Radix took years and multiple full-time engineers. Roving focus and typeahead come *after* the
basics work.

- Item collections and ordering — **easier for us than Radix**, which does real gymnastics to
  order items by DOM position at runtime. We have compile-time node order.
- Presence: mount/unmount with exit animations.
- Controlled/uncontrolled state — signals sidestep React's dance entirely.
- **Semantics table**, emitted as compile-time data even with no consumer: `role`, state, label,
  relationships, **plus keyboard interaction contracts** ("this listbox responds to ArrowDown,
  ArrowUp, Enter, Escape"). Costs a few fields and no runtime work; makes primitives testable
  without a screen reader and turns a future platform bridge into a mapping job.

### C2 · shadcn-compatible components
Tailwind support means shadcn's `className` strings work **verbatim**. Both projects are MIT, so
this is clean with attribution. Call it *shadcn-compatible*, not shadcn.

- **Tier 0** — Button, Badge, Card, Separator, Alert, Label, Skeleton, static Table. No primitives;
  ships after A1.
- **Tier 1a** — Checkbox, Radio, Switch, Toggle, Tabs. **Needs A3 only.** These carry no text, so
  the earlier "Tier 1 needs A3 and A5" over-coupled them to the text buffer; five of the six ship a
  milestone earlier than that implied.
- **Tier 1b** — Input. Needs A5's text input.
- **Tier 2 — cut from v1.** Dropdown, Select, Combobox, Popover, Tooltip, Dialog, Sheet, Command
  each need layering, positioning and animation: three subsystems for visual polish. **A desktop app
  with working forms and no dropdowns is shippable; one with a broken Dialog is not.** These are
  where every framework discovers years of edge cases, and cutting them is the single largest
  reduction in single-maintainer risk available.

**"Native" form controls means Skia-drawn, not OS widgets.** Decided, because the alternative
contradicts the thesis rather than merely costing more: Tailwind cannot style an `HWND`, Taffy cannot
lay one out, child windows break the single-surface zero-copy model, and `appearance` and
`accent-color` only exist *because* the UA draws the control. Native-looking and native-behaving,
drawn by us.

Which makes most of Tier 1a cheap. `:checked`, `:disabled` and `:indeterminate` are enumerable
booleans, so they pass the compile-time gate at question 3 exactly like `:hover` — a second style id
and an int write, with **no new ledger entry**, because a checkbox's checked-ness is a `state()`
value and "current state values" is already on the list.

**Phase 0 of this is done, and it was smaller than the paragraph above predicted.** The prediction
was that variant slots are a fixed `base/hover/active/focus` quad, so a new role widens a structure
crossing the protocol boundary — `variants.ts`, `compile.ts`, `ir.ts` and `schema.ts` together. Only
the last part held. The quad had already stopped being the shipping representation when conditional
styling became a predicate *mask*: `compile.ts` names a predicate in exactly one table
(`PREDICATE_PSEUDO`), the run and the engine work in bits, and the surviving quad was a reporting
detail in the measurement harness (`variants.ts`, `ROLES`). So `:checked` and `:disabled` cost two
entries in that table, two in `SUPPORTED_PSEUDO`, and two bits in `schema.ts` — which *is* a protocol
bump (v9) and did need `protocol-guard`, but not a structural change.

The three compile-time CSS properties landed with them: `accent-color`, `caret-color` and
`appearance` are ordinary `STYLE_FIELDS` (both colours inherit; `appearance` does not, per spec),
checked against Chrome in `conformance` and against `mdn-data` in `spec-audit`. Nothing in the engine
reads any of the five yet — a `:checked` node simply wears its base style until A3 can tell the
engine which nodes are checked. `:indeterminate` is deliberately still absent: same shape, same cost,
but nothing can author it until there is a control to be indeterminate.

Two of the five form-control CSS properties are **non-goals**, and saying so keeps them out of the
backlog: `resize` needs drag handles on a textarea and multi-line editing is deferred indefinitely,
so it could never do anything; `field-sizing: content` makes layout depend on the runtime string,
which is a larger ask than the other four combined. Both are now in `css-coverage`'s
`OUT_OF_SCOPE_NAMES`, so the two tools agree.

**On "shadcn-importable":** an `add` command that downloads the original and transforms it is
appealing but would be a **React-to-ours source transpiler** — `forwardRef`, `useState`,
`useEffect`, the `asChild`/Slot pattern, and `@radix-ui/react-*` imports rewritten to matching
primitives. We would also need to parse TSX ourselves; today Bun transpiles JSX and we never see
the AST. And it stays permanently brittle: every upstream release can break it, and the failure
mode is a confusing miscompile.

Committed version: **API-compatible primitives plus an `add` codemod** that performs the
mechanical rewrites and *flags* what it cannot. Same practical benefit — copy from the docs, run
one command — without promising unchanged imports.

### C3 · Refs, not selectors
```tsx
const field = ref();
<Input ref={field} />

field.focus();
field.classList.toggle("invalid");  // known class → compiled variant, one int write
field.rect();                       // straight from layout bounds
field.on("click", fn);
```

No selector, no lookup, resolved to a node id at compile time, and it composes through
components. Refs fit this architecture; selectors were DOM habit.

`query()` survives only for **explicitly tagged** nodes. A literal selector that "happens to
match" is a selector engine in embryo — allow `query(".button:nth-child(2)")` and we have built
one. Documented as *imperative handles for named nodes*, never as a DOM query API.

**Library compatibility, stated plainly in the docs:**

- **Logic libraries work** — XState, `@zag-js/core`, `@floating-ui/core`, TanStack Query core, zod.
- **Rendering libraries do not, by design** — Radix, MUI, shadcn-as-published need React *and* a
  real DOM.

---

## Compatibility: the experiment, not the layer

One reviewer proposed a full Phase X emulating `document`, `window`, `EventTarget`,
`ResizeObserver` and portals in order to run ecosystem code. The other named exactly that as the
project's largest scope risk. **Their disagreement is the most decision-relevant thing in either
review**, so it is recorded rather than resolved by preference.

Our own measurements side with the second: `react-reconciler` in persistent mode genuinely works
and needs no tree-mutation code, but ships 118 KiB (6.1× the whole runtime) and — decisively —
hands the runtime a **class string** at a point where the compiler no longer exists. Recovering a
style index from that requires either compile-time enumeration or a cascade in the runtime. A
compatibility layer does not change that, because the problem is *where the cascade lives*, not
which DOM APIs exist. A layer permitting runtime `createElement` means runtime style resolution,
which moves the thesis rather than implementing it. `happy-dom` is 8.5 MB because "minimum DOM"
has no natural boundary.

**So the experiment comes first, and the layer only exists if the experiment earns it:**

> Take one Radix primitive. Try to run it. **Count the browser APIs it needs**, marking which
> require real layout. One week.

Twelve APIs and no layout dependency: the layer is real, and it gets built as an isolated
subsystem that never leaks into the runtime. Forty APIs including geometry: the strategy is dead
and we learned it for a week instead of six months.

The architectural point stands regardless — if it is ever built, it is a **layer above the
runtime**, never inside it.

---

## Accessibility

In scope, deliberately partial.

| | In scope |
| --- | --- |
| **Keyboard** — navigation, activation, focus-visible | **yes** (A3) |
| **Visual** — contrast, focus indicators, OS text scaling, reduced motion, high contrast | **yes** (A1, A2, B3) |
| **Motor** — hit targets, click tolerance, no timing requirements | **yes** (conventions) |
| **Assistive tech** — UIAutomation / NSAccessibility / AT-SPI | **no, not yet** |

Semantics are still emitted at compile time (C1) so a bridge stays a mapping exercise.

**Docs must say "keyboard accessible; assistive-technology support planned"**, never "accessible".
This matters most for shadcn-compatible components, because Radix's headline value *is*
accessibility — shipping the visuals while dropping the reason it exists will be noticed.

---

## Phase D — product readiness

### D1 · CLI, template, hot reload

**CLI and template landed 2026-08-02.** `dziri compile | dev | build`, and
`bun create dziri my-app` scaffolds from the demo this repository develops against.

- **Not split into packages, deliberately.** `compiler`, `runtime`, `cli` as separate
  npm packages was the plan; what actually unblocked everything was giving the
  existing tree a *package identity* — `name: "dziri"` plus an `exports` map — and
  letting the demo under `windows/` import through it. Bun and `tsc` both resolve a
  package's self-reference, so `windows/main` *is* the scaffold template rather than
  something a codemod has to rewrite, and the twenty-odd harness scripts kept
  working. A package split remains available and is no longer on the critical path.
  The exports map is also where the "public API versus internal" line D4 asks for now
  physically lives: named entries are the authoring surface, wildcards exist because
  the emitter writes those specifiers.
- **The compiler had to stop assuming it lived in the project it compiles.** It took
  the project directory to be its own repository, which is true exactly once.
- `create <name>` template with Tailwind preinstalled, so integration is exercised
  from day one. The template is *derived* from `windows/` by `bun run template:sync`
  and `template:check` fails the build if they drift — a hand-maintained template
  rots into one that will not compile against the framework that scaffolded it.
- **Hot reload: still not started.** The three stages below are unchanged.
- **Hot reload in three stages, easiest first:**
  1. **CSS-only** — a stylesheet change alters the style table but not the tree, so swap tables
     and repaint. State, focus and scroll all survive. This is the demo that sells the thesis.
  2. **Module-level** — reload handlers and callbacks without rebuilding the IR. Covers most
     development iteration.
  3. **Markup reload — cut from v1.** Node ids change, so signal subscriptions, focus, scroll and
     list slot identity all need a stable identity key generalised from the list `key` concept.
     That's a research problem, and stages 1 and 2 already cover the large majority of iteration.

### D2 · Packaging and distribution
Simpler than before: the engine is **one** statically linked artifact, not three fetched DLLs.

**`dziri build` landed 2026-08-02**, on this machine's platform. It produces a single
executable that renders byte-identically to `dziri dev`, verified by hashing the same
frame out of both.

- `bun build --compile`; the engine extracted to a real path on first run, since `dlopen` needs a
  file — and on macOS, code signing requires that too. Confirmed necessary rather than
  assumed: `dlopen` refuses the `B:/~BUN/root/` path an embedded file reports. The
  copy is keyed by a hash the *build* computes, so startup does not re-hash 18 MB.
- **Four things about `bun build --compile` that had to be measured**, each of which
  produced a shipped-app-only failure:
  1. A **runtime plugin is not a bundler plugin**, and a `bunfig.toml` preload does
     not change that. The reactive rewrite never ran, so the binary contained a raw
     `todos.filter(…)` and threw on its first frame while `dziri dev` was fine. Fixed
     by driving `Bun.build({ plugins })` instead of the CLI — `compile` is
     undocumented in `@types/bun` 1.3.14 but implemented.
  2. A **standalone binary reads `bunfig.toml` from its working directory** and
     honours the top-level `preload` it finds, resolving it against its own virtual
     filesystem. A shipped app started next to any project's bunfig dies before its
     first line. The template therefore carries `[test]` preload only.
  3. The **embedded worker must be pre-bundled JavaScript.** The standalone runtime
     loads an embedded `.ts` verbatim and dies on the first `const`.
  4. **`--windows-hide-console` does not produce a GUI binary** — the PE subsystem
     field is still 3, so launching the app pops a terminal behind its window.
     `dziri build` writes the field itself; `--console` opts out for diagnostics,
     since a GUI-subsystem process has no stdout.
- **Still to do:** cross-compilation. `--target` can cross-build the JavaScript half,
  but the embedded engine is the one built for this machine, so shipping for another
  OS means building there. That is CI work with a pinned toolchain.
- Cross-compilation for win/mac/linux × x64/arm64, built in CI with a pinned toolchain.
- **macOS notarization and Windows code signing are prerequisites for distribution**, not polish.
- Windowing: title, sizing, min/max, DPI. **Multiple windows, tray and native menus are cut from
  v1** — single-window apps are the large majority of desktop products, and shipping one window
  well beats shipping several badly.
- **Window chrome is an A0 decision, not a D2 one.** macOS expects traffic lights and a unified
  toolbar; Windows dark-mode title bars need DWM calls; Linux is a CSD-versus-SSD argument. Native
  chrome or custom-drawn has to be chosen when the window is created.

### D3 · Measure and publish
Lead with **~28 ms compile for 1215 nodes** and **memory per window** against Electron — 10 MB
versus 200 MB for a comparable UI is the headline, and it is where we beat Tauri too, since Tauri
still hosts a system webview.

**Binary size is not a number to lead with, and that is now measured rather than
estimated.** The "20+ MB" figure counted the engine and forgot the host: a
`bun build --compile` executable is `bun.exe` with the payload appended, and on
Windows that floor is **98.5 MB** before a single line of the app. The demo packages
to **117.3 MB** — 18.7 MB engine, 98.6 MB Bun runtime and app.

**And no bundler flag reaches it.** Tree-shaking works — a dead export and a 50 KB
dead string were verified gone — but it only ever touched the JavaScript, and the
JavaScript is not the problem: the whole app is **24 KiB** (engine thread) plus
**124 KiB** (app thread) before minification. `--minify` is on by default now and
takes the executable from 117,345,792 to 117,294,592 bytes: **50 KiB, 0.04 %**. An
empty program compiles to 98,480,216 bytes, which is `bun.exe` byte for byte. Bun's
own documentation is candid about it — *"Bun's binary is still way too big and we
need to make it smaller"* — and offers no flag that strips or compresses the
runtime.

(`--bytecode` is not available to us either: it emits CommonJS, and the wrapper needs
top-level `await` to unpack the engine before the app loads. It would buy startup
time rather than size, and reaching it means making the unpack synchronous.)

Against Electron's ~150 MB that is a 22 % saving, not an order of magnitude, and
publishing it as a headline would invite exactly the comparison it loses. Nothing
about the thesis changes; the number that was supposed to carry it does. Options, in
the order they should be considered:

- **Lead with memory per window instead.** It was always the stronger claim and it is
  where we beat Tauri too, since Tauri still hosts a system webview. This needs the
  measurement D3 already asks for.
- Ship a directory rather than one file — a small launcher beside a shared Bun
  runtime and the engine — for anyone shipping several dziri apps.
- Treat the single file as a *convenience*, which is what it actually is.

The old "~20 KB runtime" headline stays dead either way; `runtime-surface` reports
10,517 minified bytes across four modules, which is the honest version of it and is
about the JavaScript, not the download.

**Document the Tauri comparison aggressively.** Every prospective user will ask "why not Tauri?"
Without a published answer, "no web target" reads as a limitation rather than a deliberate
position. The answer is memory per window and predictable frame cost, and it needs numbers.

### D4 · Docs and API freeze
**Freeze the authoring API before adoption.** `cn`, `signal`, `.map(fn, { key })`, `bind:value`,
`ref` are all still in flux, and every week of adoption raises the cost of changing them.

Document boundaries as features: no floats, no assistive-tech bridge yet, logic libraries only.

---

## Routing, windows and residency — future, decided in outline

Not scheduled, but the shape is settled enough to write down, because the router's
API has to be designed against it rather than around it.

**Structure**: `windows/main/index.tsx` with a `windows/main/pages/` file-based
router. The route tree is static, which is the whole point — matching a path
becomes an integer switch with each page's node range precomputed, not a matcher
running at startup.

### Residency: keep the tables eager

**Measured first, decided second.** The sample's entire compiled UI is ~51 KB
across all three copies, against 2.22 MB for one window's pixel buffer — 2 %. Per
node it is ~100 bytes, so 10,000 nodes is ~1 MB. Lazy-loading the *tables* would
be optimising the cheapest thing in the process, so:

1. **All routes in one table set, inactive ones `hidden`.** `hidden` already
   excludes a subtree from layout, paint and hit-testing, so an unvisited route
   costs memory and nothing else. This is the v1 answer.
2. **Split the *module*, not the tables.** `ui.gen.ts` is JavaScript Bun parses at
   startup — 18 KB for one screen, so twenty routes is ~360 KB parsed before the
   first frame, plus every route's handlers and signals imported eagerly. That is
   the cost worth deferring, behind an ordinary dynamic `import()`, appending the
   route's rows through the same growth path list arenas already use.
3. **A table set per window.** Needed for multi-window anyway, and the only clean
   way to *unload*: node ids are indices, and focus, the variant table, the
   interactive set and list arenas are all keyed by them, so a route's rows can be
   appended but never removed. Dropping a whole set invalidates nothing.

**Prerequisite — met, 2026-07-31.** "Resident but hidden" is only free if inactive
nodes cost nothing per frame, and they did not: a structural change rebuilt the whole
Taffy tree and `apply_all_styles` walked table *capacity*, so twenty resident routes
paid for twenty on every relink. The diff now carries changed node indices rather
than two booleans, and a full rebuild is reserved for the first tick and a capacity
change.

Measured on exactly this shape — 10,021 nodes across twenty routes, nineteen hidden,
one row dropped out of the visible route's chain: **6.04 ms → 1.39 ms**. The residual
is the relayout and repaint that change genuinely causes; what went away was the
nineteen hidden routes' share of it.

### Preloading: intent at run time, targets at compile time

Once the module is lazy (step 2), navigation has a cost worth hiding.

```
MOUSE_MOVE  → preload(route)   // idempotent, cached promise
MOUSE_DOWN  → preload(route)   // no-op if in flight; covers touch and keyboard
CLICK       → navigate(route)
```

**Hover first, press as the fallback.** Hover-to-click on a deliberate target is
200–500 ms; press-to-release is 80–150 ms. Same hook, same cache, three times the
budget. The engine already emits both events with the node id, so this needs no
new plumbing.

Three things fall out of the existing design:

- **Drag-off is already handled.** `CLICK` fires only when press and release land
  on the same node, so pressing and dragging away preloads a route that is never
  visited — wasted work, not a bug, and the cache keeps it.
- **A slow preload does not freeze the window.** Bun can be busy importing while
  the engine keeps repainting hover, press and resize, because it renders from
  `live` while Bun writes `staged`.
- **Preload cannot remove layout.** An appended-but-hidden route is
  `display: none`, so Taffy skips it and the work lands on the flip. Avoiding that
  would need offscreen layout — a second pass over a tree not in the window — and
  a full frame here is ~4 ms, so it is not worth it. `navigate()` costs one
  relayout.

**Never `await` on click.** Keep the current route visible and flip `hidden` when
the new subtree is ready. Late navigation then looks like a slightly slow click
rather than a hang — and it is the same mechanism a route-level loading state
would use, which is worth noticing before designing a second one.

**Which nodes are links, and what they point at, is compiler output** — a table,
so `MOUSE_MOVE` → route id is an array lookup rather than a selector match. The
set of routes worth preloading eagerly comes from the static route graph too.
Runtime intent decides *when*; the compiler already knows *what*, and a heuristic
is what you reach for when you have lost that information.

## Not planned

- **Web target.** Technically easier than native — we already have HTML and CSS as input, so it
  would be the original markup plus a signal→DOM shim, no IR needed. Removed anyway, because it
  dilutes the one clear position: *native UI, no browser, 20 KB runtime.* Shipping it early turns
  us into another cross-platform framework competing with React and Svelte. Always addable later.
- **Floats, tables, writing modes, fragmentation, print.**
- **Assistive-technology bridge** — per-OS platform work, deferred not refused.
- **Video, canvas-equivalent, plugin sandboxing** — undecided.

---

## Risks

Ordered by how badly a wrong guess hurts.

1. **Shared-memory layout drift.** A stride or field-order disagreement corrupts silently rather
   than raising a type error, and it would present as inexplicably wrong pixels. **Mitigation:
   generate both sides' offsets from one schema.** A startup assert is a backstop, not the fix —
   it detects a mismatch but does not prevent *field inserted → offset forgotten → release build.*
2. **IME.** Determines whether CJK users can use the framework at all, and it is invisible from a
   Latin-only development machine. Mitigation: SDL3 rather than winit, validated in A0.
3. **Panics crossing FFI.** A Rust panic aborts the process and Bun reports nothing. Mitigation:
   `catch_unwind` at every entry point; `panic = "abort"` forbidden.
4. **Memory pressure invisible to Bun's GC.** Images and font caches live in Rust, so the JS heap
   looks stable and never triggers collection. Long-running sessions OOM. Mitigation: the engine
   reports heap size and owns eviction.
5. **Single-maintainer surface area.** Mitigation, and the reason for most of the cuts above: ship
   the Tier 0 preview after A1 and attract contributors before committing to Phase C.
6. **Rich text editing is a sinkhole.** Mitigation: not scheduled at all; single-line input only.
7. **Scope creep through "DOM support."** The pressure will be constant — *can I just polyfill one
   method?* The compile-time-constant rule is the constitution.
8. **Toolchain skew blocks contributors.** Documented floor plus a pinned CI image.
9. **Rust slows iteration** and **two languages raise the contribution bar.** Keep the engine's
   surface narrow and the churn in TypeScript.
10. **The a11y gap is a reputational risk** for components that look like shadcn, since Radix's
    headline value is accessibility.

## Recorded disagreement, unresolved

Our own spike concluded `react-reconciler`'s persistent mode needs no tree-mutation code, proven
with throwing stubs. A reviewer cites React issue #24645 arguing persistent mode is buggy and
`commitUpdate` is required regardless. One of these is wrong.

Left unresolved deliberately: both reviewers independently concluded the DOM compatibility layer is
dead, so adjudicating *why* it is dead changes no decision. Recorded so nobody re-derives it.

## Open decisions

- What ships as one package versus several.
- API freeze date relative to first public release.
- Whether the engine exposes a stable C ABI for other hosts (Deno, Node) or stays Bun-specific.

## Critical path

```
P0 MSVC ────► A0 engine ──► A1 Tailwind ──► Tier 0 preview ──► [pause, gauge interest]
             SDL3 +          conformance      static
             skia-safe +     harness first    components
             Taffy,
             schema-gen      A2 Text ─────┐
             shared memory   A3 Input ────┴──► Tier 1a (checkbox/radio/switch/
             + IME proof                        toggle/tabs — no text needed)
                             A4 Scrolling ┐
                             A5 Img/icons/├──► Tier 1b (Input — needs the buffer)
                                text input┘
                                          │
                            D1 CLI + CSS hot reload ──► D2 Packaging ──► D3 Measure ──► v1
                                          │
                   Radix API experiment ──► (compat layer only if it passes)

deferred past v1: Tier 2 components · rich text editing · markup hot reload
                  multi-window · plugin API · animation · layering · positioning
```

### Live resize, and why the render thread is withdrawn

A0 step 3 asked for an engine-owned render thread so "a resize or a caret blink
repaints while Bun is busy". **That does not deliver it, and it is not being built.**
While the user drags a window edge, macOS and Windows both run a *nested modal event
loop inside the pump* — so whichever thread owns the window is stuck there, render
thread or not. On macOS an engine-spawned thread cannot own the window at all, since
AppKit requires the process's first thread.

What does work, and is now in: an **SDL event watcher**. SDL calls watchers from
inside the pump, including from inside that nested loop, so the frame comes from
`Engine::resize_and_repaint` while the drag is still happening. One struct in
`window.rs`, one thread-local in `engine.rs`, no protocol or host change, and it
behaves identically on all three platforms.

Two things are deliberately left for later, in this order:

1. **The sound version of the re-entrancy.** The watcher reaches the engine through a
   pointer parked in a thread-local for the duration of `poll`, with the invariant
   written out at `pump_input`. The by-construction alternative is
   `Engine { inner: RefCell<Inner> }` with the borrow released before pumping and
   retaken by the watcher — right, and a refactor of every method on `Engine`. Do it
   if the current shape ever produces a bug that is not obviously something else.
2. **App code in a Worker — landed 2026-08-02.** The main thread owns the engine
   and does nothing but service the window; the app's TypeScript runs in a Worker in
   the same process, and the zero-copy tables survive exactly as predicted — the
   Worker wraps the same engine memory through `toArrayBuffer`, so a style patch and
   a list relink still cost no FFI call and no copy. Calls that take the engine
   handle (`grow`, the event drain) are marshalled to the main thread, which the
   handle table's owner-thread check already enforced.

   What the design note above got right: the split, the marshalling, and that no
   launcher process is needed. What it got wrong is the priority — this was filed as
   "only worth doing if the event watcher turns out to be insufficient", and the
   watcher covers a *narrower* case than it appeared to. The watcher fires from
   inside the OS's pump, so it saves the live-resize drag; it does nothing at all
   when Bun simply never calls `tick()`, which is every long computation, every slow
   handler, every synchronous import. That is not an edge case, and the OS marks the
   window unresponsive for the whole of it.

   **Measured**, demo window, app thread deliberately wedged for 2 s of a 3 s run
   (`--block 2000 --run-ms 3000`, both paths still shipped so the comparison can be
   re-run):

   | | frames rendered |
   | --- | --- |
   | one thread (`dziri dev --single`) | **62** |
   | app in a Worker (`dziri dev`) | **190** |

   Three things had to exist, and each has an obvious wrong version:

   - **A lock the engine thread may fail to take.** Not a mutex it waits on — that
     reintroduces the freeze one level down. `tryAcquire` succeeds and the frame
     commits; it fails and the frame *pumps* instead, servicing input, resize and
     repaint while leaving the staged tables alone.
   - **`Engine::pump`**, the new entry point that makes "instead" possible: `tick`
     minus the commit. The commit has to be genuinely skippable rather than merely
     delayed, because a link column caught mid-splice is not a frame of wrong
     pixels — it is a chain that loops, which the traversal budget reports as a
     malformed table and which poisons the engine.
   - **Two generated entries.** `entry.gen.ts` is the engine thread and imports no
     application code at all; `worker.gen.ts` is the app. That is what keeps a
     packaged build from carrying the application twice, and it is why the engine
     thread cannot be blocked by anything the app does — it has nothing of the
     app's to run.

   Two Bun behaviours had to be measured rather than assumed, and both were wrong in
   the optimistic direction: **a Worker inherits neither the parent's loader plugins
   nor its `process.argv`.** The first meant the reactive rewrite never reached the
   app modules; the second meant `--route` and `--patch` were silently dropped, which
   the goldens caught as twelve scenarios rendering the default route. Both are now
   passed explicitly.

   All 14 golden scenarios render pixel-identically through the Worker path, which is
   the evidence that the split changed no behaviour.

**Immediate next step: the IME proof** (A0 step 5).

**The compiler grew into the schema** rather than the schema shrinking. `src/ir.ts` went
from 25 style fields to 46: grid tracks and placement, `flex-wrap`, `flex-grow`/`shrink`/
`basis`, `align-self`, `justify-items`/`self`, separate row and column gaps,
`aspect-ratio`, `position` and insets. The two the schema still has and the IR does not are
`lineClamp` and `overflow`, because the engine implements neither clipping nor paragraph
clamping yet — writing them would be claiming a feature that does not exist.

**Inline styles are supported**, in both forms:

```tsx
<div style="color: red; padding: 8px" />
<div style={{ color: "red", padding: 8, fontWeight: 600 }} />
```

They beat every selector, as in a browser, and cost the runtime nothing — the declarations
fold into the node's computed style at build time. A number means pixels except for the
unitless properties. A non-static value (`{ color: someSignal }`) is a compile error, not a
silent drop: there is no node to attach it to once the compiler is gone.

It is verifiable against known-good output, which is the nice part: the same `app.tsx` must produce
the same screenshot the TypeScript runtime does today. **Plus one thing that is not like-for-like
and must be proven in A0: IME**, because it can still invalidate the windowing choice.

Then A1, starting with the **conformance harness over a curated corpus rather than the features**,
so Tailwind coverage is a number against a defined denominator.
