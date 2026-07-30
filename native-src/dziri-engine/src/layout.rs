//! Taffy over the shared tables.
//!
//! Taffy earned its place in the A0 spike by being *faster than the hand-written
//! engine when nothing is dirty* (0.050 ms vs 0.162 ms on 1203 nodes) and by
//! supporting CSS Grid, which the hand-written one never would. The only thing
//! that made it slow was the text-measure callback crossing into Bun; here it
//! calls [`crate::text::Measurer`] directly.
//!
//! # Absolute bounds, not Taffy's
//!
//! Taffy reports each node's location **relative to its parent**. Paint,
//! hit-testing and the imperative `rect()` API all want absolute coordinates, so
//! the read-back walks the tree once and accumulates offsets. Getting this wrong
//! is invisible until a nested node is off by its ancestors' padding.

use taffy::prelude::*;
use taffy::style::{
    AlignContent, AlignItems, AlignSelf, Dimension, Display, FlexDirection, FlexWrap,
    GridPlacement, LengthPercentage, LengthPercentageAuto, Position, Style,
};
use taffy::{Rect, Size, TaffyTree};

use crate::protocol::{self, align, display as display_enum, flex_direction, flex_wrap, justify};
use crate::tables::Tables;
use crate::text::Measurer;

const NODES: usize = protocol::Table::Nodes as usize;
const STYLES: usize = protocol::Table::Styles as usize;

pub struct LayoutTree {
    tree: TaffyTree<u32>,
    /// Our node index -> Taffy's id. Index is the identity everywhere else in
    /// the system, so this is the only place the mapping exists.
    ids: Vec<NodeId>,
    /// Absolute bounds, row-major, published to the layout table after compute.
    bounds: Vec<[f32; 4]>,
    root: usize,
}

impl LayoutTree {
    pub fn new() -> Self {
        Self {
            tree: TaffyTree::new(),
            ids: Vec::new(),
            bounds: Vec::new(),
            root: 0,
        }
    }

    pub fn bounds(&self) -> &[[f32; 4]] {
        &self.bounds
    }

    pub fn bounds_of(&self, node: usize) -> Option<[f32; 4]> {
        self.bounds.get(node).copied()
    }

    /// Rebuilds the tree's shape from `nodes.firstChild` / `nextSibling`.
    ///
    /// Called on the first commit and whenever a commit reports a structural
    /// change — which, for a dynamic list, is a relink of one node's children.
    pub fn rebuild(&mut self, tables: &Tables, root: usize) -> Result<(), String> {
        let count = tables.capacities().nodes as usize;
        self.root = root;

        self.tree = TaffyTree::with_capacity(count);
        self.ids = Vec::with_capacity(count);
        self.bounds = vec![[0.0; 4]; count];

        for i in 0..count {
            let id = self
                .tree
                .new_leaf_with_context(Style::default(), i as u32)
                .map_err(|e| format!("taffy new_leaf: {e:?}"))?;
            self.ids.push(id);
        }

        validate_tree(tables, root, count)?;
        self.relink(tables)?;
        Ok(())
    }

    /// Rewrites every node's child list from the table's chains.
    ///
    /// [`validate_tree`] has already proved the *reachable* tree is acyclic; the
    /// budget here covers the rest, because this walks every node including
    /// unreachable ones — spare capacity and abandoned arena regions, which a bad
    /// write could still have left a sibling cycle in.
    fn relink(&mut self, tables: &Tables) -> Result<(), String> {
        let count = self.ids.len();
        let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
        let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

        let mut children: Vec<NodeId> = Vec::with_capacity(16);
        let mut budget = count.saturating_mul(2) + 16;

        for i in 0..count {
            children.clear();
            let mut c = first.get(i).copied().unwrap_or(-1);
            while c >= 0 {
                let ci = c as usize;
                if ci >= count {
                    return Err(format!("node {i} has child {c}, past the {count}-node table"));
                }
                if budget == 0 {
                    return Err(format!(
                        "child chain from node {i} exceeded its budget — a cycle in \
                         firstChild/nextSibling"
                    ));
                }
                budget -= 1;
                children.push(self.ids[ci]);
                c = next.get(ci).copied().unwrap_or(-1);
            }

            self.tree
                .set_children(self.ids[i], &children)
                .map_err(|e| format!("taffy set_children on node {i}: {e:?}"))?;
        }

        Ok(())
    }

    /// Pushes a node's resolved style into Taffy.
    pub fn apply_style(&mut self, tables: &Tables, node: usize) -> Result<(), String> {
        let style = style_of(tables, node);
        self.tree
            .set_style(self.ids[node], style)
            .map_err(|e| format!("taffy set_style on node {node}: {e:?}"))
    }

    pub fn apply_all_styles(&mut self, tables: &Tables) -> Result<(), String> {
        for i in 0..self.ids.len() {
            self.apply_style(tables, i)?;
        }
        Ok(())
    }

    /// Marks a node's measured size stale — a text change, nothing else.
    pub fn mark_dirty(&mut self, node: usize) {
        if let Some(id) = self.ids.get(node) {
            let _ = self.tree.mark_dirty(*id);
        }
    }

    pub fn node_count(&self) -> usize {
        self.ids.len()
    }

    /// Lays out into `width` x `height` and publishes absolute bounds.
    pub fn compute(
        &mut self,
        tables: &Tables,
        measurer: &mut Measurer,
        width: f32,
        height: f32,
    ) -> Result<(), String> {
        if self.ids.is_empty() {
            return Ok(());
        }
        let root = *self
            .ids
            .get(self.root)
            .ok_or_else(|| format!("root node {} is outside the table", self.root))?;

        // Borrowed before the closure so it captures the tables, not `self`.
        let text = tables.i32s(NODES, protocol::nodes::TEXT);
        let flags = tables.u8s(NODES, protocol::nodes::FLAGS);
        let style_of_node = tables.u16s(NODES, protocol::nodes::STYLE);
        let font_size = tables.f32s(STYLES, protocol::styles::FONT_SIZE);
        let font_weight = tables.u16s(STYLES, protocol::styles::FONT_WEIGHT);

        // The root receives the window rect, rather than shrink-wrapping its
        // content. This is what makes `body { background: … }` fill the window
        // the way an author expects — the same decision the compiler documents
        // when it makes `body` the root node rather than a child of one.
        //
        // Only written when it differs, because `set_style` marks the node dirty
        // and would otherwise force a full relayout every single frame.
        let want = Size {
            width: Dimension::length(width),
            height: Dimension::length(height),
        };
        let current = self.tree.style(root).map(|s| s.size).ok();
        if current != Some(want) {
            let mut style = self
                .tree
                .style(root)
                .map_err(|e| format!("taffy style on root: {e:?}"))?
                .clone();
            style.size = want;
            self.tree
                .set_style(root, style)
                .map_err(|e| format!("taffy set_style on root: {e:?}"))?;
        }

        let space = Size {
            width: AvailableSpace::Definite(width),
            height: AvailableSpace::Definite(height),
        };

        self.tree
            .compute_layout_with_measure(root, space, |known, available, _id, context, _style| {
                let node = match context {
                    Some(i) => *i as usize,
                    None => return Size::ZERO,
                };

                // Leaves with no text never reach Skia at all.
                if flags.get(node).copied().unwrap_or(0) & protocol::flags::MEASURABLE == 0 {
                    return Size::ZERO;
                }

                let slot = text.get(node).copied().unwrap_or(-1);
                let content = tables.string(slot);
                if content.is_empty() {
                    return Size::ZERO;
                }

                let style = style_of_node.get(node).copied().unwrap_or(0) as usize;
                let size = font_size.get(style).copied().unwrap_or(16.0);
                let weight = font_weight.get(style).copied().unwrap_or(400);

                let avail = match available.width {
                    AvailableSpace::Definite(v) => v,
                    AvailableSpace::MaxContent => f32::INFINITY,
                    AvailableSpace::MinContent => 0.0,
                };

                let (w, h) = measurer.measure(content, size, weight, avail);
                Size {
                    width: known.width.unwrap_or(w),
                    height: known.height.unwrap_or(h),
                }
            })
            .map_err(|e| format!("taffy compute_layout: {e:?}"))?;

        self.read_back(tables)
    }

    /// Walks the tree accumulating parent offsets, turning Taffy's relative
    /// locations into the absolute rects everything downstream expects.
    fn read_back(&mut self, tables: &Tables) -> Result<(), String> {
        let count = self.ids.len();
        if self.bounds.len() != count {
            self.bounds = vec![[0.0; 4]; count];
        } else {
            self.bounds.fill([0.0; 4]);
        }

        let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
        let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

        // Explicit stack: a deep tree from a hostile table must not blow the
        // render thread's stack, and recursion here would be the easiest way to
        // let it.
        let mut stack: Vec<(usize, f32, f32)> = vec![(self.root, 0.0, 0.0)];
        let mut budget = count.saturating_mul(2) + 16;

        while let Some((node, ox, oy)) = stack.pop() {
            if budget == 0 {
                return Err("layout read-back exceeded its budget — a cycle in the tree".into());
            }
            budget -= 1;

            let l = self
                .tree
                .layout(self.ids[node])
                .map_err(|e| format!("taffy layout on node {node}: {e:?}"))?;

            let x = ox + l.location.x;
            let y = oy + l.location.y;
            self.bounds[node] = [x, y, l.size.width, l.size.height];

            let mut c = first.get(node).copied().unwrap_or(-1);
            while c >= 0 {
                let ci = c as usize;
                if ci >= count {
                    break;
                }
                stack.push((ci, x, y));
                c = next.get(ci).copied().unwrap_or(-1);
            }
        }

        Ok(())
    }
}

/// Proves the tree reachable from `root` is a tree: acyclic, single-parent.
///
/// This is the one host-written-data check that cannot be a budget. A budgeted
/// walk catches a cycle *along a chain* — `nextSibling` looping back — because
/// that chain never ends. It cannot catch a cycle through the *parent* relation:
/// `firstChild[root] = root` gives every node a chain of length one, so `relink`
/// completes happily and hands Taffy a structure where root is its own child.
/// `compute_layout` then recurses until the stack is gone.
///
/// A stack overflow is not a panic. `catch_unwind` cannot contain it, poisoning
/// never happens, and the host sees the process disappear — the exact failure the
/// whole boundary design exists to prevent, reachable from a single bad integer.
///
/// Visiting each node at most once also rules out a node appearing under two
/// parents, which is not a tree either and which Taffy would silently accept.
fn validate_tree(tables: &Tables, root: usize, count: usize) -> Result<(), String> {
    if count == 0 {
        return Ok(());
    }
    if root >= count {
        return Err(format!("root node {root} is outside the {count}-node table"));
    }

    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

    let mut seen = vec![false; count];
    let mut stack = vec![root];
    seen[root] = true;

    while let Some(node) = stack.pop() {
        let mut child = first.get(node).copied().unwrap_or(-1);
        while child >= 0 {
            let ci = child as usize;
            if ci >= count {
                return Err(format!(
                    "node {node} has child {child}, past the {count}-node table"
                ));
            }
            if seen[ci] {
                return Err(format!(
                    "node {ci} is reachable twice from the root — firstChild/nextSibling \
                     describe a cycle or a shared child, which is not a tree"
                ));
            }
            seen[ci] = true;
            stack.push(ci);
            child = next.get(ci).copied().unwrap_or(-1);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Style conversion
// ---------------------------------------------------------------------------

/// `NaN` is `auto`, matching how the compiler already encodes it. `Infinity`
/// reaches us from `INITIAL_STYLE`'s `maxW`/`maxH` and means "no limit", which is
/// also `auto`.
fn opt(v: f32) -> Option<f32> {
    if v.is_nan() || v.is_infinite() {
        None
    } else {
        Some(v)
    }
}

fn dim(v: f32) -> Dimension {
    match opt(v) {
        Some(px) => Dimension::length(px),
        None => Dimension::auto(),
    }
}

fn lp(v: f32) -> LengthPercentage {
    LengthPercentage::length(if v.is_finite() { v } else { 0.0 })
}

fn lpa(v: f32) -> LengthPercentageAuto {
    match opt(v) {
        Some(px) => LengthPercentageAuto::length(px),
        None => LengthPercentageAuto::auto(),
    }
}

fn align_of(v: u8) -> Option<AlignItems> {
    match v {
        align::CENTER => Some(AlignItems::Center),
        align::FLEX_END => Some(AlignItems::FlexEnd),
        align::STRETCH => Some(AlignItems::Stretch),
        align::BASELINE => Some(AlignItems::Baseline),
        align::FLEX_START => Some(AlignItems::FlexStart),
        // `UNSET` and anything unrecognised leave Taffy's default. Coercing to
        // variant 0 is what silently collapsed grid items in the spike, whose
        // default is `stretch` rather than `flex-start`.
        _ => None,
    }
}

/// The most tracks or spanned lines a grid is allowed to declare.
///
/// Bounds the cost of host-written integers. Grid work scales with tracks × items
/// and taffy's own arithmetic overflows well before `u16::MAX`.
const MAX_TRACKS: u16 = 1024;

/// `0` means "not placed", so grid lines stay 1-based as in CSS.
///
/// Both values are clamped: a line index beyond the track count makes taffy
/// materialise implicit tracks up to it, so a stray `grid-row: 30000` costs the
/// same as declaring 30,000 rows.
fn placement(start: i16, span: i16) -> Line<GridPlacement> {
    let start = start.clamp(-(MAX_TRACKS as i16), MAX_TRACKS as i16);
    let span = span.clamp(0, MAX_TRACKS as i16);

    Line {
        start: if start == 0 {
            GridPlacement::Auto
        } else {
            GridPlacement::from_line_index(start)
        },
        end: if span <= 0 {
            GridPlacement::Auto
        } else {
            GridPlacement::Span(span as u16)
        },
    }
}

/// Resolves one node's Taffy style from the tables.
///
/// Note what is *not* here: `borderWidth`. Borders are stroked inset by the
/// painter, so they do not change the box — the same decision the TypeScript
/// runtime made, kept so the migration stays pixel-comparable.
fn style_of(tables: &Tables, node: usize) -> Style {
    use protocol::styles as f;

    let mut s = Style::default();

    let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
    if hidden.get(node).copied().unwrap_or(0) != 0 {
        s.display = Display::None;
        return s;
    }

    let slot = tables
        .u16s(NODES, protocol::nodes::STYLE)
        .get(node)
        .copied()
        .unwrap_or(0) as usize;

    let u8f = |field: usize| -> u8 { tables.u8s(STYLES, field).get(slot).copied().unwrap_or(0) };
    let u16f = |field: usize| -> u16 { tables.u16s(STYLES, field).get(slot).copied().unwrap_or(0) };
    let i16f = |field: usize| -> i16 { tables.i16s(STYLES, field).get(slot).copied().unwrap_or(0) };
    let f32f = |field: usize| -> f32 { tables.f32s(STYLES, field).get(slot).copied().unwrap_or(0.0) };

    s.display = match u8f(f::DISPLAY) {
        display_enum::GRID => Display::Grid,
        display_enum::BLOCK => Display::Block,
        display_enum::NONE => Display::None,
        _ => Display::Flex,
    };

    s.flex_direction = match u8f(f::FLEX_DIRECTION) {
        flex_direction::COLUMN => FlexDirection::Column,
        flex_direction::ROW_REVERSE => FlexDirection::RowReverse,
        flex_direction::COLUMN_REVERSE => FlexDirection::ColumnReverse,
        _ => FlexDirection::Row,
    };

    s.flex_wrap = match u8f(f::FLEX_WRAP) {
        flex_wrap::WRAP => FlexWrap::Wrap,
        flex_wrap::WRAP_REVERSE => FlexWrap::WrapReverse,
        _ => FlexWrap::NoWrap,
    };

    s.justify_content = match u8f(f::JUSTIFY_CONTENT) {
        justify::CENTER => Some(AlignContent::Center),
        justify::FLEX_END => Some(AlignContent::FlexEnd),
        justify::SPACE_BETWEEN => Some(AlignContent::SpaceBetween),
        justify::SPACE_AROUND => Some(AlignContent::SpaceAround),
        justify::SPACE_EVENLY => Some(AlignContent::SpaceEvenly),
        justify::FLEX_START => Some(AlignContent::FlexStart),
        _ => None,
    };

    s.align_items = align_of(u8f(f::ALIGN_ITEMS));
    s.align_self = align_of(u8f(f::ALIGN_SELF)).map(AlignSelf::from);
    s.justify_items = align_of(u8f(f::JUSTIFY_ITEMS));
    s.justify_self = align_of(u8f(f::JUSTIFY_SELF)).map(AlignSelf::from);

    let grow = f32f(f::FLEX_GROW);
    s.flex_grow = if grow.is_finite() { grow } else { 0.0 };
    let shrink = f32f(f::FLEX_SHRINK);
    s.flex_shrink = if shrink.is_finite() { shrink } else { 1.0 };
    s.flex_basis = dim(f32f(f::FLEX_BASIS));

    s.gap = Size {
        width: lp(f32f(f::GAP_COLUMN)),
        height: lp(f32f(f::GAP_ROW)),
    };
    s.size = Size {
        width: dim(f32f(f::WIDTH)),
        height: dim(f32f(f::HEIGHT)),
    };
    s.min_size = Size {
        width: dim(f32f(f::MIN_WIDTH)),
        height: dim(f32f(f::MIN_HEIGHT)),
    };
    s.max_size = Size {
        width: dim(f32f(f::MAX_WIDTH)),
        height: dim(f32f(f::MAX_HEIGHT)),
    };

    s.padding = Rect {
        top: lp(f32f(f::PAD_TOP)),
        right: lp(f32f(f::PAD_RIGHT)),
        bottom: lp(f32f(f::PAD_BOTTOM)),
        left: lp(f32f(f::PAD_LEFT)),
    };
    s.margin = Rect {
        top: lpa(f32f(f::MARGIN_TOP)),
        right: lpa(f32f(f::MARGIN_RIGHT)),
        bottom: lpa(f32f(f::MARGIN_BOTTOM)),
        left: lpa(f32f(f::MARGIN_LEFT)),
    };

    s.position = if u8f(f::POSITION) == protocol::position::ABSOLUTE {
        Position::Absolute
    } else {
        Position::Relative
    };
    s.inset = Rect {
        top: lpa(f32f(f::INSET_TOP)),
        right: lpa(f32f(f::INSET_RIGHT)),
        bottom: lpa(f32f(f::INSET_BOTTOM)),
        left: lpa(f32f(f::INSET_LEFT)),
    };

    s.aspect_ratio = opt(f32f(f::ASPECT_RATIO));

    // Uniform `repeat(N, minmax(0, 1fr))`, which is what Tailwind's
    // `grid-cols-{n}` / `grid-rows-{n}` generate. `repeat(auto-fit, …)` needs
    // intrinsic sizing and is deliberately not claimed yet.
    //
    // Clamped, because these are host-written integers and grid cost is
    // multiplicative: the field is a `u16`, so `grid-cols-65535` is expressible
    // and allocates 65,535 tracks per grid node. Measured single frames of 181 ms
    // and 1.41 s, and a track count large enough to overflow taffy's own
    // arithmetic — which panics in debug and **wraps silently in release**, which
    // is how this ships.
    //
    // The limit is a real one rather than a guard value: a grid with more than
    // `MAX_TRACKS` columns has no legible cells at any window size, so anything
    // past it is a bad write, not an ambitious layout.
    let cols = u16f(f::GRID_COLUMNS).min(MAX_TRACKS);
    if cols > 0 {
        s.grid_template_columns = vec![minmax(length(0.0_f32), fr(1.0_f32)); cols as usize];
    }
    let rows = u16f(f::GRID_ROWS).min(MAX_TRACKS);
    if rows > 0 {
        s.grid_template_rows = vec![minmax(length(0.0_f32), fr(1.0_f32)); rows as usize];
    }

    s.grid_column = placement(i16f(f::GRID_COLUMN_START), i16f(f::GRID_COLUMN_SPAN));
    s.grid_row = placement(i16f(f::GRID_ROW_START), i16f(f::GRID_ROW_SPAN));

    s
}
