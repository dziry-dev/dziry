//! A C ABI over Taffy, so `bun:ffi` can drive flexbox *and* CSS Grid.
//!
//! Design notes, because they are what the spike is testing:
//!
//! - **Styles cross as a packed `f32` record**, not one call per property. One
//!   `set_style` per node instead of ~30 keeps the startup FFI count linear in
//!   nodes rather than in properties.
//! - **Layout is read back in bulk** into a caller-owned buffer, so a relayout is
//!   two FFI calls total rather than one per node.
//! - **Text measurement calls back into JS.** This is the risky part: Taffy asks
//!   the host to measure leaf nodes during layout, which means a `JSCallback`
//!   from Rust into Bun. The callback writes its result into a registered scratch
//!   buffer instead of returning a struct, since the C ABI cannot return two
//!   floats and Bun cannot marshal a struct return.
//! - `NaN` means `auto`, matching how the compiler already encodes it.

use std::os::raw::c_void;

use taffy::prelude::*;
use taffy::style::{
    AlignContent, AlignItems, AlignSelf, Dimension, Display, FlexDirection, GridPlacement,
    LengthPercentage, LengthPercentageAuto, Position, Style,
};
use taffy::{Rect, Size, TaffyTree};

/// Fields per node in the packed style record. Keep in sync with `STYLE_STRIDE`
/// on the TypeScript side.
pub const STYLE_FIELDS: usize = 44;

/// Signature of the host's text-measure callback. It receives the node id and the
/// constraints, and writes `[width, height]` into the registered scratch buffer.
type MeasureFn = extern "C" fn(node: i32, known_w: f32, known_h: f32, avail_w: f32, avail_h: f32);

struct Ctx {
    tree: TaffyTree<u32>,
    nodes: Vec<NodeId>,
    measure: Option<MeasureFn>,
    /// Where the measure callback leaves its answer: two `f32`s.
    scratch: *mut f32,
    /// Node ids that need measuring, so leaves without text stay cheap.
    measurable: Vec<bool>,
}

fn opt(v: f32) -> Option<f32> {
    if v.is_nan() {
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
    LengthPercentage::length(if v.is_nan() { 0.0 } else { v })
}

fn lpa(v: f32) -> LengthPercentageAuto {
    match opt(v) {
        Some(px) => LengthPercentageAuto::length(px),
        None => LengthPercentageAuto::auto(),
    }
}

/// `0` means "not placed", so grid lines are 1-based as in CSS.
fn placement(start: f32, span: f32) -> Line<GridPlacement> {
    let s = if start.is_nan() || start <= 0.0 {
        GridPlacement::Auto
    } else {
        GridPlacement::from_line_index(start as i16)
    };
    let e = if span.is_nan() || span <= 0.0 {
        GridPlacement::Auto
    } else {
        GridPlacement::Span(span as u16)
    };
    Line { start: s, end: e }
}

fn style_from(raw: &[f32]) -> Style {
    let mut s = Style::default();

    s.display = match raw[0] as i32 {
        1 => Display::Grid,
        2 => Display::Block,
        3 => Display::None,
        _ => Display::Flex,
    };
    s.flex_direction = match raw[1] as i32 {
        1 => FlexDirection::Column,
        2 => FlexDirection::RowReverse,
        3 => FlexDirection::ColumnReverse,
        _ => FlexDirection::Row,
    };
    // NaN means "unset": leave Taffy's own default rather than forcing FlexStart.
    // Grid items default to Stretch, and coercing NaN to 0 silently collapsed them.
    s.justify_content = if raw[2].is_nan() {
        None
    } else {
        Some(match raw[2] as i32 {
            1 => AlignContent::Center,
            2 => AlignContent::FlexEnd,
            3 => AlignContent::SpaceBetween,
            4 => AlignContent::SpaceAround,
            5 => AlignContent::SpaceEvenly,
            _ => AlignContent::FlexStart,
        })
    };
    s.align_items = if raw[3].is_nan() {
        None
    } else {
        Some(match raw[3] as i32 {
            1 => AlignItems::Center,
            2 => AlignItems::FlexEnd,
            3 => AlignItems::Stretch,
            4 => AlignItems::Baseline,
            _ => AlignItems::FlexStart,
        })
    };
    s.align_self = match raw[4] as i32 {
        1 => Some(AlignSelf::Center),
        2 => Some(AlignSelf::FlexEnd),
        3 => Some(AlignSelf::Stretch),
        _ => None,
    };

    s.flex_grow = if raw[5].is_nan() { 0.0 } else { raw[5] };
    s.flex_shrink = if raw[6].is_nan() { 1.0 } else { raw[6] };
    s.flex_basis = dim(raw[7]);
    s.flex_wrap = if raw[8] as i32 == 1 {
        taffy::style::FlexWrap::Wrap
    } else {
        taffy::style::FlexWrap::NoWrap
    };

    s.gap = Size { width: lp(raw[9]), height: lp(raw[10]) };
    s.size = Size { width: dim(raw[11]), height: dim(raw[12]) };
    s.min_size = Size { width: dim(raw[13]), height: dim(raw[14]) };
    s.max_size = Size { width: dim(raw[15]), height: dim(raw[16]) };

    s.padding = Rect {
        top: lp(raw[17]),
        right: lp(raw[18]),
        bottom: lp(raw[19]),
        left: lp(raw[20]),
    };
    s.border = Rect {
        top: lp(raw[21]),
        right: lp(raw[22]),
        bottom: lp(raw[23]),
        left: lp(raw[24]),
    };
    s.margin = Rect {
        top: lpa(raw[25]),
        right: lpa(raw[26]),
        bottom: lpa(raw[27]),
        left: lpa(raw[28]),
    };

    s.position = if raw[29] as i32 == 1 { Position::Absolute } else { Position::Relative };
    s.inset = Rect {
        top: lpa(raw[30]),
        right: lpa(raw[31]),
        bottom: lpa(raw[32]),
        left: lpa(raw[33]),
    };

    s.aspect_ratio = opt(raw[34]);

    // Grid: uniform `repeat(N, minmax(0, 1fr))` tracks, which is what Tailwind's
    // `grid-cols-{n}` / `grid-rows-{n}` generate.
    let cols = raw[35] as i32;
    if cols > 0 {
        s.grid_template_columns = vec![minmax(length(0.0), fr(1.0)); cols as usize];
    }
    let rows = raw[36] as i32;
    if rows > 0 {
        s.grid_template_rows = vec![minmax(length(0.0), fr(1.0)); rows as usize];
    }

    s.grid_column = placement(raw[37], raw[38]);
    s.grid_row = placement(raw[39], raw[40]);

    // Grid-only: how items are sized within their track on each axis. Without
    // this, `auto`-sized cells with no content collapse to zero.
    s.justify_items = if raw[41].is_nan() {
        None
    } else {
        Some(match raw[41] as i32 {
            1 => AlignItems::Center,
            2 => AlignItems::FlexEnd,
            3 => AlignItems::Stretch,
            _ => AlignItems::FlexStart,
        })
    };
    s.justify_self = if raw[42].is_nan() {
        None
    } else {
        Some(match raw[42] as i32 {
            1 => AlignSelf::Center,
            2 => AlignSelf::FlexEnd,
            3 => AlignSelf::Stretch,
            _ => AlignSelf::FlexStart,
        })
    };

    s
}

#[no_mangle]
pub extern "C" fn taffy_style_fields() -> i32 {
    STYLE_FIELDS as i32
}

#[no_mangle]
pub extern "C" fn taffy_new(capacity: i32) -> *mut c_void {
    let ctx = Box::new(Ctx {
        tree: TaffyTree::with_capacity(capacity.max(0) as usize),
        nodes: Vec::with_capacity(capacity.max(0) as usize),
        measure: None,
        scratch: std::ptr::null_mut(),
        measurable: Vec::with_capacity(capacity.max(0) as usize),
    });
    Box::into_raw(ctx) as *mut c_void
}

#[no_mangle]
pub unsafe extern "C" fn taffy_free(ctx: *mut c_void) {
    if !ctx.is_null() {
        drop(Box::from_raw(ctx as *mut Ctx));
    }
}

#[no_mangle]
pub unsafe extern "C" fn taffy_set_measure(ctx: *mut c_void, f: MeasureFn, scratch: *mut f32) {
    let ctx = &mut *(ctx as *mut Ctx);
    ctx.measure = Some(f);
    ctx.scratch = scratch;
}

/// Creates a node. Returns a dense index the host can use as its own node id.
#[no_mangle]
pub unsafe extern "C" fn taffy_new_node(ctx: *mut c_void, measurable: bool) -> i32 {
    let ctx = &mut *(ctx as *mut Ctx);
    let index = ctx.nodes.len() as u32;
    let node = ctx.tree.new_leaf_with_context(Style::default(), index).unwrap();
    ctx.nodes.push(node);
    ctx.measurable.push(measurable);
    index as i32
}

#[no_mangle]
pub unsafe extern "C" fn taffy_add_child(ctx: *mut c_void, parent: i32, child: i32) {
    let ctx = &mut *(ctx as *mut Ctx);
    let p = ctx.nodes[parent as usize];
    let c = ctx.nodes[child as usize];
    ctx.tree.add_child(p, c).unwrap();
}

/// Replaces a node's children wholesale — how a list reorder is applied.
#[no_mangle]
pub unsafe extern "C" fn taffy_set_children(
    ctx: *mut c_void,
    parent: i32,
    children: *const i32,
    count: i32,
) {
    let ctx = &mut *(ctx as *mut Ctx);
    let ids = std::slice::from_raw_parts(children, count.max(0) as usize);
    let kids: Vec<NodeId> = ids.iter().map(|&i| ctx.nodes[i as usize]).collect();
    let p = ctx.nodes[parent as usize];
    ctx.tree.set_children(p, &kids).unwrap();
}

/// One call per node, carrying all properties as a packed record.
#[no_mangle]
pub unsafe extern "C" fn taffy_set_style(ctx: *mut c_void, node: i32, raw: *const f32) {
    let ctx = &mut *(ctx as *mut Ctx);
    let fields = std::slice::from_raw_parts(raw, STYLE_FIELDS);
    let n = ctx.nodes[node as usize];
    ctx.tree.set_style(n, style_from(fields)).unwrap();
}

/// Bulk style upload: `count` consecutive records starting at node 0.
#[no_mangle]
pub unsafe extern "C" fn taffy_set_styles(ctx: *mut c_void, raw: *const f32, count: i32) {
    let ctx = &mut *(ctx as *mut Ctx);
    let all = std::slice::from_raw_parts(raw, STYLE_FIELDS * count.max(0) as usize);
    for i in 0..count.max(0) as usize {
        let fields = &all[i * STYLE_FIELDS..(i + 1) * STYLE_FIELDS];
        let n = ctx.nodes[i];
        ctx.tree.set_style(n, style_from(fields)).unwrap();
    }
}

#[no_mangle]
pub unsafe extern "C" fn taffy_mark_dirty(ctx: *mut c_void, node: i32) {
    let ctx = &mut *(ctx as *mut Ctx);
    let n = ctx.nodes[node as usize];
    let _ = ctx.tree.mark_dirty(n);
}

#[no_mangle]
pub unsafe extern "C" fn taffy_compute(ctx: *mut c_void, root: i32, width: f32, height: f32) {
    let ctx = &mut *(ctx as *mut Ctx);
    let r = ctx.nodes[root as usize];

    let space = Size {
        width: AvailableSpace::Definite(width),
        height: AvailableSpace::Definite(height),
    };

    // Raw pointers copied out so the closure does not borrow `ctx`.
    let measure = ctx.measure;
    let scratch = ctx.scratch;
    let measurable = std::mem::take(&mut ctx.measurable);

    ctx.tree
        .compute_layout_with_measure(r, space, |known, available, _node, context, _style| {
            let index = match context {
                Some(i) => *i as usize,
                None => return Size::ZERO,
            };

            // Leaves with no text never cross the FFI boundary.
            if !measurable.get(index).copied().unwrap_or(false) {
                return Size::ZERO;
            }

            if let (Some(f), false) = (measure, scratch.is_null()) {
                let aw = match available.width {
                    AvailableSpace::Definite(v) => v,
                    AvailableSpace::MaxContent => f32::INFINITY,
                    AvailableSpace::MinContent => 0.0,
                };
                let ah = match available.height {
                    AvailableSpace::Definite(v) => v,
                    AvailableSpace::MaxContent => f32::INFINITY,
                    AvailableSpace::MinContent => 0.0,
                };

                f(
                    index as i32,
                    known.width.unwrap_or(f32::NAN),
                    known.height.unwrap_or(f32::NAN),
                    aw,
                    ah,
                );

                return Size {
                    width: known.width.unwrap_or(unsafe { *scratch }),
                    height: known.height.unwrap_or(unsafe { *scratch.add(1) }),
                };
            }

            Size::ZERO
        })
        .unwrap();

    ctx.measurable = measurable;
}

/// Bulk read-back: `[x, y, w, h]` per node, in host node order.
#[no_mangle]
pub unsafe extern "C" fn taffy_read_layout(ctx: *mut c_void, out: *mut f32, count: i32) {
    let ctx = &*(ctx as *mut Ctx);
    let slots = std::slice::from_raw_parts_mut(out, 4 * count.max(0) as usize);

    for i in 0..(count.max(0) as usize).min(ctx.nodes.len()) {
        let l = ctx.tree.layout(ctx.nodes[i]).unwrap();
        slots[i * 4] = l.location.x;
        slots[i * 4 + 1] = l.location.y;
        slots[i * 4 + 2] = l.size.width;
        slots[i * 4 + 3] = l.size.height;
    }
}
