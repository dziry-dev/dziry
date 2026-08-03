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

/**
 * How a field's value is interpolated partway through a transition or animation.
 *
 * Absent means **not animatable**, which is the answer for every enum: CSS mostly
 * says `display`, `position` and `appearance` are discrete, and a lerp of two
 * variant numbers is meaningless rather than merely imprecise.
 *
 * The distinction between the two present values is measured. `number` fields
 * lerp. **Colours cannot**: they are a packed `0xAARRGGBB` `u32`, and lerping the
 * integer mixes green into alpha. They interpolate per channel in gamma-encoded
 * sRGB, **premultiplied by alpha** — `rgba(255,0,0,1)` to `rgba(0,0,255,0)` reads
 * `rgba(255,0,0,0.5)` halfway, where a plain per-channel lerp gives
 * `rgba(128,0,128,0.5)`. See BROWSER-FACTS.md.
 *
 * Only a `paint` field may carry this, and the generator enforces it. A
 * transition on a layout-affecting property is a Taffy pass per frame; nothing
 * here is wired to ask for one, so the compiler refuses such a transition by name
 * rather than emitting a mask bit the engine would honour in paint alone — which
 * would animate the colour of a box whose width jumped.
 */
export type Interp = "number" | "color";

/**
 * The wire encoding of {@link Interp}, with `none` spelt for the absent case.
 *
 * One definition because three things read it: the generator building
 * `styles::INTERP`, the `Interp` enum both sides import, and the schema test that
 * checks the two agree.
 */
export const INTERP_CODE = { none: 0, number: 1, color: 2 } as const;

export type Field = {
  name: string;
  type: ElemType;
  doc?: string;
  affects?: Affects;
  interp?: Interp;
};

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
    {
      name: "flags",
      type: "u8",
      doc: "Bit 0 interactive, bit 1 measurable text, bit 2 generated (predicates come from parent)",
    },
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
    { name: "bg", type: "u32", affects: "paint", interp: "color" },
    { name: "fg", type: "u32", affects: "paint", interp: "color" },
    { name: "borderColor", type: "u32", affects: "paint", interp: "color" },
    // Layout, not paint: the engine reserves the border in Taffy's box, so a
    // width change moves the content. `borderColor` above stays paint-only.
    { name: "borderWidth", type: "f32", affects: "layout" },
    // Four corners, not one radius. CSS has no single-radius property — it has
    // four longhands and a shorthand over them — and the one-field version could
    // not express `rounded-t-lg`, which is most of what Tailwind's radius
    // utilities are. `paint.rs` already built its border ring from two round
    // rects specifically so this could grow without changing how borders draw.
    { name: "radiusTopLeft", type: "f32", affects: "paint", interp: "number" },
    { name: "radiusTopRight", type: "f32", affects: "paint", interp: "number" },
    { name: "radiusBottomRight", type: "f32", affects: "paint", interp: "number" },
    { name: "radiusBottomLeft", type: "f32", affects: "paint", interp: "number" },
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
    // `scrollbar-width`, and paint-only *because* the gutter is not reserved:
    // dziri's bars are overlay, so thickness changes what is covered rather than
    // what fits. It stops being paint-only the day a gutter exists.
    { name: "scrollbarWidth", type: "u8", affects: "paint", doc: "0 auto, 1 thin, 2 none" },
    // `scrollbar-color`, thumb then track, exactly as CSS orders them. Alpha 0
    // means "not specified" — the same convention `borderColor` uses — so `auto`
    // needs no separate field. See css.ts `scrollbarColor` for the one divergence
    // that costs.
    { name: "scrollbarThumb", type: "u32", affects: "paint", interp: "color" },
    { name: "scrollbarTrack", type: "u32", affects: "paint", interp: "color" },
    // The form-control trio. Reserved here before anything draws a control,
    // because they are ordinary compile-time fields — the cascade resolves them
    // like any colour or keyword — and the alternative is discovering at A3 that
    // adding three style fields is also a protocol bump.
    //
    // `appearance` is on the wire at all *because* dziri draws its own controls:
    // it is the author's switch between "you draw it" and "I draw it", and only
    // the side holding the canvas can act on it. See ROADMAP C2.
    //
    // Alpha 0 is `auto` for both colours, the convention `borderColor` and
    // `scrollbar-color` already use — so neither needs a companion flag field.
    { name: "accentColor", type: "u32", affects: "paint", interp: "color" },
    { name: "caretColor", type: "u32", affects: "paint", interp: "color" },
    { name: "appearance", type: "u8", affects: "paint", doc: "0 none, 1 auto" },
    // `opacity` and `transform`, and every one of them is `paint` — measured,
    // not assumed. A transformed box does not move its parent's height or its
    // own siblings, so Taffy never needs to hear about a change here.
    { name: "opacity", type: "f32", affects: "paint", interp: "number", doc: "0..1, initial 1" },
    // The transform arrives **decomposed**, never as a matrix, and the engine
    // composes it in one fixed order: translate, rotate, skew, scale.
    //
    // Not a matrix because a matrix cannot be transitioned. `rotate(0deg)` and
    // `rotate(360deg)` have identical matrices, so interpolating the six floats
    // between them cannot move — where Chromium is at 180° halfway. Storing the
    // angle keeps the winding, which is the whole difference. See BROWSER-FACTS.md.
    //
    // Percentages travel unresolved because they are relative to the node's own
    // border box, which is layout's answer and not the compiler's. Two fields per
    // axis rather than one, since CSS permits `calc(10px + 50%)` and Tailwind
    // ships both spellings.
    { name: "translateX", type: "f32", affects: "paint", interp: "number" },
    { name: "translateY", type: "f32", affects: "paint", interp: "number" },
    { name: "translatePercentX", type: "f32", affects: "paint", interp: "number", doc: "fraction of own border-box width" },
    { name: "translatePercentY", type: "f32", affects: "paint", interp: "number", doc: "fraction of own border-box height" },
    // Degrees, and deliberately not wrapped to one turn — see above.
    { name: "rotate", type: "f32", affects: "paint", interp: "number", doc: "degrees, unnormalised" },
    { name: "scaleX", type: "f32", affects: "paint", interp: "number", doc: "initial 1" },
    { name: "scaleY", type: "f32", affects: "paint", interp: "number", doc: "initial 1" },
    { name: "skewX", type: "f32", affects: "paint", interp: "number", doc: "degrees" },
    { name: "skewY", type: "f32", affects: "paint", interp: "number", doc: "degrees" },
    // `transform-origin`. The initial value is `50% 50%`, so the percentage pair
    // is the one that carries the default and a node that never mentions the
    // property still needs its laid-out size to find its own centre.
    { name: "transformOriginPercentX", type: "f32", affects: "paint", interp: "number", doc: "initial 0.5" },
    { name: "transformOriginPercentY", type: "f32", affects: "paint", interp: "number", doc: "initial 0.5" },
    { name: "transformOriginX", type: "f32", affects: "paint", interp: "number", doc: "px, added to the percentage" },
    { name: "transformOriginY", type: "f32", affects: "paint", interp: "number", doc: "px, added to the percentage" },
    // `transition` and `animation`, as one `u16` each into the `tweens` table.
    //
    // A reference rather than a spelt-out spec, and that is the whole design.
    // `transition-property` is a comma-separated *list* where every other style
    // field is one number, and a transition also carries a duration, a delay and
    // four bezier control points — sixteen more columns on a table with one row
    // per interned style, to say a thing that is identical on the fifty nodes of a
    // page that share one `.btn` class. Interned, it is one row and two `u16`s.
    //
    // Zero means "no transition here", which is why these are index **+ 1**: row 0
    // is a real tween, and a style table starts out zeroed.
    //
    // Both are `paint` even though they are not painted, because the question
    // `affects` asks is "must Taffy hear about a change to this", and the answer is
    // no: which fields a node may interpolate does not move a box. What the fields
    // *point at* is constrained to be paint-only for the same reason — see
    // `Interp`.
    //
    // Neither is animatable, and the recursion that would be is not idle
    // speculation: `transition-property: all` in Tailwind's default list names
    // every property, so a mask built without excluding these would have a
    // transition transitioning its own duration.
    { name: "transition", type: "u16", affects: "paint", doc: "tween row + 1, or 0 for none" },
    { name: "animation", type: "u16", affects: "paint", doc: "tween row + 1, or 0 for none" },
  ],
};

/**
 * Transitions and `@keyframes` animations, as one interned row shape.
 *
 * They are the same mechanism and this table is where that is said. A transition
 * is interpolation between two rows of the style table the compiler already
 * resolved; a `@keyframes` block is a *fixed set* of such rows at fixed offsets,
 * and interpolating between two of them is the identical operation. So one row
 * type serves both, and the only difference on the wire is whether `firstSegment`
 * points at a keyframe list or is `-1`.
 *
 * Interned, like styles: `transition-colors duration-150` on forty nodes is one
 * row. Nothing here is per-node — the per-node state is the engine's `t`, and it
 * is not on the wire at all.
 *
 * What is *not* here is any timing per property. CSS allows it — `transition:
 * opacity 1s, transform 2s` computes to `duration: [1s, 2s]`, measured — and
 * dziri does not: one timing governs every field in `mask`. Tailwind never emits
 * the other shape (every utility sets one `transition-duration` for its whole
 * list), and the compiler warns by name rather than silently picking one.
 */
const TWEENS: Table = {
  name: "tweens",
  doc: "Interned transition and animation timing. One row per distinct spec.",
  sizedBy: "own",
  fields: [
    {
      name: "mask",
      type: "u32",
      doc: "Animatable-field bits this tween may move; see styles::ANIM_BIT",
    },
    { name: "duration", type: "f32", doc: "Seconds for one iteration; 0 disables the tween" },
    { name: "delay", type: "f32", doc: "Seconds before it starts" },
    {
      name: "iterations",
      type: "f32",
      doc: "f32::INFINITY for `infinite`; always 1 for a transition",
    },
    {
      name: "firstSegment",
      type: "i32",
      doc: "First row in `keyframes`, or -1 when the endpoints are two style rows",
    },
    { name: "segmentCount", type: "u16" },
    // The curve, inline rather than interned into a fifth table. Five columns on a
    // table with a handful of rows is cheaper than a table, an index, a capacity
    // and a bounds check — and a keyframe segment needs its own curve anyway
    // (measured: a keyframe's `animation-timing-function` governs the segment
    // *leaving* it and never reaches the element's computed style), so the columns
    // exist twice regardless.
    { name: "easing", type: "u8", doc: "Easing" },
    { name: "easeA", type: "f32", doc: "bezier x1, or the step count" },
    { name: "easeB", type: "f32", doc: "bezier y1, or the StepPosition" },
    { name: "easeC", type: "f32", doc: "bezier x2" },
    { name: "easeD", type: "f32", doc: "bezier y2" },
  ],
};

/**
 * One keyframe of one animation: an offset and the style row it resolves to.
 *
 * The row is an ordinary interned style, resolved by the compiler as "this
 * element's own computed style, with the keyframe's declarations applied on top".
 * That is what makes keyframes cost the engine nothing new: `@keyframes spin { to
 * { transform: rotate(360deg) } }` is two rows of a table it already interpolates
 * between, and a missing `0%` needs no synthetic value at all — measured, the
 * implicit `from` *is* the element's own computed style, which is the base slot.
 *
 * Sorted by `offset` within a tween's span, and both endpoints are always present:
 * the compiler synthesises `0` and `1` from the base row when the author omitted
 * them, so the engine's segment search never has to handle a hole.
 */
const KEYFRAMES: Table = {
  name: "keyframes",
  doc: "Per-animation keyframe list: offset, resolved style row, and segment easing.",
  sizedBy: "own",
  fields: [
    { name: "style", type: "u16", doc: "Interned style row this keyframe resolves to" },
    { name: "offset", type: "f32", doc: "0..1, ascending within a tween's span" },
    // The easing of the segment *starting* here — measured, and it is the row that
    // makes Tailwind's `bounce` possible without a second concept. `INHERIT` means
    // "the animation's own", which is what a keyframe that names none gets.
    { name: "easing", type: "u8", doc: "Easing, or Easing::INHERIT for the animation's" },
    { name: "easeA", type: "f32" },
    { name: "easeB", type: "f32" },
    { name: "easeC", type: "f32" },
    { name: "easeD", type: "f32" },
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

/**
 * Media queries, as thresholds the engine tests against the surface each frame.
 *
 * One row per *atomic* condition, not per `@media` block. A block written
 * `@media (min-width: 40rem) and (max-width: 60rem)` becomes two rows and two
 * bits, and the rules inside it declare both — which means the existing variant
 * machinery resolves the conjunction for free, as the combination where both bits
 * are live. Nothing here has to understand `and`.
 *
 * The thresholds are px, resolved by the compiler: `40rem` is 640 here, and the
 * engine never learns that `rem` exists.
 *
 * This is the smallest thing that could be on the wire. It is on the wire at all
 * because a media query is the first styling input whose answer *changes* — the
 * window is resized — so unlike `var()` or `calc()` it cannot be folded away at
 * compile time. What is still compile-time is everything else about it: which
 * rules it governs, and the finished style each combination produces.
 */
const MEDIA: Table = {
  name: "media",
  doc: "Global predicates the engine re-evaluates from the surface size each frame.",
  sizedBy: "own",
  fields: [
    { name: "bit", type: "u32", doc: "The Predicate bit this condition sets when it holds" },
    { name: "kind", type: "u8", doc: "MediaKind: which axis, and which side of the threshold" },
    { name: "value", type: "f32", doc: "Threshold in CSS px, already resolved from rem/em" },
  ],
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

export const TABLES: Table[] = [
  NODES,
  STYLES,
  VARIANTS,
  VARIANT_SLOTS,
  MEDIA,
  LISTS,
  TWEENS,
  KEYFRAMES,
  LAYOUT,
  STRINGS,
];

/**
 * Style fields that can be interpolated, low bit first — the bit numbering a
 * tween's `mask` uses.
 *
 * Derived rather than declared, so a field marked `interp` in the table above is
 * animatable the moment it is added and nobody has to remember a second list. The
 * mask is a `u32`, so this is capped at 32 entries; `schema.test.ts` asserts it,
 * because the failure mode of overrunning is a bit that silently animates the
 * wrong property.
 */
export const ANIMATABLE_FIELDS: Field[] = STYLES.fields.filter((f) => f.interp !== undefined);

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
    name: "ScrollbarWidth",
    doc:
      "`styles.scrollbarWidth`. The whole grammar: Chromium 151 rejects `thick` and a " +
      "`<length>` outright, measured — MDN's scrollbars guide is wrong about both. `NONE` hides " +
      "the bar without disabling the wheel, which is exactly what the property means.",
    ty: "u8",
    values: { AUTO: 0, THIN: 1, NONE: 2 },
  },
  {
    name: "Appearance",
    doc:
      "`styles.appearance`. An *effect*, not the specified value — `<compat-auto>` keywords all " +
      "collapse to `AUTO` here, which is what the spec says they do and what makes storing nine " +
      "more variants pointless. `BASE_SELECT` is the opt-in that makes a `<select>` and its " +
      "`::picker(select)` fully styleable; it is the one value that changes what gets drawn " +
      "rather than merely whether. Measured against Chromium 151 — see BROWSER-FACTS.md.",
    ty: "u8",
    values: { NONE: 0, AUTO: 1, BASE_SELECT: 2 },
  },
  {
    name: "MediaKind",
    doc:
      "`media.kind`. Which axis a threshold tests, and which side of it counts as true. " +
      "`MIN_*` holds at the threshold and above, `MAX_*` at it and below — the same " +
      "inclusive bounds `min-width`/`max-width` have in CSS, which is why a `min-width: 768px` " +
      "and a `max-width: 768px` query are both true at exactly 768.",
    ty: "u8",
    values: { MIN_WIDTH: 0, MAX_WIDTH: 1, MIN_HEIGHT: 2, MAX_HEIGHT: 3 },
  },
  {
    name: "Predicate",
    doc:
      "Bit positions in a variant mask. Bits 0-4 are per-node; higher bits are " +
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
       * This control is checked — a checkbox, radio, switch or pressed toggle.
       *
       * A per-node predicate like the three above, and cheap for the same reason:
       * checked-ness is an enumerable boolean, so it is a second style id and an
       * int write rather than anything the runtime has to compute. What differs
       * is *who* sets it. `HOVER`, `ACTIVE` and `FOCUS` are answers the engine
       * already has from the pointer and the focus ring; these two are the app's
       * own `state()`, so the engine learns them the same way it learns `hidden`.
       *
       * The compiler emits the bit as soon as a stylesheet reads `:checked`. Until
       * the engine can be told which nodes are checked (A3), the bit is simply
       * never live, and such a node wears its base style — a control that does not
       * light up yet, not a wrong-looking frame.
       */
      CHECKED: 1 << 3,
      /** This control is disabled, and so takes no pointer or keyboard input. */
      DISABLED: 1 << 4,

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
    name: "Interp",
    doc:
      "`styles.INTERP`. How a field's value is found partway between two style rows. " +
      "`NONE` is discrete and is what every enum gets. See the `Interp` doc comment in " +
      "schema.ts for why a colour is its own kind rather than a number.",
    ty: "u8",
    values: { NONE: INTERP_CODE.none, NUMBER: INTERP_CODE.number, COLOR: INTERP_CODE.color },
  },
  {
    name: "Easing",
    doc:
      "`tweens.easing` and `keyframes.easing`. Which curve maps elapsed fraction to " +
      "progress. The keywords are **not** normalised to `cubic-bezier()` by CSS — `ease` " +
      "reads back as `ease` — but they are here, because a keyword is a bezier with fixed " +
      "control points and storing five of them separately would be five ways to spell one " +
      "curve. The two step keywords do normalise in CSS: `step-start` is `steps(1, start)` " +
      "and `step-end` is `steps(1)`. Measured — see BROWSER-FACTS.md.",
    ty: "u8",
    values: {
      LINEAR: 0,
      /** `easeA..easeD` are the four control points, as authored. */
      CUBIC_BEZIER: 1,
      /** `easeA` is the step count, `easeB` a `StepPosition`. */
      STEPS: 2,
      /**
       * A keyframe that named no easing of its own, so the animation's governs.
       *
       * Only ever in `keyframes.easing`. A `tweens` row always holds a real curve —
       * `ease` when the author said nothing, which is CSS's initial value for both
       * `transition-timing-function` and `animation-timing-function`.
       */
      INHERIT: 255,
    },
  },
  {
    name: "StepPosition",
    doc:
      "`keyframes.easeB` / `tweens.easeB` when the easing is `STEPS`. Which end of each " +
      "step the jump happens at. `steps(4, end)` reads 0 at t=0.1 and 0.75 at t=0.9; " +
      "`steps(4, start)` reads 0.25 and 1.0 — measured, and the pair that tells them apart.",
    ty: "u8",
    values: { JUMP_END: 0, JUMP_START: 1, JUMP_BOTH: 2, JUMP_NONE: 3 },
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
 * v6 adds `scrollbarWidth`, `scrollbarThumb` and `scrollbarTrack`, so the two standard
 * scrollbar properties can be authored instead of the engine's own defaults being the
 * only answer.
 *
 * v9 adds `accentColor`, `caretColor` and `appearance`, and the `CHECKED` and `DISABLED`
 * predicate bits — the compile-time half of form controls (ROADMAP C2 phase 0). Nothing
 * in the engine reads any of the five yet; they are reserved so that A3 is a feature
 * rather than a protocol bump, and so the compiler can stop refusing `:checked`.
 *
 * v10 adds `NodeFlags.GENERATED`, which changes how the engine *interprets* bytes it
 * already had: a flagged node resolves its per-node predicates from `nodes.parent`.
 *
 * No table changed, and that is the whole reason this bump is by hand. `SCHEMA_HASH`
 * fingerprints table and field structure — names, types, `affects` — plus the version
 * string, and flag *semantics* are in none of that. Had the version not been bumped the
 * hash would have been unchanged, both guard checks would have passed, and a stale
 * binary would have resolved every `::before` variant against the wrong node: a
 * wrong-looking frame with nothing to blame, which is the exact class the version
 * exists for. The hash moving here is a consequence of the bump, not a detection of
 * the change.
 *
 * Also bumped when the *C ABI* changes shape, even though the tables did not —
 * v4 is where the engine handle stopped being a pointer and became a `u32` token
 * into a handle table. `SCHEMA_HASH` cannot cover that: it hashes the tables, and
 * a stale binary would pass both checks and then be handed a 4-byte out-parameter
 * where it expects 8. `dziri_protocol_version` takes no arguments, so it is the one
 * call that is safe to make against a binary of unknown vintage — which is why the
 * ABI's own version lives here.
 *
 * v11 adds `opacity` and the fourteen decomposed transform fields. A real table
 * change, so the hash moves on its own this time — but the version is bumped for
 * the ordinary reason as well: the styles table grew, and an old binary reading
 * the new one would find every field past `appearance` at the wrong offset.
 *
 * v12 adds `transition` and `animation` to the styles table, and the `tweens` and
 * `keyframes` tables they point into. Two tables and two fields, so the hash moves
 * on its own — but the bump is also the ordinary kind twice over: the styles table
 * grew again, and `TABLE_COUNT` went from 8 to 10, which changes what a table
 * index means. An old binary handed the new descriptor would read `tweens` where
 * it expects `layout`.
 *
 * The `Easing` and `StepPosition` enums arrive with it. Adding an enum does not
 * bump on its own — enums carry no layout — and that is worth restating here
 * precisely because `SCHEMA_HASH` cannot see enum *values*: retuning what
 * `STEPS` means would need this bumped by hand, exactly as v10 was.
 */
export const PROTOCOL_VERSION = 12;

/** Node flag bits, shared by both sides. */
export const NodeFlags = {
  INTERACTIVE: 1 << 0,
  MEASURABLE: 1 << 1,
  /**
   * A box generated by a pseudo-element, whose per-node predicates are its
   * *parent's*.
   *
   * `.btn:hover::before` means "the generated box of a hovered `.btn`", not "the
   * generated box while it is itself hovered". Without this the distinction is
   * lost and the rule silently never applies: `hit_test` only ever returns
   * `INTERACTIVE` nodes, so a generated box is never `state.hovered`, and a
   * variant compiled for its HOVER bit could not be selected by anything.
   *
   * A flag rather than an `originator` column on the variants table because
   * `::before` and `::after` are emitted as direct children of the element they
   * belong to, so `nodes.parent` already holds the answer. A pseudo-element that
   * is not a direct child would need the column; none is.
   */
  GENERATED: 1 << 2,
} as const;
