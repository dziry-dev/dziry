/**
 * The architecture of dziri, as data.
 *
 * This file is the single source of truth for `architecture/` — the React view
 * renders it, `check.ts` validates it, and `ARCHITECTURE.md` is generated from
 * it. Prose about the architecture goes *here*, not into the component.
 *
 * Two rules keep it from rotting:
 *
 *   1. Every claim that names code carries a `files` citation, and `bun run
 *      arch:check` fails if a cited path no longer exists.
 *   2. Anything derivable is *not* written down. Line counts come from the repo
 *      at serve time (`metrics.ts`); the shared-memory tables are imported from
 *      `src/protocol/schema.ts` directly, so the protocol view cannot disagree
 *      with the protocol.
 *
 * What is left is the part a machine cannot derive: what each piece is *for*,
 * why it is shaped that way, and which invariants a refactor must not break.
 */

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export type LayerId = "authoring" | "compiler" | "runtime" | "protocol" | "engine" | "tooling";

export type Layer = {
  id: LayerId;
  label: string;
  /** Where this layer's code lives — prefixes, matched against repo-relative paths. */
  roots: string[];
  blurb: string;
};

/**
 * Order is load-bearing: the colour slots in `theme.css` are assigned by index
 * and were validated as an adjacent-pair set. Re-ordering means re-validating.
 */
export const LAYERS: Layer[] = [
  {
    id: "authoring",
    label: "Authoring",
    roots: ["app/"],
    blurb:
      "What a person writes: JSX, a stylesheet, and module-level signals. None of it ships — " +
      "the compiler evaluates it and keeps the result.",
  },
  {
    id: "compiler",
    label: "Compiler",
    roots: ["src/compiler/", "src/compile.ts", "src/ir.ts", "src/variants.ts"],
    blurb:
      "Selector matching, specificity, cascade, inheritance, shorthand expansion, unit " +
      "resolution and interning — all of it at build time, ending in integer arrays.",
  },
  {
    id: "runtime",
    label: "Runtime",
    roots: ["src/runtime/"],
    blurb:
      "The only code that survives to run time: signals, and the three things they drive — " +
      "text bindings, style patches, list arenas. No parser, no cascade, no diff of a tree.",
  },
  {
    id: "protocol",
    label: "Protocol & host",
    roots: [
      "src/protocol/",
      "src/engine/",
      "src/app.ts",
      "native-src/dziri-engine/src/protocol.rs",
      "native-src/dziri-engine/src/tables.rs",
      "native-src/dziri-engine/src/lib.rs",
    ],
    blurb:
      "The boundary. One schema generates both sides' field identities; the engine reports " +
      "byte offsets at run time. Everything else is a direct write into shared memory.",
  },
  {
    id: "engine",
    label: "Engine",
    roots: [
      "native-src/dziri-engine/src/",
      "native-src/dziri-engine/examples/",
      "native-src/dziri-engine/tests/",
      "native-src/dziri-engine/build.rs",
    ],
    blurb:
      "Rust cdylib: Taffy lays out, Skia paints, SDL3 owns the window and input. It reads " +
      "Bun-written memory as untrusted input and never lets a panic cross back.",
  },
  {
    id: "tooling",
    label: "Guards & oracles",
    roots: ["scripts/", "native-src/skia-probe/"],
    blurb:
      "The scripts that keep claims honest — Chrome as an oracle for CSS and layout, golden " +
      "frames for paint, generated-vs-source checks for the protocol.",
  },
];

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export type Phase = "build" | "boundary" | "frame";

export type Stage = {
  id: string;
  phase: Phase;
  layer: LayerId;
  title: string;
  /** One line, shown on the card. Should read as a verb phrase. */
  summary: string;
  /** The detail panel. Each paragraph is a separate string. */
  detail: string[];
  /** Repo-relative paths. Validated by `arch:check`. */
  files: string[];
  /** Short factual notes — measurements, counts, encodings. */
  facts?: string[];
  /** What must stay true here. Drawn from ARCHITECTURE-REVIEW.md Part 1 §4. */
  invariant?: string;
};

export const STAGES: Stage[] = [
  // --- build time ----------------------------------------------------------
  {
    id: "author",
    phase: "build",
    layer: "authoring",
    title: "app.tsx + app.css",
    summary: "JSX, a stylesheet, and signals declared at module scope",
    detail: [
      "The authoring surface is ordinary JSX and ordinary CSS. State is a signal created at " +
        "module scope and exported; a handler is a function that assigns to one.",
      "There are two front-ends — JSX and HTML — and they land on the same `Element` tree, so " +
        "everything after the parse is shared. JSX is the default; the HTML path is what " +
        "existed first.",
    ],
    files: ["app/app.tsx", "app/app.css", "app/state.ts", "src/compiler/html.ts"],
  },
  {
    id: "evaluate",
    phase: "build",
    layer: "compiler",
    title: "Evaluate, don't render",
    summary: "Importing the module is running the components — once, at build time",
    detail: [
      "Bun transpiles the JSX against `src/compiler/jsx-runtime.ts`, so `await import(entry)` " +
        "*is* the component pass. There is no renderer and no virtual DOM; the tree that comes " +
        "back is the tree the compiler compiles.",
      "While that import runs, `setCompiling(true)` changes what reading a signal means. An " +
        "array-valued signal hands back a recording proxy that remembers its owner, so " +
        "`todos.value.map(…)` compiles to a dynamic list instead of silently freezing whatever " +
        "the initial data happened to be.",
    ],
    files: [
      "src/compiler/jsx-runtime.ts",
      "src/compiler/jsx-dev-runtime.ts",
      "src/runtime/signal.ts",
      "src/compiler/item-path.ts",
    ],
    facts: ["The entry module is imported as a file URL — a bare relative path would resolve against the compiler."],
  },
  {
    id: "cascade",
    phase: "build",
    layer: "compiler",
    title: "Resolve the cascade",
    summary: "Selectors, specificity, inheritance and shorthands collapse to numbers",
    detail: [
      "Each node's style is resolved as a full cascade from scratch — including each pseudo-state, " +
        "rather than as a patch over the finished base. That is what makes correct per-property " +
        "`hover ∧ focus` merging cheap later: the machinery that computes it already exists.",
      "Values become integers and floats with fixed encodings. `auto` is NaN, `unset` in a u8 " +
        "enum is 255, and a grid line of 0 decodes to `Auto` engine-side — coercing unset to " +
        "variant 0 is what silently collapsed grid items in the spike.",
    ],
    files: ["src/compiler/compile.ts", "src/compiler/css.ts", "src/ir.ts"],
    facts: ["1215 nodes compile in ~28 ms."],
    invariant:
      "Resolve each pseudo-state as a full cascade, not a diff over the base. The merge story depends on it.",
  },
  {
    id: "variants",
    phase: "build",
    layer: "compiler",
    title: "Precompile the interaction states",
    summary: "Every toggle and pseudo-state becomes a list of style-table writes",
    detail: [
      "A conditional class is not resolved at run time. The compiler runs one extra full " +
        "compilation per toggle and diffs it, so `.light` becomes 46 writes and `.compact` " +
        "becomes 6 — each a `(field, slot)` pair, with slots interned over the *vector* of " +
        "values across all variants rather than per-variant.",
      "That interning is what makes conflict detection possible: two toggles writing the same " +
        "`(field, slot)` cannot both be correct, because the result would depend on apply order " +
        "rather than on specificity. The compiler exits non-zero rather than shipping it.",
    ],
    files: ["src/compiler/variants.ts", "src/compiler/variant-compile.ts", "src/variants.ts"],
    invariant:
      "Patch the style table per (field, slot). Do not 'simplify' to swapping per-node style pointers — conflict detection and the predicate-mask table both depend on it.",
  },
  {
    id: "resolve-refs",
    phase: "build",
    layer: "compiler",
    title: "Map live objects back to exports",
    summary: "`{count}` and `onClick={increment}` become named imports",
    detail: [
      "Bindings and handlers reached the tree as live JavaScript objects. They are matched back " +
        "to the exports they came from by *identity* — not by a naming convention — so the " +
        "generated module can import them by name.",
      "Object identity is the only mechanism that answers 'is this a signal?' at build time " +
        "without asking the author to follow a rule.",
    ],
    files: ["src/compiler/resolve-refs.ts"],
  },
  {
    id: "emit",
    phase: "build",
    layer: "compiler",
    title: "Emit app/ui.gen.ts",
    summary: "Typed arrays, `satisfies CompiledUi` — the artifact is the IR",
    detail: [
      "The output is a TypeScript module of typed arrays plus the imports resolved above. It is " +
        "not serialized data that something parses; it is the in-memory representation already.",
      "It declares `satisfies` against the runtime's own types, so a field the compiler renames " +
        "is a compile error in the artifact rather than a `TypeError` in whichever test touches " +
        "it first.",
    ],
    files: ["src/compile.ts", "src/ir.ts"],
    facts: ["Untracked by git — a build artifact; tracked would mean an 18 KB integer diff per style change."],
  },

  // --- the boundary --------------------------------------------------------
  {
    id: "open",
    phase: "boundary",
    layer: "protocol",
    title: "dlopen and describe",
    summary: "The engine allocates; Bun wraps each field span as a typed-array view",
    detail: [
      "Layout is struct-of-arrays: every field is its own contiguous span. The engine owns the " +
        "allocation and reports a `(byteOffset, elementSize, capacity)` descriptor per field; " +
        "Bun calls `toArrayBuffer` over each one with **no finalizer**, because the memory is Rust's.",
      "Field *identity* is generated into both sides from one schema, and the engine also reports " +
        "a schema hash. Neither side hardcodes the other's layout — a startup handshake detects a " +
        "wrong layout, but generation is what prevents 'field inserted, offset forgotten, release " +
        "build, silent corruption'.",
      "The handle is a `u32` — an index plus a generation into a table the engine owns — so a " +
        "handle used after `close()` is a lookup miss rather than a dereference of freed memory.",
    ],
    files: [
      "src/protocol/schema.ts",
      "src/protocol/generated.ts",
      "src/engine/host.ts",
      "native-src/dziri-engine/src/protocol.rs",
      "native-src/dziri-engine/src/lib.rs",
    ],
    facts: ["The descriptor reports absolute pointers, not (base, offset) — there are three arenas."],
    invariant:
      "The arena stays a bare `*mut u8`, with slices materialised only inside function bodies. No Rust reference into shared memory may be live across a return to Bun.",
  },
  {
    id: "upload",
    phase: "boundary",
    layer: "protocol",
    title: "Write into the staged arena",
    summary: "A style patch is a memory write, not a call",
    detail: [
      "This is the point of the whole design: a style patch, a list relink, a `hidden` byte and a " +
        "string are all direct writes through typed-array views. The FFI surface is `host.ts` and " +
        "nothing else.",
      "The uploader is deliberately unconditional about *which* tables it writes, because the " +
        "engine's commit compares span by span and reports what changed — a second diff on this " +
        "side would be the same work with less information. Strings are the exception, uploaded " +
        "incrementally, because re-encoding every row of a long list per keystroke is not free.",
    ],
    files: ["src/engine/upload.ts", "src/app.ts"],
    invariant:
      "Keep the staged/live/bounds split and span-wise commit. This — not monomorphism — is the real argument for struct-of-arrays. Do not collapse to one arena; do not go AoS.",
  },

  // --- the frame -----------------------------------------------------------
  {
    id: "tick",
    phase: "frame",
    layer: "protocol",
    title: "tick()",
    summary: "The one FFI call per frame",
    detail: [
      "Bun drives the loop and calls `tick()`. Everything the frame needs is already in memory; " +
        "the call carries no arguments beyond the handle.",
      "A panic inside is caught and *poisons* the engine — every later call returns `POISONED` — " +
        "because `catch_unwind` needs `AssertUnwindSafe` over `&mut Engine`, and that assertion is " +
        "only honest if nobody can then observe half-updated state.",
    ],
    files: ["native-src/dziri-engine/src/lib.rs", "native-src/dziri-engine/src/error.rs"],
    invariant:
      "Keep the FFI boundary shape in full: catch_unwind, i32 status never a value, out-pointers, poisoning, and `panic = \"unwind\"` pinned in both Cargo profiles.",
  },
  {
    id: "commit",
    phase: "frame",
    layer: "engine",
    title: "Input, then commit",
    summary: "Span-by-span diff turns 'some bytes changed' into a narrow patch",
    detail: [
      "Input is pumped first, so a click staged by Bun last frame and a click arriving this frame " +
        "are never resolved against different layouts.",
      "`commit` compares the staged arena against the live one span by span and classifies what " +
        "moved. This is what makes a `hidden` toggle a patch rather than a rebuild — under " +
        "array-of-structs it would be neither cheap nor local.",
    ],
    files: ["native-src/dziri-engine/src/tables.rs", "native-src/dziri-engine/src/engine.rs"],
  },
  {
    id: "layout",
    phase: "frame",
    layer: "engine",
    title: "Taffy",
    summary: "Flex and grid, rounded to whole pixels, bounds published back",
    detail: [
      "The tree is walked with an explicit stack rather than recursion, child ids are range-checked, " +
        "and traversals carry a budget — Bun-written memory is untrusted input, and a malformed " +
        "table must be an error rather than a hang or a crash.",
      "Taffy rounds layout to whole pixels by default, which is what stops boxes landing on " +
        "half-pixel edges. Computed bounds are written back into the `layout` table, which Bun " +
        "reads for hit-testing and the imperative API.",
    ],
    files: ["native-src/dziri-engine/src/layout.rs"],
    invariant:
      "Keep the systematic distrust of host-written table contents: budgeted walks, range-checked ids, and a bad string slot reading as \"\".",
  },
  {
    id: "paint",
    phase: "frame",
    layer: "engine",
    title: "Skia",
    summary: "Raster paint; an idle tick presents nothing at all",
    detail: [
      "Paint reads the style table out of live memory as it draws, which is why a paint-only field " +
        "needs no bookkeeping — the repaint that every non-empty commit already schedules is the " +
        "whole response.",
      "When nothing changed there is no draw and no present. The window keeps the last frame it " +
        "was given, and not presenting is not the same as presenting nothing.",
    ],
    files: ["native-src/dziri-engine/src/paint.rs", "native-src/dziri-engine/src/text.rs"],
  },
  {
    id: "events",
    phase: "frame",
    layer: "runtime",
    title: "Drain events → signals",
    summary: "A click writes a signal; batching makes it one repaint",
    detail: [
      "Events come back through the same shared memory. A row's handler is found by decomposing " +
        "the node into `(slot, offset)`; a plain handler is looked up by node.",
      "Focus lives in the engine, because the engine owns input and is the thing that knows what " +
        "was clicked. It rides along on the event rather than being mirrored on the Bun side.",
      "Writes batch, so one click costs one repaint however many signals it touches — and the " +
        "loop closes: signals → bindings, patches and lists mutate the IR in place → upload → tick.",
    ],
    files: [
      "src/runtime/bindings.ts",
      "src/runtime/patches.ts",
      "src/runtime/list-runtime.ts",
      "src/runtime/signal.ts",
    ],
    invariant:
      "Append-and-abandon list growth: no node id is ever invalidated, which is the only reason focus survives a reorder.",
  },
];

// ---------------------------------------------------------------------------
// Who touches which table
// ---------------------------------------------------------------------------

/**
 * The tables themselves are imported from `src/protocol/schema.ts` by the view.
 * What the schema does not say is the *direction* of each one, which is the
 * thing you actually need when debugging a wrong frame.
 */
export const TABLE_ROLES: Record<string, { writer: string; reader: string; note: string }> = {
  nodes: {
    writer: "compiler, then list relinking and `hidden`",
    reader: "engine",
    note: "Link fields are prefilled to -1: zero is a valid node id, so zeroed memory would say every node is its own first child.",
  },
  styles: {
    writer: "compiler, then variant patches",
    reader: "engine, every frame",
    note: "Style values stay zeroed, and there zero is real — `width: 0`, not auto. Auto is NaN.",
  },
  variants: {
    writer: "compiler",
    reader: "engine painter",
    note: "Per interactive node: a bitmask of the predicates its styling reads, and where its style run begins.",
  },
  variantSlots: {
    writer: "compiler",
    reader: "engine painter",
    note: "Entry runStart+i is the style for the predicate combination whose compacted bits equal i; entry 0 is the base style.",
  },
  lists: {
    writer: "list runtime",
    reader: "engine",
    note: "The one place node count is a run-time value. Arenas grow by appending; ids are never reused.",
  },
  layout: {
    writer: "engine",
    reader: "Bun — hit-testing and the imperative API",
    note: "The only table that flows the other way.",
  },
  strings: {
    writer: "Bun, incrementally",
    reader: "engine",
    note: "JS strings cannot be shared, so Bun writes UTF-8 into an arena and records (offset, length) here.",
  },
};

// ---------------------------------------------------------------------------
// The bets
// ---------------------------------------------------------------------------

export type Verdict = "keep" | "keep-with-changes";

export type Bet = {
  id: string;
  title: string;
  verdict: Verdict;
  claim: string;
  /** What the architecture review concluded, 2026-07-30. */
  review: string;
};

/** From ARCHITECTURE-REVIEW.md Part 1 §1. All six survived; two need structural work. */
export const BETS: Bet[] = [
  {
    id: "compile-time-css",
    title: "Compile-time CSS and cascade → integer IR",
    verdict: "keep",
    claim: "Nothing that can be resolved before the app runs should be resolved while it runs.",
    review:
      "Every failure found was an implementation bug in an untested compiler, not a consequence of resolving early.",
  },
  {
    id: "shared-memory",
    title: "Shared-memory SoA tables instead of FFI calls",
    verdict: "keep",
    claim: "The boundary should be memory both sides can address, not a call surface.",
    review:
      "The mechanism is right and its real justification is stronger than the stated one: span-wise commit is what turns 'some bytes changed' into a narrow patch, and AoS would make a `hidden` toggle a full rebuild.",
  },
  {
    id: "rust-cdylib",
    title: "Rust cdylib — SDL3 + Taffy + Skia — loaded from Bun",
    verdict: "keep",
    claim: "The engine belongs in a native library, not in JavaScript.",
    review: "Taffy and Skia were chosen on measurements and both hold.",
  },
  {
    id: "signal-identity",
    title: "Signal object identity + module-export reverse mapping",
    verdict: "keep",
    claim: "Identity answers 'is this a signal?' at compile time without a naming convention.",
    review:
      "The 'per-instance state is unrepresentable' objection was refuted. What needs work is the diagnostic layer around it, not the mechanism.",
  },
  {
    id: "precompiled-variants",
    title: "Precompiled interaction-state variants",
    verdict: "keep-with-changes",
    claim: "Hover, focus and conditional classes are style-table patches computed at build time.",
    review:
      "The single best idea in the compiler. The three fixed roles were the wrong shape and are being replaced by a predicate mask — the `variants` / `variantSlots` tables are that replacement.",
  },
  {
    id: "list-arenas",
    title: "Fixed-stride arenas for dynamic lists",
    verdict: "keep-with-changes",
    claim: "A list is a homogeneous subtree repeated at a stride, grown by appending.",
    review:
      "Never invalidating a node id is exactly right. The wrapper node broke grid, the engine threw away link granularity, and `dataOffset` — the virtualization story — existed only in the IR.",
  },
];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export type Guard = {
  script: string;
  title: string;
  what: string;
  /** The oracle it measures against, if any. */
  oracle?: string;
};

/** Validated against package.json by `arch:check` — a renamed script fails the build. */
export const GUARDS: Guard[] = [
  {
    script: "protocol-guard",
    title: "Protocol identity",
    what: "Proves the shared-memory protocol's two halves still agree — offsets, field identity, enums, FFI symbols.",
  },
  {
    script: "boundary-diff",
    title: "Boundary sanity",
    what: "Validates the tables Bun is about to hand the engine: link consistency, index ranges, sibling cycles, arena bounds.",
  },
  {
    script: "characterize",
    title: "Compiler output frozen",
    what: "Golden files of compiled output, so a refactor is provably behaviour-preserving.",
  },
  {
    script: "golden",
    title: "Visual regression",
    what: "Renders scenarios headlessly and compares against blessed PNGs.",
  },
  {
    script: "conformance",
    title: "CSS conformance",
    what: "Compiles a declaration and compares the emitted value with what the browser computes.",
    oracle: "headless Chrome",
  },
  {
    script: "layout-diff",
    title: "Layout conformance",
    what: "Lays out the same html+css in dziri and in the browser at the same viewport, then compares every box.",
    oracle: "headless Chrome",
  },
  {
    script: "spec-audit",
    title: "Initial values",
    what: "Checks computed-style defaults and inheritance flags for every style field.",
    oracle: "mdn-data",
  },
  {
    script: "css-coverage",
    title: "Coverage, measured",
    what: "What CSS exists versus what dziri supports, bucketed as supported / unsupported / committed non-goal.",
    oracle: "mdn-data",
  },
  {
    script: "tailwind-coverage",
    title: "Tailwind coverage",
    what: "What fraction of Tailwind works, and what is blocking the rest ranked by classes unblocked.",
  },
  {
    script: "html-coverage",
    title: "Element defaults",
    what: "How each HTML element renders in dziri versus the browser — the table that specifies the UA stylesheet.",
    oracle: "headless Chrome",
  },
  {
    script: "doc-lint",
    title: "Citations resolve",
    what: "Verifies that every `file.ext:LINE` citation in the Markdown docs still points at something.",
  },
  {
    script: "probe",
    title: "Browser facts",
    what: "Measures what a browser actually does over CDP, so behaviour claims are recorded rather than remembered.",
    oracle: "headless Chrome",
  },
];

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

export type MilestoneState = "done" | "partial" | "next" | "planned";

export type Milestone = {
  id: string;
  title: string;
  state: MilestoneState;
  note: string;
};

/** Condensed from ROADMAP.md. `next` marks the one thing that matters now. */
export const MILESTONES: Milestone[] = [
  {
    id: "A0",
    title: "The engine",
    state: "partial",
    note: "Crate landed: window, Taffy, Skia, structured errors, descriptor + tick, staging buffer, and the three old runtime files deleted. IME proof and the window-chrome decision remain; the render thread was withdrawn.",
  },
  {
    id: "A1",
    title: "Tailwind conformance",
    state: "planned",
    note: "Tailwind defines the CSS subset. Attribute selectors and `data-[state=]` are on the critical path.",
  },
  {
    id: "A2",
    title: "Text",
    state: "next",
    note: "There is no text wrapping. It is what makes a narrow window look broken, and the window floor only keeps you away from the worst of it.",
  },
  { id: "A3", title: "Input system", state: "planned", note: "" },
  {
    id: "A4",
    title: "Scrolling",
    state: "partial",
    note: "Landed: per-axis overflow with clipping, wheel scrolling with nested-scroll escape, hit-testing that follows the offset, and a grabbable overlay scrollbar.",
  },
  { id: "A5", title: "Images, icons, single-line input", state: "planned", note: "" },
  { id: "B", title: "Interactive surfaces", state: "planned", note: "Layering and dismissal, positioning, animation." },
  { id: "C", title: "The component system", state: "planned", note: "Primitives, shadcn-compatible components, refs rather than selectors." },
  { id: "D", title: "Product readiness", state: "planned", note: "CLI, hot reload, packaging, published measurements, docs and an API freeze." },
];

// ---------------------------------------------------------------------------
// The animated figures
// ---------------------------------------------------------------------------

/**
 * The tour, in the order the ideas depend on each other.
 *
 * Only the index lives here — each figure's steps and captions are inseparable
 * from its drawing and stay in `figures/*.tsx`. What is here is the running
 * order, the question each figure answers, and the code it claims to explain,
 * so `arch:check` can verify the citations and refuse a figure with no module.
 */
export const FIGURE_ORDER: { id: string; title: string; answers: string; files: string[] }[] = [
  {
    id: "fig-pipeline",
    title: "One div, end to end",
    answers: "Where is the boundary, and what has already happened by the time you reach it?",
    files: ["architecture/figures/PipelineFigure.tsx", "src/compile.ts"],
  },
  {
    id: "fig-cascade",
    title: "The cascade, resolved once",
    answers: "Does resolving CSS early lose anything?",
    files: ["architecture/figures/CascadeFigure.tsx", "src/compiler/compile.ts"],
  },
  {
    id: "fig-memory",
    title: "Why struct-of-arrays",
    answers: "Why is the boundary memory instead of a call surface?",
    files: ["architecture/figures/MemoryFigure.tsx", "native-src/dziri-engine/src/tables.rs"],
  },
  {
    id: "fig-loop",
    title: "The frame loop",
    answers: "What does a frame actually cost, and what does an idle one cost?",
    files: ["architecture/figures/FrameLoopFigure.tsx", "native-src/dziri-engine/src/engine.rs"],
  },
  {
    id: "fig-variants",
    title: "Hover costs one u16",
    answers: "How can interaction state work with no selector matching at run time?",
    files: ["architecture/figures/VariantsFigure.tsx", "src/compiler/variant-compile.ts"],
  },
  {
    id: "fig-lists",
    title: "Lists that never renumber",
    answers: "How does anything dynamic work when the tree was decided at build time?",
    files: ["architecture/figures/ListArenaFigure.tsx", "src/runtime/list-runtime.ts"],
  },
];

/** Named docs, so the view can point at the long-form source. */
export const DOCS: { path: string; what: string }[] = [
  { path: "ROADMAP.md", what: "Phases, decisions and the critical path." },
  { path: "ARCHITECTURE-REVIEW.md", what: "The fix-order authority. Part 1 §4 lists what a refactor must not touch." },
  { path: "API.md", what: "The authoring API as planned, with status per surface." },
  { path: "NOTES.md", what: "Working notes and measurements." },
  { path: "BROWSER-FACTS.md", what: "Browser behaviour that was measured rather than remembered." },
  { path: "framework-design.md", what: "The long-form design argument." },
  { path: "data-layer-design.md", what: "The data layer, designed but not built." },
];
