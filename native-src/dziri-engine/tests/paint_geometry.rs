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

// "Nothing was drawn here", which is opaque black rather than white because that
// is what `Engine::paint` clears to. Naming it wrongly made an unpainted pixel
// report as the red background: black is equidistant from red and blue, and the
// first candidate wins the tie.
const SURFACE: u32 = 0xff00_0000;

/// A 120x120 window, so the corner arithmetic below has room to be unambiguous.
fn config() -> EngineConfig {
    config_of(1)
}

fn config_of(nodes: u32) -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 120,
        height: 120,
        node_capacity: nodes,
        style_capacity: nodes.max(1),
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
    assert_eq!(
        what_is_at(&mut engine, 60, 4),
        "border",
        "top edge is border"
    );
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

/// An off-screen node is skipped, but its subtree still gets walked.
///
/// The viewport reject in `Painter::paint` is per node for exactly this case: an
/// absolutely-positioned child can be placed outside its parent's box, so an
/// off-screen parent says nothing about its children. Skipping the subtree is the
/// tempting version of the optimisation and it silently loses content — hence a
/// test whose only job is to fail if someone writes `continue` there.
#[test]
fn an_offscreen_parent_does_not_hide_an_onscreen_child() {
    let mut engine = Engine::new(&config_of(3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }

        // Slot 1: a 50x50 red box pushed a long way below the 120px window.
        t.set_u32(STYLES, styles::BG, 1, BG);
        t.set_u8(STYLES, styles::POSITION, 1, protocol::position::ABSOLUTE);
        t.set_f32(STYLES, styles::INSET_TOP, 1, 200.0);
        t.set_f32(STYLES, styles::INSET_LEFT, 1, 0.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 50.0);

        // Slot 2: a 20x20 blue box, absolute inside the red one, pulled back up so
        // it lands at y = 200 - 190 = 10 — on screen, under an off-screen parent.
        t.set_u32(STYLES, styles::BG, 2, BORDER);
        t.set_u8(STYLES, styles::POSITION, 2, protocol::position::ABSOLUTE);
        t.set_f32(STYLES, styles::INSET_TOP, 2, -190.0);
        t.set_f32(STYLES, styles::INSET_LEFT, 2, 5.0);
        t.set_f32(STYLES, styles::WIDTH, 2, 20.0);
        t.set_f32(STYLES, styles::HEIGHT, 2, 20.0);

        for node in 0..3 {
            t.set_u8(NODES, nodes::KIND, node, protocol::node_kind::BOX);
            t.set_u16(NODES, nodes::STYLE, node, node as u16);
            t.set_i32(NODES, nodes::TEXT, node, -1);
            t.set_i32(NODES, nodes::PARENT, node, -1);
            t.set_i32(NODES, nodes::FIRST_CHILD, node, -1);
            t.set_i32(NODES, nodes::NEXT_SIBLING, node, -1);
            t.set_i16(NODES, nodes::LIST, node, -1);
        }
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        t.set_i32(NODES, nodes::PARENT, 1, 0);
        t.set_i32(NODES, nodes::FIRST_CHILD, 1, 2);
        t.set_i32(NODES, nodes::PARENT, 2, 1);
    }
    engine.tick().expect("tick");

    // The parent is at y = 200 in a 120px window, so nothing of it is visible.
    assert_eq!(
        engine.bounds_of(1).expect("parent bounds")[1],
        200.0,
        "the parent really is off screen"
    );
    // The child is not.
    assert_eq!(
        what_is_at(&mut engine, 10, 15),
        "border",
        "an on-screen child of an off-screen parent must still be drawn"
    );
}

/// Text is rasterised with subpixel AA, which is what ClearType is.
///
/// SkFont's defaults are greyscale AA and integer glyph positions, so white text on
/// black produced pixels with `r == g == b` — grey, thin, and visibly unlike every
/// other window on the same desktop. Subpixel AA weights the three channels
/// separately, so the tell is a coloured edge pixel, and that is what this looks
/// for rather than for "crisper", which is not an assertion.
///
/// It is also the precondition check: subpixel AA is only valid over known pixels,
/// and it is valid here because the surface is opaque.
#[test]
fn glyph_edges_are_subpixel_antialiased() {
    let mut engine = Engine::new(&config_of(2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        // White text, and the engine clears to black, so any colour in a glyph
        // edge came from the rasteriser rather than from the design.
        t.set_u32(STYLES, styles::FG, 1, 0xffff_ffff);
        t.set_f32(STYLES, styles::FONT_SIZE, 1, 40.0);

        let mut cursor = 0;
        t.push_string(0, "iiii", &mut cursor).expect("string arena");

        for node in 0..2 {
            t.set_u8(NODES, nodes::KIND, node, protocol::node_kind::BOX);
            t.set_u16(NODES, nodes::STYLE, node, node as u16);
            t.set_i32(NODES, nodes::TEXT, node, -1);
            t.set_i32(NODES, nodes::PARENT, node, -1);
            t.set_i32(NODES, nodes::FIRST_CHILD, node, -1);
            t.set_i32(NODES, nodes::NEXT_SIBLING, node, -1);
            t.set_i16(NODES, nodes::LIST, node, -1);
        }
        t.set_u8(NODES, nodes::KIND, 1, protocol::node_kind::TEXT);
        t.set_i32(NODES, nodes::TEXT, 1, 0);
        t.set_u8(NODES, nodes::FLAGS, 1, protocol::flags::MEASURABLE);
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        t.set_i32(NODES, nodes::PARENT, 1, 0);
    }
    engine.tick().expect("tick");

    let (bytes, row_bytes) = engine.pixels().expect("surface pixels");
    let mut coloured = 0;
    let mut lit = 0;
    for y in 0..120usize {
        for x in 0..120usize {
            let i = y * row_bytes + x * 4;
            let (b, g, r) = (
                i32::from(bytes[i]),
                i32::from(bytes[i + 1]),
                i32::from(bytes[i + 2]),
            );
            if r.max(g).max(b) > 16 {
                lit += 1;
                // Greyscale AA can only produce r == g == b here. A spread this
                // wide is the three channels being weighted separately.
                if r.max(g).max(b) - r.min(g).min(b) > 24 {
                    coloured += 1;
                }
            }
        }
    }

    assert!(lit > 0, "the glyphs were drawn at all");
    assert!(
        coloured > 0,
        "no glyph edge carried colour, so this is greyscale AA: {lit} lit pixels, {coloured} coloured"
    );
}

/// `overflow: hidden` clips its descendants, and only its descendants.
///
/// Two children of a clipping container: one inside its box, one placed well outside
/// it. Before this, both were drawn — the engine had an `overflow` field in the
/// schema that nothing read, so content spilled over whatever came after it.
///
/// The sibling *after* the container proves the clip is undone: an explicit paint
/// stack has no natural "after the children" moment, so the restore is pushed as its
/// own step, and getting that ordering wrong would clip the rest of the frame.
#[test]
fn overflow_hidden_clips_the_subtree_and_nothing_after_it() {
    let mut engine = Engine::new(&config_of(4)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..4 {
            init_style(t, slot);
        }

        // 0: the root, a column.
        // 1: a 40x40 clipping container at the top left, red.
        t.set_u32(STYLES, styles::BG, 1, BG);
        t.set_u8(STYLES, styles::OVERFLOW_X, 1, protocol::overflow::HIDDEN);
        t.set_u8(STYLES, styles::OVERFLOW_Y, 1, protocol::overflow::HIDDEN);
        t.set_f32(STYLES, styles::WIDTH, 1, 40.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 40.0);

        // 2: its child, absolutely placed so most of it hangs outside the container.
        t.set_u32(STYLES, styles::BG, 2, BORDER);
        t.set_u8(STYLES, styles::POSITION, 2, protocol::position::ABSOLUTE);
        t.set_f32(STYLES, styles::INSET_TOP, 2, 20.0);
        t.set_f32(STYLES, styles::INSET_LEFT, 2, 20.0);
        t.set_f32(STYLES, styles::WIDTH, 2, 60.0);
        t.set_f32(STYLES, styles::HEIGHT, 2, 60.0);

        // 3: a sibling of the container, below it, blue.
        t.set_u32(STYLES, styles::BG, 3, BORDER);
        t.set_f32(STYLES, styles::WIDTH, 3, 40.0);
        t.set_f32(STYLES, styles::HEIGHT, 3, 40.0);

        for node in 0..4 {
            t.set_u8(NODES, nodes::KIND, node, protocol::node_kind::BOX);
            t.set_u16(NODES, nodes::STYLE, node, node as u16);
            t.set_i32(NODES, nodes::TEXT, node, -1);
            t.set_i32(NODES, nodes::PARENT, node, -1);
            t.set_i32(NODES, nodes::FIRST_CHILD, node, -1);
            t.set_i32(NODES, nodes::NEXT_SIBLING, node, -1);
            t.set_i16(NODES, nodes::LIST, node, -1);
        }
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        t.set_i32(NODES, nodes::PARENT, 1, 0);
        t.set_i32(NODES, nodes::NEXT_SIBLING, 1, 3);
        t.set_i32(NODES, nodes::PARENT, 3, 0);
        t.set_i32(NODES, nodes::FIRST_CHILD, 1, 2);
        t.set_i32(NODES, nodes::PARENT, 2, 1);
    }
    engine.tick().expect("tick");

    // Inside the container, where the child overlaps it: the child wins.
    assert_eq!(what_is_at(&mut engine, 30, 30), "border", "the child draws");
    // Outside the container, where the child would have reached: clipped away, and
    // the root has no background, so this is bare surface.
    assert_eq!(
        what_is_at(&mut engine, 60, 60),
        "surface",
        "the part of the child outside the container must be clipped"
    );
    // The sibling below is unaffected: the clip was undone.
    let sibling = engine.bounds_of(3).expect("sibling bounds");
    assert!(sibling[1] >= 40.0, "the sibling is below the container");
    assert_eq!(
        what_is_at(&mut engine, 20, (sibling[1] + 20.0) as usize),
        "border",
        "a sibling after the clipping container is not clipped by it"
    );
}

/// `overflow-y: hidden` clips vertically and leaves the other axis alone.
///
/// The whole reason the schema carries an axis each. A column that scrolls
/// vertically must not clip sideways — a focus ring, a shadow or a dropdown that
/// legitimately sticks out horizontally would be cut off — and one shared field
/// would have made this either a lie about the other axis or unexpressible.
#[test]
fn overflow_clips_only_the_axes_that_contain() {
    let mut engine = Engine::new(&config_of(3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }

        // A 40x40 container that contains vertically and spills horizontally.
        t.set_u32(STYLES, styles::BG, 1, BG);
        t.set_u8(STYLES, styles::OVERFLOW_X, 1, protocol::overflow::VISIBLE);
        t.set_u8(STYLES, styles::OVERFLOW_Y, 1, protocol::overflow::HIDDEN);
        t.set_f32(STYLES, styles::WIDTH, 1, 40.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 40.0);

        // A child hanging out of *both* axes: 20..80 in x and in y.
        t.set_u32(STYLES, styles::BG, 2, BORDER);
        t.set_u8(STYLES, styles::POSITION, 2, protocol::position::ABSOLUTE);
        t.set_f32(STYLES, styles::INSET_TOP, 2, 20.0);
        t.set_f32(STYLES, styles::INSET_LEFT, 2, 20.0);
        t.set_f32(STYLES, styles::WIDTH, 2, 60.0);
        t.set_f32(STYLES, styles::HEIGHT, 2, 60.0);

        for node in 0..3 {
            t.set_u8(NODES, nodes::KIND, node, protocol::node_kind::BOX);
            t.set_u16(NODES, nodes::STYLE, node, node as u16);
            t.set_i32(NODES, nodes::TEXT, node, -1);
            t.set_i32(NODES, nodes::PARENT, node, -1);
            t.set_i32(NODES, nodes::FIRST_CHILD, node, -1);
            t.set_i32(NODES, nodes::NEXT_SIBLING, node, -1);
            t.set_i16(NODES, nodes::LIST, node, -1);
        }
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        t.set_i32(NODES, nodes::PARENT, 1, 0);
        t.set_i32(NODES, nodes::FIRST_CHILD, 1, 2);
        t.set_i32(NODES, nodes::PARENT, 2, 1);
    }
    engine.tick().expect("tick");

    // Right of the container, still within its rows: horizontal spill is allowed.
    assert_eq!(
        what_is_at(&mut engine, 60, 30),
        "border",
        "overflow-x: visible must let the child spill sideways"
    );
    // Below the container, within its columns: vertical spill is clipped.
    assert_eq!(
        what_is_at(&mut engine, 30, 60),
        "surface",
        "overflow-y: hidden must clip the child below the container"
    );
}

/// Content scrolled *into* view is painted.
///
/// The bug this pins was invisible to every existing test, because they all painted an
/// unscrolled frame. The viewport reject read the canvas clip once, in window
/// coordinates, and compared each node's *unscrolled* layout rect against it — so a
/// row at content y=200 that a 100px scroll had brought on screen was still compared
/// at 200 and thrown away. Scrolling made content disappear, and scrolling far enough
/// made everything disappear but the root's background.
#[test]
fn a_row_scrolled_into_view_is_actually_drawn() {
    // A 120x120 scroll container holding three 100px rows: 300 of content, 180 of
    // scroll. Only the first row and a sliver of the second are visible at rest.
    let mut engine = Engine::new(&config_of(4)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..4 {
            init_style(t, slot);
        }
        t.set_u8(STYLES, styles::OVERFLOW_Y, 0, protocol::overflow::SCROLL);
        for node in 1..4usize {
            t.set_f32(STYLES, styles::HEIGHT, node, 100.0);
            t.set_f32(STYLES, styles::FLEX_SHRINK, node, 0.0);
        }
        // Row 1 red, row 2 blue, row 3 red again — so "which row is at the top" is
        // readable from one pixel.
        t.set_u32(STYLES, styles::BG, 1, BG);
        t.set_u32(STYLES, styles::BG, 2, BORDER);
        t.set_u32(STYLES, styles::BG, 3, BG);

        for node in 0..4 {
            t.set_u8(NODES, nodes::KIND, node, protocol::node_kind::BOX);
            t.set_u16(NODES, nodes::STYLE, node, node as u16);
            t.set_i32(NODES, nodes::TEXT, node, -1);
            t.set_i32(NODES, nodes::PARENT, node, -1);
            t.set_i32(NODES, nodes::FIRST_CHILD, node, -1);
            t.set_i32(NODES, nodes::NEXT_SIBLING, node, -1);
            t.set_i16(NODES, nodes::LIST, node, -1);
        }
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        for node in 1..4usize {
            t.set_i32(NODES, nodes::PARENT, node, 0);
            t.set_i32(
                NODES,
                nodes::NEXT_SIBLING,
                node,
                if node < 3 { node as i32 + 1 } else { -1 },
            );
        }
    }
    engine.tick().expect("tick");

    assert_eq!(
        what_is_at(&mut engine, 60, 50),
        "background",
        "row 1 at rest"
    );

    // Scroll 100: row 2 should now be at the top of the box.
    assert!(engine.scroll_at(60.0, 60.0, 0.0, 100.0), "scrolled");
    engine.tick().expect("tick");
    assert_eq!(
        what_is_at(&mut engine, 60, 50),
        "border",
        "row 2 scrolled into view and must be painted"
    );

    // Scroll to the very end: row 3 fills the box. Under the bug every row was
    // rejected here and the frame was bare surface.
    assert!(engine.scroll_at(60.0, 60.0, 0.0, 10_000.0));
    engine.tick().expect("tick");
    assert_eq!(
        what_is_at(&mut engine, 60, 60),
        "background",
        "the last row is on screen at the end of the scroll, not blank"
    );
}

/// `scrollbar-color` is used as written, and paints a track when one is asked for.
///
/// The distinction that matters: an *unauthored* bar borrows the container's foreground
/// at 35% alpha, because it has to invent a colour that works over unknown content. An
/// authored one is used as given — someone who writes `scrollbar-color: blue red` means
/// blue, not 35% of it — and the track, which dziri otherwise never draws, appears
/// because they named a second colour.
#[test]
fn scrollbar_color_paints_the_colours_it_was_given() {
    let mut engine = scrolling_rows(protocol::overflow::SCROLL, 3);
    {
        let t = engine.tables_mut();
        // Blue thumb on a red track, over rows that are also red — so "the track was
        // drawn" is not readable from the track's own colour alone, and the thumb's is.
        t.set_u32(STYLES, styles::SCROLLBAR_THUMB, 0, BORDER);
        t.set_u32(STYLES, styles::SCROLLBAR_TRACK, 0, BG);
    }
    engine.tick().expect("tick");

    // On the thumb, near the top of the track: opaque blue, not a blend.
    assert_eq!(
        pixel(&mut engine, THUMB_X, 20),
        BORDER,
        "an authored thumb colour is used as written, alpha included"
    );

    // Below the thumb, still on the bar: the track's red, over red content — which the
    // next assertion is what makes meaningful.
    assert_eq!(
        pixel(&mut engine, THUMB_X, 100),
        BG,
        "the rest of the bar is the track colour"
    );

    // Without a track colour, the same pixel is untouched content rather than a track.
    // Together these two say the track is drawn *because* it was asked for.
    let mut bare = scrolling_rows(protocol::overflow::SCROLL, 3);
    {
        let t = bare.tables_mut();
        t.set_u32(STYLES, styles::SCROLLBAR_THUMB, 0, BORDER);
    }
    bare.tick().expect("tick");
    assert_eq!(
        pixel(&mut bare, THUMB_X, 20),
        BORDER,
        "the thumb is still honoured on its own"
    );
    assert_eq!(
        red_at(&mut bare, THUMB_X, 100),
        red_at(&mut bare, 60, 100),
        "and with no track colour nothing is drawn behind it"
    );
}

/// The red channel at a point.
///
/// The thumb is translucent black over red content, so "is there a thumb here" is
/// "is this red darker than the content's red" — a comparison rather than a named
/// colour, because a blend of the two is neither of them and `nearest` would round it
/// back to the content it is drawn over.
fn red_at(engine: &mut Engine, x: usize, y: usize) -> i32 {
    ((pixel(engine, x, y) >> 16) & 0xff) as i32
}

/// The thumb's column: `THUMB_INSET` from the right edge of a 120-wide box, and
/// `THUMB_THICKNESS` wide, so its centre is 6 px in.
const THUMB_X: usize = 114;

/// A 120x120 box holding `rows` red rows of 100, with `overflow_y` on the root.
///
/// Three rows is 300 of content in 120 of box: 180 of scroll. One row fits, so the
/// same builder covers both "there is somewhere to scroll" and "there is not".
fn scrolling_rows(overflow_y: u8, rows: usize) -> Engine {
    let count = rows + 1;
    let mut engine = Engine::new(&config_of(count as u32)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..count {
            init_style(t, slot);
        }
        t.set_u8(STYLES, styles::OVERFLOW_Y, 0, overflow_y);
        for node in 1..count {
            t.set_u32(STYLES, styles::BG, node, BG);
            t.set_f32(STYLES, styles::HEIGHT, node, 100.0);
            t.set_f32(STYLES, styles::FLEX_SHRINK, node, 0.0);
        }

        for node in 0..count {
            t.set_u8(NODES, nodes::KIND, node, protocol::node_kind::BOX);
            t.set_u16(NODES, nodes::STYLE, node, node as u16);
            t.set_i32(NODES, nodes::TEXT, node, -1);
            t.set_i32(NODES, nodes::PARENT, node, -1);
            t.set_i32(NODES, nodes::FIRST_CHILD, node, -1);
            t.set_i32(NODES, nodes::NEXT_SIBLING, node, -1);
            t.set_i16(NODES, nodes::LIST, node, -1);
        }
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        for node in 1..count {
            t.set_i32(NODES, nodes::PARENT, node, 0);
            t.set_i32(
                NODES,
                nodes::NEXT_SIBLING,
                node,
                if node + 1 < count {
                    node as i32 + 1
                } else {
                    -1
                },
            );
        }
    }
    engine.tick().expect("tick");
    engine
}

/// A box that scrolls says so, and says where in the content it is.
///
/// Nothing signalled scrollability before this: a list that scrolled and a list that
/// did not looked identical, which is the one thing a scrollbar exists to fix.
///
/// The thumb is drawn *over* the content rather than in a reserved gutter, so these
/// assertions are about the content's own pixels being darkened — see `THUMB_THICKNESS`
/// for why the gutter is not reserved.
#[test]
fn a_scrolling_box_draws_a_thumb_that_tracks_the_offset() {
    let mut engine = scrolling_rows(protocol::overflow::SCROLL, 3);

    // 116 of track for 120 visible out of 300: a 46 px thumb, at the top.
    let content = red_at(&mut engine, 60, 20);
    assert!(
        red_at(&mut engine, THUMB_X, 20) + 20 < content,
        "a thumb must be drawn at the top of the bar when the box is at the top"
    );
    assert_eq!(
        red_at(&mut engine, THUMB_X, 90),
        content,
        "and nowhere near the bottom of the bar, which is where the rest of the content is"
    );

    // To the end: the thumb has to reach the far end exactly when the scroll does,
    // which is the property that makes a bar worth looking at.
    assert!(engine.scroll_at(60.0, 60.0, 0.0, 10_000.0), "scrolled");
    engine.tick().expect("tick");
    assert!(
        red_at(&mut engine, THUMB_X, 110) + 20 < content,
        "scrolled to the end, the thumb must be at the end of the bar"
    );
    assert_eq!(
        red_at(&mut engine, THUMB_X, 20),
        content,
        "and must have left the top"
    );
}

/// Content that fits gets no thumb.
///
/// `auto` semantics, and the reason a gutter is not reserved: the compiler collapses
/// `auto` and `scroll` into one wire value, and Chromium 151 reserves room for
/// `scroll` even when the content fits — measured in BROWSER-FACTS.md. Paint is where
/// that approximation is made good, so a box with nothing to scroll must look
/// untouched.
#[test]
fn a_box_with_nothing_to_scroll_draws_no_thumb() {
    let mut engine = scrolling_rows(protocol::overflow::SCROLL, 1);

    assert_eq!(
        red_at(&mut engine, THUMB_X, 20),
        red_at(&mut engine, 60, 20),
        "one 100px row in a 120px box has nowhere to scroll, so no thumb"
    );
}

/// A resize followed by an ordinary idle tick still paints the tree.
///
/// This is the "sometimes it hides all elements" bug itself, and it had nothing to do
/// with scrolling. `resize` sets `fresh`, meaning "this tree has no layout". `resync`
/// consumed that flag to decide whether to rebuild — and `rebuild` zeroes every
/// bound — then cleared it. `tick` read it as false, found an empty diff, and skipped
/// `compute`. What it painted was a tree in which every node was a 0x0 box at the
/// origin: nothing to fill, nothing to measure, every node rejected by the viewport
/// test, and only the clear colour left on screen.
///
/// It needed an idle frame to show, which is what made it intermittent: any table
/// change in the same tick set `diff.any` and laid out anyway.
#[test]
fn a_resize_then_an_idle_tick_is_not_a_blank_window() {
    let mut engine = scrolling_rows(protocol::overflow::VISIBLE, 1);
    assert_eq!(
        what_is_at(&mut engine, 60, 50),
        "background",
        "the row is painted before the resize"
    );

    engine.resize(200, 200).expect("resize");
    // No table writes at all: the host had nothing to say this frame, which is the
    // common case and was the broken one.
    engine.tick().expect("tick");

    let row = engine.bounds_of(1).expect("row bounds");
    assert!(
        row[2] > 0.0 && row[3] > 0.0,
        "the row must still have a size after a resize, got {row:?}"
    );
    assert_eq!(
        what_is_at(&mut engine, 60, 50),
        "background",
        "a resize followed by an idle tick must not paint an empty frame"
    );
}

/// A window that grows takes back the scroll it no longer has room for.
///
/// Reported from the real window as "sometimes it hides all elements". A scroll offset
/// is engine state, deliberately outlived by relayout so a box the user scrolled stays
/// where they put it — but nothing re-clamped it, so an offset earned at one window
/// size survived into a layout that had less to scroll, or nothing at all. The content
/// was then translated up by an offset the box could no longer justify and left the
/// screen, and no scrollbar was drawn either, because by then the extent was 0.
#[test]
fn growing_the_window_gives_back_a_scroll_it_can_no_longer_hold() {
    // 300 of content in 120: 180 of scroll, all of which we take.
    let mut engine = scrolling_rows(protocol::overflow::SCROLL, 3);
    assert!(engine.scroll_at(60.0, 60.0, 0.0, 10_000.0), "scrolled");
    engine.tick().expect("tick");
    assert_eq!(
        engine.scroll_of(0),
        [0.0, 180.0],
        "scrolled to the very end"
    );

    // Now 300 of content in 400: nothing overflows, so there is nothing to scroll
    // and the content belongs at the top of the box.
    engine.resize(120, 400).expect("resize");
    engine.tick().expect("tick");

    assert_eq!(
        engine.scroll_of(0),
        [0.0, 0.0],
        "a box with nothing left to scroll cannot still be scrolled"
    );
    assert_eq!(
        what_is_at(&mut engine, 60, 10),
        "background",
        "the first row is back at the top of the box, not 180px above it"
    );
    assert_eq!(
        what_is_at(&mut engine, 60, 250),
        "background",
        "and the content reaches where it should rather than ending 180px early"
    );
}

/// The same clamp, when there is *some* scroll left rather than none.
///
/// The half of the fix that a "reset it to zero" answer would get wrong: growing a
/// window that still overflows must keep the user's position, only shortened to what
/// now fits. Losing it entirely would be its own bug.
#[test]
fn a_scroll_that_still_fits_is_kept_not_reset() {
    let mut engine = scrolling_rows(protocol::overflow::SCROLL, 3);
    assert!(engine.scroll_at(60.0, 60.0, 0.0, 10_000.0));
    engine.tick().expect("tick");
    assert_eq!(engine.scroll_of(0), [0.0, 180.0]);

    // 300 of content in 200: 100 of scroll, so the offset shortens to 100 rather
    // than to 0.
    engine.resize(120, 200).expect("resize");
    engine.tick().expect("tick");
    assert_eq!(
        engine.scroll_of(0),
        [0.0, 100.0],
        "the scroll is clamped to what the new layout can give, not discarded"
    );
}

/// `overflow: hidden` overflows without scrolling, and so draws no thumb.
///
/// Clipping and scrolling are separate properties — that is the whole difference
/// between `hidden` and `scroll` — and the wheel refuses a `hidden` box, so a bar
/// there would promise something nothing delivers.
#[test]
fn a_clipping_box_that_cannot_scroll_draws_no_thumb() {
    let mut engine = scrolling_rows(protocol::overflow::HIDDEN, 3);

    assert_eq!(
        red_at(&mut engine, THUMB_X, 20),
        red_at(&mut engine, 60, 20),
        "hidden clips its overflow but the user cannot move it, so no thumb"
    );
    assert!(
        !engine.scroll_at(60.0, 60.0, 0.0, 100.0),
        "and the wheel agrees, which is what the missing thumb has to match"
    );
}
