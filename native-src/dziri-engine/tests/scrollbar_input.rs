//! The scrollbar as a control: grab it, drag it, page it, hover it.
//!
//! Separate from `paint_geometry.rs`, which asks what a frame *looks* like. These ask
//! what a pointer *does*, and the two are different failure modes: a bar can be drawn
//! perfectly and be ungrabbable, or grabbable three pixels from where it is drawn.
//! Every test here drives `mouse_down`/`mouse_move`/`mouse_up`, which is exactly what
//! the SDL arms call, so nothing is exercised here that the real window does not.
//!
//! Coordinates are window pixels and hand-computed. The geometry they rely on:
//! a 120x120 container, so the vertical bar's 8 px thumb is drawn at x 110..118 and its
//! 16 px hot region covers x 104..120.

use dziri_engine::engine::{Engine, EngineConfig};
use dziri_engine::protocol::{self, align, display, flex_direction, justify, nodes, styles, Table};
use dziri_engine::tables::Tables;

const NODES: usize = Table::Nodes as usize;
const STYLES: usize = Table::Styles as usize;

/// Somewhere on the vertical bar, across it.
const ON_BAR_X: f32 = 114.0;
/// Well clear of it, in the content.
const IN_CONTENT_X: f32 = 40.0;

fn config_of(nodes: u32) -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 120,
        height: 120,
        node_capacity: nodes,
        style_capacity: nodes.max(1),
        variant_capacity: 1,
        variant_slot_capacity: 1,
        media_capacity: 1,
        list_capacity: 1,
        tween_capacity: 1,
        keyframe_capacity: 1,
        control_capacity: 4,
        string_capacity: 1,
        string_bytes: 32,
        image_capacity: 1,
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
    // The transform identities. A zeroed row is `scale(0)` — a node scaled to
    // nothing, not a node without a transform — so omitting these makes every box
    // in the file invisible and unhittable. `Uploader::uploadStyles` derives the
    // same values for real tables from `INITIAL_STYLE`.
    t.set_f32(STYLES, styles::SCALE_X, slot, 1.0);
    t.set_f32(STYLES, styles::SCALE_Y, slot, 1.0);
    t.set_f32(STYLES, styles::OPACITY, slot, 1.0);
    t.set_f32(STYLES, styles::TRANSFORM_ORIGIN_PERCENT_X, slot, 0.5);
    t.set_f32(STYLES, styles::TRANSFORM_ORIGIN_PERCENT_Y, slot, 0.5);
}

/// A 120x120 vertical scroll container holding `rows` rows of 100.
///
/// Three rows is 300 of content: 180 of scroll, and a thumb of
/// `116 * 120/300 = 46.4` px, leaving `116 - 46.4 = 69.6` of travel. Those two numbers
/// are what every drag assertion below is derived from.
fn rows(count_rows: usize, interactive: bool) -> Engine {
    let count = count_rows + 1;
    let mut engine = Engine::new(&config_of(count as u32)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..count {
            init_style(t, slot);
        }
        t.set_u8(STYLES, styles::OVERFLOW_Y, 0, protocol::overflow::SCROLL);
        for node in 1..count {
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
            if interactive && node > 0 {
                t.set_u8(NODES, nodes::FLAGS, node, protocol::flags::INTERACTIVE);
            }
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

/// A 120x120 box scrolling *horizontally* over `count` cells of 100.
///
/// The mirror of [`rows`], for the axis a plain mouse can only reach with shift held.
fn columns(count_cells: usize) -> Engine {
    let count = count_cells + 1;
    let mut engine = Engine::new(&config_of(count as u32)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..count {
            init_style(t, slot);
        }
        t.set_u8(STYLES, styles::OVERFLOW_X, 0, protocol::overflow::SCROLL);
        t.set_u8(STYLES, styles::FLEX_DIRECTION, 0, flex_direction::ROW);
        for node in 1..count {
            t.set_f32(STYLES, styles::WIDTH, node, 100.0);
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

/// Dragging the thumb scrolls the content, in proportion and both ways.
#[test]
fn dragging_the_thumb_scrolls_the_content() {
    let mut engine = rows(3, false);
    assert_eq!(engine.scroll_of(0), [0.0, 0.0], "at rest");

    // Grab the thumb near its top — it starts at y=2 — and pull down 34.8, half the
    // 69.6 of travel. Half the travel is half the extent: 90 of 180.
    engine.mouse_down(ON_BAR_X, 10.0);
    engine.mouse_move(ON_BAR_X, 44.8);
    let half = engine.scroll_of(0)[1];
    assert!(
        (half - 90.0).abs() < 1.0,
        "half the travel is half the scroll, got {half}"
    );

    // Past the end of the track: clamped to the extent, not beyond it.
    engine.mouse_move(ON_BAR_X, 10_000.0);
    assert_eq!(
        engine.scroll_of(0)[1],
        180.0,
        "dragging past the end stops at the end"
    );

    // And back to the top.
    engine.mouse_move(ON_BAR_X, -10_000.0);
    assert_eq!(engine.scroll_of(0)[1], 0.0, "and back to the very top");

    engine.mouse_up(ON_BAR_X, 0.0);
    engine.mouse_move(ON_BAR_X, 60.0);
    assert_eq!(
        engine.scroll_of(0)[1],
        0.0,
        "after release the pointer is just a pointer again"
    );
}

/// The thumb keeps the point it was grabbed by.
///
/// The single most noticeable way to get a scrollbar wrong: centre the thumb on the
/// cursor at the first move and the content lurches the instant you touch the bar. Here
/// the press lands 30 px down a 46 px thumb, and a mouse that has not moved must not
/// have scrolled anything.
#[test]
fn grabbing_a_thumb_low_down_does_not_jump_it() {
    let mut engine = rows(3, false);

    engine.mouse_down(ON_BAR_X, 32.0);
    assert_eq!(
        engine.scroll_of(0),
        [0.0, 0.0],
        "pressing the thumb must not move it"
    );

    engine.mouse_move(ON_BAR_X, 32.0);
    assert_eq!(
        engine.scroll_of(0),
        [0.0, 0.0],
        "and a move to the same place must not either"
    );

    // Now move exactly the travel: full scroll, not overshooting by the grab offset.
    engine.mouse_move(ON_BAR_X, 32.0 + 69.6);
    assert_eq!(
        engine.scroll_of(0)[1],
        180.0,
        "moving the full travel reaches the end exactly"
    );
}

/// A drag keeps following the pointer after it leaves the bar.
///
/// What pointer capture means. A drag that stopped the moment the cursor slid off the
/// 16 px hot region sideways — which is most drags — would be unusable.
#[test]
fn a_drag_survives_the_pointer_leaving_the_bar() {
    let mut engine = rows(3, false);

    engine.mouse_down(ON_BAR_X, 10.0);
    // Far into the content, and off the left edge of the window entirely.
    engine.mouse_move(IN_CONTENT_X, 44.8);
    let inside = engine.scroll_of(0)[1];
    assert!(
        (inside - 90.0).abs() < 1.0,
        "the drag follows the pointer into the content, got {inside}"
    );

    // Outside the window entirely, where only the axis the bar runs along matters.
    engine.mouse_move(-500.0, 200.0);
    assert_eq!(
        engine.scroll_of(0)[1],
        180.0,
        "a drag off the left edge still tracks vertically"
    );
}

/// Clicking the track pages towards the click, and does not start a drag.
///
/// A page is glided rather than cut to, so the destination is the target and the position
/// catches up — a whole viewport arriving in one frame gives no sense of which way the
/// content went. `advance_scrolls(1.0)` is "arrive now" at this time constant.
#[test]
fn clicking_the_track_pages() {
    let mut engine = rows(3, false);

    // Below the thumb, which ends at y=48: one viewport forward, so 120 of 180.
    engine.mouse_down(ON_BAR_X, 100.0);
    assert_eq!(
        engine.scroll_target_of(0)[1],
        120.0,
        "a click below the thumb pages forward by one viewport"
    );
    engine.advance_scrolls(1.0);
    assert_eq!(engine.scroll_of(0)[1], 120.0, "and the glide gets there");

    // A release, then a click above the thumb: back a page, to 0.
    engine.mouse_up(ON_BAR_X, 100.0);
    engine.mouse_down(ON_BAR_X, 4.0);
    assert_eq!(
        engine.scroll_target_of(0)[1],
        0.0,
        "and above it, back a page — clamped at the top"
    );
}

/// Shift turns a vertical wheel sideways.
///
/// The only way to reach a horizontal scroll region with a plain mouse, and neither the
/// platform nor SDL does it — SDL's wheel event does not even carry the modifier, which is
/// why `window.rs` queries `SDL_GetModState` separately.
#[test]
fn shift_scrolls_a_vertical_wheel_sideways() {
    // A row of three 100-wide cells in a 120 box: 180 of horizontal scroll and none
    // vertical, so a plain wheel has nothing to move and a shifted one has.
    let mut engine = columns(3);

    engine.wheel(60.0, 60.0, 0.0, 1.0, false);
    assert_eq!(
        engine.scroll_target_of(0),
        [0.0, 0.0],
        "an unshifted wheel finds nothing to scroll vertically"
    );

    engine.wheel(60.0, 60.0, 0.0, 1.0, true);
    assert_eq!(
        engine.scroll_target_of(0),
        [48.0, 0.0],
        "shift sends the same notch along x"
    );

    // Back the other way, and clamped at zero rather than going negative.
    engine.wheel(60.0, 60.0, 0.0, -10.0, true);
    assert_eq!(engine.scroll_target_of(0), [0.0, 0.0], "and back");

    // A device that reports its own horizontal delta keeps it: swapping there would
    // discard the real `dx` and turn a diagonal trackpad gesture into a wrong one.
    engine.wheel(60.0, 60.0, 1.0, 2.0, true);
    assert_eq!(
        engine.scroll_target_of(0)[0],
        48.0,
        "a real dx survives shift rather than being replaced by dy"
    );
}

/// A wheel glides; a drag does not.
///
/// The distinction is the whole design. A wheel is an *indirect* gesture — a notch is a
/// request to move, and easing it reads as smoothness. A drag is *direct*: the thumb is
/// visibly attached to the cursor, and easing that puts lag between the hand and the thing
/// it is holding, which reads as a broken scrollbar rather than a smooth one.
#[test]
fn a_wheel_glides_rather_than_jumping() {
    let mut engine = rows(3, false);

    assert!(engine.scroll_at(60.0, 60.0, 0.0, 100.0), "the wheel aimed");
    assert_eq!(
        engine.scroll_target_of(0)[1],
        100.0,
        "the destination is immediate"
    );
    assert_eq!(
        engine.scroll_of(0)[1],
        0.0,
        "the content has not moved yet — that is what a glide is"
    );

    // One frame at 60 Hz covers part of the gap, and not all of it.
    engine.advance_scrolls(1.0 / 60.0);
    let after_a_frame = engine.scroll_of(0)[1];
    assert!(
        after_a_frame > 0.0 && after_a_frame < 100.0,
        "a frame moves part of the way, got {after_a_frame}"
    );

    // A second notch mid-glide adds to the destination rather than restarting from
    // wherever the content currently is. Measuring from the position instead is what
    // makes a fast scroll travel less far than a slow one.
    assert!(engine.scroll_at(60.0, 60.0, 0.0, 50.0));
    assert_eq!(
        engine.scroll_target_of(0)[1],
        150.0,
        "notches accumulate on the destination"
    );

    // And it settles exactly, rather than approaching forever.
    engine.advance_scrolls(1.0);
    assert_eq!(engine.scroll_of(0)[1], 150.0, "the glide arrives exactly");
    assert!(
        !engine.advance_scrolls(1.0),
        "and stops animating, so an idle frame stays free"
    );

    // A drag is not glided: the content is where the cursor put it, this instant.
    engine.mouse_down(ON_BAR_X, 60.0);
    engine.mouse_move(ON_BAR_X, 70.0);
    assert_eq!(
        engine.scroll_of(0),
        engine.scroll_target_of(0),
        "a dragged thumb never lags the cursor"
    );
}

/// The bar takes the hover, and the row under it does not keep one.
///
/// An overlay bar covers content, so a pointer on the bar is not on the row: leaving the
/// row hovered would light its hover style while the cursor is demonstrably elsewhere,
/// and is one press away from clicking something nobody aimed at.
#[test]
fn a_hovered_bar_takes_the_hover_off_the_row_beneath_it() {
    let mut engine = rows(3, true);

    engine.mouse_move(IN_CONTENT_X, 50.0);
    assert_eq!(
        engine.input_state().hovered,
        1,
        "the pointer is on the first row"
    );
    assert!(
        engine.input_state().bar.is_none(),
        "and not on any scrollbar"
    );

    engine.mouse_move(ON_BAR_X, 50.0);
    let bar = engine.input_state().bar.expect("the bar is hovered");
    assert!(bar.vertical && bar.node == 0 && !bar.held);
    assert_eq!(
        engine.input_state().hovered,
        -1,
        "and the row beneath it is not hovered any more"
    );

    // Back into the content: the bar lets go, the row takes it back.
    engine.mouse_move(IN_CONTENT_X, 50.0);
    assert!(engine.input_state().bar.is_none());
    assert_eq!(engine.input_state().hovered, 1);
}

/// A press on the bar never becomes a click on the row underneath.
#[test]
fn pressing_the_bar_does_not_click_through() {
    let mut engine = rows(3, true);

    engine.mouse_down(ON_BAR_X, 10.0);
    assert_eq!(
        engine.input_state().pressed,
        -1,
        "nothing under an overlay bar is pressed by a press on the bar"
    );
    assert!(
        engine.input_state().bar.is_some_and(|bar| bar.held),
        "the bar is held instead"
    );

    engine.mouse_up(ON_BAR_X, 10.0);
    let mut queue = [Default::default(); 8];
    let n = engine.drain_events(&mut queue);
    assert!(
        queue[..n]
            .iter()
            .all(|event| event.kind != protocol::event_kind::CLICK),
        "and no click reaches the host"
    );

    // The same press in the content does click, so the suppression is the bar's doing
    // and not a broken hit test.
    engine.mouse_down(IN_CONTENT_X, 50.0);
    assert_eq!(engine.input_state().pressed, 1);
    engine.mouse_up(IN_CONTENT_X, 50.0);
    let n = engine.drain_events(&mut queue);
    assert!(
        queue[..n]
            .iter()
            .any(|event| event.kind == protocol::event_kind::CLICK),
        "a press in the content still clicks"
    );
}

/// `scrollbar-width: none` removes the bar from input too, and keeps the wheel.
///
/// The property's whole meaning: no scrollbar, still scrollable. Suppressing only the
/// *drawing* would leave an invisible 16 px strip that swallows presses aimed at the
/// content — which is why the width is read in `bars_of`, the one function both paint and
/// input go through, rather than at the draw call.
#[test]
fn scrollbar_width_none_hides_the_bar_without_disabling_scrolling() {
    let mut engine = rows(3, true);
    {
        let t = engine.tables_mut();
        t.set_u8(
            STYLES,
            styles::SCROLLBAR_WIDTH,
            0,
            protocol::scrollbar_width::NONE,
        );
    }
    engine.tick().expect("tick");

    engine.mouse_move(ON_BAR_X, 50.0);
    assert!(
        engine.input_state().bar.is_none(),
        "there is no bar to hover"
    );

    engine.mouse_down(ON_BAR_X, 50.0);
    assert_eq!(
        engine.input_state().pressed,
        1,
        "and the row under that strip takes the press, as it would anywhere else"
    );
    assert_eq!(
        engine.scroll_of(0),
        [0.0, 0.0],
        "the press was not a page either"
    );

    engine.mouse_up(ON_BAR_X, 50.0);
    assert!(
        engine.scroll_at(60.0, 60.0, 0.0, 50.0),
        "and the wheel still scrolls — hidden is not the same as unscrollable"
    );
}

/// `scrollbar-width: thin` is thinner, and still grows towards the pointer.
#[test]
fn scrollbar_width_thin_is_thinner_than_auto() {
    let wide = rows(3, false);
    let mut narrow = rows(3, false);
    {
        let t = narrow.tables_mut();
        t.set_u8(
            STYLES,
            styles::SCROLLBAR_WIDTH,
            0,
            protocol::scrollbar_width::THIN,
        );
    }
    narrow.tick().expect("tick");

    let thickness = |engine: &Engine| {
        let (_, bar) = engine.bars_of(0);
        bar.expect("a vertical bar").thumb.width()
    };

    let auto = thickness(&wide);
    let thin = thickness(&narrow);
    assert!(
        thin < auto,
        "thin must be thinner than auto, got {thin} against {auto}"
    );

    // And it still comes to meet the pointer, rather than jumping to `auto`'s width.
    narrow.mouse_move(ON_BAR_X, 20.0);
    let hovered = thickness(&narrow);
    assert!(
        hovered > thin && hovered < auto * 1.4,
        "a hovered thin bar grows but stays thin, got {hovered}"
    );
}

/// A box with nothing to scroll has no bar to grab, and the content keeps the press.
#[test]
fn there_is_nothing_to_grab_where_there_is_no_bar() {
    let mut engine = rows(1, true);

    engine.mouse_move(ON_BAR_X, 50.0);
    assert!(
        engine.input_state().bar.is_none(),
        "no overflow, no bar, nothing to hover"
    );

    engine.mouse_down(ON_BAR_X, 50.0);
    assert_eq!(
        engine.input_state().pressed,
        1,
        "so the row under that point takes the press, as it would anywhere else"
    );
}
