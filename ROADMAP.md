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
| 3 · staging buffer | **half** — staged/live arenas and the commit diff exist; the engine does not yet own a render thread, so Bun still drives `tick()` |
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

**Not started**: text clipping and editing, scrolling, images, SVG, animation, widgets, windowing,
packaging, hot reload, CLI, diagnostics.

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
  `app/app.css:415:1`, the offending line and a caret — `stripComments` blanks comments in place
  rather than deleting them, so the offsets survive.
  **TSX: blocked, not deferred.** The only channel is `jsxDEV`'s `_source`, and Bun emits a literal
  `undefined` there (measured, 1.3.14) — so the "one field and one argument" estimate is void until
  either Bun populates it or we own the TSX transform, which is ruled out elsewhere. See the note in
  `jsx-dev-runtime.ts`.
- Runtime error boundaries: catch a signal error and paint a red overlay instead of dying.
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
- **Media queries — real `@media` blocks, not only Tailwind variants.** An earlier draft said
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
- Enter/Space activation through the same dispatch as a click, including `dispatchItem`.
- `onSubmit` on `bindValue`; distinct `onChange` vs `onInput` semantics.
- `:focus-visible` — ring for keyboard focus only, which is the difference between polished and
  broken.
- Skip hidden subtrees; autofocus.
- Tab order over spatial navigation: it is the desktop convention and what Radix implements.

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
- Inertia and rubber-banding are OS expectations; budget polish time.

### A5 · Images, icons, and single-line text input
- Image decode, async load, cache, eviction. Decode off the main thread.
- **Icons.** Lucide SVGs are what shadcn uses, so Tier 0 needs *something*. Full SVG is not
  fundamental — ship a built-in icon set (paths baked at compile time, which suits the thesis) and
  move general SVG parsing behind demand.
- **Single-line text input**, moved forward from B4: selection, IME, clipboard (text only for v1).
  You cannot build a login form without it, and IME must be validated in A0 anyway. *Rich* editing
  — multi-line, undo, word navigation — stays deferred indefinitely.
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

### B1 · Layering and dismissal
- An overlay layer painted after the main tree — far simpler than DOM portals, with no stacking
  contexts and no `z-index` arithmetic.
- **Hit-testing must respect layers**: a click on an overlay must not reach nodes beneath it.
  Easy to get wrong with a single paint tree.
- Dismissal: click-outside, Escape, scroll-outside.
- Focus scopes: trap, **restore focus to the trigger on dismissal**, focus stack.

### B2 · Positioning
Adapter for `@floating-ui/core`, which is platform-agnostic by design (built that way for React
Native). Implement its ~8 platform methods and get collision-aware placement for tooltips,
dropdowns and popovers. We are a *better* host than a DOM shim here — `happy-dom` returns zeros
from `getBoundingClientRect` because it has no layout. We have layout.

### B3 · Animation
- **A generic timeline is the primitive, not CSS.** `animate(node, { duration, curve, props })`.
  CSS transitions and keyframes compile *into* it, and imperative animation uses the same system.
  One runtime, two authoring models.
- **Transitions before keyframes** — state A → B over time is what shadcn actually uses.
- Compile-time precomputes endpoints and easing tables; ticking is irreducibly runtime.
- `prefers-reduced-motion` **disables** animation rather than slowing it. Accessibility
  requirement, not polish. Wire it before shipping animation.
- The frame loop lives **in the engine**, which is where it belongs now that the engine owns the
  window and paint. Bun still drives — it just calls `tick()` on a timer while animations are
  active instead of blocking in `wait_event`. That is a much smaller change than it was when the
  loop would have lived in TypeScript, though the architecture is still settled in A1.

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
- **Tier 1** — Input, Checkbox, Radio, Switch, Tabs, Toggle. Needs A3 and A5's text input.
- **Tier 2 — cut from v1.** Dropdown, Select, Combobox, Popover, Tooltip, Dialog, Sheet, Command
  each need layering, positioning and animation: three subsystems for visual polish. **A desktop app
  with working forms and no dropdowns is shippable; one with a broken Dialog is not.** These are
  where every framework discovers years of edge cases, and cutting them is the single largest
  reduction in single-maintainer risk available.

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
- Split into packages: `compiler`, `runtime`, `cli`, `primitives`, `components`.
- `create <name>` template with Tailwind preinstalled, so integration is exercised from day one.
- CLI: `compile`, `dev`, `build`.
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

- `bun build --compile`; the engine extracted to a real path on first run, since `dlopen` needs a
  file — and on macOS, code signing requires that too.
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

Binary size replaces the old "~20 KB runtime" claim. Earlier estimate of 10–15 MB was wrong:
`skia-safe` enables `embed-icudtl` by default on Windows, which bakes ~10 MB of ICU data into the
binary, putting it at **20+ MB** — or ship `icudtl.dat` as a sidecar and take the complexity
instead. Against Electron's ~150 MB it is still a strong number, but it must be stated honestly.

**Document the Tauri comparison aggressively.** Every prospective user will ask "why not Tauri?"
Without a published answer, "no web target" reads as a limitation rather than a deliberate
position. The answer is memory per window and predictable frame cost, and it needs numbers.

### D4 · Docs and API freeze
**Freeze the authoring API before adoption.** `cn`, `signal`, `.map(fn, { key })`, `bindValue`,
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
             shared memory   A3 Input ────┼──► Tier 1  (forms actually work)
             + IME proof     A4 Scrolling ┤
                             A5 Img/icons/│
                                text input┘
                                          │
                            D1 CLI + CSS hot reload ──► D2 Packaging ──► D3 Measure ──► v1
                                          │
                   Radix API experiment ──► (compat layer only if it passes)

deferred past v1: Tier 2 components · rich text editing · markup hot reload
                  multi-window · plugin API · animation · layering · positioning
```

**Immediate next step: A0 step 3 — the engine's own render thread**, then the IME proof.
Bun still calls `tick()`, so a long computation in app code stalls a resize. The
staged/live split that makes the move safe is already in place; what is missing is a
thread-safe handle and a published-snapshot swap.

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
