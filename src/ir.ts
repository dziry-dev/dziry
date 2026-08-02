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
  Overflow as SchemaOverflow,
  Position as SchemaPosition,
  MediaKind as SchemaMediaKind,
  Predicate as SchemaPredicate,
  ScrollbarWidth as SchemaScrollbarWidth,
  Appearance as SchemaAppearance,
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

export const Predicate = SchemaPredicate;
export const MediaKind = SchemaMediaKind;
export const Display = SchemaDisplay;
export const FlexWrap = SchemaFlexWrap;
export const Position = SchemaPosition;
export const Overflow = SchemaOverflow;
export const ScrollbarWidth = SchemaScrollbarWidth;
export const Appearance = SchemaAppearance;

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
 * Gathers the bits of `value` that are set in `mask` down to a dense index.
 *
 * A variant run holds one entry per *combination* of the predicates a node reads,
 * so a node reading bits 0 and 8 needs four entries rather than 257. Mirrors
 * `compact` in the engine's `paint.rs`; both sides must agree, because one builds
 * the run and the other indexes it.
 */
export function compactBits(value: number, mask: number): number {
  let out = 0;
  let bit = 0;
  let remaining = mask;

  while (remaining !== 0) {
    const lowest = remaining & -remaining;
    if ((value & lowest) !== 0) out |= 1 << bit;
    bit++;
    remaining &= remaining - 1;
  }
  return out;
}

/** The set bits of `mask`, low to high. */
export function maskBits(mask: number): number[] {
  const bits: number[] = [];
  let remaining = mask;
  while (remaining !== 0) {
    const lowest = remaining & -remaining;
    bits.push(lowest);
    remaining &= remaining - 1;
  }
  return bits;
}

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
  // Width changes the box — the engine reserves the border like padding — so a
  // toggle that only changes a border width still needs a relayout. Kept in the
  // paint block because it is interned next to `borderColor`, which is paint-only;
  // the fourth column, not the grouping, is what decides.
  ["borderWidth", "Float32Array", false, true],
  // Four corners rather than one radius: CSS has four longhands and a shorthand
  // over them, and `rounded-t-lg` — most of what Tailwind's radius utilities are —
  // cannot be said with one field.
  ["radTL", "Float32Array", false, false],
  ["radTR", "Float32Array", false, false],
  ["radBR", "Float32Array", false, false],
  ["radBL", "Float32Array", false, false],
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
  // Layout, not paint, even though its most visible effect is clipping: a scroll
  // container's automatic minimum size is 0 rather than its content, so whether a
  // node scrolls changes where its *siblings* end up.
  //
  // Per axis, because the case that matters is asymmetric — a column that scrolls
  // vertically and never horizontally.
  ["overflowX", "Uint8Array", false, true],
  ["overflowY", "Uint8Array", false, true],
  // The two standard scrollbar properties, and they disagree about inheritance —
  // measured, and confirmed against `mdn-data`. `scrollbar-color` inherits;
  // `scrollbar-width` does not. Easy to get wrong in one breath because they are
  // always described together, so the asymmetry is written down here where the
  // cascade reads it.
  //
  // Paint-only, both of them, and only because the gutter is not reserved: dziri's
  // bars are overlay, so their thickness changes what is covered rather than what
  // fits. `scrollbarWidth` moves to `affects: "layout"` the day a gutter exists.
  ["scrollbarWidth", "Uint8Array", false, false],
  ["scrollbarThumb", "Uint32Array", true, false],
  ["scrollbarTrack", "Uint32Array", true, false],
  // The three CSS properties a form control needs that nothing else does. Paint-only
  // — none of them changes a box — and the two colours *inherit*, which is the part
  // worth stating rather than assuming: `accent-color` and `caret-color` are both
  // inherited per spec, so setting one on a form styles every control inside it,
  // which is exactly how people use them.
  //
  // `appearance` does not inherit, and that asymmetry is also the spec's. It is a
  // statement about one element's own rendering, and inheriting it would mean a
  // `appearance: none` on a fieldset silently stripped every control in it.
  ["accentColor", "Uint32Array", true, false],
  ["caretColor", "Uint32Array", true, false],
  ["appearance", "Uint8Array", false, false],
] as const;

export type StyleField = (typeof STYLE_FIELDS)[number][0];
export type ComputedStyle = Record<StyleField, number>;

export const INHERITED_FIELDS: StyleField[] = STYLE_FIELDS.filter((f) => f[2]).map((f) => f[0]);

export const LAYOUT_FIELDS: StyleField[] = STYLE_FIELDS.filter((f) => f[3]).map((f) => f[0]);

/** CSS initial values, in resolved px. The root inherits from this. */
export const INITIAL_STYLE: ComputedStyle = {
  bg: 0x00000000, // transparent
  fg: 0xff000000, // black
  borderColor: 0x00000000,
  borderWidth: 0,
  radTL: 0,
  radTR: 0,
  radBR: 0,
  radBL: 0,
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
  minW: NaN,
  maxW: Infinity,
  minH: NaN,
  maxH: Infinity,
  aspectRatio: AUTO,
  position: Position.RELATIVE,
  insetT: AUTO,
  insetR: AUTO,
  insetB: AUTO,
  insetL: AUTO,
  fontSize: 16,
  fontWeight: 400,
  overflowX: Overflow.VISIBLE,
  overflowY: Overflow.VISIBLE,
  scrollbarWidth: ScrollbarWidth.AUTO,
  // `scrollbar-color: auto`, spelled as alpha 0 — the convention `borderColor`
  // already uses for "nothing was said here".
  scrollbarThumb: 0x00000000,
  scrollbarTrack: 0x00000000,
  // `accent-color: auto` and `caret-color: auto`, spelled the same way
  // `scrollbar-color: auto` is: alpha 0, meaning "the author said nothing, pick
  // the platform answer". A real colour is never fully transparent in practice,
  // and a control that painted its accent in transparent black would be a bug
  // either way — so the sentinel costs no expressible value.
  accentColor: 0x00000000,
  caretColor: 0x00000000,
  // The spec's initial value is `none`, not `auto`: CSS makes drawing a control
  // something the UA stylesheet asks for on the elements that are controls,
  // rather than something every element gets.
  appearance: Appearance.NONE,
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
 * Conditional styling as a predicate mask, stored sparsely.
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
export type VariantTable = {
  count: number;
  /** Sorted ascending, for binary search. */
  node: Int32Array;
  /** Predicate bits this node's styling reads. */
  mask: Uint32Array;
  /** First entry of this node's run in `variantSlots`. */
  runStart: Int32Array;
  /** Concatenated runs: one style id per predicate combination. */
  slots: Uint16Array;
};

export function emptyVariantTable(): VariantTable {
  return {
    count: 0,
    node: new Int32Array(0),
    mask: new Uint32Array(0),
    runStart: new Int32Array(0),
    slots: new Uint16Array(0),
  };
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
  /**
   * Where the rows hang, as a splice point in the container's child chain.
   *
   * There is no wrapper node. An earlier design put a `LIST` node between the
   * container and its rows and copied the container's `display`, tracks, gaps
   * and alignment onto it, on the theory that a transparent box is what
   * `display: contents` would have given us. That works for a flex column and
   * is wrong for everything else: inside a grid the wrapper is one item in one
   * cell with its own N tracks nested inside it, and a container's
   * `justify-content` distributes exactly one shrink-wrapped child. It also
   * silently became the containing block for any absolutely positioned row.
   *
   * Rows are children of the container instead, spliced between two anchors.
   * `relink` rebuilds child lists from the chains on every structural change,
   * so nothing has to know that part of a chain is arena-backed.
   */
  container: Int32Array;
  /**
   * The static sibling the rows follow, or `-1` for "the container's first
   * child". Written by the compiler, never at run time.
   */
  anchorPrev: Int32Array;
  /** The static sibling the last row points at, or `-1` for end-of-chain. */
  anchorNext: Int32Array;
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
  variants: VariantTable;
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
  /**
   * Sorted node ids that are `::before` / `::after` boxes.
   *
   * Emitted rather than inferred for the same reason `interactive` is: the fact
   * is known at compile time and unrecoverable at run time. The engine uses it to
   * resolve a generated box's hover/active/focus/checked against its *parent* —
   * `.btn:hover::before` is about the button, and the box is never the node the
   * hit test returns.
   */
  generated: Int32Array;
  lists: ListTable;
  media: MediaTable;
  root: number;
};

/**
 * One route, as the compiler found it on disk.
 *
 * The route path *is* the file path under `pages/`, so this row carries no
 * identity of its own — nothing here was authored, and a rename changes it.
 * `segments` is the path already split, because the only run-time consumer is a
 * matcher comparing segment by segment.
 */
export type RouteRow = {
  /** Owning window's folder name. */
  window: string;
  /** `"/"` for the index; otherwise the path with no leading slash. */
  path: string;
  /** Repo-relative source file, forward slashes. Diagnostics only. */
  file: string;
  /** `path` split on `/`; `$name` segments kept verbatim. Empty for `"/"`. */
  segments: readonly string[];
  /** Parameter names in path order — the `$` stripped. */
  params: readonly string[];
  /**
   * Index in `routes` of the nearest route whose path is a proper prefix, or -1.
   *
   * Path-prefix nesting, which is *potential* nesting: whether that route is
   * actually a layout depends on it rendering an `<Outlet/>`, which is not
   * knowable until it is compiled.
   */
  parent: number;
};

/**
 * A window's configuration, as `<Window>` declared it.
 *
 * Every field is a compile-time constant. It lives here rather than beside the
 * component because it is the shape the generated artifact emits and the host
 * reads — and, once `minWidth` reaches the engine, the shape `EngineConfig` grows.
 */
export type WindowConfig = {
  title: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
};

/**
 * A route, as nodes rather than as a path.
 *
 * `roots` is what navigation writes: the top-level nodes this route contributed,
 * which is normally one. Hiding them excludes the route from layout, paint and
 * hit-testing, so switching route is a handful of byte writes and one relayout —
 * no allocation, no table growth, nothing to rebuild.
 *
 * There is no span. A route's nodes are not contiguous, because a layout's subtree
 * contains its children's routes, and a span would either overlap them or need the
 * nesting encoded twice.
 */
export type RouteNodes = {
  /** Route path, as the file path under `pages/` gave it. */
  path: string;
  roots: readonly number[];
  /** Nearest prefix route in this window's list, or -1. Visible when this one is. */
  parent: number;
};

/**
 * A route and its ancestors — the set visible at once.
 *
 * An ancestor stays visible because the active route renders *inside* it; that is
 * what makes a layout a layout, and it falls out of the parent chain rather than
 * needing a rule anywhere.
 *
 * One definition because three things walk it and they must agree: the emitter
 * deciding which routes start `hidden`, the driver reporting how many that was, and
 * the host switching route. Two of those disagreeing would show as a frame that is
 * correct until the first navigation.
 *
 * Tolerates a cycle rather than hanging on one. `parent` is compiler output and a
 * cycle would be a compiler bug, but the failure mode of a `while` here is a build
 * that never finishes and never says why.
 */
export function routeChain(routes: readonly RouteNodes[], index: number): Set<number> {
  const chain = new Set<number>();
  for (let i = index; i !== -1; i = routes[i]?.parent ?? -1) {
    if (chain.has(i)) break;
    chain.add(i);
  }
  return chain;
}

/** One window folder, and the contiguous span of `routes` it owns. */
export type WindowRow = {
  /** Folder name under `windows/` — the window's id. There is no override. */
  id: string;
  /** Repo-relative `windows/<id>/index.tsx`. */
  entry: string;
  firstRoute: number;
  routeCount: number;
};

/**
 * Media conditions, as thresholds the engine tests against the surface.
 *
 * One row per atomic condition rather than per `@media` block: a block with two
 * conditions produces two rows and two predicate bits, and the rules inside it
 * require both. That is what lets the variant machinery resolve a conjunction
 * without anything having to understand `and`.
 */
export type MediaTable = {
  count: number;
  /** The predicate bit this condition sets when it holds. */
  bit: Uint32Array;
  /** `MediaKind` — which axis, and which side of the threshold counts as true. */
  kind: Uint8Array;
  /** Threshold in px; `rem` was resolved by the compiler. */
  value: Float32Array;
};

