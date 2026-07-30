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

export type Field = { name: string; type: ElemType; doc?: string };

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
    { name: "kind", type: "u8", doc: "NodeKind: box, text, button, list" },
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
    { name: "bg", type: "u32" },
    { name: "fg", type: "u32" },
    { name: "borderColor", type: "u32" },
    { name: "borderWidth", type: "f32" },
    { name: "radius", type: "f32" },
    // box
    { name: "padTop", type: "f32" },
    { name: "padRight", type: "f32" },
    { name: "padBottom", type: "f32" },
    { name: "padLeft", type: "f32" },
    { name: "marginTop", type: "f32" },
    { name: "marginRight", type: "f32" },
    { name: "marginBottom", type: "f32" },
    { name: "marginLeft", type: "f32" },
    // flex + grid
    { name: "display", type: "u8", doc: "0 flex, 1 grid, 2 block, 3 none" },
    { name: "flexDirection", type: "u8" },
    { name: "flexWrap", type: "u8" },
    { name: "justifyContent", type: "u8" },
    { name: "alignItems", type: "u8" },
    { name: "alignSelf", type: "u8" },
    { name: "justifyItems", type: "u8", doc: "Grid only" },
    { name: "justifySelf", type: "u8", doc: "Grid only" },
    { name: "flexGrow", type: "f32" },
    { name: "flexShrink", type: "f32" },
    { name: "flexBasis", type: "f32" },
    { name: "gapRow", type: "f32" },
    { name: "gapColumn", type: "f32" },
    { name: "gridColumns", type: "u16", doc: "repeat(N, minmax(0,1fr)) — Tailwind's grid-cols-N" },
    { name: "gridRows", type: "u16" },
    { name: "gridColumnStart", type: "i16" },
    { name: "gridColumnSpan", type: "i16" },
    { name: "gridRowStart", type: "i16" },
    { name: "gridRowSpan", type: "i16" },
    // sizing — NaN means auto
    { name: "width", type: "f32" },
    { name: "height", type: "f32" },
    { name: "minWidth", type: "f32" },
    { name: "minHeight", type: "f32" },
    { name: "maxWidth", type: "f32" },
    { name: "maxHeight", type: "f32" },
    { name: "aspectRatio", type: "f32" },
    { name: "position", type: "u8", doc: "0 relative, 1 absolute" },
    { name: "insetTop", type: "f32" },
    { name: "insetRight", type: "f32" },
    { name: "insetBottom", type: "f32" },
    { name: "insetLeft", type: "f32" },
    // text
    { name: "fontSize", type: "f32" },
    { name: "fontWeight", type: "u16" },
    { name: "lineClamp", type: "u16", doc: "0 = unlimited; drives SkParagraph maxLines" },
    { name: "overflow", type: "u8", doc: "0 visible, 1 hidden, 2 ellipsis, 3 scroll" },
  ],
};

/** Interaction-state styles, sparse: only nodes with a `:hover`/`:active`/`:focus` style. */
const STATES: Table = {
  name: "states",
  doc: "Sparse interaction-state styles, sorted by node for binary search.",
  sizedBy: "own",
  fields: [
    { name: "node", type: "i32" },
    { name: "hover", type: "i32" },
    { name: "active", type: "i32" },
    { name: "focus", type: "i32" },
  ],
};

/** Dynamic list arenas — the one place node count is a runtime value. */
const LISTS: Table = {
  name: "lists",
  doc: "List arenas: homogeneous item subtrees addressed by stride.",
  sizedBy: "own",
  fields: [
    { name: "node", type: "i32", doc: "The LIST node owning this arena" },
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

export const TABLES: Table[] = [NODES, STYLES, STATES, LISTS, LAYOUT, STRINGS];

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
    values: { BOX: 0, TEXT: 1, BUTTON: 2, LIST: 3 },
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
    doc: "`styles.overflow`.",
    ty: "u8",
    values: { VISIBLE: 0, HIDDEN: 1, ELLIPSIS: 2, SCROLL: 3 },
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
 */
export const PROTOCOL_VERSION = 1;

/** Node flag bits, shared by both sides. */
export const NodeFlags = {
  INTERACTIVE: 1 << 0,
  MEASURABLE: 1 << 1,
} as const;
