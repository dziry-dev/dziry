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

use crate::protocol::{self, display, node_kind, predicate};
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
fn thumb_paint(authored: u32, tables: &Tables, slot: usize, phase: BarPhase) -> u32 {
    if authored >> 24 != 0 {
        let alpha = (authored >> 24).max(u32::from(phase.alpha()));
        return (authored & 0x00ff_ffff) | (alpha.min(255) << 24);
    }

    let fg = tables
        .u32s(STYLES, protocol::styles::FG)
        .get(slot)
        .copied()
        .unwrap_or(0);
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
fn transform_of(tables: &Tables, slot: usize, bounds: [f32; 4]) -> Option<Matrix> {
    use protocol::styles as f;
    let g = |field: usize, dflt: f32| -> f32 {
        tables
            .f32s(STYLES, field)
            .get(slot)
            .copied()
            .unwrap_or(dflt)
    };

    let (tx, ty) = (g(f::TRANSLATE_X, 0.0), g(f::TRANSLATE_Y, 0.0));
    let (px, py) = (
        g(f::TRANSLATE_PERCENT_X, 0.0),
        g(f::TRANSLATE_PERCENT_Y, 0.0),
    );
    let rotate = g(f::ROTATE, 0.0);
    let (sx, sy) = (g(f::SCALE_X, 1.0), g(f::SCALE_Y, 1.0));
    let (kx, ky) = (g(f::SKEW_X, 0.0), g(f::SKEW_Y, 0.0));

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
    let ox = x + g(f::TRANSFORM_ORIGIN_PERCENT_X, 0.5) * w + g(f::TRANSFORM_ORIGIN_X, 0.0);
    let oy = y + g(f::TRANSFORM_ORIGIN_PERCENT_Y, 0.5) * h + g(f::TRANSFORM_ORIGIN_Y, 0.0);

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
fn opacity_of(tables: &Tables, slot: usize) -> Option<f32> {
    let a = tables
        .f32s(STYLES, protocol::styles::OPACITY)
        .get(slot)
        .copied()
        .unwrap_or(1.0);
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

pub struct Painter {
    /// The only paint there is. Borders are a two-rect fill rather than a stroke,
    /// so nothing here needs `PaintStyle::Stroke` or a per-node stroke width.
    fill: Paint,
    /// Predicate bits that hold for every node this frame.
    ///
    /// Media queries and colour scheme land here. They are the engine's to
    /// evaluate, not the host's: the engine owns the window, so it re-evaluates
    /// them between a resize and the relayout, and a resize repaints correctly
    /// even while Bun is busy.
    globals: u32,
}

impl Default for Painter {
    fn default() -> Self {
        Self::new()
    }
}

impl Painter {
    /// Sets the globally-true predicates for subsequent frames.
    pub fn set_globals(&mut self, globals: u32) {
        self.globals = globals;
    }

    pub fn globals(&self) -> u32 {
        self.globals
    }

    pub fn new() -> Self {
        let mut fill = Paint::default();
        fill.set_anti_alias(true);
        fill.set_style(PaintStyle::Fill);

        Self { fill, globals: 0 }
    }

    /// Resolves which precompiled style a node wears right now.
    ///
    /// The node declares a `mask` of the predicates its styling depends on and
    /// owns a run of `1 << popcount(mask)` styles. This intersects the live
    /// predicates with that mask, compacts the result to a run index, and reads
    /// one `u16` — so a node styled by both `:hover` and `:focus` gets the entry
    /// the compiler resolved for *both*, rather than whichever the old precedence
    /// order happened to rank first.
    ///
    /// Still free for the nodes that do not participate: the early return means
    /// only nodes that are actually hovered, pressed or focused — or that read a
    /// global predicate — reach the binary search.
    pub(crate) fn style_for(&self, tables: &Tables, node: usize, state: &InputState) -> usize {
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

        // Which predicates hold for *this* node right now. The per-node ones come
        // from the input state; the global ones (media queries, colour scheme)
        // are the same for everybody and were evaluated once this frame.
        let mut live = self.globals;
        if subject == state.hovered {
            live |= predicate::HOVER;
        }
        if subject == state.pressed {
            live |= predicate::ACTIVE;
        }
        if subject == state.focused {
            live |= predicate::FOCUS;
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
            let slot = self.style_for(tables, node, state);
            if display_of(tables, slot) == display::NONE {
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
            let matrix = transform_of(tables, slot, geometry.bounds[node]);
            let alpha = opacity_of(tables, slot);

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
                self.node(canvas, tables, geometry.bounds, state, measurer, node);
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
        let slot = self.style_for(tables, node, state);
        // `CLIP` belongs here and not in `is_scrollable`: it clips like `hidden` and
        // is deliberately *not* a scroll container, which is the whole reason CSS
        // distinguishes the two.
        let contains = |field: usize| {
            matches!(
                tables.u8s(STYLES, field).get(slot).copied(),
                Some(
                    protocol::overflow::HIDDEN
                        | protocol::overflow::ELLIPSIS
                        | protocol::overflow::SCROLL
                        | protocol::overflow::CLIP
                )
            )
        };
        (
            contains(protocol::styles::OVERFLOW_X),
            contains(protocol::styles::OVERFLOW_Y),
        )
    }

    /// The border width, which the clip has to sit inside.
    fn border_of(&self, tables: &Tables, node: usize, state: &InputState) -> f32 {
        let slot = self.style_for(tables, node, state);
        match tables
            .f32s(STYLES, protocol::styles::BORDER_WIDTH)
            .get(slot)
            .copied()
        {
            Some(width) if width.is_finite() && width > 0.0 => width,
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

        let slot = self.style_for(tables, node, state);
        let colour =
            |field: usize| -> u32 { tables.u32s(STYLES, field).get(slot).copied().unwrap_or(0) };

        let thumb_colour = colour(protocol::styles::SCROLLBAR_THUMB);
        let track_colour = colour(protocol::styles::SCROLLBAR_TRACK);

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

            self.fill
                .set_color(Color::from(thumb_paint(thumb_colour, tables, slot, phase)));
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
        let bar_width = tables
            .u8s(STYLES, protocol::styles::SCROLLBAR_WIDTH)
            .get(self.style_for(tables, node, state))
            .copied()
            .unwrap_or(protocol::scrollbar_width::AUTO);
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
        state: &InputState,
        measurer: &mut Measurer,
        node: usize,
    ) {
        use protocol::styles as f;

        let slot = self.style_for(tables, node, state);
        let g =
            |field: usize| -> f32 { tables.f32s(STYLES, field).get(slot).copied().unwrap_or(0.0) };
        let c =
            |field: usize| -> u32 { tables.u32s(STYLES, field).get(slot).copied().unwrap_or(0) };

        let [x, y, w, h] = bounds[node];
        // Sanitised once: both the fill and the border ring build round rects from
        // this, and Skia has no defined answer for a NaN or infinite radius. The
        // old `radius > 0.0` test happened to reject NaN and let infinity through.
        // Sanitised per corner, in Skia's order: top-left, top-right,
        // bottom-right, bottom-left.
        let corner = |field: usize| -> f32 {
            match g(field) {
                r if r.is_finite() && r > 0.0 => r,
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
        if text.is_empty() {
            return;
        }

        let size = g(f::FONT_SIZE);
        let weight = tables
            .u16s(STYLES, f::FONT_WEIGHT)
            .get(slot)
            .copied()
            .unwrap_or(400);
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
        }
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

        // Undone before this node's own box is tested, matching paint, which
        // concats before the node draws itself. A transform that cannot be
        // inverted is degenerate — a zero scale, so the node occupies no area —
        // and the whole subtree is correctly unhittable.
        if let Some(m) = transform_of(
            tables,
            painter.style_for(tables, node, state),
            geometry.bounds[node],
        ) {
            match m.invert() {
                Some(inv) => {
                    let p = inv.map_point((px, py));
                    px = p.x;
                    py = p.y;
                }
                None => continue,
            }
        }

        let [bx, by, w, h] = geometry.bounds[node];
        let (x, y) = (bx - sx, by - sy);
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

        let painter = Painter::new();

        // Nothing hovered: the box wears its resting style.
        let idle = InputState::none();
        assert_eq!(painter.style_for(&tables, 1, &idle), 1);

        // The *button* is hovered. The box is not, and never can be.
        let hovering_parent = InputState {
            hovered: 0,
            ..InputState::none()
        };
        assert_eq!(
            painter.style_for(&tables, 1, &hovering_parent),
            3,
            "`.btn:hover::before` must apply while the button is hovered"
        );

        // And the redirection is not a blanket "ask the parent": an ordinary node
        // still answers for itself, or hovering any parent would restyle its
        // children.
        tables.set_u8(nodes, protocol::nodes::FLAGS, 1, 0);
        tables.commit();
        assert_eq!(
            painter.style_for(&tables, 1, &hovering_parent),
            1,
            "a node that is not a generated box reads its own state"
        );
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
            transform_of(&t, 0, bounds).expect("not the identity"),
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
            transform_of(&t, 0, bounds).expect("not the identity"),
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
            transform_of(&t, 0, bounds).expect("not the identity"),
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
            transform_of(&t, 0, [0.0, 0.0, 100.0, 50.0]).is_none(),
            "a node with no transform must not pay for a matrix"
        );

        // `translateX(50%)` on a 100px-wide box is 50px — measured, and the reason
        // the percentage cannot be folded at compile time.
        let mut t = one_style();
        t.set_f32(s, protocol::styles::TRANSLATE_PERCENT_X, 0, 0.5);
        t.set_f32(s, protocol::styles::TRANSLATE_PERCENT_Y, 0, 1.0);
        t.commit();
        let m = transform_of(&t, 0, [0.0, 0.0, 100.0, 50.0]).expect("not the identity");
        assert_matrix(m, [1.0, 0.0, 0.0, 1.0, 50.0, 50.0], "percentage translate");

        // The same declaration on a different box is a different matrix, which is
        // the whole point of resolving it here.
        let m = transform_of(&t, 0, [0.0, 0.0, 40.0, 10.0]).expect("not the identity");
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

        let m = transform_of(&t, 0, [0.0, 0.0, 100.0, 50.0]).expect("not the identity");
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
        assert_eq!(opacity_of(&t, 0), None);

        let mut t = one_style();
        t.set_f32(s, protocol::styles::OPACITY, 0, 0.25);
        t.commit();
        assert_eq!(opacity_of(&t, 0), Some(0.25));

        // NaN must read as opaque rather than making the subtree vanish.
        let mut t = one_style();
        t.set_f32(s, protocol::styles::OPACITY, 0, f32::NAN);
        t.commit();
        assert_eq!(opacity_of(&t, 0), None);
    }
}
