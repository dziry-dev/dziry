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

use crate::protocol::{self, node_kind};
use crate::tables::Tables;
use crate::text::Measurer;

const NODES: usize = protocol::Table::Nodes as usize;
const STYLES: usize = protocol::Table::Styles as usize;
const STATES: usize = protocol::Table::States as usize;

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
}

impl Painter {
    pub fn new() -> Self {
        let mut fill = Paint::default();
        fill.set_anti_alias(true);
        fill.set_style(PaintStyle::Fill);

        let mut stroke = Paint::default();
        stroke.set_anti_alias(true);
        stroke.set_style(PaintStyle::Stroke);

        Self { fill, stroke }
    }

    /// Resolves which precompiled style a node wears right now.
    ///
    /// The early return is what makes the sparse state table free: at most three
    /// nodes are involved in an interaction, so every other node skips the lookup
    /// entirely. Precedence is pressed → hover → focus → base, each falling
    /// through when it has no style of its own.
    fn style_for(&self, tables: &Tables, node: usize, state: &InputState) -> usize {
        let base = tables
            .u16s(NODES, protocol::nodes::STYLE)
            .get(node)
            .copied()
            .unwrap_or(0) as usize;

        let i = node as i32;
        if i != state.pressed && i != state.hovered && i != state.focused {
            return base;
        }

        let ids = tables.i32s(STATES, protocol::states::NODE);
        let row = match ids.binary_search(&i) {
            Ok(r) => r,
            Err(_) => return base,
        };

        let hover = tables.i32s(STATES, protocol::states::HOVER)[row];
        let active = tables.i32s(STATES, protocol::states::ACTIVE)[row];
        let focus = tables.i32s(STATES, protocol::states::FOCUS)[row];

        if i == state.pressed && i == state.hovered {
            if active >= 0 {
                return active as usize;
            }
            if hover >= 0 {
                return hover as usize;
            }
        } else if i == state.hovered && hover >= 0 {
            return hover as usize;
        }
        if i == state.focused && focus >= 0 {
            return focus as usize;
        }

        base
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

/// Deepest interactive node containing the point, or `-1`.
///
/// Walks the live tree rather than a sorted `interactive` array: arena rows are
/// numbered by slot, so after a list reorder those two orders diverge and only
/// the tree matches what the user sees.
pub fn hit_test(tables: &Tables, bounds: &[[f32; 4]], px: f32, py: f32) -> i32 {
    let count = bounds.len();
    let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
    let flags = tables.u8s(NODES, protocol::nodes::FLAGS);
    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

    let mut hit = -1i32;
    let mut stack = vec![0usize];
    let mut budget = count.saturating_mul(2) + 16;

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
            // Deeper nodes are visited later and win, matching paint order.
            hit = node as i32;
        }

        let mut c = first.get(node).copied().unwrap_or(-1);
        while c >= 0 && (c as usize) < count {
            stack.push(c as usize);
            c = next[c as usize];
        }
    }

    hit
}
