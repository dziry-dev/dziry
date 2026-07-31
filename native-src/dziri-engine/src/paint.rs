//! Laid-out nodes into Skia draw calls.
//!
//! A direct port of `src/runtime/paint.ts`, kept deliberately faithful so the
//! migration is comparable frame to frame: same fill-then-border-then-text order,
//! same inset stroke, same button label centring, same baseline arithmetic.
//!
//! Interaction state costs one integer comparison per node. The compiler already
//! decided what a hovered or pressed node looks like, so there is nothing to
//! resolve here beyond picking an index.

use skia_safe::{Canvas, Color, Paint, PaintStyle, Rect};

use crate::protocol::{self, node_kind, predicate};
use crate::tables::Tables;
use crate::text::Measurer;

const NODES: usize = protocol::Table::Nodes as usize;
const STYLES: usize = protocol::Table::Styles as usize;
const VARIANTS: usize = protocol::Table::Variants as usize;
const VARIANT_SLOTS: usize = protocol::Table::VariantSlots as usize;

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
}

impl InputState {
    pub fn none() -> Self {
        Self {
            hovered: -1,
            pressed: -1,
            focused: -1,
        }
    }
}

pub struct Painter {
    fill: Paint,
    stroke: Paint,
    /// Predicate bits that hold for every node this frame.
    ///
    /// Media queries and colour scheme land here. They are the engine's to
    /// evaluate, not the host's: the engine owns the window, so it re-evaluates
    /// them between a resize and the relayout, and a resize repaints correctly
    /// even while Bun is busy.
    globals: u32,
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

        let mut stroke = Paint::default();
        stroke.set_anti_alias(true);
        stroke.set_style(PaintStyle::Stroke);

        Self { fill, stroke, globals: 0 }
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
    fn style_for(&self, tables: &Tables, node: usize, state: &InputState) -> usize {
        let base = tables
            .u16s(NODES, protocol::nodes::STYLE)
            .get(node)
            .copied()
            .unwrap_or(0) as usize;

        let i = node as i32;

        // Which predicates hold for *this* node right now. The per-node ones come
        // from the input state; the global ones (media queries, colour scheme)
        // are the same for everybody and were evaluated once this frame.
        let mut live = self.globals;
        if i == state.hovered {
            live |= predicate::HOVER;
        }
        if i == state.pressed {
            live |= predicate::ACTIVE;
        }
        if i == state.focused {
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
        bounds: &[[f32; 4]],
        state: &InputState,
        measurer: &mut Measurer,
        root: usize,
    ) {
        let count = bounds.len();
        let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
        let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
        let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

        // Pre-order, iterative: children paint over their parents, and a hostile
        // tree must not be able to overflow the render thread's stack.
        let mut stack = vec![root];
        let mut siblings: Vec<usize> = Vec::with_capacity(16);
        let mut budget = count.saturating_mul(2) + 16;

        while let Some(node) = stack.pop() {
            if budget == 0 {
                break;
            }
            budget -= 1;

            if node >= count || hidden.get(node).copied().unwrap_or(0) != 0 {
                continue;
            }

            self.node(canvas, tables, bounds, state, measurer, node);

            siblings.clear();
            let mut c = first.get(node).copied().unwrap_or(-1);
            while c >= 0 && (c as usize) < count {
                siblings.push(c as usize);
                c = next[c as usize];
            }
            // Reversed, because the stack pops last-in first.
            stack.extend(siblings.iter().rev().copied());
        }
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
        let g = |field: usize| -> f32 { tables.f32s(STYLES, field).get(slot).copied().unwrap_or(0.0) };
        let c = |field: usize| -> u32 { tables.u32s(STYLES, field).get(slot).copied().unwrap_or(0) };

        let [x, y, w, h] = bounds[node];
        let radius = g(f::RADIUS);
        let bg = c(f::BG);

        // A zero alpha channel means the box contributes no fill at all.
        if bg >> 24 != 0 && w > 0.0 && h > 0.0 {
            let rect = Rect::from_xywh(x, y, w, h);
            self.fill.set_color(Color::from(bg));
            if radius > 0.0 {
                canvas.draw_round_rect(rect, radius, radius, &self.fill);
            } else {
                canvas.draw_rect(rect, &self.fill);
            }
        }

        let border_width = g(f::BORDER_WIDTH);
        let border_color = c(f::BORDER_COLOR);
        if border_width > 0.0 && border_color >> 24 != 0 && w > 0.0 && h > 0.0 {
            // Inset by half the stroke so the border sits inside the node's bounds.
            let half = border_width / 2.0;
            let rect = Rect::from_xywh(x + half, y + half, w - border_width, h - border_width);
            self.stroke.set_color(Color::from(border_color));
            self.stroke.set_stroke_width(border_width);
            canvas.draw_round_rect(rect, radius, radius, &self.stroke);
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

        if kind == node_kind::BUTTON {
            // Centre the label in the content box, so asymmetric padding is
            // honoured rather than averaged away.
            let (advance, line_height) = measurer.measure(text, size, weight, w);
            let ascent = measurer.face(size, weight).ascent;
            let box_w = w - g(f::PAD_LEFT) - g(f::PAD_RIGHT);
            let box_h = h - g(f::PAD_TOP) - g(f::PAD_BOTTOM);

            let tx = x + g(f::PAD_LEFT) + (box_w - advance) / 2.0;
            let ty = y + g(f::PAD_TOP) + (box_h - line_height) / 2.0 - ascent;
            let font = &measurer.face(size, weight).font;
            canvas.draw_str(text, (tx, ty), font, &self.fill);
        } else {
            // Ascent is negative, so subtracting it moves down to the baseline.
            let ascent = measurer.face(size, weight).ascent;
            let font = &measurer.face(size, weight).font;
            canvas.draw_str(text, (x, y - ascent), font, &self.fill);
        }
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
pub fn hit_test(tables: &Tables, bounds: &[[f32; 4]], root: usize, px: f32, py: f32) -> i32 {
    let count = bounds.len();
    let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
    let flags = tables.u8s(NODES, protocol::nodes::FLAGS);
    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

    let mut hit = -1i32;
    let mut stack = vec![root];
    let mut budget = count.saturating_mul(2) + 16;
    // Reused per node so the reversal below does not allocate per level.
    let mut children: Vec<usize> = Vec::new();

    while let Some(node) = stack.pop() {
        if budget == 0 {
            break;
        }
        budget -= 1;

        if node >= count || hidden.get(node).copied().unwrap_or(0) != 0 {
            continue;
        }

        let [x, y, w, h] = bounds[node];
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
        stack.extend(children.iter().rev());
    }

    hit
}
