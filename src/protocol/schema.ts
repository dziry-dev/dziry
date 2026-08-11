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
  /**
   * What the compiler calls this field, when that differs from the wire name.
   *
   * The schema spells CSS out (`padTop`) and the IR abbreviates (`padT`), and both
   * are deliberate: the wire name is read by someone debugging a byte offset, the IR
   * name is read a hundred times in the expander. What was not deliberate is that
   * the mapping was written a third time by hand, in `upload.ts`, and a fourth as
   * `STYLE_FIELDS` in `ir.ts` — with `affectsLayout` restating `affects` beside it.
   * `schema.test.ts` existed to assert the two agreed, and said so in its header:
   * "nothing but this file makes them agree."
   *
   * Naming it here makes both generated instead. Absent means the names match.
   *
   * `null` means the opposite: on the wire, with no IR row at all, because the
   * compiler does not write it yet. Stated rather than inferred so that the next
   * such field has to say so, instead of the generator carrying a list of names to
   * skip — which is the shape of the problem this whole field exists to remove.
   *
   * Deliberately outside `schemaHash`. The hash catches the two *sides* disagreeing,
   * and Rust never sees this — so there is no disagreement it could catch, and
   * including it would bump `PROTOCOL_VERSION` for a rename that moves no bytes.
   */
  ir?: string | null;
  /**
   * Whether the value inherits, for the one table where that is a CSS question.
   *
   * A compiler fact rather than a wire one: inheritance is resolved before anything
   * is written, so the engine has no use for it. It lives here because the row is
   * the only place that knows everything about a field, and splitting it out is what
   * produced two lists to keep in step. Outside `schemaHash` for the same reason as
   * {@link Field.ir}.
   */
  inherited?: true;
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
      // Named rather than listed. This doc said "bit 0 interactive, bit 1 measurable, bit 2
      // generated" for five bits' worth of additions after that stopped being the whole
      // set — a copy of a list is a copy that drifts, and nothing checks it.
      //
      // **Full as of v24.** `AUTOFOCUS` is bit 7 and a `u8` has no bit 8, so the next flag
      // widens this column, which unlike every flag addition so far *is* a layout change:
      // visible to the hash, and every offset after `flags` moves.
      doc: "See NodeFlags. Bits 0-7, all assigned",
    },
    {
      name: "activates",
      type: "i32",
      doc: "The control node a press here operates, or -1",
    },
  ],
};

/**
 * Which nodes are form controls, and what kind. Sparse and sorted by node.
 *
 * Sparse because controls are rare — a page of 900 nodes has a dozen — and the
 * engine's per-node lookup is a dense array it builds *itself* on rescan, exactly
 * as `Anims` does. So nothing here is paid per node.
 *
 * The engine owns the live checkedness, and this table holds only what the
 * compiler knows: which node is a control, which group it belongs to, and the
 * state it was authored in. That split is deliberate — see `ControlFlags`.
 */
const CONTROLS: Table = {
  name: "controls",
  doc: "Form controls: kind, radio group, and authored initial state.",
  sizedBy: "own",
  fields: [
    { name: "node", type: "i32", doc: "Sorted ascending, for binary search" },
    { name: "kind", type: "u8", doc: "ControlKind" },
    {
      name: "group",
      type: "i32",
      doc: "Radio group id — interned per (form, name), or per <select> for an option — or -1",
    },
    { name: "flags", type: "u8", doc: "ControlFlags: the authored initial state" },
    {
      name: "label",
      type: "i32",
      doc:
        "The text-run node this control's label lives on, or -1. On a SELECT it is the " +
        "run inside <selectedcontent>, whose string the engine repoints at the committed " +
        "option's; on an OPTION it is that option's own run. Nothing else fills it.",
    },
    {
      name: "rows",
      type: "i32",
      doc:
        "A LISTBOX's height in rows — its `size`, defaulting to 4. 0 on every other kind. " +
        "The engine multiplies it by the option row height, which only the engine knows.",
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
    { name: "fg", type: "u32", affects: "paint", interp: "color", inherited: true },
    // Four sides, like the widths. Alpha 0 is "nothing said" per side — a side
    // with no colour paints nothing even if it has a width, the convention the
    // single field already had.
    { name: "borderTopColor", type: "u32", affects: "paint", interp: "color" },
    { name: "borderRightColor", type: "u32", affects: "paint", interp: "color" },
    { name: "borderBottomColor", type: "u32", affects: "paint", interp: "color" },
    { name: "borderLeftColor", type: "u32", affects: "paint", interp: "color" },
    // Layout, not paint: the engine reserves the border in Taffy's box, so a
    // width change moves the content.
    //
    // Four sides, because that is what CSS has — `border-t-2 border-b-red-500`
    // is not expressible otherwise, and folding the logical border properties
    // onto one field would paint all four edges for any one of them. The width
    // of a side is also its *visibility*: `border-style: none` on a side means
    // no border however wide it is, and the compiler encodes that as width 0
    // rather than carrying a style enum nothing else would read.
    { name: "borderTopWidth", type: "f32", affects: "layout" },
    { name: "borderRightWidth", type: "f32", affects: "layout" },
    { name: "borderBottomWidth", type: "f32", affects: "layout" },
    { name: "borderLeftWidth", type: "f32", affects: "layout" },
    // Four corners, not one radius. CSS has no single-radius property — it has
    // four longhands and a shorthand over them — and the one-field version could
    // not express `rounded-t-lg`, which is most of what Tailwind's radius
    // utilities are. `paint.rs` already built its border ring from two round
    // rects specifically so this could grow without changing how borders draw.
    { name: "radiusTopLeft", type: "f32", affects: "paint", interp: "number", ir: "radTL" },
    { name: "radiusTopRight", type: "f32", affects: "paint", interp: "number", ir: "radTR" },
    { name: "radiusBottomRight", type: "f32", affects: "paint", interp: "number", ir: "radBR" },
    { name: "radiusBottomLeft", type: "f32", affects: "paint", interp: "number", ir: "radBL" },
    // `box-shadow`, reduced to the concentric bands it can actually be.
    //
    // Three bands rather than a layer list, because a style row is a fixed struct and a
    // shadow list is not. What fits is the subset with no offset and no blur — a *spread*
    // in a solid colour — and that subset is exactly what Tailwind's `ring-*`, `inset-ring-*`
    // and `ring-offset-*` utilities compile to. Measured, not assumed: `ring-2 ring-sky-400
    // ring-offset-2 ring-offset-black` resolves to
    //
    //   0 0 #0000, 0 0 #0000, 0 0 0 2px #000, 0 0 0 calc(2px + 2px) #38bdf8, 0 0 #0000
    //
    // through dziri's own `var()` and `@property` machinery. See BROWSER-FACTS.md and
    // `properties.ts::parseBoxShadow`, which refuses the layers that do not fit rather than
    // approximating them.
    //
    // `outer` is the widest outset band and `inner` is an outset band painted *over* it, so
    // the visible ring is `inner..outer` in `outerColor` and `0..inner` in `innerColor` —
    // which is precisely how a ring offset works. Extents from the border box, not
    // thicknesses, because that is what a shadow's spread is.
    //
    // All `paint`: CSS says a box shadow never affects layout, which is the whole reason
    // `ring-2` is reached for instead of a second border.
    //
    // **Deliberately not `interp`.** The mask is a `u32` and 25 of its 32 bits are already
    // spent; six more would leave one. A ring that appears on focus without fading is a
    // smaller cost than a budget with no room in it, and `transitionMask` warns rather than
    // silently doing nothing. Revisit when the mask grows.
    { name: "ringOuterWidth", type: "f32", affects: "paint" },
    { name: "ringOuterColor", type: "u32", affects: "paint" },
    { name: "ringInnerWidth", type: "f32", affects: "paint" },
    { name: "ringInnerColor", type: "u32", affects: "paint" },
    { name: "ringInsetWidth", type: "f32", affects: "paint" },
    { name: "ringInsetColor", type: "u32", affects: "paint" },
    // `::selection`, as two colours on the *originating element's* row rather than a
    // style row of its own.
    //
    // A selection is not a box. `::before` and `::placeholder` are generated nodes because
    // they occupy space; a selection is a range of characters inside a node that already
    // exists, so it has nowhere to put a row and nothing to lay out. Two fields on the
    // field itself is the whole of it.
    //
    // The **default is a convention, not a measurement**: Chromium does not expose its
    // highlight colour through `getComputedStyle` — a selection with no author rule reports
    // `rgba(0, 0, 0, 0)` — so it is unmeasurable from script, in the same category as the
    // caret's width and blink rate. dziri's default therefore lives in its own UA sheet,
    // where a UA default belongs, and `::selection` is what makes it overridable. See
    // BROWSER-FACTS.md, which records the refusal.
    //
    // **Inherited**, which is what makes the cascade come out right. The UA default is set
    // on `body::selection`, so it reaches every field by inheritance rather than by being
    // declared on it — and an author's `body::selection` then wins on origin, while an
    // author's `input::selection` wins by being declared closer. A UA rule *on the field*
    // would have beaten an author rule on the root, which is backwards.
    //
    // Not `interp`, for the reason the `ring*` fields are not: 25 of the mask's 32 bits were
    // already spent before this commit, and a selection colour that cross-fades is not worth
    // one of the seven left.
    { name: "selectionBg", type: "u32", affects: "paint", inherited: true },
    { name: "selectionFg", type: "u32", affects: "paint", inherited: true },
    // `outline` — a ring drawn *outside* the border box, so it is all paint and
    // layout never hears about it. No style field, the border convention:
    // `outline-style: none` compiles to width 0, and the patterned styles paint
    // solid with a warning. Offset is signed — a negative one draws the ring
    // *inside* the box, which is how a focus ring on a filled button reads.
    { name: "outlineColor", type: "u32", affects: "paint", interp: "color" },
    { name: "outlineWidth", type: "f32", affects: "paint" },
    { name: "outlineOffset", type: "f32", affects: "paint" },
    // `text-decoration`. `line` is a bit set (underline 1, overline 2,
    // line-through 4), which is the one place a decoration differs from every
    // other style here: two of them can be on at once. The colour's alpha-0
    // means currentcolor — resolved to `fg` at paint, since the cascade cannot
    // substitute a keyword that names the very field being computed.
    // `thickness` 0 is auto (the font's own metric); `underlineOffset` NaN is
    // auto likewise. All paint: a decoration never moves a line.
    //
    // Marked inherited even though the spec says the property is not: CSS
    // *propagates* a decoration to inline descendants, and dziri's text runs
    // are separate nodes — so inheritance is how `underline` on an element
    // reaches its text. The divergence: it also crosses block boundaries,
    // which CSS stops at. Underlining one more box beats not underlining the
    // link.
    { name: "decorationLine", type: "u8", affects: "paint", inherited: true, doc: "bit set: 1 underline, 2 overline, 4 line-through" },
    { name: "decorationColor", type: "u32", affects: "paint", interp: "color", inherited: true },
    { name: "decorationStyle", type: "u8", affects: "paint", inherited: true, doc: "0 solid, 1 double, 2 dotted, 3 dashed, 4 wavy" },
    { name: "decorationThickness", type: "f32", affects: "paint", inherited: true, doc: "0 = auto (font metric)" },
    { name: "underlineOffset", type: "f32", affects: "paint", inherited: true, doc: "px; NaN = auto (font metric)" },
    // box
    { name: "padTop", type: "f32", affects: "layout", ir: "padT" },
    { name: "padRight", type: "f32", affects: "layout", ir: "padR" },
    { name: "padBottom", type: "f32", affects: "layout", ir: "padB" },
    { name: "padLeft", type: "f32", affects: "layout", ir: "padL" },
    { name: "marginTop", type: "f32", affects: "layout", ir: "marT" },
    { name: "marginRight", type: "f32", affects: "layout", ir: "marR" },
    { name: "marginBottom", type: "f32", affects: "layout", ir: "marB" },
    { name: "marginLeft", type: "f32", affects: "layout", ir: "marL" },
    // flex + grid
    { name: "display", type: "u8", affects: "layout", doc: "0 flex, 1 grid, 2 block, 3 none" },
    { name: "flexDirection", type: "u8", affects: "layout", ir: "direction" },
    { name: "flexWrap", type: "u8", affects: "layout", ir: "wrap" },
    { name: "justifyContent", type: "u8", affects: "layout", ir: "justify" },
    { name: "alignItems", type: "u8", affects: "layout", ir: "align" },
    { name: "alignSelf", type: "u8", affects: "layout" },
    { name: "justifyItems", type: "u8", affects: "layout", doc: "Grid only" },
    { name: "justifySelf", type: "u8", affects: "layout", doc: "Grid only" },
    { name: "flexGrow", type: "f32", affects: "layout", ir: "grow" },
    { name: "flexShrink", type: "f32", affects: "layout", ir: "shrink" },
    { name: "flexBasis", type: "f32", affects: "layout", ir: "basis" },
    // Fraction of the containing block, resolved by Taffy — see `widthPct`.
    { name: "flexBasisPct", type: "f32", affects: "layout", ir: "basisPct" },
    // `order` — flexbox item order. Initial value is 0. Affects layout.
    { name: "order", type: "i32", affects: "layout" },
    { name: "gapRow", type: "f32", affects: "layout" },
    { name: "gapColumn", type: "f32", affects: "layout", ir: "gapCol" },
    { name: "gridColumns", type: "u16", affects: "layout", doc: "repeat(N, minmax(0,1fr)) — Tailwind's grid-cols-N", ir: "gridCols" },
    { name: "gridRows", type: "u16", affects: "layout" },
    { name: "gridColumnStart", type: "i16", affects: "layout", ir: "gridColStart" },
    { name: "gridColumnSpan", type: "i16", affects: "layout", ir: "gridColSpan" },
    { name: "gridRowStart", type: "i16", affects: "layout" },
    { name: "gridRowSpan", type: "i16", affects: "layout" },
    // sizing — NaN means auto
    //
    // Each of the six has two companions, and a length is the *sum* of its
    // channels: px the compiler resolved, plus `Pct` — a fraction of the
    // containing block, which Taffy resolves natively — plus `Vp`, a fraction
    // of the window on the field's own axis, which the engine resolves when it
    // builds the Taffy style and re-resolves on resize. That is where
    // `width: 50%`, `w-1/2` (`calc(1 / 2 * 100%)`) and `h-screen` (`100vh`)
    // live; the channels exist because none of those is a number at compile
    // time, and the compiler still refuses the one shape Taffy cannot express —
    // a percentage summed with an absolute part, `calc(100% - 2rem)`.
    //
    // The small/large/dynamic viewport variants fold to the plain unit at
    // compile time: a dziri window has no browser chrome, so the four sizes a
    // mobile browser distinguishes are one size here.
    //
    // Padding, margin and gap have no `Pct` companions — percentages are valid
    // CSS there but Tailwind never emits them, and adding the channels is one
    // row each when a measurement says otherwise.
    { name: "width", type: "f32", affects: "layout" },
    { name: "widthPct", type: "f32", affects: "layout", doc: "fraction of containing-block width" },
    { name: "widthVp", type: "f32", affects: "layout", doc: "fraction of the window's width" },
    { name: "height", type: "f32", affects: "layout" },
    { name: "heightPct", type: "f32", affects: "layout", doc: "fraction of containing-block height" },
    { name: "heightVp", type: "f32", affects: "layout", doc: "fraction of the window's height" },
    { name: "minWidth", type: "f32", affects: "layout", ir: "minW" },
    { name: "minWidthPct", type: "f32", affects: "layout", ir: "minWPct" },
    { name: "minWidthVp", type: "f32", affects: "layout", ir: "minWVp" },
    { name: "minHeight", type: "f32", affects: "layout", ir: "minH" },
    { name: "minHeightPct", type: "f32", affects: "layout", ir: "minHPct" },
    { name: "minHeightVp", type: "f32", affects: "layout", ir: "minHVp" },
    { name: "maxWidth", type: "f32", affects: "layout", ir: "maxW" },
    { name: "maxWidthPct", type: "f32", affects: "layout", ir: "maxWPct" },
    { name: "maxWidthVp", type: "f32", affects: "layout", ir: "maxWVp" },
    { name: "maxHeight", type: "f32", affects: "layout", ir: "maxH" },
    { name: "maxHeightPct", type: "f32", affects: "layout", ir: "maxHPct" },
    { name: "maxHeightVp", type: "f32", affects: "layout", ir: "maxHVp" },
    { name: "aspectRatio", type: "f32", affects: "layout" },
    { name: "position", type: "u8", affects: "layout", doc: "0 relative, 1 absolute" },
    { name: "insetTop", type: "f32", affects: "layout", ir: "insetT" },
    { name: "insetRight", type: "f32", affects: "layout", ir: "insetR" },
    { name: "insetBottom", type: "f32", affects: "layout", ir: "insetB" },
    { name: "insetLeft", type: "f32", affects: "layout", ir: "insetL" },
    // Inset percentages, resolved by Taffy against the containing block exactly
    // as CSS resolves `top: 50%`. No viewport channel — nothing in the measured
    // Tailwind corpus positions from the window.
    { name: "insetTopPct", type: "f32", affects: "layout", ir: "insetTPct" },
    { name: "insetRightPct", type: "f32", affects: "layout", ir: "insetRPct" },
    { name: "insetBottomPct", type: "f32", affects: "layout", ir: "insetBPct" },
    { name: "insetLeftPct", type: "f32", affects: "layout", ir: "insetLPct" },
    // `border-spacing` — horizontal and vertical space between table borders.
    // CSS property for `<table>`, but dziri doesn't render tables; paint-only as a no-op.
    // Two f32 fields for H and V spacing. NaN means unset (use browser default 2px).
    { name: "borderSpacingH", type: "f32", affects: "paint" },
    { name: "borderSpacingV", type: "f32", affects: "paint" },
    // `scroll-margin` — distance the browser adds when scrolling an element into view.
    // Four per-side fields (top/right/bottom/left). Paint-only (no layout effect).
    // NaN means unset (default 0). Logical aliases (scroll-margin-inline, etc.) expand here.
    { name: "scrollMarginTop", type: "f32", affects: "paint" },
    { name: "scrollMarginRight", type: "f32", affects: "paint" },
    { name: "scrollMarginBottom", type: "f32", affects: "paint" },
    { name: "scrollMarginLeft", type: "f32", affects: "paint" },
    // `scroll-padding` — distance to scroll a viewport when scrolling a container into view.
    // Four per-side fields (top/right/bottom/left). Paint-only (no layout effect).
    // NaN means unset (default 0). Logical aliases (scroll-padding-inline, etc.) expand here.
    { name: "scrollPaddingTop", type: "f32", affects: "paint" },
    { name: "scrollPaddingRight", type: "f32", affects: "paint" },
    { name: "scrollPaddingBottom", type: "f32", affects: "paint" },
    { name: "scrollPaddingLeft", type: "f32", affects: "paint" },
    // text
    //
    // `layout`, and not for the obvious reason: neither appears in Taffy's
    // `Style` at all. They reach layout through the *measure callback*, which
    // reads them out of this table to shape the string. So they are the two
    // fields where "the resolved Taffy style is unchanged" and "the laid-out
    // size is unchanged" come apart — which is why `apply_style` must not be
    // guarded by comparing styles for equality. See `LayoutTree::apply_style`.
    { name: "fontSize", type: "f32", affects: "layout", inherited: true },
    { name: "fontWeight", type: "u16", affects: "layout", inherited: true },
    // The remaining two axes of font selection, both reaching layout through the
    // measure callback exactly as the two above do. `fontStyle` is a slant flag
    // rather than an angle: CSS `oblique <angle>` is a non-goal until a probe
    // shows something needs it. `fontFamily` is a *generic* family, not a name —
    // dziri resolves one concrete face per generic at startup, which is the
    // compile-time-first answer to font selection: an author names a category,
    // never a file. 0 is whatever the platform gave `Measurer::new`.
    { name: "fontStyle", type: "u8", affects: "layout", inherited: true, doc: "0 normal, 1 italic" },
    { name: "fontFamily", type: "u8", affects: "layout", inherited: true, doc: "generic family: 0 default, 1 monospace" },
    // `line-height`, as two channels because CSS has two forms: a multiplier of
    // the font size (`1.5`, `150%`) and an absolute length (`24px`). The engine
    // folds the px form against the resolved font size — a division the compiler
    // cannot do, because the cascade answers font-size and line-height
    // independently and neither expander can see the other's result.
    // `lineHeight` 0 is `normal`; `lineHeightPx` NaN is "no absolute value".
    { name: "lineHeight", type: "f32", affects: "layout", inherited: true, doc: "multiplier of font size; 0 = normal" },
    { name: "lineHeightPx", type: "f32", affects: "layout", inherited: true, doc: "absolute px; NaN = unset" },
    // `text-indent` — indentation of the first line of text. NaN means unset (default 0).
    // Layout property because it affects text positioning. Inherited.
    { name: "textIndent", type: "f32", affects: "layout", inherited: true, doc: "px; NaN = unset" },
    {
      name: "lineClamp",
      type: "u16",
      affects: "layout",
      doc: "0 = unlimited; drives SkParagraph maxLines",
      // On the wire ahead of the compiler: A2 wires this when SkParagraph lands.
      ir: null,
    },
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
    { name: "scrollbarThumb", type: "u32", affects: "paint", interp: "color", inherited: true },
    { name: "scrollbarTrack", type: "u32", affects: "paint", interp: "color", inherited: true },
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
    { name: "accentColor", type: "u32", affects: "paint", interp: "color", inherited: true },
    { name: "caretColor", type: "u32", affects: "paint", interp: "color", inherited: true },
    { name: "appearance", type: "u8", affects: "paint", doc: "0 none, 1 auto" },
    // `cursor` — the SDL system cursor shown when hovering this node.
    // Inherited, because a label should show the pointer cursor even if its
    // input is far away. Values: 0 auto, 1 default, 2 pointer, 3 text, 4 grab,
    // 5 grabbing, 6 wait, 7 not-allowed, 8 move, 9 ns-resize, 10 ew-resize, etc.
    { name: "cursor", type: "u8", affects: "paint", inherited: true, doc: "SDL_SystemCursor enum" },
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
    { name: "translatePercentX", type: "f32", affects: "paint", interp: "number", doc: "fraction of own border-box width", ir: "translatePctX" },
    { name: "translatePercentY", type: "f32", affects: "paint", interp: "number", doc: "fraction of own border-box height", ir: "translatePctY" },
    // Degrees, and deliberately not wrapped to one turn — see above.
    { name: "rotate", type: "f32", affects: "paint", interp: "number", doc: "degrees, unnormalised" },
    { name: "scaleX", type: "f32", affects: "paint", interp: "number", doc: "initial 1" },
    { name: "scaleY", type: "f32", affects: "paint", interp: "number", doc: "initial 1" },
    { name: "skewX", type: "f32", affects: "paint", interp: "number", doc: "degrees" },
    { name: "skewY", type: "f32", affects: "paint", interp: "number", doc: "degrees" },
    // `transform-origin`. The initial value is `50% 50%`, so the percentage pair
    // is the one that carries the default and a node that never mentions the
    // property still needs its laid-out size to find its own centre.
    { name: "transformOriginPercentX", type: "f32", affects: "paint", interp: "number", doc: "initial 0.5", ir: "originPctX" },
    { name: "transformOriginPercentY", type: "f32", affects: "paint", interp: "number", doc: "initial 0.5", ir: "originPctY" },
    { name: "transformOriginX", type: "f32", affects: "paint", interp: "number", doc: "px, added to the percentage", ir: "originPxX" },
    { name: "transformOriginY", type: "f32", affects: "paint", interp: "number", doc: "px, added to the percentage", ir: "originPxY" },
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
  CONTROLS,
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
    name: "FontStyle",
    doc: "`styles.fontStyle`. A slant flag; `oblique <angle>` is a non-goal until measured.",
    ty: "u8",
    values: { NORMAL: 0, ITALIC: 1 },
  },
  {
    name: "FontFamily",
    doc:
      "`styles.fontFamily`. A *generic* family, never a name: the engine resolves one " +
      "concrete face per generic at startup, so an author picks a category and the platform " +
      "picks the font. `DEFAULT` is whatever `Measurer::new` resolved.",
    ty: "u8",
    values: { DEFAULT: 0, MONOSPACE: 1 },
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
    name: "DecorationStyle",
    doc:
      "`styles.decorationStyle`. `text-decoration-style`'s five keywords, in spec " +
      "order — SOLID is 0, which is also the initial value.",
    ty: "u8",
    values: { SOLID: 0, DOUBLE: 1, DOTTED: 2, DASHED: 3, WAVY: 4 },
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
       * This node's popover is showing — a `<select>` whose picker is open.
       *
       * The same category as `HOVER` and `FOCUS` rather than as `CHECKED`: it is
       * an answer the engine already has, because the engine is what opened the
       * thing. One integer in `InputState` names the open node, and only one
       * popover can be open at a time — measured, and it is why this needs no
       * per-node array.
       *
       * It reaches `select::picker(select)` through `GENERATED`, which resolves a
       * generated box's predicates from its parent. So `:open` on the select is
       * what makes the picker visible, and an author writing
       * `select:open { border-color: … }` gets the same bit.
       */
      OPEN: 1 << 5,

      /**
       * This node holds focus **and the focus should be visible** — `:focus-visible`.
       *
       * The bit `:focus` is not, and the difference is the whole reason it exists:
       * a ring on every click is the thing the pseudo-class was invented to stop,
       * and no ring while someone is tabbing is a keyboard user with no idea where
       * they are.
       *
       * Measured, `probes/focus-visible.html`, and the rule is **modality**, not
       * focus. Three parts, none of which is "keyboard focus is visible and mouse
       * focus is not":
       *
       * 1. Focus arriving from the keyboard is visible. Every Tab arrival, no
       *    exceptions found.
       * 2. Focus arriving from a pointer is not — *unless the control takes text*.
       *    A clicked text field is visible focus; a clicked button, checkbox,
       *    radio, link and `tabindex` div are not. The distinction is "does typing
       *    go here", which the engine answers by whether a caret landed.
       * 3. A keystroke makes the currently focused node visible, retroactively and
       *    without focus moving. So this is re-evaluated per input, not decided
       *    once when focus arrives.
       *
       * Engine-owned like `HOVER` and `FOCUS`, and cheaper than either: one bool
       * beside the focused node, written in the two places input enters the engine.
       * It needs no per-node array because only one node can be focused.
       */
      FOCUS_VISIBLE: 1 << 6,

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
      /**
       * A control's own state changed. `node` is the control; `a` is its new
       * value, whose meaning is the control's kind:
       *
       * - **checkbox, radio** — 1 for checked, 0 for unchecked.
       * - **select** — the index of the chosen option within that select, or -1
       *   if it could not be resolved. Not the option's node id: an id is an
       *   implementation detail an author never sees, and the index is the
       *   position in the list they wrote.
       *
       * **The select's `CHANGE` names the select, not the option.** Measured —
       * `probes/select-picker.html` listens on the `<select>` and that is where
       * `input` and `change` arrive. It named the option until an `onChange`
       * handler existed to receive it, which is how a queue nobody drains stays
       * wrong quietly.
       *
       * Distinct from `CLICK` because the two are not the same event and the
       * difference is measured: clicking an already-checked radio fires `click`
       * and no `change`, and clicking a *label* fires `click` on the label as
       * well as on the control. A host wanting "the value changed" cannot get it
       * by counting clicks. The converse holds too — a `CLICK` on a picker's row
       * still names the row, because dziri has no bubbling and the node a click
       * names is the node that was clicked.
       */
      CHANGE: 10,
      /**
       * An element **took** focus. `node` is it; `a` is the node that lost focus,
       * or -1.
       *
       * Named `FOCUS_IN` only because `FOCUS` above is already the *window*'s. It
       * is the non-bubbling `focus`, not the bubbling `focusin` — measured, the
       * two fire in that order, so `focus` is the primitive and the one dziri
       * copies. dziri has no bubbling for the distinction to matter to.
       */
      FOCUS_IN: 11,
      /**
       * An element **lost** focus. `node` is it; `a` is the node that took focus,
       * or -1 when focus went nowhere.
       *
       * Always emitted **before** the matching `FOCUS_IN`, which is measured
       * rather than chosen: every event of the leaving element precedes every
       * event of the arriving one, so one ordered queue tells a coherent story.
       *
       * **`a` is why this carries a field at all.** During a real `blur`,
       * `document.activeElement` is `BODY` — focus has left the old element and
       * not yet reached the new one, and both events fall inside that window. So
       * neither event can name the other element by asking what is focused, and a
       * host that wants "who took my focus" can only be told. Measured, and it is
       * the finding that turned a comment into a column.
       *
       * Neither fires when focus does not actually move: re-pressing the focused
       * element produces nothing, which is what stops "validate on blur" running
       * on every click of the field it is already in.
       */
      FOCUS_OUT: 12,
    },
  },
  {
    name: "ControlKind",
    doc:
      "`controls.kind`. What a press does to this node, which is the only thing the " +
      "engine needs to know about a control — appearance is the stylesheet's job and " +
      "is already resolved into the style table. `CHECKBOX` toggles; `RADIO` sets " +
      "itself and clears its group, and cannot be unchecked by pointer (measured). " +
      "`SELECT` opens its picker on the press rather than the release, and `OPTION` " +
      "commits — which is the same set-self-clear-group `RADIO` does, plus closing.",
    ty: "u8",
    values: {
      NONE: 0,
      CHECKBOX: 1,
      RADIO: 2,
      /**
       * A `<select>`. A press **opens** it, on `mouse_down` and not on the click.
       *
       * That is the opposite of every other kind here and it is measured, not
       * assumed: `probes/select-picker.html` shows the press alone opening the
       * picker before any release, while a checkbox's bit flips during the click.
       * So the two cannot share a trigger point, and `Controls::activate` — which
       * runs on the release — deliberately declines this kind.
       */
      SELECT: 3,
      /**
       * An `<option>`. Committing one is a radio set: check it, clear its group.
       *
       * Which is why `controls.group` is filled for options exactly as it is for
       * radios, interned per `<select>` rather than per `(form, name)`. The extra
       * behaviour over `RADIO` is entirely about the picker — close it, restore
       * focus to the select, mirror the label — and none of that is checkedness.
       *
       * Unlike a radio, re-committing the already-selected option is not a change
       * either, so `Activation::changed` carries the same distinction.
       */
      OPTION: 4,
      /**
       * A `<button>`. Activating one changes no state — the `CLICK` event *is* the
       * activation — so it is here for the keyboard and for nothing else.
       *
       * Measured, `probes/keyboard-activation.html`: Enter activates a button on
       * **keydown** and Space on **keyup**, and both dispatch a real `click`. The
       * pointer path never needed this row, because a click is emitted on whatever
       * was hit whether or not it is a control. The keyboard has nothing equivalent
       * to "whatever was hit" — it has a focused node and a question about what a
       * key means there — and that question is answered by kind.
       *
       * Which is also why a plain `<div>` cannot be given a row and made
       * keyboard-operable: measured, neither key activates a focusable div, so
       * activation is a property of the kind and this table is where kinds live.
       */
      BUTTON: 5,
      /**
       * An `<a href>`. Enter activates it; **Space does not** — measured, and the
       * one asymmetry that makes a link a different kind from a button rather than
       * a synonym for one. (Space scrolls the page in a browser, which dziri does
       * not implement and should not fake.)
       *
       * A link with no `href` gets no row, matching the tab-stop set: it is not
       * focusable, so there is no state in which a key could reach it.
       */
      LINK: 6,
      /**
       * A `<select>` drawn as a **list** rather than a dropdown: `multiple`, or
       * `size` greater than one. Its options are in flow, so it has no picker.
       *
       * A separate kind from `SELECT` rather than a flag on it, because almost
       * nothing they do is shared. A `SELECT` opens an overlay on the press and
       * commits on a release *inside that overlay*; a `LISTBOX` has no overlay at
       * all, its options are hit by the ordinary tree walk, and — measured,
       * `probes/select-multiple.html` — its selection changes on the **release**.
       * Two elements wearing one tag, and the one thing they share is that
       * `<option>` means the same in both.
       *
       * Which of the two an author gets is `multiple || size > 1`, measured in
       * `probes/select-listbox.html`: `<select size="4">` with no `multiple` is a
       * list box, and keying this on `multiple` alone compiled a shape authors
       * really write into a dropdown.
       *
       * `ControlFlags.MULTIPLE` then says whether its selection is a *set*. It is
       * a flag rather than an eighth kind because it changes only what a modifier
       * does — the box, the hit path and the row height are identical either way.
       */
      LISTBOX: 7,
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
 *
 * v13 makes a control a control: `nodes.activates` and the `controls` table, which
 * together are what lets a press reach a checkbox and a radio clear its group. The
 * hash moves on its own — a new table and a new node field — and the bump is the
 * ordinary kind as well, twice: the nodes table grew, and `TABLE_COUNT` went from
 * 10 to 11, so `layout` and `strings` both shifted index.
 *
 * The `CHECKED` and `DISABLED` predicate bits reserved back in v9 are finally read
 * by something. They needed no protocol change to become live, which is what
 * reserving them was for.
 *
 * v15 adds `NodeFlags.PLACEHOLDER`, a box paint draws only while its field is empty.
 * Hand-bumped for the same reason v14 was — a flag bit moves no bytes, so `SCHEMA_HASH`
 * cannot see it, and an engine without the bit would paint every placeholder over the
 * user's own text.
 *
 * v14 adds `NodeFlags.EDITABLE`, so a field is one line high when it is empty.
 * **`SCHEMA_HASH` cannot see this**, exactly as it cannot see enum values: the flags
 * are a hand-written bitfield rather than a generated column, no table grew and no
 * offset moved. So the bump is by hand, for the same reason v10's was — an engine
 * built before this bit would read a field's flags without it and quietly go back to
 * collapsing every empty field, which is a wrong picture rather than a loud failure.
 *
 * v16 adds the six `ring*` style fields — `box-shadow` reduced to the concentric bands a
 * fixed style row can hold, which is what Tailwind's ring utilities compile to. An
 * ordinary bump: the styles table grew, so `SCHEMA_HASH` moves on its own and the
 * handshake would have caught it anyway.
 *
 * v17 adds `selectionBg` / `selectionFg` — `::selection`, as two inherited colours on the
 * originating element rather than a style row of its own, because a selection is a range
 * inside a node that already exists rather than a box. The styles table grew, so the hash
 * moves on its own.
 *
 * It also grows `Event` by one `i32`: `b` carries the caret and `c` now carries the
 * selection anchor, because splicing a range needs both ends and the host had only one
 * number. **`Event` is outside the generator** — its layout is written by hand in
 * `engine.rs` and again as byte offsets in `host.ts` — so `dziri_engine_event_size` was
 * added for `host.ts` to check its own constant against at open time. That check is the
 * point: the two had agreed on 56 bytes only because someone kept them in sync, which is
 * precisely the failure this file's header says the generator exists to prevent.
 *
 * v18 is the `<select>` picker, and it moves bytes in one place and semantics in three.
 *
 * The byte move is `controls.label`: a fifth column, so `SCHEMA_HASH` shifts on its own
 * and the handshake would catch a stale binary regardless. It is what lets the engine
 * repoint a `<selectedcontent>`'s string at the committed option's without writing into
 * host memory, which it must not do — Bun owns the tables.
 *
 * The three the hash cannot see, and which are therefore the whole reason this is also a
 * hand bump:
 *
 * - **`NodeFlags.OVERLAY`** (bit 5). A flag bit moves nothing, exactly as with v14's
 *   `EDITABLE` and v15's `PLACEHOLDER`. An engine without it would paint a picker in tree
 *   order — under whatever follows the select — and would hit-test its options through
 *   their select's box, which prunes them entirely. A dropdown that draws behind the page
 *   and cannot be clicked: a wrong picture with nothing to blame.
 * - **`Predicate.OPEN`** (bit 5 of a variant mask). Predicate bits are not columns either.
 *   An engine that never sets it leaves every picker hidden, because the UA sheet's
 *   visibility rule *is* that bit.
 * - **`ControlKind.SELECT` and `OPTION`**. Two new enum values, and the header above
 *   already says enum values are invisible to the hash — retuning what a code means needs
 *   a bump by hand. Here an old engine would fall through `Controls::activate`'s `_ => None`
 *   and simply do nothing on a press, which is the benign end of the range and still
 *   silent.
 *
 * v19 is ROADMAP A3's keyboard: **`NodeFlags.TAB_STOP`** (bit 6). A flag bit again, so it
 * moves nothing and the hash cannot see it — the third such bump, and the pattern is by now
 * the ordinary case rather than the exception.
 *
 * What it carries is the half of the focus model that is genuinely compile-time. The *set*
 * of nodes Tab can reach is a function of the markup: a `<button>`, an `<a>` with an `href`,
 * a form control, and nothing else. The *order* is not — it is document order in the live
 * tree, which a reorder changes — so the engine walks for it. Measured before it was
 * written, `probes/tab-order.html`, and the measurement is what forced the split: node ids
 * are strictly document order today, so a sorted table of tab stops would look right and
 * would be wrong for exactly the case A3's own bullet warns about.
 *
 * An engine without the bit finds no tab stops and Tab does nothing, which is the same
 * failure as having no keyboard at all — silent, but not a wrong picture.
 *
 * v20 is the other half of A3's keyboard: **`ControlKind.BUTTON` and `ControlKind.LINK`**.
 * Enum values, invisible to the hash, hand-bumped for the reason the header gives.
 *
 * Neither changes anything about the pointer, and that is the point worth recording. A
 * click is emitted on whatever was hit, control or not, so `<button>` never needed a row.
 * The keyboard has no "whatever was hit" — it has a focused node and a question about what
 * a key means there — and the measured answer differs per kind in a way that cannot be
 * derived from anything already in the tables: Enter activates a button and a link, Space
 * activates a button and *not* a link, and neither key activates a focusable `<div>`.
 *
 * An old engine sees two kinds it has no arm for, falls through `Controls::activate`'s
 * `_ => None`, and a keyboard activation does nothing — while the pointer keeps working,
 * because it never went through here.
 *
 * v21 is **`Predicate.FOCUS_VISIBLE`** (bit 6 of a variant mask). A predicate bit, so not
 * a column, so invisible to the hash — the same category as v18's `OPEN`.
 *
 * An engine that never sets it leaves every `:focus-visible` rule permanently unmatched,
 * which for the UA sheet's ring means no focus indicator at all. Silent, and the one
 * failure mode here that is an accessibility failure rather than a cosmetic one: a
 * keyboard user with no way to tell where they are.
 *
 * v22 **retunes what an existing field means**, which is the category this header says is
 * invisible to the hash and needs a hand bump: a `CHANGE` event for a `<select>` now names
 * the *select* and carries the chosen option's **index** in `a`, where it named the option
 * and carried a constant 1.
 *
 * No column moved and no enum value was added, so nothing would have caught it — and until
 * this version nothing would have *noticed* either, because the engine had queued `CHANGE`
 * since v13 and no host had ever drained it. A wrong event in a queue nobody reads is
 * indistinguishable from a right one, which is the argument for bumping on a meaning
 * change rather than only on a layout change.
 *
 * v23 adds **`EventKind.FOCUS_IN` and `FOCUS_OUT`**, the element focus pair. Two enum
 * values, invisible to the hash, hand-bumped.
 *
 * Until now dziri emitted no element focus event of any kind — `FOCUS` is the window's —
 * so an app could not validate a field on blur, save a draft when focus left, or show a
 * hint while a control had it. The focus *model* has been complete since v19 and none of
 * it was observable from outside the engine.
 *
 * An old engine emits neither and `onFocus`/`onBlur` never run: the same silent shape as
 * every other missing event, and the reason the pair arrives together with its handlers
 * rather than ahead of them.
 *
 * v24 adds **`NodeFlags.AUTOFOCUS`** (bit 7). A flag bit, invisible to the hash, hand-bumped
 * for the fourth time — see the bit's own comment for why `autofocus` travels as a per-node
 * flag when the compiler has already resolved it to a single id.
 *
 * It ships with a change to something the hash cannot see either, and this one is not a
 * flag: `InputState::focus_visible` now starts **true** rather than false. Measured
 * (`probes/focus-without-interaction.html`) — before any interaction Chromium treats focus
 * as visible, which is why an autofocused field opens wearing a ring. The two belong in one
 * version because separating them ships a feature whose whole visible behaviour is wrong:
 * `autofocus` with the old start value focuses silently and draws nothing.
 *
 * An old engine ignores the bit and nothing is focused at startup — the pre-v24 behaviour
 * exactly, so this is the one bump here whose failure mode is not a wrong picture but an
 * older correct one.
 *
 * v25 adds the **list box**: a `controls.rows` column, `ControlKind.LISTBOX` and
 * `ControlFlags.MULTIPLE`. This one the hash *does* see, because the column moves bytes —
 * the first of these bumps in a while that would have been caught had it been forgotten.
 *
 * A `<select multiple>` compiled to a dropdown before this, which was the wrong *shape*
 * rather than a missing feature: a closed button and an overlay, for an element whose
 * options are ordinary in-flow boxes. Measured in `probes/select-multiple.html` and
 * `probes/select-listbox.html`, and the second of those moved two things the first had
 * left to assumption — `size > 1` makes a list box with no `multiple` anywhere, and a list
 * box starts with **nothing** selected where a dropdown falls back to its first option.
 *
 * `rows` is a column rather than a compiled height because the height is not compilable.
 * Measured across a 4× font-size range, a list box's content height is `size` times the
 * option's own row height — a ratio, not the 17px constant it looks like at the default
 * font — and dziri's row height comes from Skia's ascent + descent + line gap at layout
 * time. So the row *count* crosses the boundary and the multiplication happens in
 * `layout.rs`, which is the one place that knows both numbers.
 *
 * An old engine sees `LISTBOX` as a kind it has no arm for: the box lays out with no
 * height of its own and presses on it do nothing. Not a wrong picture — an inert one —
 * but the column bump means it never gets that far.
 */
/*
 * v26 — `fontStyle` and `fontFamily` join the styles table: the two remaining
 * axes of font selection, both inherited, both reaching layout through the
 * measure callback like `fontSize`. `fontFamily` is a generic-family enum, not
 * a name — the engine resolves one concrete face per generic at startup.
 */
export const PROTOCOL_VERSION = 37;

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
  /**
   * A text run inside a field the user can edit, which is one line high **whether
   * or not it has any text**.
   *
   * Measured, 2026-08-04, `probes/text-field-box.html`: an `<input>`'s content box
   * is 15.0px at 13.3333px Arial when empty, with one character, and with forty —
   * content has no say at all, and a `contenteditable` div behaves the same way. A
   * plain block box does the opposite: `<div></div>` is 0 high.
   *
   * So the floor cannot live in `measure` for every empty string. dziri only ever
   * emits a text node with an empty string for a *dynamic* binding, so doing it
   * unconditionally would work by accident today and diverge the moment a
   * non-editable binding renders `""` — Chrome gives that 0 height, and a counter
   * reading empty would silently reserve a line. This bit is what separates the two
   * cases, and the compiler already knows which is which: it is the `editables`
   * table it has been emitting all along.
   *
   * Why the flag is on the text run rather than on the field: layout measures the
   * run, and the field's height is whatever its child reports. Putting it on the
   * parent would mean teaching layout to look at a child's parent mid-measure.
   */
  EDITABLE: 1 << 3,
  /**
   * A `::placeholder` box, painted **only while its field is empty**.
   *
   * The condition is why this is a flag rather than a variant. Every other
   * pseudo-element's visibility is a compile-time question, and `:hover`-style state is
   * a predicate bit the compiler can enumerate — but "does this field hold text" is the
   * emptiness of a value nobody declared, which is the same category as checkedness and
   * for the same reason lives on this side of the boundary.
   *
   * A predicate bit would also work and would let a stylesheet write
   * `:placeholder-shown`. It is not what this does, deliberately: a bit would make the
   * placeholder's *display* an authored decision, and an author who set
   * `display: block` on it would get a placeholder sitting behind their own text. Paint
   * owning the condition means the box cannot be shown at the wrong time.
   *
   * The box is laid out `position: absolute` by the UA sheet, so it costs no room and
   * overlays where the text will go — which is also what makes hiding it a pure paint
   * decision with nothing to re-lay-out.
   */
  PLACEHOLDER: 1 << 4,
  /**
   * The root of an overlay: painted **after** the whole tree, and hit-tested
   * **before** it.
   *
   * This is ROADMAP B1's layer, and it is a flag rather than a second tree
   * because the subtree is already in the right place. A `<select>`'s picker is a
   * child of the select, so it inherits, cascades and lays out with no special
   * case; the only thing wrong with painting it in tree order is the *order*. So
   * the main walk skips a flagged node and the painter revisits it at the end,
   * which is one branch per node and no stacking contexts to arithmetic over.
   *
   * Being out of the main walk is what makes the layer work at all, and both
   * halves are load-bearing:
   *
   * - **Paint.** A picker is drawn over whatever follows the select in document
   *   order, which in tree order it would be drawn under.
   * - **Hit-testing.** `hit_test` prunes a subtree whose parent's box does not
   *   contain the point, and a picker hangs *below* its select's box — so in the
   *   main walk its options are unreachable by the pointer. The overlay walk
   *   starts at the flagged node with no such ancestor test.
   *
   * The node is laid out either way, always, and is only *drawn* when the engine
   * says its overlay is showing — the same trick `PLACEHOLDER` uses, and for the
   * same reason: an absolutely positioned box that layout has already placed can
   * be shown and hidden as a pure paint decision, with nothing to invalidate.
   * That is what makes opening a picker cost zero relayout.
   */
  OVERLAY: 1 << 5,
  /**
   * Tab can reach this node.
   *
   * The compile-time half of ROADMAP A3's focus model, and the split is the point: the
   * **set** is a table, the **order** is a walk. A node is a tab stop because of what it
   * is — `<button>`, `<a href>`, a form control — which the compiler knows and no
   * reordering can change. Where it sits in the order is document order in the *live*
   * tree, which a reorder changes constantly, so the engine walks `firstChild`/
   * `nextSibling` for it rather than reading an index from here.
   *
   * Measured, `probes/tab-order.html`, and the measurement is why the set is not simply
   * "is it interactive":
   *
   * - **An `<a>` with no `href` is not focusable.** `INTERACTIVE` does not care, because
   *   hit-testing a link without a destination is still meaningful; Tab does.
   * - **A `<select>` is one tab stop, not two.** Its `<button>` is `INTERACTIVE` — it is
   *   what the pointer hits — and it is not a stop. So this bit cannot be derived from
   *   that one, in either direction.
   * - **An `<option>` is never a stop**, even though it is a control with a kind and a
   *   row of its own. A picker's list is arrowed, not tabbed.
   *
   * Three exclusions the compiler deliberately does *not* apply, because they are not
   * compile-time facts and the engine already has each of them:
   *
   * - `:disabled` — a live predicate bit, so the walk asks what the cascade asks.
   * - `display:none` and `visibility:hidden` — layout facts. The walk skips what paint
   *   skips, which costs nothing because both are already tested per node.
   * - Which member of a radio group holds the group's single stop — that is the *checked*
   *   one, which is live state by definition.
   *
   * **`tabindex` is supported and still needs only this bit**, which is worth recording
   * because this comment predicted otherwise. The prediction was that `tabindex="-1"`
   * separates focusable-by-pointer from reachable-by-Tab, so supporting it would need a
   * second bit for the difference. It does separate them — and the second set turned out
   * to be empty anyway, because a pointer press focuses whatever it hits without
   * consulting any flag. So "not a tab stop" is the whole meaning of `tabindex="-1"` here
   * and one bit says it. A positive `tabindex` does not reorder anything; see
   * [`tabIndexOf`] in `compile.ts` for why that is structural rather than unfinished.
   */
  TAB_STOP: 1 << 6,

  /**
   * This node asked for focus when the document first appears. `autofocus`.
   *
   * A flag rather than a scalar, and the reason it could not have been a scalar is the
   * interesting half. The compiler cannot resolve `autofocus` to one id: measured
   * (`probes/autofocus-hidden.html`), an unfocusable claim is walked past rather than
   * honoured, and in dziri thirteen of a page's fourteen routes are hidden on the first
   * frame — so several claims are the normal case and which one is showing is runtime
   * state. The engine walks the flagged nodes and takes the first that is visible.
   *
   * Even for a single claim a flag is the right channel, because **the alternatives all
   * run through one host.** The engine config is built in `host/main.ts` and
   * `window-host.ts` builds its own, so a config field wired through the first would
   * silently never fire under the screenshot host — a failure this repo has already had
   * once. On the node table it arrives the same way for both, because neither is involved.
   *
   * Applied **once per document**, latched in the engine. Measured
   * (`probes/focus-without-interaction.html`, 2026-08-07): inserting an element carrying
   * `autofocus` after load moves nothing in Chromium. So this is a startup event, not a
   * property re-checked whenever a node appears — which matters here more than in a
   * browser, because Bun republishes these tables on every signal change and an unlatched
   * flag would drag the caret back to the autofocused field each time a counter ticked.
   *
   * The same measurement settled what it looks like: focus arriving from `autofocus`
   * matches `:focus-visible`, and *not* by special-casing — programmatic focus inherits
   * the ambient modality bit, and that bit starts set. See `InputState::focus_visible`.
   */
  AUTOFOCUS: 1 << 7,
} as const;

/**
 * `controls.flags` — the state a control was **authored** in, not the state it is in.
 *
 * The distinction is the whole design, so it is worth being explicit about which
 * side owns what. The compiler owns this table and never changes it. The engine
 * owns the live checkedness in a dense array it builds on rescan, seeded from
 * `CHECKED` here the first time it sees a row, and after that the user owns it.
 *
 * That seeding-once rule is not an optimisation, it is the correctness condition:
 * Bun republishes the tables whenever any signal changes, and a rescan that reset
 * from this table would silently un-tick a box the moment an unrelated counter
 * incremented.
 *
 * `DISABLED` is different and is re-read from here on every rescan, because it is
 * genuinely compile-time: it comes from the `disabled` attribute and the user
 * cannot change it. A control that needs to become enabled at run time is a
 * conditional class today, and a live bit when something needs it.
 */
export const ControlFlags = {
  CHECKED: 1 << 0,
  DISABLED: 1 << 1,
  /**
   * On a `LISTBOX`: its selection is a **set**, because the author wrote
   * `multiple`.
   *
   * Compile-time in the same sense `DISABLED` is — it comes from an attribute the
   * user cannot change — so it rides in this table rather than in the engine's live
   * state, and `Controls::rescan` re-reads it for the same reason.
   *
   * It is deliberately *not* what decides whether a select is drawn as a list; that
   * is `ControlKind.LISTBOX`, and it is also true for `<select size="4">` with no
   * `multiple`. Measured, `probes/select-listbox.html`: the two questions have
   * different answers for a shape authors really write, and one bit answering both
   * would have compiled that shape to a dropdown.
   *
   * It also changes what `CHECKED` means at rest on the options below it. A
   * dropdown falls back to selecting its first option when none says `selected`; a
   * listbox — with or without `multiple` — selects **nothing**. Same measurement.
   */
  MULTIPLE: 1 << 2,
} as const;
