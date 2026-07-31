//! What the border ring actually covers, asserted on pixels.
//!
//! `bounds.rs` can prove where a box *is*; only pixels can prove what was drawn
//! into it. The engine is a raster surface even headless, so a test can paint a
//! frame and read it back — the same buffer SDL would have presented.
//!
//! One shape, two claims, both of which the old inset stroke got wrong: a stroked
//! path of width `t` around a radius-`r` rect has an outer edge of radius
//! `r + t/2` and an inner edge of `r - t/2`, where CSS says `r` and
//! `max(0, r - t)`. So the background fill underneath (drawn at `r`) reached
//! closer to the corner than the border did, and leaked out past it.

use dziri_engine::engine::{Engine, EngineConfig};
use dziri_engine::protocol::{self, align, display, flex_direction, justify, nodes, styles, Table};
use dziri_engine::tables::Tables;

const NODES: usize = Table::Nodes as usize;
const STYLES: usize = Table::Styles as usize;

const BG: u32 = 0xffff_0000; // opaque red — the fill that used to leak
const BORDER: u32 = 0xff00_00ff; // opaque blue — the ring
const SURFACE: u32 = 0xffff_ffff; // the engine clears to white

/// A 120x120 window, so the corner arithmetic below has room to be unambiguous.
fn config() -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 120,
        height: 120,
        node_capacity: 1,
        style_capacity: 1,
        variant_capacity: 1,
        variant_slot_capacity: 1,
        list_capacity: 1,
        string_capacity: 1,
        string_bytes: 32,
        root: 0,
        windowed: 0,
        decorated: 1,
        _reserved: [0; 2],
        title: std::ptr::null(),
        title_len: 0,
    }
}

fn init_style(t: &mut Tables, slot: usize) {
    t.set_u32(STYLES, styles::BG, slot, 0x0000_0000);
    t.set_u32(STYLES, styles::FG, slot, 0xff00_0000);
    t.set_u8(STYLES, styles::DISPLAY, slot, display::FLEX);
    t.set_u8(STYLES, styles::FLEX_DIRECTION, slot, flex_direction::COLUMN);
    t.set_u8(STYLES, styles::JUSTIFY_CONTENT, slot, justify::UNSET);
    t.set_u8(STYLES, styles::ALIGN_ITEMS, slot, align::UNSET);
    t.set_u8(STYLES, styles::ALIGN_SELF, slot, align::UNSET);
    t.set_u8(STYLES, styles::JUSTIFY_ITEMS, slot, align::UNSET);
    t.set_u8(STYLES, styles::JUSTIFY_SELF, slot, align::UNSET);
    for field in [
        styles::WIDTH,
        styles::HEIGHT,
        styles::MIN_WIDTH,
        styles::MIN_HEIGHT,
        styles::MAX_WIDTH,
        styles::MAX_HEIGHT,
        styles::FLEX_BASIS,
        styles::ASPECT_RATIO,
        styles::INSET_TOP,
        styles::INSET_RIGHT,
        styles::INSET_BOTTOM,
        styles::INSET_LEFT,
    ] {
        t.set_f32(STYLES, field, slot, f32::NAN);
    }
    t.set_f32(STYLES, styles::FLEX_SHRINK, slot, 1.0);
    t.set_f32(STYLES, styles::FONT_SIZE, slot, 16.0);
    t.set_u16(STYLES, styles::FONT_WEIGHT, slot, 400);
}

/// The root, filled and bordered. The root's size is the window's, so this is a
/// 120x120 rounded rect at the origin.
fn painted_root(radius: f32, border_width: f32) -> Engine {
    let mut engine = Engine::new(&config()).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        t.set_u32(STYLES, styles::BG, 0, BG);
        t.set_u32(STYLES, styles::BORDER_COLOR, 0, BORDER);
        t.set_f32(STYLES, styles::BORDER_WIDTH, 0, border_width);
        t.set_f32(STYLES, styles::RADIUS, 0, radius);

        t.set_u8(NODES, nodes::KIND, 0, protocol::node_kind::BOX);
        t.set_u16(NODES, nodes::STYLE, 0, 0);
        t.set_i32(NODES, nodes::TEXT, 0, -1);
        t.set_i32(NODES, nodes::PARENT, 0, -1);
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, -1);
        t.set_i32(NODES, nodes::NEXT_SIBLING, 0, -1);
        t.set_i16(NODES, nodes::LIST, 0, -1);
    }
    engine.tick().expect("tick");
    engine
}

/// One pixel as 0xAARRGGBB, from the BGRA_8888 buffer the window presents.
fn pixel(engine: &mut Engine, x: usize, y: usize) -> u32 {
    let (bytes, row_bytes) = engine.pixels().expect("surface pixels");
    let i = y * row_bytes + x * 4;
    let (b, g, r, a) = (bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    (u32::from(a) << 24) | (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b)
}

/// Antialiasing means an edge pixel is a blend, so name the channel that has to
/// dominate rather than demanding an exact colour.
fn nearest(got: u32, candidates: &[(u32, &'static str)]) -> &'static str {
    let channels = |c: u32| {
        [
            ((c >> 16) & 0xff) as i32,
            ((c >> 8) & 0xff) as i32,
            (c & 0xff) as i32,
        ]
    };
    let g = channels(got);
    candidates
        .iter()
        .min_by_key(|(c, _)| {
            let c = channels(*c);
            (0..3).map(|i| (g[i] - c[i]).abs()).sum::<i32>()
        })
        .expect("candidates")
        .1
}

fn what_is_at(engine: &mut Engine, x: usize, y: usize) -> &'static str {
    let got = pixel(engine, x, y);
    nearest(
        got,
        &[(BG, "background"), (BORDER, "border"), (SURFACE, "surface")],
    )
}

/// r=40, t=32. Along the diagonal from the top-left corner, the CSS outer edge
/// sits `40√2 - 40 = 16.6` px out, while the old stroke's outer edge sat
/// `56√2 - 56 = 23.2` px out. Every pixel between those two arcs was inside the
/// background fill and outside the border ring: red where CSS paints blue.
#[test]
fn the_border_ring_covers_the_corner_the_fill_reaches() {
    let mut engine = painted_root(40.0, 32.0);

    // (14, 14) is 20.5 px along the diagonal — inside that wedge with ~3 px of
    // margin at both ends, so antialiasing cannot decide the assertion.
    assert_eq!(
        what_is_at(&mut engine, 14, 14),
        "border",
        "the fill must not reach past the border at a corner"
    );

    // Straight edges were always right, and must stay right.
    assert_eq!(what_is_at(&mut engine, 60, 4), "border", "top edge is border");
    assert_eq!(
        what_is_at(&mut engine, 60, 40),
        "background",
        "past the border, the fill"
    );
}

/// The inner edge is the same claim from the other side: CSS's padding-box radius
/// is `max(0, r - t)`, and the stroke's was `r - t/2` — 24 where CSS says 8, so
/// the ring ate 16 px of the corner it should have left to the fill.
#[test]
fn the_inner_edge_is_the_padding_box_radius() {
    let mut engine = painted_root(40.0, 32.0);

    // Padding box: (32, 32) to (88, 88), corner radius 8, so its corner arc is
    // centred at (40, 40). (35, 35) is 7.07 px from that centre — inside the
    // padding box, hence fill. Under `r - t/2 = 24` the ring still covered it.
    assert_eq!(
        what_is_at(&mut engine, 35, 35),
        "background",
        "the ring must stop at the padding box, not overshoot its corner"
    );
}

/// A border wider than the box has no padding box left to subtract. Skia has no
/// defined answer for an inverted inner rect, so the ring becomes a solid fill.
#[test]
fn a_border_wider_than_the_box_fills_it() {
    let mut engine = painted_root(0.0, 200.0);

    assert_eq!(what_is_at(&mut engine, 60, 60), "border", "all border");
    assert_eq!(what_is_at(&mut engine, 2, 2), "border", "corner too");
}
