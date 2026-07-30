/**
 * The intermediate representation, shared by the compiler and the runtime.
 *
 * The runtime sees only integers and typed arrays: no selectors, no cascade, no
 * property names, no strings except the ones that get painted. Everything in
 * here is what survived the "does the runtime really need to know this?" filter.
 */

import type { ReadonlySignal } from "./runtime/signal.ts";
import {
  Align as SchemaAlign,
  Display as SchemaDisplay,
  FlexDirection,
  FlexWrap as SchemaFlexWrap,
  Justify as SchemaJustify,
  NodeKind as SchemaNodeKind,
  Position as SchemaPosition,
} from "./protocol/generated.ts";

/**
 * Encodings are **derived** from the generated protocol, never restated.
 *
 * The compiler and the engine have to agree that `justify-content: center` is
 * `1`, and a hand-copied constant that disagreed by one would be a wrong-looking
 * frame rather than a type error — the same failure class as a wrong byte offset.
 * The names differ (`START` reads better here than `FLEX_START`); the values
 * cannot.
 */
export const NodeKind = SchemaNodeKind;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

export const Direction = { ROW: FlexDirection.ROW, COLUMN: FlexDirection.COLUMN } as const;

export const Justify = {
  START: SchemaJustify.FLEX_START,
  CENTER: SchemaJustify.CENTER,
  END: SchemaJustify.FLEX_END,
  SPACE_BETWEEN: SchemaJustify.SPACE_BETWEEN,
  SPACE_AROUND: SchemaJustify.SPACE_AROUND,
  SPACE_EVENLY: SchemaJustify.SPACE_EVENLY,
} as const;

export const Align = {
  START: SchemaAlign.FLEX_START,
  CENTER: SchemaAlign.CENTER,
  END: SchemaAlign.FLEX_END,
  STRETCH: SchemaAlign.STRETCH,
  BASELINE: SchemaAlign.BASELINE,
} as const;

export const Display = SchemaDisplay;
export const FlexWrap = SchemaFlexWrap;
export const Position = SchemaPosition;

/**
 * "The author said nothing" for an enum field.
 *
 * Distinct from variant `0`, and the distinction matters: coercing an unset
 * `justify-items` to `flex-start` silently collapses grid items, whose default
 * is `stretch`. The engine leaves Taffy's own default when it sees this.
 */
export const UNSET = SchemaAlign.UNSET;

/** `auto` for lengths — NaN so arithmetic on it stays obviously invalid. */
export const AUTO = NaN;

/**
 * Style fields in emit order: [name, typed-array constructor, inherited,
 * affectsLayout].
 *
 * `affectsLayout` matters for dynamic styling: a change that is paint-only can
 * skip the measure/arrange passes entirely and just repaint, which is the
 * difference between a cheap state update and a full relayout.
 *
 * Adding a CSS property means adding a row here plus a case in the property
 * expander; emit and the style table adapt automatically.
 */
export const STYLE_FIELDS = [
  // paint
  ["bg", "Uint32Array", false, false],
  ["fg", "Uint32Array", true, false],
  ["borderColor", "Uint32Array", false, false],
  // Borders are stroked inset, so width does not change the box.
  ["borderWidth", "Float32Array", false, false],
  ["radius", "Float32Array", false, false],
  // box
  ["padT", "Float32Array", false, true],
  ["padR", "Float32Array", false, true],
  ["padB", "Float32Array", false, true],
  ["padL", "Float32Array", false, true],
  ["marT", "Float32Array", false, true],
  ["marR", "Float32Array", false, true],
  ["marB", "Float32Array", false, true],
  ["marL", "Float32Array", false, true],
  // layout mode
  ["display", "Uint8Array", false, true],
  // flex
  ["direction", "Uint8Array", false, true],
  ["wrap", "Uint8Array", false, true],
  ["justify", "Uint8Array", false, true],
  ["align", "Uint8Array", false, true],
  ["alignSelf", "Uint8Array", false, true],
  ["grow", "Float32Array", false, true],
  ["shrink", "Float32Array", false, true],
  ["basis", "Float32Array", false, true],
  // `gap` is one CSS shorthand over two axes, and grid needs them apart.
  ["gapRow", "Float32Array", false, true],
  ["gapCol", "Float32Array", false, true],
  // grid — explicit tracks and spans only; no subgrid, no auto-fit
  ["gridCols", "Uint16Array", false, true],
  ["gridRows", "Uint16Array", false, true],
  ["gridColStart", "Int16Array", false, true],
  ["gridColSpan", "Int16Array", false, true],
  ["gridRowStart", "Int16Array", false, true],
  ["gridRowSpan", "Int16Array", false, true],
  ["justifyItems", "Uint8Array", false, true],
  ["justifySelf", "Uint8Array", false, true],
  // sizing
  ["width", "Float32Array", false, true],
  ["height", "Float32Array", false, true],
  ["minW", "Float32Array", false, true],
  ["maxW", "Float32Array", false, true],
  ["minH", "Float32Array", false, true],
  ["maxH", "Float32Array", false, true],
  ["aspectRatio", "Float32Array", false, true],
  // out-of-flow
  ["position", "Uint8Array", false, true],
  ["insetT", "Float32Array", false, true],
  ["insetR", "Float32Array", false, true],
  ["insetB", "Float32Array", false, true],
  ["insetL", "Float32Array", false, true],
  // text — both change measured advance width
  ["fontSize", "Float32Array", true, true],
  ["fontWeight", "Uint16Array", true, true],
] as const;

export type StyleField = (typeof STYLE_FIELDS)[number][0];
export type ComputedStyle = Record<StyleField, number>;

export const INHERITED_FIELDS: StyleField[] = STYLE_FIELDS.filter((f) => f[2]).map((f) => f[0]);

export const LAYOUT_FIELDS: StyleField[] = STYLE_FIELDS.filter((f) => f[3]).map((f) => f[0]);

/**
 * Properties that describe how a box arranges its *children*, as opposed to how
 * the box itself is sized, spaced or painted.
 *
 * A LIST node is a transparent wrapper — the closest CSS has is `display:
 * contents`, which Taffy does not implement — so it copies these from the
 * container it stands in for. Without that, the container's `align-items` and
 * `gap` apply to the wrapper instead of to the rows, and the rows shrink-wrap
 * with no spacing. Paint and box properties are deliberately excluded: the
 * wrapper must add no background, no border and no padding of its own.
 */
export const CONTAINER_FIELDS: StyleField[] = [
  "display",
  "direction",
  "wrap",
  "justify",
  "align",
  "gapRow",
  "gapCol",
  "gridCols",
  "gridRows",
  "justifyItems",
];

/** CSS initial values, in resolved px. The root inherits from this. */
export const INITIAL_STYLE: ComputedStyle = {
  bg: 0x00000000, // transparent
  fg: 0xff000000, // black
  borderColor: 0x00000000,
  borderWidth: 0,
  radius: 0,
  padT: 0,
  padR: 0,
  padB: 0,
  padL: 0,
  marT: 0,
  marR: 0,
  marB: 0,
  marL: 0,
  display: Display.FLEX,
  // HTML's block default stacks children vertically, so a box with no `display`
  // behaves like a column. `display: flex` with no direction means row, per CSS.
  direction: Direction.COLUMN,
  wrap: FlexWrap.NO_WRAP,
  justify: Justify.START,
  // CSS's initial `align-items` is `normal`, which behaves as `stretch` in flex
  // and grid. `flex-start` was wrong and its cost was paid in stylesheets: the
  // sample needed six `align-items: stretch` declarations purely to undo it, and
  // without them a column's children shrink-wrapped, a grid's cells collapsed,
  // and `flex: 1` found no free space to grow into.
  //
  // `UNSET` rather than `STRETCH` because the engine already maps it to Taffy's
  // own default, which is per-display-mode — the right answer for grid is not
  // literally the same value as for flex.
  align: UNSET,
  // Unset rather than START: these are per-item overrides, and defaulting them
  // to `flex-start` would silently override the parent's `align-items`.
  alignSelf: UNSET,
  grow: 0,
  shrink: 1,
  basis: AUTO,
  gapRow: 0,
  gapCol: 0,
  gridCols: 0,
  gridRows: 0,
  // 0 is "not placed", so grid lines stay 1-based as in CSS.
  gridColStart: 0,
  gridColSpan: 0,
  gridRowStart: 0,
  gridRowSpan: 0,
  justifyItems: UNSET,
  justifySelf: UNSET,
  width: AUTO,
  height: AUTO,
  minW: 0,
  maxW: Infinity,
  minH: 0,
  maxH: Infinity,
  aspectRatio: AUTO,
  position: Position.RELATIVE,
  insetT: AUTO,
  insetR: AUTO,
  insetB: AUTO,
  insetL: AUTO,
  fontSize: 16,
  fontWeight: 400,
};

/** Shape of the generated module, so the runtime can type its import. */
export type StyleTable = { count: number } & Record<StyleField, ArrayLike<number>>;

export type NodeTable = {
  count: number;
  /** NodeKind per node. */
  kind: Uint8Array;
  /** Style table index. */
  style: Uint16Array;
  /** String table index for TEXT nodes and button labels, else -1. */
  text: Int32Array;
  parent: Int32Array;
  firstChild: Int32Array;
  nextSibling: Int32Array;
  /** Index into the list table for LIST nodes, else -1. */
  list: Int16Array;
  /** Non-zero excludes the node and its subtree from layout, paint and input. */
  hidden: Uint8Array;
};

/**
 * Interaction-state styles, stored sparsely.
 *
 * Dense per-node arrays were nearly all `-1`: on a 300-item todo page only 3 of
 * 1215 nodes have any state style. Sparse costs nothing at run time because at
 * most one node is hovered, one pressed and one focused at a time — so a lookup
 * happens about three times per frame rather than once per node.
 *
 * `node` is sorted ascending for binary search. Each style column holds a style
 * table index, or -1 meaning "fall through to the next state".
 *
 * Resolution order is pressed -> hover -> focus -> base. Note this *picks* one
 * precomputed style rather than merging: CSS would combine `:hover` and `:focus`
 * per-property when both apply. Correct merging needs compiled state
 * combinations, which is deliberately not done yet.
 */
export type StateTable = {
  count: number;
  node: Int32Array;
  hover: Int32Array;
  active: Int32Array;
  focus: Int32Array;
};

export function emptyStateTable(): StateTable {
  const none = new Int32Array(0);
  return { count: 0, node: none, hover: none, active: none, focus: none };
}

/**
 * Index of `value` in a sorted array, or -1.
 *
 * Used for the state and interactive tables, both of which are consulted only for
 * the handful of nodes involved in the current interaction.
 */
export function findRow(sorted: Int32Array, value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid]!;
    if (v === value) return mid;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Dynamic lists, the one place node count is a runtime value.
 *
 * A LIST node owns a contiguous *arena* of homogeneous item subtrees: item `i`'s
 * root sits at `arenaStart[l] + i * stride[l]`, with its own links fully
 * materialized inside that slice, so ordinary traversal works *within* an item
 * and only the choice of children is special-cased.
 *
 * Three consequences make this cheap:
 *   - Reordering never moves a node. Items are homogeneous, so a reorder only
 *     recomputes slot values — there is nothing structural to reconcile.
 *   - Every style id in the arena was resolved at compile time, because the
 *     template's position in the tree is static. Adding an item never resolves
 *     a cascade.
 *   - `dataOffset` makes virtualization the same mechanism rather than a second
 *     one: cap `capacity` at the visible count and scrolling is an integer write,
 *     since slots are recomputed from `items[dataOffset + i]` regardless.
 */
export type ListTable = {
  count: number;
  /** The LIST node owning each arena. */
  node: Int32Array;
  arenaStart: Int32Array;
  /** Nodes per item. */
  stride: Int32Array;
  /** Item slots materialized in the arena. */
  capacity: Int32Array;
  /** Item slots currently live; the only runtime-authored structural value. */
  active: Int32Array;
  /** Index of the data item rendered by slot 0 — the scroll window. */
  dataOffset: Int32Array;
};

/**
 * A dynamic text run: literal chunks interleaved with live signals.
 *
 * Not typed arrays, deliberately. There is one entry per dynamic text node — a
 * handful, not thousands — and it is walked once per state change rather than per
 * node per frame, so readable emitted output is worth more than monomorphism.
 *
 * The generated module imports the signals by name and puts the real objects
 * here, so no key lookup happens at run time.
 */
export type TextPartRef = { literal: string } | { signal: ReadonlySignal<unknown> };

export type TextBinding = {
  /** Node whose text this feeds. */
  node: number;
  /** String-table slot to write. The table's tail is mutable; `nodes.text` is not. */
  slot: number;
  parts: TextPartRef[];
};

export type HandlerBinding = {
  node: number;
  fn: () => void;
};

export type CompiledUi = {
  /** The tail beyond `staticStrings` is written by text bindings. */
  strings: string[];
  styles: StyleTable;
  nodes: NodeTable;
  states: StateTable;
  textBindings: TextBinding[];
  handlers: HandlerBinding[];
  /**
   * Sorted node ids that can receive input.
   *
   * Emitted by the compiler rather than inferred at run time: interactivity used
   * to be derived from `hover >= 0`, which silently excluded a clickable list row
   * with no `:hover` rule.
   */
  interactive: Int32Array;
  lists: ListTable;
  root: number;
};

export function emptyListTable(): ListTable {
  const none = new Int32Array(0);
  return {
    count: 0,
    node: none,
    arenaStart: none,
    stride: none,
    capacity: none,
    active: none,
    dataOffset: none,
  };
}
