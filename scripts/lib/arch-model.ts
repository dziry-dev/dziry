/**
 * The C4 model of dziry, as data.
 *
 * This is the half a machine cannot derive: what each piece is *for*, which
 * process or thread it runs in, and what may not import what. The other half —
 * every module, every edge between them — is read out of the source by
 * `scripts/arch-diagram.ts` and is never written down here.
 *
 * Two rules keep it from rotting, both enforced by `bun run arch-diagram --check`:
 *
 *   1. Every element carries a `files` citation, and the check fails if a cited
 *      path no longer exists.
 *   2. Every source file must fall inside some layer, so a new subsystem that
 *      nobody put on the map is a failure rather than a silent omission.
 *
 * Deliberately self-contained: it imports nothing from `architecture/`, which is
 * a separate viewer that may be deleted, and nothing from `src/` except the
 * protocol schema — that one *is* the boundary, so importing it is what stops
 * the boundary diagram from disagreeing with the protocol.
 */

// ---------------------------------------------------------------------------
// Layers — the buckets every source file must fall into
// ---------------------------------------------------------------------------

export type LayerId =
  | "authoring"
  | "cli"
  | "compiler"
  | "ir"
  | "runtime"
  | "protocol"
  | "host"
  | "engine"
  | "tooling";

export type Layer = {
  id: LayerId;
  label: string;
  /** Repo-relative path prefixes. Longest match wins, so `src/compiler/` beats `src/`. */
  roots: string[];
  blurb: string;
};

export const LAYERS: Layer[] = [
  {
    id: "authoring",
    label: "Authoring",
    roots: ["windows/"],
    blurb:
      "What a person writes: JSX, a stylesheet, module-level signals. None of it ships — " +
      "the compiler evaluates it and keeps only the result.",
  },
  {
    id: "cli",
    label: "CLI",
    roots: ["src/cli/"],
    blurb:
      "The driver: `dev` and `build`. Not the compiler — it is the one build-time piece " +
      "allowed to know about the host, because `build` embeds the engine binary.",
  },
  {
    id: "compiler",
    label: "Compiler",
    roots: [
      "src/compiler/",
      "src/compile.ts",
      "src/compile-window.ts",
      "src/routes.ts",
      "src/route-chain.test.ts",
      "src/index.ts",
      "src/css.d.ts",
    ],
    blurb:
      "Selector matching, specificity, cascade, inheritance, shorthand expansion, unit " +
      "resolution and interning — all at build time, ending in integer arrays.",
  },
  {
    id: "ir",
    label: "IR",
    // `hot.ts` and `find-row.ts` sit here for the same reason `ir.ts` does: both
    // sides of the build/run boundary import them (ir.ts itself imports find-row),
    // so they are contract, not compiler and not runtime.
    roots: ["src/ir.ts", "src/hot.ts", "src/find-row.ts", "src/find-row.test.ts"],
    blurb:
      "The build/run contract: the shape the compiler emits and the runtime and host read. " +
      "One file, and the highest fan-in in the repo — which is why it gets its own layer " +
      "rather than hiding inside the compiler.",
  },
  {
    id: "runtime",
    label: "Runtime",
    // The Effect and LiveStore seams live with the runtime: both are `source()`
    // wrappers a consumer's app runs, importing the store engines as types only.
    roots: ["src/runtime/", "src/effect.ts", "src/livestore.ts", "src/livestore.test.ts"],
    blurb:
      "The only code that survives to run time: signals, and the three things they drive — " +
      "text bindings, style patches, list arenas. No parser, no cascade, no tree diff.",
  },
  {
    id: "protocol",
    label: "Protocol",
    roots: [
      "src/protocol/",
      "native-src/dziry-engine/src/protocol.rs",
      "native-src/dziry-engine/src/tables.rs",
    ],
    blurb:
      "One schema generates both sides' field identities; the engine reports byte offsets " +
      "at run time. Everything else is a direct write into shared memory.",
  },
  {
    id: "host",
    label: "Host",
    roots: ["src/host/", "src/engine/"],
    blurb:
      "Loads a compiled window, uploads it, dispatches input. Two threads — the engine " +
      "thread that must never block, and the app thread that may.",
  },
  {
    id: "engine",
    label: "Engine",
    roots: ["native-src/dziry-engine/"],
    blurb:
      "Rust cdylib: Taffy lays out, Skia paints, SDL3 owns the window and input. Reads " +
      "Bun-written memory as untrusted input and never lets a panic cross back.",
  },
  {
    id: "tooling",
    label: "Guards & oracles",
    roots: ["scripts/", "native-src/skia-probe/"],
    blurb:
      "The scripts that keep claims honest — Chrome as an oracle for CSS and layout, " +
      "golden frames for paint, generated-vs-source checks for the protocol.",
  },
];

// ---------------------------------------------------------------------------
// Layering rules — the edges that must not exist
// ---------------------------------------------------------------------------

/**
 * Each rule is an invariant a refactor must not break, with the reason it exists.
 * `arch-diagram` reports any real import that matches one, naming the two files.
 *
 * These are stated as *forbidden* pairs rather than an allowed matrix because the
 * allowed matrix changes whenever a module moves, and a rule nobody can explain
 * gets deleted the first time it is inconvenient.
 */
export type Rule = {
  from: LayerId;
  to: LayerId;
  why: string;
  /** Value imports only — a `import type` edge costs nothing at run time. */
  valueOnly?: boolean;
};

export const RULES: Rule[] = [
  {
    from: "runtime",
    to: "compiler",
    why:
      "The runtime is the only code that ships. Importing the compiler would drag the " +
      "cascade, the parser and the emitter into the binary — the one thing the whole " +
      "design exists to avoid.",
    valueOnly: true,
  },
  {
    from: "runtime",
    to: "host",
    why:
      "Signals and bindings must be usable without a window. The host depends on the " +
      "runtime, never the other way round.",
    valueOnly: true,
  },
  {
    from: "protocol",
    to: "compiler",
    why:
      "`schema.ts` is read by the generator that writes both sides of the boundary. It " +
      "has to stay evaluable on its own.",
  },
  {
    from: "protocol",
    to: "runtime",
    why: "Same reason: the schema describes the boundary and must not depend on either side of it.",
  },
  {
    from: "protocol",
    to: "host",
    why: "Same reason.",
  },
  {
    from: "compiler",
    to: "host",
    why:
      "The compiler *emits* code that imports the host; it must not import the host " +
      "itself, or building a window would require a window.",
    valueOnly: true,
  },
  {
    from: "compiler",
    to: "cli",
    why: "The compiler is a library the CLI drives. Depending back on the driver would make it unusable from anything else.",
  },
  {
    from: "ir",
    to: "compiler",
    // valueOnly: the stated hazard is *loading* the compiler at run time, which an
    // `import type` cannot do — ir.ts typing a field as the compiler's `ItemPath`
    // is the contract naming a shape, erased before anything runs.
    valueOnly: true,
    why:
      "`ir.ts` is the contract both sides read. If it depended on the compiler, importing " +
      "the contract at run time would pull the compiler in with it.",
  },
  {
    from: "ir",
    to: "runtime",
    why:
      "Same reason, the other direction. The one permitted edge is the `ReadonlySignal` " +
      "*type*, which costs nothing at run time.",
    valueOnly: true,
  },
  { from: "ir", to: "host", why: "The contract must not depend on either side of it." },
  { from: "ir", to: "cli", why: "The contract must not depend on either side of it." },
];

// ---------------------------------------------------------------------------
// C4 level 1 — context
// ---------------------------------------------------------------------------

export type Person = { id: string; label: string; descr: string };
export type Ext = { id: string; label: string; descr: string };

export const PEOPLE: Person[] = [
  {
    id: "author",
    label: "App author",
    descr: "Writes JSX, CSS and signals under windows/. Runs `dziry dev` and `dziry build`.",
  },
  {
    id: "enduser",
    label: "End user",
    descr: "Runs the built desktop app. Clicks, types, scrolls, resizes.",
  },
];

export const EXTERNALS: Ext[] = [
  {
    id: "os",
    label: "Operating system",
    descr: "Window manager, input, clipboard, fonts. Reached only through SDL3.",
  },
  { id: "gpu", label: "Display", descr: "The raster surface Skia paints into, presented by SDL3." },
  {
    id: "tailwind",
    label: "Tailwind CLI",
    descr: "Build-time only. Produces the CSS the compiler then resolves away.",
  },
  {
    id: "chrome",
    label: "Headless Chrome",
    descr:
      "Oracle, not a dependency. Guards diff dziry's CSS, layout and defaults against it over CDP.",
  },
];

// ---------------------------------------------------------------------------
// C4 level 2 — containers
// ---------------------------------------------------------------------------

export type Container = {
  id: string;
  label: string;
  tech: string;
  descr: string;
  /** "build" runs once and ships nothing; "run" is in the shipped app. */
  phase: "build" | "run";
  db?: boolean;
  files: string[];
};

export const CONTAINERS: Container[] = [
  {
    id: "cli",
    label: "dziry CLI",
    tech: "Bun, TypeScript",
    descr: "`dev` and `build`. Drives the compiler, then launches the host.",
    phase: "build",
    files: ["src/cli/index.ts", "src/cli/build.ts"],
  },
  {
    id: "compiler",
    label: "Compiler",
    tech: "Bun, TypeScript",
    descr:
      "Evaluates the JSX, resolves the whole cascade, interns styles, emits integer arrays. " +
      "None of it ships.",
    phase: "build",
    files: ["src/compiler/build.ts", "src/compiler/compile.ts", "src/ir.ts"],
  },
  {
    id: "artifact",
    label: "Compiled window",
    tech: "generated TypeScript",
    descr:
      "`windows/<id>/ui.gen.ts` — typed arrays plus the handful of refs the runtime needs. " +
      "The build/run seam.",
    phase: "build",
    db: true,
    files: ["src/compiler/compile.ts"],
  },
  {
    id: "engineThread",
    label: "Engine thread",
    tech: "Bun main thread",
    descr:
      "The window and the frame loop, nothing else. Never imports the app. `tryAcquire` " +
      "then tick, else pump — so a busy app cannot stop the OS being serviced.",
    phase: "run",
    files: ["src/host/main.ts"],
  },
  {
    id: "appThread",
    label: "App thread",
    tech: "Bun Worker",
    descr:
      "Signals, handlers, bindings, and the writes they produce. Holds no engine handle, " +
      "so it cannot tick — it can only write the tables.",
    phase: "run",
    files: ["src/host/worker.ts", "src/runtime/signal.ts"],
  },
  {
    id: "channel",
    label: "Lock & flags",
    tech: "SharedArrayBuffer, Atomics",
    descr:
      "The only state the two threads share outside the tables. The writer may block; the " +
      "engine thread may only try.",
    phase: "run",
    db: true,
    files: ["src/host/channel.ts"],
  },
  {
    id: "tables",
    label: "Shared tables",
    tech: "engine-owned memory, struct-of-arrays",
    descr:
      "Typed-array views over engine allocations. A style patch or a list relink costs no " +
      "FFI call at all.",
    phase: "run",
    db: true,
    files: ["src/engine/upload.ts", "native-src/dziry-engine/src/tables.rs"],
  },
  {
    id: "engine",
    label: "Engine",
    tech: "Rust cdylib",
    descr:
      "Taffy lays out, Skia paints, SDL3 owns the window. Nineteen `extern \"C\"` entry " +
      "points, each catching panics and returning a status.",
    phase: "run",
    files: ["native-src/dziry-engine/src/lib.rs", "native-src/dziry-engine/src/engine.rs"],
  },
];

export type ContainerRel = {
  from: string;
  to: string;
  label: string;
  tech?: string;
};

export const CONTAINER_RELS: ContainerRel[] = [
  { from: "author", to: "cli", label: "runs `dziry dev` / `dziry build`", tech: "shell" },
  { from: "cli", to: "compiler", label: "compiles every window" },
  { from: "tailwind", to: "compiler", label: "supplies generated CSS", tech: "file" },
  { from: "compiler", to: "artifact", label: "emits", tech: "file write" },
  { from: "cli", to: "engineThread", label: "launches" },
  { from: "engineThread", to: "appThread", label: "spawns, sends table addresses", tech: "postMessage" },
  { from: "artifact", to: "appThread", label: "imported at startup", tech: "static import" },
  { from: "appThread", to: "channel", label: "acquire / release", tech: "Atomics.wait" },
  { from: "engineThread", to: "channel", label: "tryAcquire", tech: "never blocks" },
  { from: "appThread", to: "tables", label: "writes styles, links, text", tech: "typed arrays" },
  { from: "engineThread", to: "engine", label: "tick, pump, resize", tech: "bun:ffi" },
  { from: "engine", to: "tables", label: "owns, commits staged over live", tech: "memcpy" },
  { from: "engine", to: "os", label: "window, input, clipboard", tech: "SDL3" },
  { from: "engine", to: "gpu", label: "presents the frame", tech: "Skia raster" },
  { from: "enduser", to: "os", label: "clicks, types, resizes" },
  { from: "engineThread", to: "appThread", label: "forwards input events", tech: "postMessage" },
];

// ---------------------------------------------------------------------------
// C4 level 3 — components, per container worth opening up
// ---------------------------------------------------------------------------

export type Component = {
  id: string;
  container: string;
  label: string;
  descr: string;
  files: string[];
};

export const COMPONENTS: Component[] = [
  // --- compiler -------------------------------------------------------------
  {
    id: "jsx",
    container: "compiler",
    label: "JSX evaluation",
    descr: "Runs the author's module and builds a real element tree — no virtual DOM, no diff.",
    files: ["src/compiler/jsx-runtime.ts", "src/compiler/html.ts"],
  },
  {
    id: "css",
    container: "compiler",
    label: "CSS parser & cascade",
    descr: "Selector matching, specificity, inheritance, shorthand expansion, unit resolution.",
    files: ["src/compiler/css.ts", "src/compiler/stylesheet.ts", "src/compiler/ua-sheet.ts"],
  },
  {
    id: "variants",
    container: "compiler",
    label: "Variants",
    descr:
      "Hover, focus and the rest resolved ahead of time into patch tables, so interaction " +
      "state costs one u16 rather than a selector match.",
    files: ["src/compiler/variant-compile.ts"],
  },
  {
    id: "reactive",
    container: "compiler",
    label: "Reactive transform",
    descr: "Rewrites signal reads at build time — bare reads, no `.value`, no deps arrays.",
    files: ["src/compiler/reactive-transform.ts", "src/compiler/reactive-plugin.ts"],
  },
  {
    id: "routes",
    container: "compiler",
    label: "Routes & windows",
    descr: "Every route is compiled into the same node table; showing one writes a byte.",
    files: ["src/compiler/routes.ts", "src/compiler/route.ts", "src/compiler/window-tree.ts"],
  },
  {
    id: "emit",
    container: "compiler",
    label: "Emitter",
    descr: "Interns styles and writes the typed arrays plus the runtime refs.",
    files: ["src/compiler/compile.ts", "src/ir.ts"],
  },

  // --- app thread -----------------------------------------------------------
  {
    id: "signals",
    container: "appThread",
    label: "Signals",
    descr: "The whole reactivity core. Bare reads; the plugin did the wiring at build time.",
    files: ["src/runtime/signal.ts"],
  },
  {
    id: "bindings",
    container: "appThread",
    label: "Text bindings",
    descr: "A signal to a text span — the only thing that rewrites glyphs.",
    files: ["src/runtime/bindings.ts"],
  },
  {
    id: "patches",
    container: "appThread",
    label: "Style patches",
    descr: "A signal to a style field, written straight into the interned table.",
    files: ["src/runtime/patches.ts"],
  },
  {
    id: "lists",
    container: "appThread",
    label: "List arenas",
    descr: "Insert and remove by relinking siblings — nothing renumbers.",
    files: ["src/runtime/list-runtime.ts"],
  },
  {
    id: "upload",
    container: "appThread",
    label: "Uploader",
    descr: "Grows capacities and writes the IR into engine memory.",
    files: ["src/engine/upload.ts", "src/engine/bind.ts"],
  },

  // --- engine ---------------------------------------------------------------
  {
    id: "rsEngine",
    container: "engine",
    label: "Engine core",
    descr: "Handle registry, the tick, staged/live commit.",
    files: ["native-src/dziry-engine/src/engine.rs"],
  },
  {
    id: "rsLayout",
    container: "engine",
    label: "Layout",
    descr: "Builds Taffy styles from the shared tables and runs the solve.",
    files: ["native-src/dziry-engine/src/layout.rs"],
  },
  {
    id: "rsPaint",
    container: "engine",
    label: "Paint",
    descr: "Skia: boxes, borders, radii, shadows, clips.",
    files: ["native-src/dziry-engine/src/paint.rs"],
  },
  {
    id: "rsText",
    container: "engine",
    label: "Text",
    descr: "SkParagraph: shaping, measurement, wrapping.",
    files: ["native-src/dziry-engine/src/text.rs"],
  },
  {
    id: "rsWindow",
    container: "engine",
    label: "Window & input",
    descr: "SDL3, plus the event watcher that draws during an OS-modal resize drag.",
    files: ["native-src/dziry-engine/src/window.rs"],
  },
  {
    id: "rsError",
    container: "engine",
    label: "Error guard",
    descr: "`catch_unwind` at every entry point; a panic becomes a status, never a crash.",
    files: ["native-src/dziry-engine/src/error.rs"],
  },
];

export type ComponentRel = { from: string; to: string; label: string };

export const COMPONENT_RELS: ComponentRel[] = [
  { from: "jsx", to: "css", label: "element tree to match against" },
  { from: "css", to: "variants", label: "matched rules, by state" },
  { from: "reactive", to: "jsx", label: "rewritten module" },
  { from: "routes", to: "jsx", label: "one tree per route" },
  { from: "variants", to: "emit", label: "patch tables" },
  { from: "css", to: "emit", label: "resolved styles" },
  { from: "signals", to: "bindings", label: "notifies" },
  { from: "signals", to: "patches", label: "notifies" },
  { from: "signals", to: "lists", label: "notifies" },
  { from: "bindings", to: "upload", label: "dirty spans" },
  { from: "patches", to: "upload", label: "dirty spans" },
  { from: "lists", to: "upload", label: "relinked siblings" },
  { from: "rsEngine", to: "rsLayout", label: "solve" },
  { from: "rsLayout", to: "rsText", label: "measure" },
  { from: "rsEngine", to: "rsPaint", label: "draw" },
  { from: "rsPaint", to: "rsText", label: "paragraphs" },
  { from: "rsWindow", to: "rsEngine", label: "events, resize" },
  { from: "rsError", to: "rsEngine", label: "wraps every entry point" },
];

// ---------------------------------------------------------------------------
// Flows — the sequences worth watching rather than reading
// ---------------------------------------------------------------------------

export type Flow = {
  id: string;
  title: string;
  question: string;
  /** `participant` lines, in order, as `[alias, label]`. */
  actors: [string, string][];
  /** `[from, to, label]`, or `[from, to, label, "note"]` for a self-note. */
  steps: [string, string, string][];
};

export const FLOWS: Flow[] = [
  {
    id: "build",
    title: "One div, end to end",
    question: "What has already happened by the time you reach the boundary?",
    actors: [
      ["A", "windows/main"],
      ["C", "Compiler"],
      ["G", "ui.gen.ts"],
    ],
    steps: [
      ["A", "C", "JSX module + stylesheet"],
      ["C", "C", "evaluate JSX into a real element tree"],
      ["C", "C", "match selectors, apply specificity, cascade, inherit"],
      ["C", "C", "expand shorthands, resolve units, intern styles"],
      ["C", "C", "resolve hover/focus into patch tables"],
      ["C", "G", "typed arrays + refs"],
    ],
  },
  {
    id: "frame",
    title: "The frame loop",
    question: "What does a frame cost, and what does an idle one cost?",
    actors: [
      ["W", "App thread"],
      ["L", "Lock"],
      ["M", "Engine thread"],
      ["E", "Engine (Rust)"],
    ],
    steps: [
      ["W", "L", "acquire (may block)"],
      ["W", "W", "signals fire; write styles/links/text into shared memory"],
      ["W", "L", "release"],
      ["M", "L", "tryAcquire"],
      ["M", "E", "tick: commit staged over live"],
      ["E", "E", "layout only if the tree or a size changed"],
      ["E", "E", "paint, present"],
      ["E", "M", "events"],
      ["M", "W", "forward input"],
    ],
  },
  {
    id: "contended",
    title: "A handler that takes 400 ms",
    question: "Why does a busy app no longer freeze the window?",
    actors: [
      ["W", "App thread"],
      ["L", "Lock"],
      ["M", "Engine thread"],
      ["E", "Engine (Rust)"],
    ],
    steps: [
      ["W", "L", "acquire"],
      ["W", "W", "handler runs for 400 ms, holding the lock"],
      ["M", "L", "tryAcquire → fails"],
      ["M", "E", "pump: input, resize, scroll, repaint — no commit"],
      ["M", "E", "pump again, still no commit"],
      ["W", "L", "release"],
      ["M", "L", "tryAcquire → succeeds"],
      ["M", "E", "tick: the 400 ms of work lands in one frame"],
    ],
  },
];

// ---------------------------------------------------------------------------
// Where the long-form reasoning lives
// ---------------------------------------------------------------------------

export const DOCS: { path: string; what: string }[] = [
  { path: "API.md", what: "The authoring surface, planned and tracked." },
  { path: "ARCHITECTURE-REVIEW.md", what: "The fix-order authority. Read §4 before refactoring." },
  { path: "ROADMAP.md", what: "Milestones and their state." },
  { path: "REACTIVITY.md", what: "Signals: the model, and what was rejected." },
  { path: "NOTES.md", what: "Measurements. Check provenance — some predate the Rust engine." },
  { path: "BROWSER-FACTS.md", what: "Browser behaviour, measured rather than recalled." },
];
