/**
 * The single source of truth for the Bun ↔ engine shared-memory layout.
 *
 * This file exists because a startup handshake is not enough. A handshake detects
 * a wrong layout; it does not prevent *field inserted → offset forgotten →
 * release build → silent corruption*, which presents as inexplicably wrong pixels
 * rather than an error. So both sides' field identities are **generated** from
 * here (`bun run gen:protocol`), and offsets are reported by the engine at
 * runtime, checked against the generated field count.
 *
 * Layout is struct-of-arrays: every field is its own contiguous span, so a style
 * patch touches one array and paint reads stay monomorphic. The engine owns the
 * allocation; Bun receives a descriptor of `(byteOffset, elementSize, capacity)`
 * per field and wraps each as a typed-array view.
 *
 * Adding a field means adding it here and re-running the generator. Never edit
 * the generated files.
 */

export type ElemType = "u8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64";

export const ELEM_SIZE: Record<ElemType, number> = {
  u8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  f64: 8,
};

/** The typed-array constructor each element type maps to on the Bun side. */
export const ELEM_VIEW: Record<ElemType, string> = {
  u8: "Uint8Array",
  u16: "Uint16Array",
  i16: "Int16Array",
  u32: "Uint32Array",
  i32: "Int32Array",
  f32: "Float32Array",
  f64: "Float64Array",
};

/**
 * Whether the engine has to tell Taffy when this field changes.
 *
 * `paint` is a claim that has to be earned: the engine reads the styles table
 * out of live memory when it draws, so a paint-only field needs no bookkeeping
 * at all — the repaint every non-empty commit already schedules is the whole
 * response. Getting it wrong in that direction is a stale frame with no write to
 * blame, so anything not *demonstrably* invisible to layout is `layout`, and
 * over-invalidating costs time rather than correctness.
 *
 * Tag every field of a table or none: the generator refuses a partial set,
 * because a field added without a tag would silently inherit whichever default
 * the generator happened to pick.
 */
export type Affects = "paint" | "layout";

export type Field = { name: string; type: ElemType; doc?: string; affects?: Affects };

export type Table = {
  name: string;
  doc: string;
  /**
   * How the table is sized. `nodes` grows when a list arena regrows; `styles` is
   * fixed by the compiler; `layout` tracks `nodes`.
   */
  sizedBy: "nodes" | "styles" | "strings" | "own";
  fields: Field[];
};

/**
 * Node structure and identity. Written by the compiler, then mutated at run time
 * only by list relinking and `hidden` toggles.
 */
const NODES: Table = {
  name: "nodes",
  doc: "Tree structure and per-node indices.",
  sizedBy: "nodes",
  fields: [
    { name: "kind", type: "u8", doc: "NodeKind: box, text, button" },
    { name: "style", type: "u16", doc: "Index into the style table" },
    { name: "text", type: "i32", doc: "String slot, or -1" },
    { name: "parent", type: "i32" },
    { name: "firstChild", type: "i32" },
    { name: "nextSibling", type: "i32" },
    { name: "list", type: "i16", doc: "Index into the list table, or -1" },
    { name: "hidden", type: "u8", doc: "Non-zero excludes the subtree entirely" },
    { name: "flags", type: "u8", doc: "Bit 0 interactive, bit 1 measurable text" },
  ],
};

/**
 * Computed styles, one entry per interned style. Mutated by conditional-class
 * patches: the engine reads whatever is here at frame start.
 */
const STYLES: Table = {
  name: "styles",
  doc: "Resolved style values. Patches write field values in place.",
  sizedBy: "styles",
  fields: [
    // paint
    { name: "bg", type: "u32", affects: "paint" },
    { name: "fg", type: "u32", affects: "paint" },
    { name: "borderColor", type: "u32", affects: "paint" },
    // Layout, not paint: the engine reserves the border in Taffy's box, so a
    // width change moves the content. `borderColor` above stays paint-only.
    { name: "borderWidth", type: "f32", affects: "layout" },
    { name: "radius", type: "f32", affects: "paint" },
    // box
    { name: "padTop", type: "f32", affects: "layout" },
    { name: "padRight", type: "f32", affects: "layout" },
    { name: "padBottom", type: "f32", affects: "layout" },
    { name: "padLeft", type: "f32", affects: "layout" },
    { name: "marginTop", type: "f32", affects: "layout" },
    { name: "marginRight", type: "f32", affects: "layout" },
    { name: "marginBottom", type: "f32", affects: "layout" },
    { name: "marginLeft", type: "f32", affects: "layout" },
    // flex + grid
    { name: "display", type: "u8", affects: "layout", doc: "0 flex, 1 grid, 2 block, 3 none" },
    { name: "flexDirection", type: "u8", affects: "layout" },
    { name: "flexWrap", type: "u8", affects: "layout" },
    { name: "justifyContent", type: "u8", affects: "layout" },
    { name: "alignItems", type: "u8", affects: "layout" },
    { name: "alignSelf", type: "u8", affects: "layout" },
    { name: "justifyItems", type: "u8", affects: "layout", doc: "Grid only" },
    { name: "justifySelf", type: "u8", affects: "layout", doc: "Grid only" },
    { name: "flexGrow", type: "f32", affects: "layout" },
    { name: "flexShrink", type: "f32", affects: "layout" },
    { name: "flexBasis", type: "f32", affects: "layout" },
    { name: "gapRow", type: "f32", affects: "layout" },
    { name: "gapColumn", type: "f32", affects: "layout" },
    { name: "gridColumns", type: "u16", affects: "layout", doc: "repeat(N, minmax(0,1fr)) — Tailwind's grid-cols-N" },
    { name: "gridRows", type: "u16", affects: "layout" },
    { name: "gridColumnStart", type: "i16", affects: "layout" },
    { name: "gridColumnSpan", type: "i16", affects: "layout" },
    { name: "gridRowStart", type: "i16", affects: "layout" },
    { name: "gridRowSpan", type: "i16", affects: "layout" },
    // sizing — NaN means auto
    { name: "width", type: "f32", affects: "layout" },
    { name: "height", type: "f32", affects: "layout" },
    { name: "minWidth", type: "f32", affects: "layout" },
    { name: "minHeight", type: "f32", affects: "layout" },
    { name: "maxWidth", type: "f32", affects: "layout" },
    { name: "maxHeight", type: "f32", affects: "layout" },
    { name: "aspectRatio", type: "f32", affects: "layout" },
    { name: "position", type: "u8", affects: "layout", doc: "0 relative, 1 absolute" },
    { name: "insetTop", type: "f32", affects: "layout" },
    { name: "insetRight", type: "f32", affects: "layout" },
    { name: "insetBottom", type: "f32", affects: "layout" },
    { name: "insetLeft", type: "f32", affects: "layout" },
    // text
    //
    // `layout`, and not for the obvious reason: neither appears in Taffy's
    // `Style` at all. They reach layout through the *measure callback*, which
    // reads them out of this table to shape the string. So they are the two
    // fields where "the resolved Taffy style is unchanged" and "the laid-out
    // size is unchanged" come apart — which is why `apply_style` must not be
    // guarded by comparing styles for equality. See `LayoutTree::apply_style`.
    { name: "fontSize", type: "f32", affects: "layout" },
    { name: "fontWeight", type: "u16", affects: "layout" },
    { name: "lineClamp", type: "u16", affects: "layout", doc: "0 = unlimited; drives SkParagraph maxLines" },
    // Per axis, because the common case is asymmetric: a column that scrolls
    // vertically and must not scroll horizontally. One field would make
    // `overflow-y: auto` either a lie about the other axis or unexpressible.
    { name: "overflowX", type: "u8", affects: "layout", doc: "0 visible, 1 hidden, 2 ellipsis, 3 scroll" },
    { name: "overflowY", type: "u8", affects: "layout", doc: "0 visible, 1 hidden, 2 ellipsis, 3 scroll" },
  ],
};

/**
 * Conditional styling, as a predicate mask rather than named roles.
 *
 * This replaces a fixed `(hover, active, focus)` triple, which could express
 * exactly one thing: "one style per named role, pick by precedence". Three
 * consequences of that shape, all of them wrong:
 *
 * 1. **It cannot merge.** With both `:hover` and `:focus` matching, the runtime
 *    picked *one* precompiled style; CSS combines them per property. Hover beat
 *    focus outright.
 * 2. **It cannot grow.** `group-*`, `peer-*`, `data-[state=open]:` and media
 *    predicates are all "style depends on a condition", and none of them is
 *    hover, active or focus. A1 has committed to all four.
 * 3. **The role names were replicated** across the IR, the schema, the Rust
 *    protocol, the painter and the variant compiler — five places to edit to add
 *    a fourth condition.
 *
 * The replacement: each conditional node declares a `mask` of the predicate bits
 * its styling actually depends on, and owns a dense run of `1 << popcount(mask)`
 * style slots. The painter computes which predicates are live for that node,
 * intersects with the mask, compacts the result to a run index, and reads one
 * `u16`. Merging falls out — the compiler resolves each combination as a full
 * cascade, which it already knew how to do.
 */
const VARIANTS: Table = {
  name: "variants",
  doc: "Per-node predicate mask and where that node's style run begins.",
  sizedBy: "own",
  fields: [
    { name: "node", type: "i32", doc: "Sorted ascending, for binary search" },
    { name: "mask", type: "u32", doc: "Predicate bits this node's styling reads" },
    { name: "runStart", type: "i32", doc: "First entry in variantSlots" },
  ],
};

/**
 * The runs themselves, concatenated.
 *
 * Entry `runStart + i` is the style for the predicate combination whose compacted
 * bits equal `i`; entry 0 is therefore always the node's base style. A node
 * reading two predicates costs four `u16`s.
 */
const VARIANT_SLOTS: Table = {
  name: "variantSlots",
  doc: "Dense style-slot runs, indexed by compacted live predicate bits.",
  sizedBy: "own",
  fields: [{ name: "style", type: "u16" }],
};

/** Dynamic list arenas — the one place node count is a runtime value. */
const LISTS: Table = {
  name: "lists",
  doc: "List arenas: homogeneous item subtrees addressed by stride.",
  sizedBy: "own",
  fields: [
    { name: "container", type: "i32", doc: "The node the rows are children of" },
    { name: "anchorPrev", type: "i32", doc: "Static sibling before the rows, or -1 for firstChild" },
    { name: "anchorNext", type: "i32", doc: "Static sibling after the rows, or -1 for end of chain" },
    { name: "arenaStart", type: "i32" },
    { name: "stride", type: "i32" },
    { name: "capacity", type: "i32" },
    { name: "active", type: "i32" },
  ],
};

/** Engine output. Read-only for Bun, used for hit-testing and the imperative API. */
const LAYOUT: Table = {
  name: "layout",
  doc: "Final bounds per node, written by the engine.",
  sizedBy: "nodes",
  fields: [
    { name: "x", type: "f32" },
    { name: "y", type: "f32" },
    { name: "width", type: "f32" },
    { name: "height", type: "f32" },
  ],
};

/**
 * String slots. Bun writes UTF-8 bytes into a shared arena and records
 * `(offset, length)` here, because JS strings cannot be shared directly.
 */
const STRINGS: Table = {
  name: "strings",
  doc: "Slot table into the UTF-8 arena.",
  sizedBy: "strings",
  fields: [
    { name: "offset", type: "u32" },
    { name: "length", type: "u32" },
  ],
};

export const TABLES: Table[] = [NODES, STYLES, VARIANTS, VARIANT_SLOTS, LISTS, LAYOUT, STRINGS];

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Values that cross the boundary, generated for the same reason field identity
 * is: a hand-copied `justify-content: center` encoding that disagrees by one is
 * a wrong-looking frame, not a type error.
 *
 * Unlike the tables these carry no layout, so adding one does not bump
 * `PROTOCOL_VERSION` — only changing an existing value does.
 */
export type EnumDef = {
  name: string;
  doc: string;
  /** The Rust integer type the constants are emitted as. */
  ty: "u8" | "u32" | "i32";
  values: Record<string, number>;
};

/**
 * `255` in any `u8` enum field means "the author said nothing" — the engine then
 * leaves Taffy's own default rather than coercing to variant 0. The spike found
 * that coercing `NaN` to `0` silently collapsed grid items, whose default is
 * `stretch`, not `flex-start`.
 */
export const UNSET = 255;

export const ENUMS: EnumDef[] = [
  {
    name: "NodeKind",
    doc: "What a node is. `nodes.kind`.",
    ty: "u8",
    values: { BOX: 0, TEXT: 1, BUTTON: 2 },
  },
  {
    name: "Display",
    doc: "`styles.display`. `NONE` excludes the subtree from layout.",
    ty: "u8",
    values: { FLEX: 0, GRID: 1, BLOCK: 2, NONE: 3 },
  },
  {
    name: "FlexDirection",
    doc: "`styles.flexDirection`.",
    ty: "u8",
    values: { ROW: 0, COLUMN: 1, ROW_REVERSE: 2, COLUMN_REVERSE: 3 },
  },
  {
    name: "FlexWrap",
    doc: "`styles.flexWrap`.",
    ty: "u8",
    values: { NO_WRAP: 0, WRAP: 1, WRAP_REVERSE: 2 },
  },
  {
    name: "Justify",
    doc: "`styles.justifyContent`. CSS `align-content` values, per Taffy.",
    ty: "u8",
    values: {
      FLEX_START: 0,
      CENTER: 1,
      FLEX_END: 2,
      SPACE_BETWEEN: 3,
      SPACE_AROUND: 4,
      SPACE_EVENLY: 5,
      UNSET: 255,
    },
  },
  {
    name: "Align",
    doc: "`styles.alignItems` / `alignSelf` / `justifyItems` / `justifySelf`.",
    ty: "u8",
    values: { FLEX_START: 0, CENTER: 1, FLEX_END: 2, STRETCH: 3, BASELINE: 4, UNSET: 255 },
  },
  {
    name: "Position",
    doc: "`styles.position`.",
    ty: "u8",
    values: { RELATIVE: 0, ABSOLUTE: 1 },
  },
  {
    name: "Overflow",
    doc:
      "`styles.overflowX` / `styles.overflowY`. `CLIP` is distinct from `HIDDEN` for one " +
      "measured reason: Chromium coerces a `visible` axis to `auto` when the other axis is a " +
      "scroll container, and `clip` is not one — see BROWSER-FACTS.md.",
    ty: "u8",
    values: { VISIBLE: 0, HIDDEN: 1, ELLIPSIS: 2, SCROLL: 3, CLIP: 4 },
  },
  {
    name: "Predicate",
    doc:
      "Bit positions in a variant mask. Bits 0-2 are per-node; higher bits are " +
      "global, so the engine can flip them without knowing which nodes care.",
    ty: "u32",
    values: {
      /** This node is under the cursor. */
      HOVER: 1 << 0,
      /** The mouse went down on this node and has not been released. */
      ACTIVE: 1 << 1,
      /** This node holds focus. */
      FOCUS: 1 << 2,

      /**
       * The first bit the *engine* owns rather than the input state.
       *
       * Everything from here up is a global condition — a media query, a colour
       * scheme, a reduced-motion preference — evaluated once per frame and
       * intersected with every node's mask. `md:flex` and
       * `@media (min-width: 768px)` are the same mechanism reached from two
       * syntaxes, and neither costs Bun a round trip: the engine owns the window,
       * so it re-evaluates these between a resize and the relayout.
       *
       * The compiler assigns them in order of first use and emits the thresholds
       * alongside; nothing here hardcodes a breakpoint.
       */
      FIRST_GLOBAL: 1 << 8,
    },
  },
  {
    name: "EventKind",
    doc: "Engine → Bun. Drained after `tick()`; `0` means the queue is empty.",
    ty: "u32",
    values: {
      NONE: 0,
      QUIT: 1,
      RESIZE: 2,
      MOUSE_MOVE: 3,
      MOUSE_DOWN: 4,
      MOUSE_UP: 5,
      CLICK: 6,
      KEY_DOWN: 7,
      TEXT_INPUT: 8,
      FOCUS: 9,
    },
  },
  {
    name: "Status",
    doc:
      "Return code of every FFI entry point. Negative is failure, and the " +
      "detail is in `dziri_last_error`.",
    ty: "i32",
    values: {
      OK: 0,
      /** A Rust panic was caught at the boundary. The engine is poisoned. */
      PANIC: -1,
      INVALID_HANDLE: -2,
      INVALID_ARGUMENT: -3,
      PROTOCOL_MISMATCH: -4,
      CAPACITY: -5,
      SDL: -6,
      SKIA: -7,
      LAYOUT: -8,
      /** A previous call panicked; the engine refuses further work. */
      POISONED: -9,
    },
  },
];

/**
 * Bumped on any change to the tables above. The engine refuses to start on a
 * mismatch rather than rendering garbage.
 *
 * v5 splits `overflow` into `overflowX`/`overflowY`.
 *
 * Also bumped when the *C ABI* changes shape, even though the tables did not —
 * v4 is where the engine handle stopped being a pointer and became a `u32` token
 * into a handle table. `SCHEMA_HASH` cannot cover that: it hashes the tables, and
 * a stale binary would pass both checks and then be handed a 4-byte out-parameter
 * where it expects 8. `dziri_protocol_version` takes no arguments, so it is the one
 * call that is safe to make against a binary of unknown vintage — which is why the
 * ABI's own version lives here.
 */
export const PROTOCOL_VERSION = 5;

/** Node flag bits, shared by both sides. */
export const NodeFlags = {
  INTERACTIVE: 1 << 0,
  MEASURABLE: 1 << 1,
} as const;
