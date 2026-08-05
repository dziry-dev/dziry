//! Laid-out nodes into Skia draw calls.
//!
//! Started as a direct port of `src/runtime/paint.ts`, kept faithful so the
//! migration was comparable frame to frame: same fill-then-border-then-text
//! order, same button label centring, same baseline arithmetic.
//!
//! The border no longer matches it. The prototype's inset stroke gets the corners
//! wrong — see `Painter::node` — and reproducing a known-wrong geometry is worth
//! less than a correct one now that Taffy reserves the border in the box.
//!
//! Interaction state costs one integer comparison per node. The compiler already
//! decided what a hovered or pressed node looks like, so there is nothing to
//! resolve here beyond picking an index.

use skia_safe::textlayout::TextAlign;
use skia_safe::{Canvas, Color, Matrix, Paint, PaintStyle, Point, RRect, Rect};

use crate::anim::{Anims, Blend};
use crate::caret::{boundary_at, Carets, Motion};
use crate::controls::{Activation, Controls};
use crate::protocol::{self, control_flags, display, node_kind, predicate};
use crate::tables::Tables;
use crate::text::Measurer;

const NODES: usize = protocol::Table::Nodes as usize;
const STYLES: usize = protocol::Table::Styles as usize;
const VARIANTS: usize = protocol::Table::Variants as usize;
const VARIANT_SLOTS: usize = protocol::Table::VariantSlots as usize;

/// The `display` of one resolved style slot.
///
/// Defaults to `FLEX` for an out-of-range slot rather than `NONE`, so a bad index
/// keeps drawing. Failing open matters here: the alternative is a blank window
/// with nothing to blame.
fn display_of(tables: &Tables, slot: usize) -> u8 {
    tables
        .u8s(STYLES, protocol::styles::DISPLAY)
        .get(slot)
        .copied()
        .unwrap_or(display::FLEX)
}

/// The `EDITABLE` text run inside `field`, or `None` if it has none.
///
/// Every text-entry field owns one — the compiler emits an empty run even for an unbound
/// `<input>` — so `None` means the node is not a field at all, which is what a press on
/// anything else looks like.
pub fn editable_run_of(tables: &Tables, field: i32, count: usize) -> Option<usize> {
    if field < 0 || field as usize >= count {
        return None;
    }
    let flags = tables.u8s(NODES, protocol::nodes::FLAGS);
    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

    let mut child = first[field as usize];
    let mut seen = 0;
    while child >= 0 && (child as usize) < count && seen <= count {
        let c = child as usize;
        // A placeholder is `GENERATED` and a value run is not, which is what keeps this
        // from returning the placeholder — it carries no `EDITABLE` bit either, but being
        // explicit costs nothing and the two boxes are otherwise alike.
        if flags[c] & protocol::flags::EDITABLE != 0 && flags[c] & protocol::flags::GENERATED == 0 {
            return Some(c);
        }
        child = next[c];
        seen += 1;
    }
    None
}

/// Whether the field a `::placeholder` belongs to currently holds any text.
///
/// The placeholder's parent is the field, and the field's value is in whichever child
/// carries `EDITABLE` — the generated text run. So this is a walk of the placeholder's
/// own siblings, which is at most a handful and runs only for placeholder nodes.
///
/// **False for a field with no run at all**, which is an *unbound* `<input>`: nothing
/// owns its value yet, so it is permanently empty and its placeholder permanently shows.
/// That is the honest rendering of the current state rather than a special case — when an
/// engine-owned text buffer lands, the buffer becomes the thing this asks, and every
/// unbound field starts behaving like a bound one with no further change here.
fn field_has_text(
    tables: &Tables,
    first: &[i32],
    next: &[i32],
    flags: &[u8],
    text: &[i32],
    count: usize,
    placeholder: usize,
) -> bool {
    let parent = match tables
        .i32s(NODES, protocol::nodes::PARENT)
        .get(placeholder)
        .copied()
    {
        Some(p) if p >= 0 && (p as usize) < count => p as usize,
        _ => return false,
    };

    let mut child = first.get(parent).copied().unwrap_or(-1);
    // Bounded by the sibling count, and by `count` besides: a malformed chain must not
    // spin the render thread.
    let mut seen = 0;
    while child >= 0 && (child as usize) < count && seen <= count {
        let c = child as usize;
        if flags.get(c).copied().unwrap_or(0) & protocol::flags::EDITABLE != 0 {
            let slot = text.get(c).copied().unwrap_or(-1);
            if !tables.string(slot).is_empty() {
                return true;
            }
        }
        child = next.get(c).copied().unwrap_or(-1);
        seen += 1;
    }
    false
}

/// How thick a scrollbar thumb is, in CSS pixels.
///
/// dziri's scrollbars are **overlay**: drawn over the content, reserving no layout
/// room, which is why `style_of` leaves Taffy's `scrollbar_width` at 0. That is a
/// measured decision rather than a missing feature. Chromium 151 reserves a 15 px
/// gutter for a scrollbar — but only when the content overflows, if the keyword was
/// `auto`, and unconditionally if it was `scroll`. The compiler collapses those two
/// keywords into one wire value, and Taffy's `scrollbar_width` is a static style
/// input, so no single number is right for both: 15 would inset every
/// `overflow-y-auto` box permanently, and that is the common Tailwind case. Chromium
/// gets the conditional answer by laying out twice. See BROWSER-FACTS.md, "What a
/// scrollbar costs in layout room".
///
/// 8 is narrower than either of Chromium's gutters (15, or 10 for
/// `scrollbar-width: thin`) because an overlay bar covers content instead of
/// displacing it, so its cost is what it hides.
const THUMB_THICKNESS: f32 = 8.0;

/// `scrollbar-width: thin`, against dziri's own default rather than a native gutter.
///
/// Chromium's `thin` is 10 of its 15 (measured), and 5 of 8 is the same ratio — the
/// property asks for "thinner than the platform default", and 8 *is* this platform's
/// default. Copying Chromium's 10 would be wider than dziri's `auto`, which is the one
/// answer that is definitely wrong.
const THUMB_THICKNESS_THIN: f32 = 5.0;

/// How much a thumb grows once the pointer is on it, or dragging it.
///
/// Overlay bars are deliberately unobtrusive, which makes them hard to *aim* at. The
/// answer every overlay implementation reaches is the same: stay thin until the pointer
/// is there, then become a control. The grab region is wider still — see [`Bar::hot`] —
/// so this is about looking grabbable rather than being grabbable.
///
/// A ratio rather than a second constant, so `scrollbar-width: thin` grows too instead
/// of jumping to the same width as `auto` the moment it is hovered.
const THUMB_GROWTH: f32 = 1.375;

/// The gap between a thumb and the padding-box edge it runs along.
const THUMB_INSET: f32 = 2.0;

/// How wide a strip along the edge counts as "on the scrollbar" for input.
///
/// Wider than the thumb is drawn, and that asymmetry is the point: an 8 px target is
/// a miss most of the time, and a bar that has to be hit exactly is worse than no bar.
/// 16 is Chromium's classic gutter (15, measured) rounded up — the width a user who has
/// ever used a scrollbar expects to be able to aim at.
///
/// The visual and the hot region are computed together in [`Painter::bars_of`] and
/// never separately, because a bar you can see in one place and grab in another is the
/// specific bug this shape exists to prevent.
const BAR_HOT_WIDTH: f32 = 16.0;

/// The shortest a thumb may get, so a very long document still leaves something
/// grabbable and visible rather than a sub-pixel tick.
const THUMB_MIN: f32 = 24.0;

/// Alpha the container's text colour is drawn at, out of 255.
///
/// Translucent for one reason: an overlay bar sits on top of content, so anything it
/// covers has to stay legible through it.
const THUMB_ALPHA: u8 = 90;

/// The same, with the pointer on the bar. Still translucent — it is still over content.
const THUMB_ALPHA_HOVER: u8 = 150;

/// And while it is being dragged, where the user's attention already is.
const THUMB_ALPHA_HELD: u8 = 200;

/// Where a thumb sits along a `track`-long bar, as `(start, length)`.
///
/// `viewport` and `viewport + extent` are how much is shown and how much there is, and
/// their ratio is the length — the same proportion the user reads as "this is a third
/// of the document". The start is that of the *remaining* travel, so a thumb reaches
/// the far end exactly when the scroll does, which is the property that makes a bar
/// trustworthy at the bottom of a list.
///
/// `None` when the track cannot hold a bar at all, which is a real case rather than a
/// defensive one: a box only a little larger than one thumb has a *negative* track once
/// the other axis's thumb has taken its corner. Answering that with an inverted rect
/// and trusting Skia to discard it would work, and would also be a lie about geometry.
fn thumb(track: f32, viewport: f32, extent: f32, offset: f32) -> Option<(f32, f32)> {
    // Finiteness first: NaN fails every comparison, so `track <= 0.0` alone would let
    // it through rather than reject it.
    if !track.is_finite() || track <= 0.0 {
        return None;
    }
    // `min(track)` on the floor as well: `clamp` panics if its bounds cross, and a box
    // shorter than `THUMB_MIN` is not a reason to stop drawing.
    let length = (track * viewport / (viewport + extent)).clamp(THUMB_MIN.min(track), track);
    let progress = if extent > 0.0 {
        (offset / extent).clamp(0.0, 1.0)
    } else {
        0.0
    };
    Some(((track - length) * progress, length))
}

/// What colour to fill a thumb with, honouring `scrollbar-color` if it was set.
///
/// Two sources, and the author's wins outright. An authored colour is used as written,
/// including its alpha — someone who says `scrollbar-color: red orange` means opaque red
/// and would not thank us for 35% of it. Only the *unauthored* case reaches for the
/// container's foreground at a phase alpha, because only then is there a colour to
/// invent, and the foreground is the one colour a box already contrasts against its own
/// background — so an overlay bar reads correctly in a dark theme with no second colour
/// to keep in sync.
///
/// A hover still has to show through an authored colour, so the phase applies as a
/// *lightening of the alpha floor* rather than a replacement: an opaque thumb stays
/// opaque, a semi-transparent one firms up.
fn thumb_paint(authored: u32, tables: &Tables, blend: &Blend, phase: BarPhase) -> u32 {
    if authored >> 24 != 0 {
        let alpha = (authored >> 24).max(u32::from(phase.alpha()));
        return (authored & 0x00ff_ffff) | (alpha.min(255) << 24);
    }

    let fg = blend.u32(tables, protocol::styles::FG);
    // The alpha is *replaced* rather than scaled: a bar over transparent text still has
    // to be visible.
    (fg & 0x00ff_ffff) | (u32::from(phase.alpha()) << 24)
}

/// One scrollbar: what is drawn, what can be grabbed, and what it maps onto.
///
/// Produced once by [`Painter::bars_of`] and used by both the paint walk and the input
/// path, which is the whole reason it is a type. The alternative — paint computing a
/// rect and input computing the same rect again — is a bar that drifts from its own hit
/// region as soon as either side is edited.
///
/// Rects are in the container's own unscrolled layout space, the space the paint walk is
/// in when it draws them. Input converts *the pointer* into that space rather than
/// converting these, so there is one direction of travel and no rect exists in two
/// forms.
#[derive(Clone, Copy, Debug)]
pub struct Bar {
    pub node: usize,
    pub vertical: bool,
    /// The corridor the thumb travels in — the part of the bar that means anything.
    pub track: Rect,
    /// The thumb, as drawn.
    pub thumb: Rect,
    /// The track widened across its short axis to something a pointer can hit.
    pub hot: Rect,
    /// How far the content can scroll on this axis.
    pub extent: f32,
    /// How much of it is visible — one page, for a click in the track.
    pub viewport: f32,
}

impl Bar {
    /// The pointer coordinate that matters, along the axis this bar runs.
    pub fn along(&self, px: f32, py: f32) -> f32 {
        if self.vertical {
            py
        } else {
            px
        }
    }

    /// Where the track starts and how long it is, along that same axis.
    pub fn span(&self) -> (f32, f32) {
        if self.vertical {
            (self.track.top, self.track.height())
        } else {
            (self.track.left, self.track.width())
        }
    }

    /// Where the thumb starts and how long it is.
    pub fn thumb_span(&self) -> (f32, f32) {
        if self.vertical {
            (self.thumb.top, self.thumb.height())
        } else {
            (self.thumb.left, self.thumb.width())
        }
    }

    /// Whether the point is on the thumb rather than merely on the bar.
    ///
    /// Across the bar this asks about [`Bar::hot`], not the thumb's drawn width: a
    /// press 6 px to the side of a thin thumb is aimed at the thumb, and treating it as
    /// a track click would page the content away from where the user was pointing.
    pub fn on_thumb(&self, px: f32, py: f32) -> bool {
        let (start, len) = self.thumb_span();
        let at = self.along(px, py);
        at >= start && at < start + len
    }

    /// The scroll offset that puts the thumb's start at `at`, clamped to the extent.
    ///
    /// The inverse of [`thumb`], and it has to divide by the same travel: dividing by
    /// the track's whole length instead is the classic scrollbar bug where the content
    /// lags the cursor and can never quite reach the end.
    pub fn offset_at(&self, at: f32) -> f32 {
        let (start, track_len) = self.span();
        let (_, thumb_len) = self.thumb_span();
        let travel = track_len - thumb_len;
        if travel <= 0.0 {
            return 0.0;
        }
        (((at - start) / travel) * self.extent).clamp(0.0, self.extent)
    }
}

/// Gathers the bits of `value` that are set in `mask` down to a dense index.
///
/// A run holds one entry per *combination* of the predicates a node reads, so a
/// node reading bits 0 and 8 needs four entries rather than 257. This is the
/// `pext` instruction in software: walk the mask's set bits low to high, and for
/// each one shift the corresponding bit of `value` into the next output position.
///
/// Masks are tiny — three bits today, a handful after A1 — so the loop runs a few
/// times per interacting node, and only for nodes that are actually interacting.
fn compact(value: u32, mask: u32) -> u32 {
    let mut out = 0u32;
    let mut bit = 0;
    let mut remaining = mask;

    while remaining != 0 {
        let lowest = remaining & remaining.wrapping_neg();
        if value & lowest != 0 {
            out |= 1 << bit;
        }
        bit += 1;
        remaining &= remaining - 1;
    }

    out
}

/// Where the tree is, and how far each box's content has been scrolled.
///
/// One argument because they are one idea: a node's rect on screen is its layout rect
/// minus what its ancestors have scrolled, and every walk in this file — paint,
/// hit-test, scroll targeting — needs both halves or neither. Threading them
/// separately is how they get out of step.
#[derive(Clone, Copy)]
pub struct Geometry<'a> {
    /// Absolute layout rects, unscrolled. What the host reads.
    pub bounds: &'a [[f32; 4]],
    /// Per node, `[x, y]` of its own content offset, both >= 0.
    pub scroll: &'a [[f32; 2]],
    /// Per node, how far that offset may go, per axis. Straight from Taffy.
    ///
    /// Here rather than only in the layout tree because a scrollbar's thumb is the
    /// ratio between what is visible and what there is, and the extent is the half of
    /// that the box's own rect cannot supply.
    pub extent: &'a [[f32; 2]],
}

impl Geometry<'_> {
    fn scroll_of(&self, node: usize) -> [f32; 2] {
        self.scroll.get(node).copied().unwrap_or([0.0, 0.0])
    }

    fn extent_of(&self, node: usize) -> [f32; 2] {
        self.extent.get(node).copied().unwrap_or([0.0, 0.0])
    }
}

/// One entry on the paint walk's stack.
///
/// A plain node index was enough until clipping: a clip has to be *undone* when the
/// subtree that opened it finishes, and an explicit stack has no natural "after the
/// children" moment. This is that moment, made a value.
enum Step {
    /// A node, plus the scroll its ancestors have applied — needed so the viewport
    /// reject can compare a window-coordinate rect against a window-coordinate clip.
    ///
    /// The `bool` is whether any ancestor has applied a transform. It rides down the
    /// walk because the viewport reject is only meaningful in the space `viewport`
    /// was read in, and a concat leaves that space for the whole subtree — not just
    /// for the node that opened it.
    Node(usize, f32, f32, bool),
    /// Pop the clip this node opened, then draw its scrollbars.
    ///
    /// The node index rides along because the bars must be drawn *after* the restore:
    /// they belong to the container, not to its content, so they must not be moved by
    /// the scroll translate the restore undoes — and they must be drawn after the
    /// content so they sit on top of it.
    Restore(usize),
    /// Pop a transform or opacity layer. No node index, because unlike `Restore`
    /// there is nothing to draw afterwards — the save it undoes was opened *before*
    /// the node drew itself, so that the node and its subtree share one matrix.
    Pop,
}

/// A node's `transform`, composed, or `None` when it is the identity.
///
/// Composed here rather than in the compiler because two of its inputs are the
/// laid-out box: a percentage `translate` is relative to the node's own border
/// box, and so is `transform-origin` — whose *initial* value is `50% 50%`, which
/// is why even a node that never mentions the property needs its size. Measured
/// on Chromium 151; see BROWSER-FACTS.md.
///
/// The order is translate, rotate, skewX, skewY, scale, and it is the only order
/// decomposed storage can express — the compiler refuses a list that needs
/// another. Mirrors `composed()` in `css.test.ts`, which pins this exact sequence
/// against the matrices Chromium produced.
/// The style columns the per-node transform and opacity reads need, resolved once.
///
/// `Tables::f32s` looks like a field access and is not: it resolves a span plan
/// through two dependent loads, matches on which arena the span lives in,
/// bounds-checks a byte range and casts it to a slice. Cheap once per frame; ten
/// times per node it was most of what paint cost. Deciding that a node has *no*
/// transform — the answer for very nearly every node — took nine of those resolutions
/// before this existed, and `paint` was already hoisting the node table's columns the
/// same way twenty lines above where it wasn't hoisting these.
///
/// Measured at 8000 nodes: paint 0.729 -> 0.560 ms/frame, and 0.195 -> 0.166 at 1000.
/// Worth being exact that this is a quarter of the cost and not all of it — paint is
/// still ~76% above the recorded baseline at 8000 nodes, so something else in the
/// commits since it is spending the rest.
struct StyleCols<'a> {
    opacity: &'a [f32],
    translate_x: &'a [f32],
    translate_y: &'a [f32],
    translate_pct_x: &'a [f32],
    translate_pct_y: &'a [f32],
    rotate: &'a [f32],
    scale_x: &'a [f32],
    scale_y: &'a [f32],
    skew_x: &'a [f32],
    skew_y: &'a [f32],
    origin_pct_x: &'a [f32],
    origin_pct_y: &'a [f32],
    origin_x: &'a [f32],
    origin_y: &'a [f32],
}

impl<'a> StyleCols<'a> {
    fn of(tables: &'a Tables) -> Self {
        use protocol::styles as f;
        let c = |field: usize| tables.f32s(STYLES, field);
        Self {
            opacity: c(f::OPACITY),
            translate_x: c(f::TRANSLATE_X),
            translate_y: c(f::TRANSLATE_Y),
            translate_pct_x: c(f::TRANSLATE_PERCENT_X),
            translate_pct_y: c(f::TRANSLATE_PERCENT_Y),
            rotate: c(f::ROTATE),
            scale_x: c(f::SCALE_X),
            scale_y: c(f::SCALE_Y),
            skew_x: c(f::SKEW_X),
            skew_y: c(f::SKEW_Y),
            origin_pct_x: c(f::TRANSFORM_ORIGIN_PERCENT_X),
            origin_pct_y: c(f::TRANSFORM_ORIGIN_PERCENT_Y),
            origin_x: c(f::TRANSFORM_ORIGIN_X),
            origin_y: c(f::TRANSFORM_ORIGIN_Y),
        }
    }
}

fn transform_of(cols: &StyleCols, blend: &Blend, bounds: [f32; 4]) -> Option<Matrix> {
    use protocol::styles as f;
    // Every one of the fourteen fields goes through the blend, which is what makes a
    // transform transition work at all: the whole point of storing it decomposed is
    // that the *scalars* interpolate. `rotate(0)` and `rotate(360deg)` have identical
    // matrices, so composing first and interpolating after could not move.
    //
    // The field index is still passed alongside the column because the blend needs it
    // to answer whether *this* field is one the mask moves.
    let g = |column: &[f32], field: usize, dflt: f32| -> f32 { blend.f32_at(column, field, dflt) };

    let (tx, ty) = (
        g(cols.translate_x, f::TRANSLATE_X, 0.0),
        g(cols.translate_y, f::TRANSLATE_Y, 0.0),
    );
    let (px, py) = (
        g(cols.translate_pct_x, f::TRANSLATE_PERCENT_X, 0.0),
        g(cols.translate_pct_y, f::TRANSLATE_PERCENT_Y, 0.0),
    );
    let rotate = g(cols.rotate, f::ROTATE, 0.0);
    let (sx, sy) = (
        g(cols.scale_x, f::SCALE_X, 1.0),
        g(cols.scale_y, f::SCALE_Y, 1.0),
    );
    let (kx, ky) = (
        g(cols.skew_x, f::SKEW_X, 0.0),
        g(cols.skew_y, f::SKEW_Y, 0.0),
    );

    // The early-out that keeps this free for the overwhelming majority of nodes.
    // Checked before the origin is read, because the origin is meaningless — and
    // its default non-zero — when there is nothing to transform about it.
    if tx == 0.0
        && ty == 0.0
        && px == 0.0
        && py == 0.0
        && rotate == 0.0
        && sx == 1.0
        && sy == 1.0
        && kx == 0.0
        && ky == 0.0
    {
        return None;
    }

    let [x, y, w, h] = bounds;

    // Percentages resolve against this node's own border box, then add to the px
    // half. Two fields rather than one precisely so this addition can happen here,
    // where the width is known, instead of being guessed at compile time.
    let tx = tx + px * w;
    let ty = ty + py * h;

    // The origin is relative to the box, so it has to be offset by where the box
    // actually is: the matrix is composed in the same space the node is painted
    // in, which is layout coordinates rather than node-local ones.
    let ox = x
        + g(cols.origin_pct_x, f::TRANSFORM_ORIGIN_PERCENT_X, 0.5) * w
        + g(cols.origin_x, f::TRANSFORM_ORIGIN_X, 0.0);
    let oy = y
        + g(cols.origin_pct_y, f::TRANSFORM_ORIGIN_PERCENT_Y, 0.5) * h
        + g(cols.origin_y, f::TRANSFORM_ORIGIN_Y, 0.0);

    // Move the origin to zero, apply, move it back — which is what makes
    // `transform-origin` mean anything at all.
    let mut m = Matrix::translate((ox, oy));
    m = m * Matrix::translate((tx, ty));

    if rotate != 0.0 {
        // Degrees, and deliberately not wrapped: the compiler keeps the winding
        // because 360 and 0 are the same matrix but not the same animation.
        m = m * Matrix::rotate_deg(rotate);
    }
    // Two multiplications, not one `Matrix::skew((kx, ky))`. Skia's two-argument
    // skew builds `[1 kx; ky 1]` in one step, but CSS `skewX(a) skewY(b)` is the
    // *product* of two functions, whose m00 is `1 + tan(a)tan(b)` rather than 1.
    // Measured: Chromium gives `matrix(1.01543, …)` for `skewX(10deg) skewY(5deg)`
    // and the combined form gives 1. Caught by the test below, having passed on
    // the TypeScript side where the composition was already two steps.
    if kx != 0.0 {
        m = m * Matrix::skew((kx.to_radians().tan(), 0.0));
    }
    if ky != 0.0 {
        m = m * Matrix::skew((0.0, ky.to_radians().tan()));
    }
    if sx != 1.0 || sy != 1.0 {
        m = m * Matrix::scale((sx, sy));
    }

    m = m * Matrix::translate((-ox, -oy));
    Some(m)
}

/// A node's `opacity`, or `None` when it is fully opaque.
///
/// `None` is the case worth optimising: opacity is a *group* property — the node
/// and its subtree composite as one, so overlapping children do not show through
/// each other — and the only way to get that is a layer, which is expensive
/// enough that it must not be paid by every node that never asked for it.
fn opacity_of(cols: &StyleCols, blend: &Blend) -> Option<f32> {
    let a = blend.f32_at(cols.opacity, protocol::styles::OPACITY, 1.0);
    // NaN fails every comparison, so a nonsense value falls through to opaque
    // rather than making the subtree invisible.
    if a >= 1.0 || a.is_nan() {
        None
    } else {
        Some(a.max(0.0))
    }
}

/// Which scrollbar the pointer is on, and whether it is being held.
///
/// Not a node index, and deliberately outside predicate resolution: a scrollbar is
/// painted furniture the compiler has never heard of, so it cannot be `:hover`ed in
/// the sense the variant machinery means. It only changes how the bar itself is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BarHover {
    pub node: usize,
    /// Which of the container's two bars.
    pub vertical: bool,
    /// Held, rather than merely under the pointer.
    pub held: bool,
}

/// Which node is under the cursor, pressed, and focused.
///
/// The engine owns this now, rather than Bun: it owns the event loop, so it can
/// repaint a hover without a round trip. Bun learns about it from the event
/// queue.
#[derive(Clone, Copy, Debug, Default)]
pub struct InputState {
    pub hovered: i32,
    pub pressed: i32,
    pub focused: i32,
    /// The scrollbar under the pointer, if the pointer is on one at all.
    pub bar: Option<BarHover>,
}

impl InputState {
    pub fn none() -> Self {
        Self {
            hovered: -1,
            pressed: -1,
            focused: -1,
            bar: None,
        }
    }

    /// The hover state of `node`'s bar on one axis: held, hovered, or neither.
    fn bar_state(&self, node: usize, vertical: bool) -> BarPhase {
        match self.bar {
            Some(bar) if bar.node == node && bar.vertical == vertical => {
                if bar.held {
                    BarPhase::Held
                } else {
                    BarPhase::Hovered
                }
            }
            _ => BarPhase::Idle,
        }
    }
}

/// How prominent a bar is right now.
///
/// A bar under the pointer thickens and darkens, and one being dragged more so. Both
/// are the same idea — the bar becomes a control while you are using it, and gets out
/// of the way when you are not — so they are one axis with three stops rather than two
/// independent flags.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BarPhase {
    Idle,
    Hovered,
    Held,
}

impl BarPhase {
    /// How thick a bar of this `scrollbar-width` is in this phase.
    ///
    /// `thin` scales the growth as well as the resting size, so a thin bar still comes to
    /// meet the pointer — just proportionately. `none` never gets here: it has no bar at
    /// all, which is decided in `bars_of` because it must suppress the hit region too.
    fn thickness(self, width: u8) -> f32 {
        let base = match width {
            protocol::scrollbar_width::THIN => THUMB_THICKNESS_THIN,
            // `AUTO` and anything unrecognised: the platform default, which here is
            // dziri's own overlay thickness rather than a native gutter width.
            _ => THUMB_THICKNESS,
        };
        match self {
            BarPhase::Idle => base,
            // Both grown states are the same width: a thumb that changed size at the
            // moment you pressed it would move under the cursor mid-grab.
            BarPhase::Hovered | BarPhase::Held => base * THUMB_GROWTH,
        }
    }

    fn alpha(self) -> u8 {
        match self {
            BarPhase::Idle => THUMB_ALPHA,
            BarPhase::Hovered => THUMB_ALPHA_HOVER,
            BarPhase::Held => THUMB_ALPHA_HELD,
        }
    }
}

/// Everything the predicate resolution needs that is not per node.
///
/// One struct because it is one lifetime — all of it is recomputed at the top of a
/// frame and read by every node during it — and because `resolve_slot` needs all of it
/// while `advance_animations` holds `&mut` on the tween state beside it.
#[derive(Default)]
pub struct FrameState {
    /// Predicate bits that hold for every node this frame.
    ///
    /// Media queries and colour scheme land here. They are the engine's to evaluate,
    /// not the host's: the engine owns the window, so it re-evaluates them between a
    /// resize and the relayout, and a resize repaints correctly even while Bun is busy.
    globals: u32,
    /// The hovered node **and every ancestor of it**, deepest first.
    ///
    /// A chain rather than the single id it used to be, because that is what CSS
    /// matches — measured, `probes/hover-propagation.html`: pointing at a button three
    /// levels deep matches `html body card mid btn`, every one of them. The exact
    /// comparison it replaced could only ever light one node, so a hoverable card
    /// containing a button went dark the moment the pointer reached the button. Worse,
    /// it went dark *silently*: the compiler emitted the card's HOVER variant correctly
    /// and nothing could ever select it.
    ///
    /// It is the **tree** chain, not geometric containment — also measured: a child
    /// positioned entirely outside its parent's box still matches the parent. So
    /// `nodes.parent` is the whole input and no rect is involved.
    ///
    /// Every ancestor that *cares* is already `INTERACTIVE`, which is what makes this
    /// complete rather than half a fix: `buildInteractive` marks a node interactive when
    /// its variant mask is non-zero, so a card with a `hover:` rule is interactive, and
    /// `hit_test` returns it when the pointer is over its own padding. The chain covers
    /// the other direction — the pointer over a descendant.
    hover: Vec<i32>,
    /// The pressed node and its ancestors, same rule.
    ///
    /// Measured to be the *identical* set to `:hover`'s while a button is held — so
    /// this was one rule applied twice, until labels turned out to be the exception.
    /// See `set_input`.
    active: Vec<i32>,
}

impl FrameState {
    /// Rebuilds both chains from the current input state.
    ///
    /// Once per frame rather than per node: a membership test against a chain of tree
    /// depth is a few compares on one cache line, and the empty case — nothing hovered,
    /// which is most frames — is a length check.
    ///
    /// # The two chains differ, and only over labels
    ///
    /// A `<label>` drags its control into both chains, and *from where* is not the same
    /// for the two. Measured, `probes/control-activation.html`:
    ///
    /// - `:hover` reaches the control when the label **is the hovered node**, and not
    ///   when the hovered node is a descendant of the label. Pointing at the label's
    ///   own padding matched the checkbox; pointing at a `<span>` inside the same label
    ///   did not.
    /// - `:active` reaches it from **any** label in the chain, descendant or not.
    ///
    /// Which is why the hover side asks `activates` of one node and the press side asks
    /// it of every node it walks. Neither is guessable, and one of them looks like a
    /// Chromium implementation artifact rather than a spec requirement — but both are
    /// what Chromium does, so both are what this does.
    pub fn set_input(&mut self, tables: &Tables, state: &InputState) {
        walk_ancestors(tables, state.hovered, &mut self.hover);
        push_activated(tables, state.hovered, &mut self.hover);

        walk_ancestors(tables, state.pressed, &mut self.active);
        // Cloned bounds first: the loop reads what `walk_ancestors` wrote while pushing
        // onto the same vector, and a control's own row must not then be re-examined.
        for i in 0..self.active.len() {
            push_activated(tables, self.active[i], &mut self.active);
        }
    }
}

/// Adds the control `node` operates to `out`, if it is not already there.
///
/// The dedup is not tidiness: a control's `activates` points at *itself*, so without
/// it every hovered control would appear twice, and the pressed chain would grow by
/// one entry per label per frame.
fn push_activated(tables: &Tables, node: i32, out: &mut Vec<i32>) {
    if node < 0 {
        return;
    }
    let target = tables
        .i32s(NODES, protocol::nodes::ACTIVATES)
        .get(node as usize)
        .copied()
        .unwrap_or(-1);
    if target >= 0 && !out.contains(&target) {
        out.push(target);
    }
}

/// `from` and every ancestor of it, deepest first, into `out`.
///
/// Budgeted, because Bun-written memory is untrusted input and a `parent` cycle must be
/// a bounded walk rather than a hung render thread — the same rule the paint walk's
/// traversal budget follows. A cycle here would be a host bug; hanging on one would be
/// this file's.
fn walk_ancestors(tables: &Tables, from: i32, out: &mut Vec<i32>) {
    out.clear();
    if from < 0 {
        return;
    }
    let parents = tables.i32s(NODES, protocol::nodes::PARENT);
    let mut node = from;
    let mut budget = parents.len() + 1;
    while node >= 0 && budget > 0 {
        out.push(node);
        node = parents.get(node as usize).copied().unwrap_or(-1);
        budget -= 1;
    }
}

pub struct Painter {
    /// The only paint there is. Borders are a two-rect fill rather than a stroke,
    /// so nothing here needs `PaintStyle::Stroke` or a per-node stroke width.
    fill: Paint,
    frame: FrameState,
    /// Every transition and animation in flight.
    ///
    /// Here rather than on the `Engine`, because "which style row does this node
    /// wear" is already this type's question and a tween only makes the answer two
    /// rows and a fraction. It also keeps the borrow honest: `advance_animations`
    /// needs `&mut` on the tween state while reading the tables, and the two are
    /// disjoint fields.
    ///
    /// Engine state the app never declares, and the NOTES.md ledger says why it has
    /// to be: a transition's progress depends on the clock, which does not exist at
    /// build time. Everything *else* about it — the endpoints, the mask, the curve —
    /// is compile-time and is in the tables.
    anims: Anims,
    /// Which controls are checked, and which are disabled.
    ///
    /// Here for the same reason `anims` is: "which style row does this node wear" is
    /// this type's question, and `:checked` is one more predicate that answers it. See
    /// `controls.rs` for why the live state is the engine's at all.
    controls: Controls,
    /// Where the caret is, and whether this frame draws it.
    ///
    /// Beside `controls` for the same reason that is beside `anims`: paint asks "is there
    /// a caret in this node" while drawing a run, so the answer belongs to whatever owns
    /// the per-node drawing questions. See `caret.rs` for why the index is engine state.
    carets: Carets,
}

impl Default for Painter {
    fn default() -> Self {
        Self::new()
    }
}

impl Painter {
    /// Sets the globally-true predicates for subsequent frames.
    pub fn set_globals(&mut self, globals: u32) {
        self.frame.globals = globals;
    }

    pub fn globals(&self) -> u32 {
        self.frame.globals
    }

    /// Recomputes the hover and press chains. Called once at the top of a frame.
    ///
    /// Separate from `set_globals` because the two go stale for different reasons and at
    /// different rates: globals change on a resize, which is what `relayout` is for,
    /// while these change on every pointer move. Both are per-frame; only one is
    /// per-*layout*.
    pub fn set_input_chains(&mut self, tables: &Tables, state: &InputState) {
        self.frame.set_input(tables, state);
    }

    pub fn new() -> Self {
        let mut fill = Paint::default();
        fill.set_anti_alias(true);
        fill.set_style(PaintStyle::Fill);

        Self {
            fill,
            frame: FrameState::default(),
            anims: Anims::new(),
            controls: Controls::new(),
            carets: Carets::new(),
        }
    }

    /// Rebuilds the animation watch list and the control state. Called when a commit
    /// changed the tables.
    pub fn rescan_animations(&mut self, tables: &Tables, node_count: usize) {
        self.anims.rescan(tables, node_count);
        self.controls.rescan(tables, node_count);
    }

    /// Runs the activation behaviour for a press on `node`. See `Controls::activate`.
    pub fn activate_control(&mut self, tables: &Tables, node: i32) -> Option<Activation> {
        self.controls.activate(tables, node)
    }

    /// Whether a press on `node` is swallowed because the node is a disabled control.
    pub fn press_is_swallowed(&self, node: i32) -> bool {
        self.controls.press_is_swallowed(node)
    }

    /// Puts the caret where a click at `x` landed inside `field`, if it is a text field.
    ///
    /// Returns whether a caret was placed, which is what tells the caller a repaint is
    /// due. `false` for a press on anything that is not a field — which is also how a
    /// click elsewhere clears the previous caret, since `place` is one-at-a-time.
    ///
    /// The index is resolved against the *run*, not the field: the run is where the text
    /// is and where its origin is, and it is already inset by the field's padding and
    /// border. Doing the arithmetic from the field's own box would have to re-derive both.
    pub fn place_caret(
        &mut self,
        tables: &Tables,
        geometry: Geometry,
        measurer: &mut Measurer,
        field: i32,
        x: f32,
    ) -> bool {
        let Some((run, index, _)) = self.resolve_x(tables, geometry, measurer, field, x) else {
            self.carets.clear();
            return false;
        };
        self.carets.place(run, index);
        true
    }

    /// Drags the selection's focus to `x`, leaving the anchor the press put down.
    ///
    /// The same resolution a click uses, which is what makes a press-then-drag land exactly
    /// where two separate clicks would.
    pub fn extend_caret(
        &mut self,
        tables: &Tables,
        geometry: Geometry,
        measurer: &mut Measurer,
        field: i32,
        x: f32,
    ) -> bool {
        // No `clear` on a miss, unlike `place_caret`. A drag that leaves the field — which
        // is most drags, since the pointer is not confined — must keep the selection it has
        // built rather than dropping it because one motion event landed outside.
        let Some((run, index, _)) = self.resolve_x(tables, geometry, measurer, field, x) else {
            return false;
        };
        self.carets.extend(run, index)
    }

    /// Selects the word at `x`, for a double click. Returns whether anything is selected.
    pub fn select_word(
        &mut self,
        tables: &Tables,
        geometry: Geometry,
        measurer: &mut Measurer,
        field: i32,
        x: f32,
    ) -> bool {
        let Some((run, index, chars)) = self.resolve_x(tables, geometry, measurer, field, x) else {
            return false;
        };
        let (start, end) = crate::caret::word_at(index, &chars);
        // Anchor at the start, so a Shift+Arrow afterwards extends from the end the user is
        // most likely reaching away from.
        self.carets.select(run, start, end);
        true
    }

    /// Selects everything in the field, for a triple click or Ctrl+A.
    pub fn select_all(&mut self, tables: &Tables, node_count: usize, field: i32) -> bool {
        let Some(run) = editable_run_of(tables, field, node_count) else {
            return false;
        };
        let slot = tables.i32s(NODES, protocol::nodes::TEXT)[run];
        let chars = tables.string(slot).chars().count();
        self.carets.select(run, 0, chars);
        true
    }

    /// The selected range in the field's run, in document order, or `None`.
    pub fn selection(
        &self,
        tables: &Tables,
        node_count: usize,
        field: i32,
    ) -> Option<(usize, usize)> {
        let run = editable_run_of(tables, field, node_count)?;
        self.carets.range_of(run)
    }

    /// Which character boundary `x` falls on inside `field`'s text run, and the run's text.
    ///
    /// Shared by every gesture that turns a pointer position into an offset — click, drag,
    /// double click — so all three agree. They agreeing is not cosmetic: a double click is
    /// specified in terms of *the boundary a click would have produced*, which is how a
    /// pointer in the right half of a hyphen selects the word after it. See `word_at`.
    fn resolve_x(
        &self,
        tables: &Tables,
        geometry: Geometry,
        measurer: &mut Measurer,
        field: i32,
        x: f32,
    ) -> Option<(usize, usize, Vec<char>)> {
        let run = editable_run_of(tables, field, geometry.bounds.len())?;

        let [rx, _, _, _] = geometry.bounds[run];
        let slot = tables.i32s(NODES, protocol::nodes::TEXT)[run];
        let content = tables.string(slot);
        let chars: Vec<char> = content.chars().collect();

        // The run's *base* style, not a resolved variant slot. A field's font does not
        // change with `:hover`, and reading the base keeps this out of the variant
        // machinery for a value that would be identical either way.
        let style = tables.u16s(NODES, protocol::nodes::STYLE)[run] as usize;
        let size = tables
            .f32s(STYLES, protocol::styles::FONT_SIZE)
            .get(style)
            .copied()
            .unwrap_or(16.0);
        let weight = tables
            .u16s(STYLES, protocol::styles::FONT_WEIGHT)
            .get(style)
            .copied()
            .unwrap_or(400);

        // Measured per prefix rather than from an average advance, because the boundaries
        // of proportional text are not evenly spaced — see `boundary_at`. Each call goes
        // through the measure cache, so a field of *n* characters costs n cached lookups
        // on the frame it is clicked and nothing afterwards.
        let index = boundary_at(x - rx, chars.len(), |n| {
            if n == 0 {
                return 0.0;
            }
            let prefix: String = chars[..n].iter().collect();
            measurer.measure(&prefix, size, weight, f32::INFINITY).0
        });

        Some((run, index, chars))
    }

    /// Moves the caret blink on. Returns whether the phase flipped, so a caller can
    /// repaint only when it did.
    pub fn advance_caret(&mut self, dt: f32) -> bool {
        self.carets.advance(dt)
    }

    /// Drops the caret, for a blur or a press outside every field.
    pub fn clear_caret(&mut self) {
        self.carets.clear();
    }

    /// The node holding the caret and its index, or `None`.
    pub fn caret(&self) -> Option<(usize, usize)> {
        self.carets.current()
    }

    /// Just the index, which is what a `TEXT_INPUT` event carries to the host.
    pub fn caret_index(&self) -> Option<usize> {
        self.carets.current().map(|(_, index)| index)
    }

    /// The anchor in the node holding the caret, or `None`.
    ///
    /// Equal to `caret_index` when collapsed, which is how the host tells "no selection" from
    /// a range without a third state to keep in step.
    pub fn caret_anchor(&self) -> Option<usize> {
        let (node, index) = self.carets.current()?;
        Some(self.carets.range_of(node).map_or(index, |(start, end)| {
            // Whichever end is *not* the focus. The host only needs the pair to know the
            // range, and it orders them itself — but returning the focus for both would make
            // every selection look collapsed.
            if index == start {
                end
            } else {
                start
            }
        }))
    }

    /// The selection in the node holding the caret, in document order, or `None`.
    ///
    /// By caret rather than by field, so the `TEXT_INPUT` path can read it without knowing
    /// which element is focused — the caret already knows which run it is in.
    pub fn caret_range(&self) -> Option<(usize, usize)> {
        let (node, _) = self.carets.current()?;
        self.carets.range_of(node)
    }

    /// Moves the caret within `node`. `extend` is Shift held. Returns whether anything moved.
    pub fn move_caret(&mut self, node: usize, motion: Motion, chars: usize, extend: bool) -> bool {
        self.carets.move_to(node, motion, chars, extend)
    }

    /// Shifts the caret by an edit that inserted `inserted` characters, `delta` net.
    pub fn shift_caret(&mut self, node: usize, delta: i32, inserted: usize) {
        self.carets.shift(node, delta, inserted);
    }

    /// Whether any tween is still in flight, so an idle frame stays free.
    pub fn animating(&self) -> bool {
        self.anims.running()
    }

    /// Moves every live tween `dt` seconds forward, and starts any that should be.
    ///
    /// Returns whether anything moved, which is what decides a repaint. Called from
    /// `tick` beside `advance_scrolls`, sharing the one `dt` that frame reads from the
    /// wall clock — `dt` is a parameter all the way down so a golden can sample an
    /// exact `t`.
    pub fn advance_animations(&mut self, tables: &Tables, state: &InputState, dt: f32) -> bool {
        // Destructured so the borrow checker sees two *disjoint fields* rather than one
        // `&mut self`: the closure reads the frame state while `anims` is mutably
        // borrowed. `resolve_slot` is a free function for exactly this reason, and
        // `style_for` is a thin wrapper over it.
        let Self {
            anims,
            frame,
            controls,
            ..
        } = self;
        anims.advance(tables, dt, |node| {
            resolve_slot(tables, node, state, frame, controls)
        })
    }

    /// Resolves which precompiled style a node wears right now. See `resolve_slot`.
    pub(crate) fn style_for(&self, tables: &Tables, node: usize, state: &InputState) -> usize {
        resolve_slot(tables, node, state, &self.frame, &self.controls)
    }

    /// The two rows a node is between, and how far — `style_for` plus its tween.
    ///
    /// This is what every style read in this file goes through now. For the
    /// overwhelming majority of nodes it is `Blend::solid`, whose accessors are the
    /// single table read they replaced; the interpolation only exists for the handful
    /// of nodes with a tween in flight.
    pub(crate) fn blend_for(&self, tables: &Tables, node: usize, state: &InputState) -> Blend {
        let slot = self.style_for(tables, node, state);
        self.anims.blend(tables, node, slot)
    }
}

/// Which precompiled style a node wears right now.
///
/// The node declares a `mask` of the predicates its styling depends on and owns a run
/// of `1 << popcount(mask)` styles. This intersects the live predicates with that
/// mask, compacts the result to a run index, and reads one `u16` — so a node styled
/// by both `:hover` and `:focus` gets the entry the compiler resolved for *both*,
/// rather than whichever the old precedence order happened to rank first.
///
/// Still free for the nodes that do not participate: the early return means only
/// nodes that are actually hovered, pressed or focused — or that read a global
/// predicate — reach the binary search.
///
/// A free function rather than a method, because `advance_animations` needs it while
/// holding `&mut` on the tween state beside the frame state it reads.
fn resolve_slot(
    tables: &Tables,
    node: usize,
    state: &InputState,
    frame: &FrameState,
    controls: &Controls,
) -> usize {
    let base = tables
        .u16s(NODES, protocol::nodes::STYLE)
        .get(node)
        .copied()
        .unwrap_or(0) as usize;

    let i = node as i32;

    // Which node's input state this one reads.
    //
    // Itself, except for a box generated by `::before` / `::after`, which
    // reads its parent's. `.btn:hover::before` means "the generated box of a
    // hovered button", and the box is never `state.hovered` itself —
    // `hit_test` only ever returns `INTERACTIVE` nodes, and a generated box is
    // not one. Without this the compiled HOVER variant exists and nothing can
    // ever select it, which is a rule that silently does nothing rather than
    // a visible fault.
    //
    // The parent *is* the originating element by construction: the compiler
    // emits both pseudo-elements as direct children. See `NodeFlags.GENERATED`.
    let subject = if tables
        .u8s(NODES, protocol::nodes::FLAGS)
        .get(node)
        .copied()
        .unwrap_or(0)
        & protocol::flags::GENERATED
        != 0
    {
        tables
            .i32s(NODES, protocol::nodes::PARENT)
            .get(node)
            .copied()
            .unwrap_or(i)
    } else {
        i
    };

    // Which predicates hold for *this* node right now. The global ones (media queries,
    // colour scheme) are the same for everybody and were evaluated once this frame; the
    // per-node ones come from the input state.
    //
    // **Hover and press are membership in a chain; focus is an equality.** That
    // asymmetry is measured rather than assumed, and it is the one thing about these
    // three that is easy to get wrong precisely because they are always described in one
    // breath: `:hover` and `:active` match the element under the pointer *and every
    // ancestor of it* — identical sets, measured while a button was held — while
    // `:focus` matches only the focused element. `:focus-within` is the ancestor form of
    // focus, and dziri has neither it nor any reason to change this line.
    //
    // See BROWSER-FACTS.md, "`:hover` and `:active` match the ancestors too".
    //
    // Both chains are empty on a frame with nothing hovered and nothing pressed, which
    // is most frames, so `contains` is a length check for almost every node.
    let mut live = frame.globals;
    if frame.hover.contains(&subject) {
        live |= predicate::HOVER;
    }
    if frame.active.contains(&subject) {
        live |= predicate::ACTIVE;
    }
    if subject == state.focused {
        live |= predicate::FOCUS;
    }

    // `:checked` and `:disabled`, from the state this engine owns. Reserved as
    // predicate bits back in protocol v9 and read by nothing until now, which is what
    // reserving them was for — the compiler has been resolving `:checked` variants
    // correctly the whole time, against a bit that was never true.
    //
    // Read against `subject` like the other three, so `.check:checked::before` — the
    // canonical way to draw a tick — resolves against the checkbox rather than against
    // the generated box, which is never a control.
    let control = controls.state(subject);
    if control & control_flags::CHECKED != 0 {
        live |= predicate::CHECKED;
    }
    if control & control_flags::DISABLED != 0 {
        live |= predicate::DISABLED;
    }

    if live == 0 {
        return base;
    }

    let ids = tables.i32s(VARIANTS, protocol::variants::NODE);
    let row = match ids.binary_search(&i) {
        Ok(r) => r,
        Err(_) => return base,
    };

    let mask = tables.u32s(VARIANTS, protocol::variants::MASK)[row];
    let selected = live & mask;
    if selected == 0 {
        // The node is conditional, but none of *its* conditions hold.
        return base;
    }

    let run_start = tables.i32s(VARIANTS, protocol::variants::RUN_START)[row];
    if run_start < 0 {
        return base;
    }

    let index = compact(selected, mask) as usize;
    let slots = tables.u16s(VARIANT_SLOTS, protocol::variant_slots::STYLE);

    match slots.get(run_start as usize + index) {
        Some(&slot) => slot as usize,
        // A short run is a host-side bug, not a reason to stop drawing.
        None => base,
    }
}

impl Painter {
    pub fn paint(
        &mut self,
        canvas: &Canvas,
        tables: &Tables,
        geometry: Geometry,
        state: &InputState,
        measurer: &mut Measurer,
        root: usize,
    ) {
        let count = geometry.bounds.len();
        let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
        let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
        let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);
        // Hoisted with the chains for the same reason they are: `flags` is read for
        // every node to test `PLACEHOLDER`, and `f32s`/`u8s` resolve a span plan through
        // two dependent loads each time — cheap once per frame, not once per node. That
        // is the lesson `StyleCols` was extracted for.
        let flags = tables.u8s(NODES, protocol::nodes::FLAGS);
        let text = tables.i32s(NODES, protocol::nodes::TEXT);
        // For the same reason as the three above, and it was the one missing: the
        // per-node transform and opacity reads are fourteen more style columns.
        let cols = StyleCols::of(tables);

        // What is visible on screen, asked once per frame rather than per node:
        // `local_clip_bounds` inverts the canvas matrix, and this loop runs over
        // every node in the tree.
        //
        // Skia would reject an off-screen rect itself, but only after the draw op
        // exists — and for text the expensive part happens on this side of that
        // call: `measure` before `draw_str`. An off-screen list therefore paid full
        // price. `None` means the clip is empty, so nothing is visible at all.
        //
        // Read *before* any scroll translate, so it is in window coordinates. Each
        // node's rect is compared after subtracting the scroll its ancestors have
        // applied, which is what puts both sides in the same space.
        let viewport = canvas.local_clip_bounds();

        // Whatever the canvas was, it is that again when this returns.
        //
        // The loop below can leave early — a budget exhausted by a hostile tree —
        // with clips still on the stack, and a Skia canvas outlives the frame: an
        // unbalanced `save` persists, the *next* frame's `clear` is clipped to
        // whatever was left, and the window goes progressively blank. That is not a
        // hypothetical; it is what "the window went all grey" was.
        let base_save_count = canvas.save_count();

        // Pre-order, iterative: children paint over their parents, and a hostile
        // tree must not be able to overflow the render thread's stack. Each entry
        // carries the scroll its ancestors have applied.
        let mut stack = vec![Step::Node(root, 0.0, 0.0, false)];
        let mut siblings: Vec<usize> = Vec::with_capacity(16);
        let mut budget = count.saturating_mul(2) + 16;

        while let Some(step) = stack.pop() {
            if budget == 0 {
                break;
            }
            budget -= 1;

            // A clip ends when the subtree that opened it does. Pushed *before* the
            // children, so it pops after all of them — which is what makes an
            // explicit stack able to express save/restore at all.
            let (node, scrolled_x, scrolled_y, mut transformed) = match step {
                Step::Node(node, sx, sy, t) => (node, sx, sy, t),
                Step::Restore(opened_by) => {
                    canvas.restore();
                    // Now in the space the container itself was painted in: its
                    // ancestors' scrolls are still applied, its own is not.
                    self.scrollbars(canvas, tables, geometry, state, opened_by);
                    continue;
                }
                Step::Pop => {
                    canvas.restore();
                    continue;
                }
            };

            if node >= count || hidden.get(node).copied().unwrap_or(0) != 0 {
                continue;
            }

            // `display: none` takes the subtree out of paint, exactly as `hidden`
            // does. Layout already agrees — `style_of` gives Taffy `Display::None`,
            // and Taffy neither sizes the node nor lays out its children.
            //
            // Which is what made the omission visible rather than harmless: a node
            // Taffy never laid out keeps all-zero bounds, so a hidden subtree
            // painted its text at the container's origin. A `<select>`'s options
            // drew on top of its own closed button.
            //
            // Resolved, not base: `display` can differ per predicate, and reading
            // the live slot is the whole point of the variant machinery.
            let blend = self.blend_for(tables, node, state);
            if display_of(tables, blend.to) == display::NONE {
                continue;
            }

            // A `::placeholder` is drawn only while its field is empty, and this is the
            // whole of that rule. It reads emptiness from the field's own text rather
            // than from a predicate bit, because a value nobody declared is engine state
            // by the same argument checkedness is — and because paint owning the
            // condition means no stylesheet can show a placeholder underneath the user's
            // own text by setting `display` on it.
            //
            // Free for every other node: one flag test, and the sibling walk happens
            // only for the handful of nodes that are placeholders.
            if flags.get(node).copied().unwrap_or(0) & protocol::flags::PLACEHOLDER != 0
                && field_has_text(tables, first, next, flags, text, count, node)
            {
                continue;
            }

            // `transform` and `opacity`, opened *before* the node draws itself so
            // that the node and its whole subtree share one matrix and one layer.
            // That is the difference from the clip below, which is opened after —
            // a scroll container is not clipped by its own clip, but a transformed
            // element certainly is transformed by its own transform.
            //
            // Both are paint-only, which is measured rather than assumed: neither
            // moves a sibling or changes a parent's height, so layout has already
            // finished and its answer stands.
            let matrix = transform_of(&cols, &blend, geometry.bounds[node]);
            let alpha = opacity_of(&cols, &blend);

            if matrix.is_some() || alpha.is_some() {
                match alpha {
                    // A layer, not a per-draw alpha, because CSS `opacity` groups:
                    // the subtree composites as one, so two overlapping children at
                    // 50% do not show through each other. `None` bounds lets Skia
                    // work the extent out from what actually gets drawn.
                    Some(a) => canvas.save_layer_alpha_f(None, a),
                    None => canvas.save(),
                };
                if let Some(m) = matrix {
                    canvas.concat(&m);
                }
                transformed = true;
                stack.push(Step::Pop);
            }

            // Rejected per node, never per subtree: an absolutely-positioned child
            // can sit outside its parent's box, so an off-screen parent does not
            // imply off-screen children. Hence the skip is around the *draw*, and
            // the traversal below runs either way.
            //
            // NaN compares false everywhere, so a nonsense rect fails open and is
            // drawn — Skia's own clip is still behind this.
            //
            // Skipped entirely inside a transform, and it has to be. `viewport` was
            // read once per frame in the canvas space of that moment, and a concat
            // has since changed what the node's layout rect means — so the
            // comparison is not merely imprecise, it is between two different
            // spaces. It also fails in the dangerous direction: a translate can
            // bring an off-screen node *on* screen, and a stale reject would drop a
            // node that should be drawn. Skia's own clip still bounds the work.
            let visible = if transformed {
                true
            } else {
                match viewport {
                    Some(vp) => {
                        // Where this node is *on screen*: its layout rect minus what
                        // its ancestors have scrolled. Comparing the unscrolled rect
                        // against a window-coordinate viewport is what made scrolled
                        // content vanish — a footer at content y=600 is on screen
                        // once the page has scrolled 500, and the stale comparison
                        // rejected it.
                        let [x, y, w, h] = geometry.bounds[node];
                        let (x, y) = (x - scrolled_x, y - scrolled_y);
                        !(x + w <= vp.left || x >= vp.right || y + h <= vp.top || y >= vp.bottom)
                    }
                    // An empty clip: nothing is visible, but the walk still has to
                    // reach the children, which is what makes this a `false` rather
                    // than an early return.
                    None => false,
                }
            };

            if visible {
                self.node(canvas, tables, geometry.bounds, &blend, measurer, node);
            }

            siblings.clear();
            let mut c = first.get(node).copied().unwrap_or(-1);
            while c >= 0 && (c as usize) < count {
                siblings.push(c as usize);
                c = next[c as usize];
            }

            // A node that contains its overflow clips its descendants to its own
            // padding box, on the axes that contain. Ordered so `Restore` pops last:
            // push it, then the children in reverse.
            //
            // The clip is the *padding* box rather than the border box, which is what
            // CSS says and what makes a bordered scroll container look right: content
            // scrolls under its own border rather than over it.
            let (clip_x, clip_y) = if siblings.is_empty() {
                (false, false)
            } else {
                self.clips(tables, node, state)
            };

            // A scroll offset only means anything on a box that clips: a node with
            // `overflow: visible` has no scroll region for the wheel to move, so it
            // must not translate its children either.
            let own_scroll = if clip_x || clip_y {
                geometry.scroll_of(node)
            } else {
                [0.0, 0.0]
            };

            if clip_x || clip_y {
                let [x, y, w, h] = geometry.bounds[node];
                let inset = self.border_of(tables, node, state);
                // The unclipped axis keeps whatever bound is already in force, so a
                // vertical-only clip does not quietly become a horizontal one. Taking
                // it from the live clip rather than from a large constant means an
                // enclosing clip still wins.
                let outer = canvas.local_clip_bounds().unwrap_or(Rect::new(
                    f32::MIN / 4.0,
                    f32::MIN / 4.0,
                    f32::MAX / 4.0,
                    f32::MAX / 4.0,
                ));

                let left = if clip_x { x + inset } else { outer.left };
                let right = if clip_x {
                    (x + w - inset).max(x + inset)
                } else {
                    outer.right
                };
                let top = if clip_y { y + inset } else { outer.top };
                let bottom = if clip_y {
                    (y + h - inset).max(y + inset)
                } else {
                    outer.bottom
                };

                canvas.save();
                canvas.clip_rect(
                    Rect::new(left, top, right, bottom),
                    None,
                    // Antialiased, or a clipped edge crossing a rounded corner shows
                    // a stair-step against the border it is supposed to sit inside.
                    true,
                );

                // The scroll itself: shift the *content* up and left, inside the clip
                // that was just set. Translating the canvas rather than adjusting
                // every descendant's rect is what keeps `bounds` meaning "where
                // layout put this", which is what the host reads — and the walk
                // carries the same offset down the stack so the viewport reject can
                // put both sides in window coordinates, which is what lets rows
                // scrolled out of view fail that test and never reach `measure`.
                if own_scroll != [0.0, 0.0] {
                    canvas.translate((-own_scroll[0], -own_scroll[1]));
                }
                stack.push(Step::Restore(node));
            }

            // Reversed, because the stack pops last-in first. Children inherit this
            // node's scroll on top of their ancestors'.
            stack.extend(siblings.iter().rev().map(|&c| {
                Step::Node(
                    c,
                    scrolled_x + own_scroll[0],
                    scrolled_y + own_scroll[1],
                    transformed,
                )
            }));
        }

        // Unconditional, and it must be: every `break` above and every clip left on
        // the stack is undone here rather than leaking into the next frame.
        canvas.restore_to_count(base_save_count);
    }

    /// Which axes this node contains its overflow on, and so clips.
    ///
    /// Per axis because the useful case is asymmetric: a column that scrolls
    /// vertically must *not* clip horizontally, or a focus ring or a dropdown that
    /// legitimately sticks out sideways gets cut off.
    fn clips(&self, tables: &Tables, node: usize, state: &InputState) -> (bool, bool) {
        let blend = self.blend_for(tables, node, state);
        // `CLIP` belongs here and not in `is_scrollable`: it clips like `hidden` and
        // is deliberately *not* a scroll container, which is the whole reason CSS
        // distinguishes the two.
        //
        // `overflow` is discrete, so the blend reads its destination outright. That is
        // the right answer rather than a shortcut: a box halfway through a fade must
        // not stop clipping its content, and there is no half-clipped.
        let contains = |field: usize| {
            matches!(
                blend.u8(tables, field, protocol::overflow::VISIBLE),
                protocol::overflow::HIDDEN
                    | protocol::overflow::ELLIPSIS
                    | protocol::overflow::SCROLL
                    | protocol::overflow::CLIP
            )
        };
        (
            contains(protocol::styles::OVERFLOW_X),
            contains(protocol::styles::OVERFLOW_Y),
        )
    }

    /// The border width, which the clip has to sit inside.
    ///
    /// Not interpolated even though it is a length: `borderWidth` is layout-affecting,
    /// so it carries no `interp` and no mask can name it. That is the scope boundary
    /// rather than an oversight — easing it here while Taffy kept the old box would
    /// move the clip out of step with the content it clips.
    fn border_of(&self, tables: &Tables, node: usize, state: &InputState) -> f32 {
        let blend = self.blend_for(tables, node, state);
        match blend.f32(tables, protocol::styles::BORDER_WIDTH, 0.0) {
            width if width.is_finite() && width > 0.0 => width,
            _ => 0.0,
        }
    }

    /// Draws the overlay scrollbars for a box that scrolls, over its own content.
    ///
    /// Called after the container's clip has popped, so the canvas is in the space the
    /// container itself was painted in: its ancestors' scrolls applied, its own not.
    /// The bars therefore stay put while the content moves under them, which is the
    /// whole point of them.
    ///
    /// A thumb and no track. A track would have to be a second colour that contrasts
    /// with an unknown background, and the thumb alone already answers the question
    /// the user has — *does this box scroll, and where am I in it?*
    fn scrollbars(
        &mut self,
        canvas: &Canvas,
        tables: &Tables,
        geometry: Geometry,
        state: &InputState,
        node: usize,
    ) {
        let (bar_x, bar_y) = self.bars_of(tables, geometry, state, node);
        if bar_x.is_none() && bar_y.is_none() {
            return;
        }

        let blend = self.blend_for(tables, node, state);
        let thumb_colour = blend.u32(tables, protocol::styles::SCROLLBAR_THUMB);
        let track_colour = blend.u32(tables, protocol::styles::SCROLLBAR_TRACK);

        for bar in [bar_y, bar_x].into_iter().flatten() {
            let phase = state.bar_state(node, bar.vertical);

            // A track is drawn only when `scrollbar-color` asked for one. Left to
            // itself dziri draws a thumb and nothing else — a track would have to be a
            // second colour that contrasts with an unknown background — but an author
            // who names two colours has said what they want behind the thumb.
            if track_colour >> 24 != 0 {
                self.fill.set_color(Color::from(track_colour));
                let radius = bar.track.width().min(bar.track.height()) / 2.0;
                canvas.draw_round_rect(bar.track, radius, radius, &self.fill);
            }

            self.fill.set_color(Color::from(thumb_paint(
                thumb_colour,
                tables,
                &blend,
                phase,
            )));
            // Fully round ends: the radius is half the short side, so the thumb is a
            // capsule at every thickness rather than a rect with hinted corners.
            let radius = bar.thumb.width().min(bar.thumb.height()) / 2.0;
            canvas.draw_round_rect(bar.thumb, radius, radius, &self.fill);
        }
    }

    /// The geometry of a container's two scrollbars: `(horizontal, vertical)`.
    ///
    /// The single source for both what is drawn and what can be clicked. Everything
    /// that decides whether a bar exists lives here — scrollability, whether the
    /// content actually overflows, whether the box is big enough to say so — so paint
    /// and input cannot disagree about any of it.
    pub fn bars_of(
        &self,
        tables: &Tables,
        geometry: Geometry,
        state: &InputState,
        node: usize,
    ) -> (Option<Bar>, Option<Bar>) {
        const NONE: (Option<Bar>, Option<Bar>) = (None, None);

        // The *base* style, matching [`is_scrollable`]: this bar promises the wheel
        // will move this box, so it has to be drawn from the same fact the wheel
        // reads. A node whose scrollability changed on hover would otherwise show a
        // bar that does nothing.
        let (may_scroll_x, may_scroll_y) = scrollable_axes(tables, node);
        if !may_scroll_x && !may_scroll_y {
            return NONE;
        }

        // `scrollbar-width: none` is the whole property gone: no bar drawn, and — because
        // this is also what the input path asks — nothing to hover or grab. The wheel is
        // untouched, which is exactly what the property means and why it is not spelled
        // `overflow: hidden`.
        let bar_width = self.blend_for(tables, node, state).u8(
            tables,
            protocol::styles::SCROLLBAR_WIDTH,
            protocol::scrollbar_width::AUTO,
        );
        if bar_width == protocol::scrollbar_width::NONE {
            return NONE;
        }

        // `auto`, not `scroll`: a bar exists only where the content actually
        // overflows. The compiler collapses both keywords into `SCROLL`, and this is
        // the half of that approximation paint gets to make good — measured in
        // BROWSER-FACTS.md, "What a scrollbar costs in layout room".
        //
        // Half a pixel of overflow is rounding, not a scroll region.
        let extent = geometry.extent_of(node);
        let wants_x = may_scroll_x && extent[0] > 0.5;
        let wants_y = may_scroll_y && extent[1] > 0.5;
        if !wants_x && !wants_y {
            return NONE;
        }

        let Some(&[x, y, w, h]) = geometry.bounds.get(node) else {
            return NONE;
        };

        // The padding box, because that is what the clip is: the bars sit inside the
        // container's border rather than across it.
        let inset = self.border_of(tables, node, state);
        let (vx, vy) = (x + inset, y + inset);
        let (vw, vh) = (w - inset * 2.0, h - inset * 2.0);
        // A box too small to hold a thumb has no room to say anything. Finiteness is
        // its own clause because NaN fails every comparison, so the size tests alone
        // would let a nonsense rect through — the trap `radius` fell into in `node`.
        if !vw.is_finite() || !vh.is_finite() || vw <= THUMB_THICKNESS || vh <= THUMB_THICKNESS {
            return NONE;
        }

        let offset = geometry.scroll_of(node);
        // Each thickness comes from that bar's own phase, so hovering the vertical bar
        // does not fatten the horizontal one.
        let thick_x = state.bar_state(node, false).thickness(bar_width);
        let thick_y = state.bar_state(node, true).thickness(bar_width);

        let mut out = NONE;

        if wants_y {
            // Where two bars meet, each track stops short of the other so the thumbs
            // cannot cross in the corner. It is the *other* bar's thickness that takes
            // the room, which is why this is not one shared constant.
            let corner = if wants_x {
                thick_x + THUMB_INSET * 2.0
            } else {
                0.0
            };
            let track_len = vh - THUMB_INSET * 2.0 - corner;
            if let Some((start, len)) = thumb(track_len, vh, extent[1], offset[1]) {
                let left = vx + vw - thick_y - THUMB_INSET;
                let top = vy + THUMB_INSET;
                out.1 = Some(Bar {
                    node,
                    vertical: true,
                    track: Rect::from_xywh(left, top, thick_y, track_len),
                    thumb: Rect::from_xywh(left, top + start, thick_y, len),
                    // Grown inwards from the edge the bar is pinned to, and never
                    // wider than the box: a narrow container must not end up with its
                    // whole width counted as scrollbar.
                    hot: Rect::from_xywh(
                        vx + vw - BAR_HOT_WIDTH.min(vw),
                        top,
                        BAR_HOT_WIDTH.min(vw),
                        track_len,
                    ),
                    extent: extent[1],
                    viewport: vh,
                });
            }
        }

        if wants_x {
            let corner = if wants_y {
                thick_y + THUMB_INSET * 2.0
            } else {
                0.0
            };
            let track_len = vw - THUMB_INSET * 2.0 - corner;
            if let Some((start, len)) = thumb(track_len, vw, extent[0], offset[0]) {
                let left = vx + THUMB_INSET;
                let top = vy + vh - thick_x - THUMB_INSET;
                out.0 = Some(Bar {
                    node,
                    vertical: false,
                    track: Rect::from_xywh(left, top, track_len, thick_x),
                    thumb: Rect::from_xywh(left + start, top, len, thick_x),
                    hot: Rect::from_xywh(
                        left,
                        vy + vh - BAR_HOT_WIDTH.min(vh),
                        track_len,
                        BAR_HOT_WIDTH.min(vh),
                    ),
                    extent: extent[0],
                    viewport: vw,
                });
            }
        }

        out
    }

    fn node(
        &mut self,
        canvas: &Canvas,
        tables: &Tables,
        bounds: &[[f32; 4]],
        blend: &Blend,
        measurer: &mut Measurer,
        node: usize,
    ) {
        use protocol::styles as f;

        // The blend arrives from the walk rather than being resolved again here: it
        // already cost a binary search and a tween lookup one frame-step up, and
        // re-resolving would also risk the fill and the transform disagreeing about
        // which two rows this node is between.
        let g = |field: usize| -> f32 { blend.f32(tables, field, 0.0) };
        let c = |field: usize| -> u32 { blend.u32(tables, field) };

        let [x, y, w, h] = bounds[node];
        // Sanitised once: both the fill and the border ring build round rects from
        // this, and Skia has no defined answer for a NaN or infinite radius. The
        // old `radius > 0.0` test happened to reject NaN and let infinity through.
        // Sanitised per corner, in Skia's order: top-left, top-right,
        // bottom-right, bottom-left.
        // **Clamped to half the box rather than required to be finite.** CSS clamps a
        // radius that exceeds half the side, which is how `border-radius: 9999px`
        // means "a capsule" — and Tailwind v4 spells `rounded-full` as
        // `calc(infinity * 1px)`, so an `is_finite` test made the most common rounding
        // utility in the framework draw square corners. `r > 0.0` is false for `NaN`
        // and true for infinity, and `min` of infinity with a finite half-side is the
        // half-side, so both nonsense and the idiom land where they should.
        let half = (w.max(0.0) / 2.0).min(h.max(0.0) / 2.0);
        let corner = |field: usize| -> f32 {
            match g(field) {
                r if r > 0.0 && half.is_finite() => r.min(half),
                _ => 0.0,
            }
        };
        let radii = [
            corner(f::RADIUS_TOP_LEFT),
            corner(f::RADIUS_TOP_RIGHT),
            corner(f::RADIUS_BOTTOM_RIGHT),
            corner(f::RADIUS_BOTTOM_LEFT),
        ];
        let rounded = radii.iter().any(|r| *r > 0.0);
        // Skia takes an (x, y) pair per corner; circular corners repeat the value.
        let points = |radii: [f32; 4]| -> [Point; 4] {
            [
                Point::new(radii[0], radii[0]),
                Point::new(radii[1], radii[1]),
                Point::new(radii[2], radii[2]),
                Point::new(radii[3], radii[3]),
            ]
        };
        // The border box grown (or, for a negative `d`, shrunk) by `d`, with the corner
        // radii CSS gives a shadow of that spread.
        //
        // A zero radius stays zero: css-backgrounds-3 §7.1.1 adjusts a corner radius by the
        // spread *only when the radius is greater than zero*, so a square-cornered box casts
        // a square-cornered ring however wide the ring is. Adding the spread
        // unconditionally would round every square box the moment it gained a focus ring.
        let spread = |d: f32| -> RRect {
            let adjusted = radii.map(|r| if r > 0.0 { (r + d).max(0.0) } else { 0.0 });
            RRect::new_rect_radii(
                Rect::from_xywh(x - d, y - d, w + d * 2.0, h + d * 2.0),
                &points(adjusted),
            )
        };

        // A band between two of those, in `colour`. `draw_drrect` is undefined on an empty
        // or inverted inner rect, so a band that swallows what it surrounds fills the outer
        // shape instead — the same accommodation the border ring below makes.
        let band = |fill: &mut Paint, outer: f32, inner: f32, colour: u32| {
            if colour >> 24 == 0 || outer <= inner || w <= 0.0 || h <= 0.0 {
                return;
            }
            fill.set_color(Color::from(colour));
            let hole = spread(inner);
            if hole.width() <= 0.0 || hole.height() <= 0.0 {
                canvas.draw_rrect(spread(outer), fill);
            } else {
                canvas.draw_drrect(spread(outer), hole, fill);
            }
        };

        // `box-shadow`, as the concentric bands a style row can hold — see
        // `properties.ts::parseBoxShadow` for why that is the expressible subset and why it
        // is exactly what Tailwind's ring utilities compile to.
        //
        // **Before the background**, because CSS draws an outer shadow behind the box. With
        // matching corner radii the two shapes only touch rather than overlap, so this is
        // ordering for correctness-by-construction rather than for a visible difference
        // today — it stops mattering the day a ring is drawn semi-transparent.
        let ring_outer = ring_width(g(f::RING_OUTER_WIDTH));
        let ring_inner = ring_width(g(f::RING_INNER_WIDTH)).min(ring_outer);
        band(
            &mut self.fill,
            ring_outer,
            ring_inner,
            c(f::RING_OUTER_COLOR),
        );
        // Tailwind's ring offset: a narrower band painted over the inner part of the ring,
        // which is what puts a gap of page colour between the box and its ring.
        band(&mut self.fill, ring_inner, 0.0, c(f::RING_INNER_COLOR));

        let bg = c(f::BG);

        // A zero alpha channel means the box contributes no fill at all.
        if bg >> 24 != 0 && w > 0.0 && h > 0.0 {
            let rect = Rect::from_xywh(x, y, w, h);
            self.fill.set_color(Color::from(bg));
            if rounded {
                canvas.draw_rrect(RRect::new_rect_radii(rect, &points(radii)), &self.fill);
            } else {
                canvas.draw_rect(rect, &self.fill);
            }
        }

        // An inset ring goes **over** the background and **under** the border, which is
        // where css-backgrounds-3 puts an inner shadow. Tailwind's `inset-ring-*`.
        let ring_inset = ring_width(g(f::RING_INSET_WIDTH));
        band(&mut self.fill, 0.0, -ring_inset, c(f::RING_INSET_COLOR));

        // Non-finite is the sentinel for "unset" everywhere else, and `style_of`
        // already resolves it to no border for layout; paint must agree or the
        // ring and the box disagree about where the content starts.
        let border_width = match g(f::BORDER_WIDTH) {
            t if t.is_finite() && t > 0.0 => t,
            _ => 0.0,
        };
        let border_color = c(f::BORDER_COLOR);
        if border_width > 0.0 && border_color >> 24 != 0 && w > 0.0 && h > 0.0 {
            // A ring between the border box and the padding box, not a stroke
            // inset by half its width. The stroke was wrong at the corners: its
            // outer edge is an arc of radius `radius + width/2`, so the fill
            // underneath — drawn at `radius` — poked out past the border at each
            // corner, and its inner edge was `radius - width/2` where CSS says
            // `max(0, radius - width)`. Two rounded rects say exactly what CSS
            // means, need no `set_stroke_width` per node, and `new_rect_radii`
            // takes four corner radii the day the schema grows per-corner and
            // per-side utilities, which a single stroked path cannot express.
            let outer = RRect::new_rect_radii(Rect::from_xywh(x, y, w, h), &points(radii));
            self.fill.set_color(Color::from(border_color));

            let inner_w = w - border_width * 2.0;
            let inner_h = h - border_width * 2.0;
            if inner_w <= 0.0 || inner_h <= 0.0 {
                // The border swallows the box. Skia's `draw_drrect` takes the
                // difference of two rects and an empty or inverted inner one is
                // not a shape it is defined on, so fill the outer instead.
                canvas.draw_rrect(outer, &self.fill);
            } else {
                // `max(0, radius - width)` per corner, which is what CSS says the
                // inner edge of a border is. Per corner rather than once, or a box
                // rounded on one side only would get that side's inset everywhere.
                let inner_radii = radii.map(|r| (r - border_width).max(0.0));
                let inner = RRect::new_rect_radii(
                    Rect::from_xywh(x + border_width, y + border_width, inner_w, inner_h),
                    &points(inner_radii),
                );
                canvas.draw_drrect(outer, inner, &self.fill);
            }
        }

        let text_slot = tables
            .i32s(NODES, protocol::nodes::TEXT)
            .get(node)
            .copied()
            .unwrap_or(-1);
        if text_slot < 0 {
            return;
        }

        let text = tables.string(text_slot);

        let size = g(f::FONT_SIZE);
        let weight = blend.u16(tables, f::FONT_WEIGHT, 400);

        // The selection band goes **behind** the text and behind the caret, which is the order
        // a highlight has to be drawn in: over the background, under the glyphs.
        let band = self.selection_band(node, text, size, weight, measurer, x, y, h);
        if let Some(rect) = band {
            self.fill.set_color(Color::from(c(f::SELECTION_BG)));
            canvas.draw_rect(rect, &self.fill);
        }

        // The caret is drawn *before* the early-out for empty text, because an empty field
        // is the commonest place to want one — you click a blank box and expect a cursor.
        // It lived after the glyph drawing at first and the caret never appeared: the run
        // holds "", the function returned two lines earlier, and a golden of a clicked
        // field came back byte-identical to an unclicked one.
        //
        // Drawn from the run's own origin rather than over the text, which is why it does
        // not need the paragraph: the offset is the advance of the prefix, and for an empty
        // field that is zero.
        self.draw_caret(
            canvas,
            node,
            text,
            size,
            weight,
            measurer,
            x,
            y,
            h,
            c(f::CARET_COLOR),
        );

        if text.is_empty() {
            return;
        }
        self.fill.set_color(Color::from(c(f::FG)));

        let kind = tables
            .u8s(NODES, protocol::nodes::KIND)
            .get(node)
            .copied()
            .unwrap_or(node_kind::BOX);

        // SkParagraph positions from the top of the text block, so none of the
        // ascent arithmetic this used to do survives. `Paragraph::paint` takes the
        // block's origin, not a baseline.
        if kind == node_kind::BUTTON {
            // Centre the label in the content box, so asymmetric padding is
            // honoured rather than averaged away. The border counts: Taffy reports
            // the border box, and since `style_of` now reserves the border the
            // content box is inset by it on every side.
            //
            // Horizontal centring is the paragraph's own `TextAlign::Center` rather
            // than arithmetic on an advance. That is what makes a label that *does*
            // wrap centre line by line, which is what the previous version could
            // only anticipate.
            let borders = border_width * 2.0;
            let box_w = w - borders - g(f::PAD_LEFT) - g(f::PAD_RIGHT);
            let box_h = h - borders - g(f::PAD_TOP) - g(f::PAD_BOTTOM);

            let mut paragraph = measurer.paragraph(text, size, weight, box_w, TextAlign::Center);
            let tx = x + border_width + g(f::PAD_LEFT);
            let ty = y + border_width + g(f::PAD_TOP) + (box_h - paragraph.height()) / 2.0;
            crate::text::paint_paragraph(&mut paragraph, canvas, (tx, ty).into(), &self.fill);
        } else {
            // A text run is its own node, so its bounds *are* the text block and
            // the wrap width is the box width. Laying out to anything else here
            // would wrap at a width the layout pass did not predict, and the box
            // would be the wrong height for what is drawn in it.
            let mut paragraph = measurer.paragraph(text, size, weight, w, TextAlign::Left);
            crate::text::paint_paragraph(&mut paragraph, canvas, (x, y).into(), &self.fill);

            // Selected characters in `::selection`'s colour, by drawing the same paragraph a
            // second time clipped to the band. Not a styled range on the paragraph: the
            // measure cache is keyed on (text, size, weight, width), so a paragraph whose
            // glyph colours varied by selection would have to be rebuilt on every drag step
            // and would miss the cache every time. Clipping reuses the cached layout, and
            // both passes lay the text out identically because it is the same call.
            //
            // Alpha 0 on `selectionFg` means "leave the text its own colour", the convention
            // the rest of the table uses for "nothing was said" — so an author who sets only
            // a background gets one.
            if let Some(rect) = band {
                let fg = c(f::SELECTION_FG);
                if fg >> 24 != 0 {
                    canvas.save();
                    canvas.clip_rect(rect, None, None);
                    self.fill.set_color(Color::from(fg));
                    let mut over = measurer.paragraph(text, size, weight, w, TextAlign::Left);
                    crate::text::paint_paragraph(&mut over, canvas, (x, y).into(), &self.fill);
                    canvas.restore();
                }
            }
        }
    }

    /// The rectangle a live selection covers in `node`, or `None` when there is none.
    ///
    /// From the same prefix advances the caret uses, so the band's edges land exactly on the
    /// boundaries a click resolves to. The full run height rather than the glyphs' ink extent,
    /// which is what a browser highlights and what makes a selection of a space visible.
    #[allow(clippy::too_many_arguments)]
    fn selection_band(
        &mut self,
        node: usize,
        text: &str,
        size: f32,
        weight: u16,
        measurer: &mut Measurer,
        x: f32,
        y: f32,
        h: f32,
    ) -> Option<Rect> {
        let (start, end) = self.carets.range_of(node)?;
        let chars: Vec<char> = text.chars().collect();
        let mut advance = |n: usize| -> f32 {
            let n = n.min(chars.len());
            if n == 0 {
                return 0.0;
            }
            let prefix: String = chars[..n].iter().collect();
            measurer.measure(&prefix, size, weight, f32::INFINITY).0
        };
        let (left, right) = (advance(start), advance(end));
        if right <= left {
            return None;
        }
        Some(Rect::from_xywh(x + left, y, right - left, h))
    }

    /// The caret in `node`, if it has one and this frame is a visible phase.
    ///
    /// `caret-color` has been resolving into the style table since v9 with nothing reading
    /// it. This is the something. A transparent value means no caret — which is also what
    /// the CSS initial value gives, so a field whose stylesheet never mentions the property
    /// shows nothing, exactly as the spec says.
    #[allow(clippy::too_many_arguments)]
    fn draw_caret(
        &mut self,
        canvas: &Canvas,
        node: usize,
        text: &str,
        size: f32,
        weight: u16,
        measurer: &mut Measurer,
        x: f32,
        y: f32,
        h: f32,
        colour: u32,
    ) {
        let Some(index) = self.carets.index_of(node) else {
            return;
        };
        if !self.carets.visible() || colour >> 24 == 0 {
            return;
        }
        // No caret while a range is live. **A convention, not a measurement** — the caret is
        // browser chrome and nothing script can read, the same admission `caret.rs` makes
        // about the blink rate — but it is what every desktop text field does, and a caret
        // blinking at one edge of a highlight reads as two cursors rather than one selection.
        if self.carets.range_of(node).is_some() {
            return;
        }

        // The same prefix advance the boundary search used, so the caret lands *on* the
        // boundary the click resolved to rather than near it.
        let prefix: String = text.chars().take(index).collect();
        let dx = if prefix.is_empty() {
            0.0
        } else {
            measurer.measure(&prefix, size, weight, f32::INFINITY).0
        };

        // One CSS pixel wide, the full line height. Chrome's caret is browser chrome with
        // no readable width, so this is convention rather than measurement — `caret.rs`
        // makes the same admission about the blink rate.
        self.fill.set_color(Color::from(colour));
        canvas.draw_rect(Rect::from_xywh(x + dx, y, 1.0, h), &self.fill);
    }
}

/// A ring band's width, or 0 if it is not one Skia can be handed.
///
/// The same sanitising `BORDER_WIDTH` gets, for the same reason: non-finite is the "unset"
/// sentinel throughout the style table, and Skia has no defined answer for a NaN or
/// infinite corner radius. A `calc(infinity * 1px)` ring — which is not idiomatic, but
/// `rounded-full` proves the value reaches the tables — must draw nothing rather than
/// whatever an infinite rrect does.
fn ring_width(raw: f32) -> f32 {
    if raw.is_finite() && raw > 0.0 {
        raw
    } else {
        0.0
    }
}

/// Which axes the user may scroll, from the node's base style.
///
/// `hidden` clips without scrolling — that is the whole difference between it and
/// `scroll` — so only `SCROLL` answers a wheel.
///
/// The *base* slot, not the variant-resolved one: a node whose scrollability changed
/// on hover would be a trap rather than a feature, and the wheel arrives without a
/// paint's notion of which predicates are live.
///
/// Per axis, because both callers need the axes apart: the wheel to know a sideways
/// gesture has somewhere to go, the painter to know which bar to draw.
pub fn scrollable_axes(tables: &Tables, node: usize) -> (bool, bool) {
    let slot = tables
        .u16s(NODES, protocol::nodes::STYLE)
        .get(node)
        .copied()
        .unwrap_or(0) as usize;

    let scrolls = |field: usize| {
        tables.u8s(STYLES, field).get(slot).copied() == Some(protocol::overflow::SCROLL)
    };
    (
        scrolls(protocol::styles::OVERFLOW_X),
        scrolls(protocol::styles::OVERFLOW_Y),
    )
}

/// Whether the user may scroll this node on either axis.
pub fn is_scrollable(tables: &Tables, node: usize) -> bool {
    let (x, y) = scrollable_axes(tables, node);
    x || y
}

/// The innermost scrollable node containing the point, or `None`.
///
/// Shares [`hit_test`]'s walk and differs in what it is looking for: the deepest
/// match rather than the topmost interactive one, and no `INTERACTIVE` flag — a
/// scrollable box need not be clickable.
pub fn scrollable_at(
    tables: &Tables,
    geometry: Geometry,
    root: usize,
    px: f32,
    py: f32,
) -> Option<usize> {
    let count = geometry.bounds.len();
    let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

    let mut found = None;
    // Each entry carries the scroll its ancestors have applied, exactly as the paint
    // walk does — a point in window coordinates has to be compared against boxes
    // that have been shifted.
    let mut stack: Vec<(usize, f32, f32)> = vec![(root, 0.0, 0.0)];
    let mut budget = count.saturating_mul(2) + 16;

    while let Some((node, sx, sy)) = stack.pop() {
        if budget == 0 {
            break;
        }
        budget -= 1;

        if node >= count || hidden.get(node).copied().unwrap_or(0) != 0 {
            continue;
        }

        let [x, y, w, h] = geometry.bounds[node];
        let (x, y) = (x - sx, y - sy);
        if px < x || py < y || px >= x + w || py >= y + h {
            continue;
        }

        if is_scrollable(tables, node) {
            // Deeper wins, and children are visited after their parent.
            found = Some(node);
        }

        let own = geometry.scroll_of(node);
        let mut c = first.get(node).copied().unwrap_or(-1);
        while c >= 0 && (c as usize) < count {
            stack.push((c as usize, sx + own[0], sy + own[1]));
            c = next[c as usize];
        }
    }

    found
}

impl Painter {
    /// The scrollbar under a window-coordinate point, innermost first.
    ///
    /// Consulted *before* [`hit_test`], because an overlay bar is on top of content and
    /// a press that lands on it is aimed at it. Without that order a click near the
    /// right edge of a scrolling list would both drag the bar and press the row under
    /// it.
    ///
    /// Innermost wins, matching [`scrollable_at`]: the bar of the list you are pointing
    /// at, not the page's.
    pub fn bar_at(
        &self,
        tables: &Tables,
        geometry: Geometry,
        state: &InputState,
        root: usize,
        px: f32,
        py: f32,
    ) -> Option<Bar> {
        let count = geometry.bounds.len();
        let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
        let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
        let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

        let mut found = None;
        // Each entry carries the scroll its ancestors have applied, as every other walk
        // in this file does.
        let mut stack: Vec<(usize, f32, f32)> = vec![(root, 0.0, 0.0)];
        let mut budget = count.saturating_mul(2) + 16;

        while let Some((node, sx, sy)) = stack.pop() {
            if budget == 0 {
                break;
            }
            budget -= 1;

            if node >= count || hidden.get(node).copied().unwrap_or(0) != 0 {
                continue;
            }

            let [x, y, w, h] = geometry.bounds[node];
            if px < x - sx || py < y - sy || px >= x + w - sx || py >= y + h - sy {
                continue;
            }

            // The bars are in unscrolled layout space, so the *pointer* moves into it.
            // One direction of travel: a rect that existed in both spaces is how a bar
            // and its hit region drift apart.
            let (at_x, at_y) = (px + sx, py + sy);
            let (bar_x, bar_y) = self.bars_of(tables, geometry, state, node);
            // Vertical first: where both bars' hot regions overlap, in the corner, the
            // vertical one wins because it is the one almost every wheel-less scroll
            // reaches for.
            for bar in [bar_y, bar_x].into_iter().flatten() {
                let hot = bar.hot;
                if at_x >= hot.left && at_x < hot.right && at_y >= hot.top && at_y < hot.bottom {
                    found = Some(bar);
                    break;
                }
            }

            let own = geometry.scroll_of(node);
            let mut c = first.get(node).copied().unwrap_or(-1);
            while c >= 0 && (c as usize) < count {
                stack.push((c as usize, sx + own[0], sy + own[1]));
                c = next[c as usize];
            }
        }

        found
    }
}

/// Topmost interactive node containing the point, or `-1`.
///
/// Walks the live tree rather than a sorted `interactive` array: arena rows are
/// numbered by slot, so after a list reorder those two orders diverge and only
/// the tree matches what the user sees.
///
/// It walks from `root` for the same reason [`Painter::paint`] does. Hardcoding
/// node 0 agreed with the configured root in the sample and nowhere else: a
/// non-zero root would have hit-tested a tree that is not on screen, which is
/// the kind of divergence that only shows up in someone else's app.
///
/// The scrollbars are not in this walk, and must not be: they are painted furniture with
/// no row in the tree. [`Painter::bar_at`] is their walk, and the input path asks it
/// *first* — an overlay bar is on top of the content, so a press on one is aimed at it
/// rather than at whatever it covers.
///
/// **Transforms are undone on the way down.** A parent's transform moves its
/// children's on-screen rects — measured on Chromium 151, a `scale(2)` parent
/// doubles the child's reported box — so a walk that compared the pointer against
/// raw layout bounds would hit-test a node where it *was not* drawn. Rather than
/// mapping every box forward, the pointer is mapped *backward* by the inverse at
/// each transformed node, which is one inversion per transformed node instead of
/// one matrix multiply per box.
///
/// It takes the painter and the input state to do this, which the pre-transform
/// version did not need: the transform can live in a variant slot, so
/// `hover:scale-105` is only visible through the *resolved* style. Reading the
/// base slot would have hit-tested the untransformed box for exactly the case
/// transforms are most used for.
pub fn hit_test(
    painter: &Painter,
    tables: &Tables,
    geometry: Geometry,
    state: &InputState,
    root: usize,
    px: f32,
    py: f32,
) -> i32 {
    let count = geometry.bounds.len();
    let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
    let flags = tables.u8s(NODES, protocol::nodes::FLAGS);
    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);
    let cols = StyleCols::of(tables);

    let mut hit = -1i32;
    // Each entry carries how far its ancestors have scrolled, and the pointer as
    // that node's ancestors' transforms have left it. Without the scroll, clicking
    // a scrolled row hits whichever node *used* to be under the cursor — the
    // pointer is in window coordinates and `bounds` are unscrolled, so one of them
    // has to move, and moving the box is what paint does too.
    let mut stack: Vec<(usize, f32, f32, f32, f32)> = vec![(root, 0.0, 0.0, px, py)];
    let mut budget = count.saturating_mul(2) + 16;
    // Reused per node so the reversal below does not allocate per level.
    let mut children: Vec<usize> = Vec::new();

    while let Some((node, sx, sy, mut px, mut py)) = stack.pop() {
        if budget == 0 {
            break;
        }
        budget -= 1;

        if node >= count || hidden.get(node).copied().unwrap_or(0) != 0 {
            continue;
        }

        let [bx, by, w, h] = geometry.bounds[node];
        let (x, y) = (bx - sx, by - sy);

        // Undone before this node's own box is tested, matching paint, which
        // concats before the node draws itself. A transform that cannot be
        // inverted is degenerate — a zero scale, so the node occupies no area —
        // and the whole subtree is correctly unhittable.
        //
        // **Built from the scroll-adjusted rect, not the layout one.** The pointer
        // is in window coordinates and `bounds` are unscrolled, so a matrix whose
        // origin came from `bounds` would turn the point about a centre displaced
        // by however far the page had scrolled. Translation survived that — it is
        // origin-independent — which is exactly why the bug hid: `hover:scale-110`
        // on a scrolled page lost its own hover while `hover:-translate-y-1` beside
        // it worked, and the golden could not see it because a 1500px-tall
        // screenshot never scrolls.
        // The *blended* transform, so the pointer follows the pixels through a
        // transition as well as into one. A hit test against the destination row
        // would put the clickable area where the box is going to be rather than
        // where it is, which is worst at exactly the moment the user is aiming at
        // a button that is still growing under the cursor.
        let blend = painter.blend_for(tables, node, state);
        if let Some(m) = transform_of(&cols, &blend, [x, y, w, h]) {
            match m.invert() {
                Some(inv) => {
                    let p = inv.map_point((px, py));
                    px = p.x;
                    py = p.y;
                }
                None => continue,
            }
        }

        if px < x || py < y || px >= x + w || py >= y + h {
            // A child can still overflow its parent's box, but the TypeScript
            // runtime pruned here too and nothing in the corpus relies on it.
            continue;
        }

        if flags.get(node).copied().unwrap_or(0) & protocol::flags::INTERACTIVE != 0 {
            // Later visits win, and the push order below makes "later" mean
            // "painted on top".
            hit = node as i32;
        }

        // Children are pushed **reversed** so they pop in document order, which
        // makes the visit sequence exactly [`Painter::paint`]'s. Pushed forwards
        // the stack visits the last sibling first and the *first* one wins — so
        // two overlapping absolute siblings would hit-test to the one underneath
        // while the user is pointing at the one on top.
        children.clear();
        let mut c = first.get(node).copied().unwrap_or(-1);
        while c >= 0 && (c as usize) < count {
            children.push(c as usize);
            c = next[c as usize];
            if children.len() > count {
                break;
            }
        }

        let own = geometry.scroll_of(node);
        stack.extend(
            children
                .iter()
                .rev()
                .map(|&c| (c, sx + own[0], sy + own[1], px, py)),
        );
    }

    hit
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Table;
    use crate::tables::Capacities;

    /// A generated box resolves `:hover` against its parent, not itself.
    ///
    /// This is the one part of `::before` that cannot be tested from the compiler
    /// side, and the one where being wrong is invisible: `hit_test` only returns
    /// `INTERACTIVE` nodes, so a generated box is never `state.hovered`, and
    /// without the redirection the compiled hover variant is simply unreachable.
    /// A rule that silently does nothing, which is exactly the failure class this
    /// codebase keeps trying to make impossible.
    #[test]
    fn a_generated_box_wears_its_parents_hover_style() {
        let mut tables = Tables::new(Capacities {
            nodes: 4,
            styles: 4,
            // Exactly one, deliberately. A spare row defaults to `node = 0`, which
            // leaves the column `[1, 0]` — unsorted, so the binary search below
            // walks the wrong half and reports the conditional node as absent.
            // `Uploader::uploadVariants` guards against this for real tables; a
            // test that allocated slack would have failed here for that reason
            // and looked like a bug in the redirection.
            variants: 1,
            variant_slots: 4,
            media: 1,
            lists: 1,
            tweens: 1,
            keyframes: 1,
            controls: 4,
            strings: 2,
            string_bytes: 16,
        });

        let nodes = Table::Nodes as usize;
        let variants = Table::Variants as usize;
        let slots = Table::VariantSlots as usize;

        // Node 0 is the button; node 1 is its `::before` box. Only the box is
        // conditional — the point is that it reads node 0's state.
        tables.set_u16(nodes, protocol::nodes::STYLE, 0, 0);
        tables.set_u16(nodes, protocol::nodes::STYLE, 1, 1);
        tables.set_i32(nodes, protocol::nodes::PARENT, 0, -1);
        tables.set_i32(nodes, protocol::nodes::PARENT, 1, 0);
        tables.set_u8(
            nodes,
            protocol::nodes::FLAGS,
            0,
            protocol::flags::INTERACTIVE,
        );
        tables.set_u8(nodes, protocol::nodes::FLAGS, 1, protocol::flags::GENERATED);

        tables.set_i32(variants, protocol::variants::NODE, 0, 1);
        tables.set_u32(variants, protocol::variants::MASK, 0, predicate::HOVER);
        tables.set_i32(variants, protocol::variants::RUN_START, 0, 0);
        tables.set_u16(slots, protocol::variant_slots::STYLE, 0, 1); // resting
        tables.set_u16(slots, protocol::variant_slots::STYLE, 1, 3); // hovered
        tables.commit();

        let mut painter = Painter::new();

        // `set_input_chains` is part of a frame now, not a nicety: `:hover` is
        // membership in the chain of the hovered node and its ancestors, and the chain
        // is walked once per frame rather than per node. A test that skipped it would be
        // asserting against an empty chain, which is the "nothing hovered" answer.

        // Nothing hovered: the box wears its resting style.
        let idle = InputState::none();
        painter.set_input_chains(&tables, &idle);
        assert_eq!(painter.style_for(&tables, 1, &idle), 1);

        // The *button* is hovered. The box is not, and never can be.
        let hovering_parent = InputState {
            hovered: 0,
            ..InputState::none()
        };
        painter.set_input_chains(&tables, &hovering_parent);
        assert_eq!(
            painter.style_for(&tables, 1, &hovering_parent),
            3,
            "`.btn:hover::before` must apply while the button is hovered"
        );

        // And the redirection is not a blanket "ask the parent": an ordinary node
        // still answers for itself, or hovering any parent would restyle its
        // children.
        //
        // Still true with ancestor propagation, and worth being sure of: the chain runs
        // *up* from the hovered node, so a child of a hovered node is not in it. Hover
        // reaches ancestors and never descendants, which is the whole difference between
        // this and a subtree restyle.
        tables.set_u8(nodes, protocol::nodes::FLAGS, 1, 0);
        tables.commit();
        painter.set_input_chains(&tables, &hovering_parent);
        assert_eq!(
            painter.style_for(&tables, 1, &hovering_parent),
            1,
            "a node that is not a generated box reads its own state"
        );
    }

    /// `:hover` reaches a node's ancestors; `:focus` does not. Both measured.
    ///
    /// This is the bug the exact comparison it replaced could not express: a hoverable
    /// card containing a button went dark the moment the pointer reached the button, and
    /// went dark *silently* — the compiler emitted the card's HOVER variant and nothing
    /// could ever select it.
    ///
    /// The tree is `card(0) > mid(1) > button(2)`, and every one of the three carries a
    /// HOVER and a FOCUS variant, so the assertion is about propagation rather than about
    /// which nodes happen to have rules.
    #[test]
    fn hover_reaches_the_ancestors_and_focus_does_not() {
        let mut tables = Tables::new(Capacities {
            nodes: 3,
            styles: 4,
            variants: 3,
            variant_slots: 12,
            media: 1,
            lists: 1,
            tweens: 1,
            keyframes: 1,
            controls: 4,
            strings: 1,
            string_bytes: 16,
        });

        let nodes = Table::Nodes as usize;
        let variants = Table::Variants as usize;
        let slots = Table::VariantSlots as usize;

        // Styles: 0 resting, 1 hovered, 2 focused, 3 both.
        for node in 0..3usize {
            tables.set_u16(NODES, protocol::nodes::STYLE, node, 0);
            tables.set_i32(
                NODES,
                protocol::nodes::PARENT,
                node,
                if node == 0 { -1 } else { node as i32 - 1 },
            );
            tables.set_u8(
                nodes,
                protocol::nodes::FLAGS,
                node,
                protocol::flags::INTERACTIVE,
            );

            // Two predicates, so the run is four long and the compacted index matters:
            // bit 0 is HOVER and bit 2 is FOCUS, so `compact` maps them to 1 and 2.
            tables.set_i32(variants, protocol::variants::NODE, node, node as i32);
            tables.set_u32(
                variants,
                protocol::variants::MASK,
                node,
                predicate::HOVER | predicate::FOCUS,
            );
            tables.set_i32(
                variants,
                protocol::variants::RUN_START,
                node,
                node as i32 * 4,
            );
            for (offset, style) in [(0, 0u16), (1, 1), (2, 2), (3, 3)] {
                tables.set_u16(
                    slots,
                    protocol::variant_slots::STYLE,
                    node * 4 + offset,
                    style,
                );
            }
        }
        tables.commit();

        let mut painter = Painter::new();

        // Pointing at the deepest node. Measured: `:hover` matches it *and* every
        // ancestor — `html body card mid btn`, all five.
        let hovering_button = InputState {
            hovered: 2,
            ..InputState::none()
        };
        painter.set_input_chains(&tables, &hovering_button);
        for node in 0..3 {
            assert_eq!(
                painter.style_for(&tables, node, &hovering_button),
                1,
                "node {node} is the hovered node or an ancestor of it"
            );
        }

        // Pointing at the middle one: the chain stops there, so the deepest node is
        // resting. Hover reaches ancestors and never descendants.
        let hovering_mid = InputState {
            hovered: 1,
            ..InputState::none()
        };
        painter.set_input_chains(&tables, &hovering_mid);
        assert_eq!(painter.style_for(&tables, 0, &hovering_mid), 1, "the card");
        assert_eq!(
            painter.style_for(&tables, 1, &hovering_mid),
            1,
            "the middle box"
        );
        assert_eq!(
            painter.style_for(&tables, 2, &hovering_mid),
            0,
            "a descendant of a hovered node is not hovered"
        );

        // Focus is the exception, and the reason it is measured rather than assumed:
        // `:focus` matched only `btn` where `:focus-within` matched the whole chain. So
        // this line stays an equality while the two above became membership.
        let focused_button = InputState {
            focused: 2,
            ..InputState::none()
        };
        painter.set_input_chains(&tables, &focused_button);
        assert_eq!(
            painter.style_for(&tables, 0, &focused_button),
            0,
            "the card"
        );
        assert_eq!(
            painter.style_for(&tables, 1, &focused_button),
            0,
            "the middle box"
        );
        assert_eq!(
            painter.style_for(&tables, 2, &focused_button),
            2,
            "only the focused node"
        );

        // And both at once resolve to the *combination* the compiler produced, which is
        // what the variant run is for — the card is hovered-not-focused while the button
        // is both.
        let both = InputState {
            hovered: 2,
            focused: 2,
            ..InputState::none()
        };
        painter.set_input_chains(&tables, &both);
        assert_eq!(
            painter.style_for(&tables, 0, &both),
            1,
            "hovered, not focused"
        );
        assert_eq!(
            painter.style_for(&tables, 2, &both),
            3,
            "hovered and focused"
        );
    }

    /// A `parent` cycle is a bounded walk, not a hung render thread.
    ///
    /// Bun-written memory is untrusted input and can say anything, including that two
    /// nodes are each other's parent. The chain walk is the newest thing to read that
    /// column, so it needs the same budget the paint walk has — a cycle would be a host
    /// bug, and hanging on one would be this file's.
    #[test]
    fn a_parent_cycle_does_not_hang_the_chain_walk() {
        let mut tables = Tables::new(Capacities {
            nodes: 2,
            styles: 1,
            variants: 1,
            variant_slots: 1,
            media: 1,
            lists: 1,
            tweens: 1,
            keyframes: 1,
            controls: 4,
            strings: 1,
            string_bytes: 16,
        });
        tables.set_i32(NODES, protocol::nodes::PARENT, 0, 1);
        tables.set_i32(NODES, protocol::nodes::PARENT, 1, 0);
        tables.commit();

        let mut painter = Painter::new();
        painter.set_input_chains(
            &tables,
            &InputState {
                hovered: 0,
                ..InputState::none()
            },
        );
        // Reaching here at all is the assertion. Both nodes are in the chain, which is
        // the honest consequence of a cycle: everything reachable is an "ancestor".
        assert_eq!(painter.style_for(&tables, 0, &InputState::none()), 0);
    }

    /// Tables holding one style slot, with the transform fields at their initial
    /// values so a test only has to say what it is changing.
    fn one_style() -> Tables {
        let mut tables = Tables::new(Capacities {
            nodes: 2,
            styles: 2,
            variants: 1,
            variant_slots: 2,
            media: 1,
            lists: 1,
            tweens: 1,
            keyframes: 1,
            controls: 4,
            strings: 2,
            string_bytes: 16,
        });
        let s = Table::Styles as usize;
        // The identities, which are 1 rather than 0 for the scales — the whole
        // reason `transform_of` cannot just read zeroed memory.
        tables.set_f32(s, protocol::styles::SCALE_X, 0, 1.0);
        tables.set_f32(s, protocol::styles::SCALE_Y, 0, 1.0);
        tables.set_f32(s, protocol::styles::TRANSFORM_ORIGIN_PERCENT_X, 0, 0.5);
        tables.set_f32(s, protocol::styles::TRANSFORM_ORIGIN_PERCENT_Y, 0, 0.5);
        tables.set_f32(s, protocol::styles::OPACITY, 0, 1.0);
        tables
    }

    fn assert_matrix(got: Matrix, want: [f32; 6], what: &str) {
        // CSS `matrix(a,b,c,d,e,f)` against Skia's row-major accessors.
        let mine = [
            got.scale_x(),
            got.skew_y(),
            got.skew_x(),
            got.scale_y(),
            got.translate_x(),
            got.translate_y(),
        ];
        for i in 0..6 {
            assert!(
                (mine[i] - want[i]).abs() < 1e-3,
                "{what}: component {i} was {}, expected {} (full: {mine:?})",
                mine[i],
                want[i]
            );
        }
    }

    /// The composed matrix must equal the one Chromium computes.
    ///
    /// The expected values are readings from `probes/transform-composition.html`
    /// on Chromium 151, and the same numbers `css.test.ts` asserts on the compiler
    /// side. Both ends of the boundary are pinned to one measurement, so a
    /// composition order that drifts on either side shows up here rather than as a
    /// frame that looks slightly wrong.
    ///
    /// The origin is `0 0` throughout, because these matrices were measured with
    /// the transform applied about the element's origin — the probe's own
    /// `transform-origin` cases cover the centring separately.
    #[test]
    fn the_composed_matrix_matches_chromium() {
        let s = Table::Styles as usize;
        let at_origin = |t: &mut Tables| {
            t.set_f32(s, protocol::styles::TRANSFORM_ORIGIN_PERCENT_X, 0, 0.0);
            t.set_f32(s, protocol::styles::TRANSFORM_ORIGIN_PERCENT_Y, 0, 0.0);
        };
        let bounds = [0.0, 0.0, 100.0, 50.0];

        // translate(10px,20px) rotate(30deg) scale(2,3)
        let mut t = one_style();
        at_origin(&mut t);
        t.set_f32(s, protocol::styles::TRANSLATE_X, 0, 10.0);
        t.set_f32(s, protocol::styles::TRANSLATE_Y, 0, 20.0);
        t.set_f32(s, protocol::styles::ROTATE, 0, 30.0);
        t.set_f32(s, protocol::styles::SCALE_X, 0, 2.0);
        t.set_f32(s, protocol::styles::SCALE_Y, 0, 3.0);
        t.commit();
        assert_matrix(
            transform_of(&StyleCols::of(&t), &Blend::solid(0), bounds).expect("not the identity"),
            [1.73205, 1.0, -1.5, 2.59808, 10.0, 20.0],
            "translate rotate scale",
        );

        // skewX(10deg) skewY(5deg) — the pair that does not commute, so this also
        // pins which of the two dziri applies first.
        let mut t = one_style();
        at_origin(&mut t);
        t.set_f32(s, protocol::styles::SKEW_X, 0, 10.0);
        t.set_f32(s, protocol::styles::SKEW_Y, 0, 5.0);
        t.commit();
        assert_matrix(
            transform_of(&StyleCols::of(&t), &Blend::solid(0), bounds).expect("not the identity"),
            [1.01543, 0.0874887, 0.176327, 1.0, 0.0, 0.0],
            "skewX then skewY",
        );

        // The full canonical order.
        let mut t = one_style();
        at_origin(&mut t);
        t.set_f32(s, protocol::styles::TRANSLATE_X, 0, 10.0);
        t.set_f32(s, protocol::styles::TRANSLATE_Y, 0, 20.0);
        t.set_f32(s, protocol::styles::ROTATE, 0, 30.0);
        t.set_f32(s, protocol::styles::SKEW_X, 0, 10.0);
        t.set_f32(s, protocol::styles::SKEW_Y, 0, 5.0);
        t.set_f32(s, protocol::styles::SCALE_X, 0, 2.0);
        t.set_f32(s, protocol::styles::SCALE_Y, 0, 3.0);
        t.commit();
        assert_matrix(
            transform_of(&StyleCols::of(&t), &Blend::solid(0), bounds).expect("not the identity"),
            [1.67128, 1.16696, -1.04189, 2.86257, 10.0, 20.0],
            "translate rotate skew scale",
        );
    }

    /// An untransformed node costs nothing, and a percentage needs the box.
    #[test]
    fn the_identity_is_none_and_percentages_resolve_against_the_box() {
        let s = Table::Styles as usize;

        let mut t = one_style();
        t.commit();
        assert!(
            transform_of(
                &StyleCols::of(&t),
                &Blend::solid(0),
                [0.0, 0.0, 100.0, 50.0]
            )
            .is_none(),
            "a node with no transform must not pay for a matrix"
        );

        // `translateX(50%)` on a 100px-wide box is 50px — measured, and the reason
        // the percentage cannot be folded at compile time.
        let mut t = one_style();
        t.set_f32(s, protocol::styles::TRANSLATE_PERCENT_X, 0, 0.5);
        t.set_f32(s, protocol::styles::TRANSLATE_PERCENT_Y, 0, 1.0);
        t.commit();
        let m = transform_of(
            &StyleCols::of(&t),
            &Blend::solid(0),
            [0.0, 0.0, 100.0, 50.0],
        )
        .expect("not the identity");
        assert_matrix(m, [1.0, 0.0, 0.0, 1.0, 50.0, 50.0], "percentage translate");

        // The same declaration on a different box is a different matrix, which is
        // the whole point of resolving it here.
        let m = transform_of(&StyleCols::of(&t), &Blend::solid(0), [0.0, 0.0, 40.0, 10.0])
            .expect("not the identity");
        assert_matrix(
            m,
            [1.0, 0.0, 0.0, 1.0, 20.0, 10.0],
            "percentage on a smaller box",
        );
    }

    /// `transform-origin` is what a rotation turns about, and it defaults to the
    /// centre of the box rather than to its corner.
    #[test]
    fn rotation_turns_about_the_origin() {
        let s = Table::Styles as usize;
        // A 100x50 box at (0,0), rotated a quarter turn about its own centre.
        // The centre is (50,25) and must be a fixed point.
        let mut t = one_style();
        t.set_f32(s, protocol::styles::ROTATE, 0, 90.0);
        t.commit();

        let m = transform_of(
            &StyleCols::of(&t),
            &Blend::solid(0),
            [0.0, 0.0, 100.0, 50.0],
        )
        .expect("not the identity");
        let centre = m.map_point((50.0, 25.0));
        assert!(
            (centre.x - 50.0).abs() < 1e-3 && (centre.y - 25.0).abs() < 1e-3,
            "the default origin is the centre, so the centre must not move: {centre:?}"
        );

        // The corner swings a quarter turn about that centre: (0,0) -> (75,-25).
        let corner = m.map_point((0.0, 0.0));
        assert!(
            (corner.x - 75.0).abs() < 1e-3 && (corner.y + 25.0).abs() < 1e-3,
            "corner should swing to (75,-25), got {corner:?}"
        );
    }

    /// Opacity is `None` unless it is actually doing something, because the layer
    /// it implies is expensive.
    #[test]
    fn opacity_is_none_when_opaque() {
        let s = Table::Styles as usize;

        let mut t = one_style();
        t.commit();
        assert_eq!(opacity_of(&StyleCols::of(&t), &Blend::solid(0)), None);

        let mut t = one_style();
        t.set_f32(s, protocol::styles::OPACITY, 0, 0.25);
        t.commit();
        assert_eq!(opacity_of(&StyleCols::of(&t), &Blend::solid(0)), Some(0.25));

        // NaN must read as opaque rather than making the subtree vanish.
        let mut t = one_style();
        t.set_f32(s, protocol::styles::OPACITY, 0, f32::NAN);
        t.commit();
        assert_eq!(opacity_of(&StyleCols::of(&t), &Blend::solid(0)), None);
    }

    /// A placeholder shows only while its field is empty.
    ///
    /// The condition `paint` consults, tested directly rather than through a rendered
    /// frame, because "a grey word is not on screen" is a claim about pixels that a
    /// golden states far less precisely than this does — and both directions matter. A
    /// placeholder that never hides sits underneath the user's own text; one that never
    /// shows is the bug this whole feature was written for.
    #[test]
    fn a_placeholder_is_hidden_exactly_while_its_field_has_text() {
        // 0: the field. 1: its editable run. 2: the placeholder box.
        let mut tables = Tables::new(Capacities {
            nodes: 3,
            styles: 1,
            variants: 1,
            variant_slots: 1,
            media: 1,
            lists: 1,
            tweens: 1,
            keyframes: 1,
            controls: 1,
            strings: 2,
            string_bytes: 32,
        });

        let nodes = Table::Nodes as usize;
        for n in 0..3 {
            tables.set_i32(nodes, protocol::nodes::FIRST_CHILD, n, -1);
            tables.set_i32(nodes, protocol::nodes::NEXT_SIBLING, n, -1);
            tables.set_i32(nodes, protocol::nodes::TEXT, n, -1);
        }
        tables.set_i32(nodes, protocol::nodes::PARENT, 0, -1);
        tables.set_i32(nodes, protocol::nodes::PARENT, 1, 0);
        tables.set_i32(nodes, protocol::nodes::PARENT, 2, 0);
        tables.set_i32(nodes, protocol::nodes::FIRST_CHILD, 0, 1);
        tables.set_i32(nodes, protocol::nodes::NEXT_SIBLING, 1, 2);

        tables.set_u8(nodes, protocol::nodes::FLAGS, 1, protocol::flags::EDITABLE);
        tables.set_u8(
            nodes,
            protocol::nodes::FLAGS,
            2,
            protocol::flags::PLACEHOLDER | protocol::flags::GENERATED,
        );

        let mut cursor = 0;
        tables.push_string(0, "", &mut cursor).expect("arena");
        tables.push_string(1, "typed", &mut cursor).expect("arena");
        tables.set_i32(nodes, protocol::nodes::TEXT, 1, 0);
        tables.commit();

        let read = |t: &Tables| {
            let first = t.i32s(nodes, protocol::nodes::FIRST_CHILD).to_vec();
            let next = t.i32s(nodes, protocol::nodes::NEXT_SIBLING).to_vec();
            let flags = t.u8s(nodes, protocol::nodes::FLAGS).to_vec();
            let text = t.i32s(nodes, protocol::nodes::TEXT).to_vec();
            field_has_text(t, &first, &next, &flags, &text, 3, 2)
        };

        assert!(
            !read(&tables),
            "the run holds the empty string, so the placeholder must show"
        );

        // The same tree with text in the field.
        tables.set_i32(nodes, protocol::nodes::TEXT, 1, 1);
        tables.commit();
        assert!(
            read(&tables),
            "the run holds \"typed\", so the placeholder must be hidden"
        );

        // A field with no run at all — an *unbound* `<input>` as things stand. Nothing
        // owns its value, so it is permanently empty and its placeholder permanently
        // shows. Asserted so that when an engine-owned buffer lands, the test that has
        // to change is this one, and it says why.
        tables.set_i32(nodes, protocol::nodes::FIRST_CHILD, 0, 2);
        tables.commit();
        assert!(
            !read(&tables),
            "a field with no editable run has no text, so its placeholder shows"
        );
    }
}
