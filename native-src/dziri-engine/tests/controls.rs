//! What a press on a form control actually paints.
//!
//! The unit tests in `controls.rs` prove the state machine — a checkbox toggles, a
//! radio clears its group, a rescan does not undo the user. They prove none of it is
//! reachable. Between them and a working checkbox sit four things: `hit_test` has to
//! return the node, the press has to survive `mouse_down`, `resolve_slot` has to turn
//! the bit into a predicate, and paint has to read the variant row. This file is that
//! seam, and it asserts on the raster surface the window would have presented.
//!
//! Every press here goes through `mouse_down`/`mouse_up` at a **coordinate**, not
//! through a state setter. That is the point: `set_input_state` can declare a hover,
//! but nothing can declare a click, and a checkbox that ticks only when a real press
//! reaches it would pass every test that skipped the press.

use dziri_engine::engine::{Engine, EngineConfig};
use dziri_engine::protocol::{
    self, align, control_flags, control_kind, controls, display, flex_direction, justify, nodes,
    predicate, styles, variant_slots, variants, Table,
};
use dziri_engine::tables::Tables;

const NODES: usize = Table::Nodes as usize;
const STYLES: usize = Table::Styles as usize;
const VARIANTS: usize = Table::Variants as usize;
const VARIANT_SLOTS: usize = Table::VariantSlots as usize;
const CONTROLS: usize = Table::Controls as usize;

const BLACK: u32 = 0xff00_0000;
const WHITE: u32 = 0xffff_ffff;
const GREY: u32 = 0xff80_8080;

/// A spare controls row claims this node, which is no node.
///
/// `i32::MAX` and not `-1`, because the engine binary-searches the column and padding
/// lives at the *end* — only a sentinel above every real node keeps it sorted. The
/// uploader writes the same value; see `NO_CONTROL_NODE` in `upload.ts`.
const NO_NODE: i32 = i32::MAX;

fn config(nodes: u32, styles: u32) -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 100,
        height: 100,
        node_capacity: nodes,
        style_capacity: styles,
        variant_capacity: 4,
        variant_slot_capacity: 8,
        media_capacity: 1,
        list_capacity: 1,
        tween_capacity: 1,
        keyframe_capacity: 1,
        control_capacity: 4,
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

/// A style row at its initial values. See the same helper in `animation.rs` for why
/// the transform identities are not optional — a zeroed row is `scale(0)`.
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
    t.set_f32(STYLES, styles::SCALE_X, slot, 1.0);
    t.set_f32(STYLES, styles::SCALE_Y, slot, 1.0);
    t.set_f32(STYLES, styles::OPACITY, slot, 1.0);
    t.set_f32(STYLES, styles::TRANSFORM_ORIGIN_PERCENT_X, slot, 0.5);
    t.set_f32(STYLES, styles::TRANSFORM_ORIGIN_PERCENT_Y, slot, 0.5);
}

fn node(t: &mut Tables, i: usize, slot: u16, parent: i32) {
    t.set_u8(NODES, nodes::KIND, i, protocol::node_kind::BOX);
    t.set_u16(NODES, nodes::STYLE, i, slot);
    t.set_i32(NODES, nodes::TEXT, i, -1);
    t.set_i32(NODES, nodes::PARENT, i, parent);
    t.set_i32(NODES, nodes::FIRST_CHILD, i, -1);
    t.set_i32(NODES, nodes::NEXT_SIBLING, i, -1);
    t.set_i16(NODES, nodes::LIST, i, -1);
    t.set_u8(NODES, nodes::FLAGS, i, protocol::flags::INTERACTIVE);
    t.set_i32(NODES, nodes::ACTIVATES, i, -1);
}

/// A one-bit variant run: `base` at rest, `on` when `bit` holds.
fn variant(t: &mut Tables, row: usize, target: i32, bit: u32, run: usize, base: u16, on: u16) {
    t.set_i32(VARIANTS, variants::NODE, row, target);
    t.set_u32(VARIANTS, variants::MASK, row, bit);
    t.set_i32(VARIANTS, variants::RUN_START, row, run as i32);
    t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, run, base);
    t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, run + 1, on);
}

/// Spare *variant* rows, pushed past every real node.
///
/// Not optional, and it cost five failing tests to remember why: a spare row defaults
/// to `node = 0`, so a table with one real row for node 1 has the column `[1, 0, 0, 0]`
/// — unsorted, and `resolve_slot`'s binary search then lands on a spare row whose mask
/// is `0` and returns the base style. Every assertion here failed with the *resting*
/// colour, which reads exactly like the predicate never going live.
fn pad_variants(t: &mut Tables, from: usize) {
    for row in from..4 {
        t.set_i32(VARIANTS, variants::NODE, row, NO_NODE);
        t.set_u32(VARIANTS, variants::MASK, row, 0);
        t.set_i32(VARIANTS, variants::RUN_START, row, -1);
    }
}

fn control(t: &mut Tables, row: usize, target: i32, kind: u8, group: i32, flags: u8) {
    t.set_i32(CONTROLS, controls::NODE, row, target);
    t.set_u8(CONTROLS, controls::KIND, row, kind);
    t.set_i32(CONTROLS, controls::GROUP, row, group);
    t.set_u8(CONTROLS, controls::FLAGS, row, flags);
    t.set_i32(NODES, nodes::ACTIVATES, target as usize, target);
}

/// Spare rows, exactly as the uploader leaves them.
fn pad_controls(t: &mut Tables, from: usize) {
    for row in from..4 {
        t.set_i32(CONTROLS, controls::NODE, row, NO_NODE);
        t.set_i32(CONTROLS, controls::GROUP, row, -1);
        t.set_u8(CONTROLS, controls::KIND, row, control_kind::NONE);
        t.set_u8(CONTROLS, controls::FLAGS, row, 0);
    }
}

/// One pixel as 0xAARRGGBB, from the BGRA_8888 buffer the window presents.
fn pixel(engine: &mut Engine, x: usize, y: usize) -> u32 {
    let (bytes, row_bytes) = engine.pixels().expect("surface pixels");
    let i = y * row_bytes + x * 4;
    let (b, g, r, a) = (bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    (u32::from(a) << 24) | (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b)
}

/// The colour at the centre of the window, which every box below fills.
fn centre(engine: &mut Engine) -> u32 {
    pixel(engine, 50, 50)
}

/// A press and release at the centre — a real click, through `hit_test`.
fn click_centre(engine: &mut Engine) {
    engine.mouse_down(50.0, 50.0);
    engine.mouse_up(50.0, 50.0);
    engine.tick().expect("tick");
}

/// A checkbox filling the window: black unchecked, white checked.
fn checkbox(flags: u8) -> Engine {
    let mut engine = Engine::new(&config(1, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_u32(STYLES, styles::BG, 0, BLACK);
        t.set_u32(STYLES, styles::BG, 1, WHITE);

        node(t, 0, 0, -1);
        variant(t, 0, 0, predicate::CHECKED, 0, 0, 1);
        control(t, 0, 0, control_kind::CHECKBOX, -1, flags);
        pad_controls(t, 1);
        pad_variants(t, 1);
    }
    engine.tick().expect("tick");
    engine
}

/// The headline claim, at the pixel level: clicking a checkbox changes what is drawn.
///
/// Nothing in the compiler changed for this to work. The `:checked` variant row was
/// already being emitted correctly — it had simply never been selectable, because the
/// predicate bit was reserved in protocol v9 and set by nothing until the engine
/// owned the state.
#[test]
fn clicking_a_checkbox_changes_what_is_painted() {
    let mut engine = checkbox(0);
    assert_eq!(centre(&mut engine), BLACK, "unchecked at rest");

    click_centre(&mut engine);
    assert_eq!(centre(&mut engine), WHITE, "and checked after a real press");

    click_centre(&mut engine);
    assert_eq!(centre(&mut engine), BLACK, "and back, because it toggles");
}

/// The authored `checked` attribute is the *initial* value, not a static style.
#[test]
fn an_authored_checked_box_starts_checked_and_can_be_unchecked() {
    let mut engine = checkbox(control_flags::CHECKED);
    assert_eq!(centre(&mut engine), WHITE, "authored checked");

    click_centre(&mut engine);
    assert_eq!(
        centre(&mut engine),
        BLACK,
        "and the user can turn it off — it was a seed, not a fixed style"
    );
}

/// Measured: a disabled control receives no button events at all, so the press is
/// dropped before `pressed` is even recorded.
///
/// Asserted through `:disabled` *and* through `:checked`, because the two failure
/// modes are different — a disabled box that still ticks, and a disabled box that
/// does not look disabled.
#[test]
fn a_disabled_checkbox_takes_no_press_and_does_not_tick() {
    let mut engine = Engine::new(&config(1, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_u32(STYLES, styles::BG, 0, BLACK);
        t.set_u32(STYLES, styles::BG, 1, WHITE);
        t.set_u32(STYLES, styles::BG, 2, GREY);

        node(t, 0, 0, -1);
        // Reads both bits, so the run is four wide: base, checked, disabled, both.
        t.set_i32(VARIANTS, variants::NODE, 0, 0);
        t.set_u32(
            VARIANTS,
            variants::MASK,
            0,
            predicate::CHECKED | predicate::DISABLED,
        );
        t.set_i32(VARIANTS, variants::RUN_START, 0, 0);
        t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, 0, 0);
        t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, 1, 1);
        t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, 2, 2);
        t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, 3, 2);

        control(t, 0, 0, control_kind::CHECKBOX, -1, control_flags::DISABLED);
        pad_controls(t, 1);
        pad_variants(t, 1);
    }
    engine.tick().expect("tick");

    assert_eq!(centre(&mut engine), GREY, "`:disabled` is live at rest");

    engine.mouse_down(50.0, 50.0);
    assert_eq!(
        engine.input_state().pressed,
        -1,
        "the press is not even recorded — measured, no mousedown reaches a disabled control"
    );

    click_centre(&mut engine);
    assert_eq!(centre(&mut engine), GREY, "and it never ticks");
}

/// A press on a label ticks the box it labels, with the box never being what was hit.
///
/// The exact shape of `<label><input type="checkbox"><span>text</span></label>`, which
/// is what the demo page writes and what the pointer actually lands on most of the
/// time: the **text**, not the 18px box.
///
/// The text span is an ordinary node with no styling of its own, and it is
/// `INTERACTIVE` only because `buildInteractive` marks a node that operates a control.
/// Without that, `hit_test` would walk straight past it and a perfectly correct
/// `activates` column would be unreachable — a rule that silently does nothing, which
/// is the failure class this codebase keeps trying to make impossible.
#[test]
fn clicking_a_labels_text_ticks_the_box_beside_it() {
    let mut engine = Engine::new(&config(3, 4)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..4 {
            init_style(t, slot);
        }
        // 0: the label, a row filling the window. 1/2: the box unchecked and checked.
        // 3: the text span, transparent, so it contributes no pixels of its own.
        t.set_u32(STYLES, styles::BG, 0, BLACK);
        t.set_u8(STYLES, styles::FLEX_DIRECTION, 0, flex_direction::ROW);
        t.set_u32(STYLES, styles::BG, 1, BLACK);
        t.set_f32(STYLES, styles::FLEX_GROW, 1, 1.0);
        t.set_u32(STYLES, styles::BG, 2, WHITE);
        t.set_f32(STYLES, styles::FLEX_GROW, 2, 1.0);
        t.set_u32(STYLES, styles::BG, 3, 0x0000_0000);
        t.set_f32(STYLES, styles::FLEX_GROW, 3, 1.0);

        node(t, 0, 0, -1);
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        node(t, 1, 1, 0);
        t.set_i32(NODES, nodes::NEXT_SIBLING, 1, 2);
        node(t, 2, 3, 0);

        // The box carries the variant, because `:checked` styles the control. Node 2
        // only *operates* it.
        variant(t, 0, 1, predicate::CHECKED, 0, 1, 2);
        control(t, 0, 1, control_kind::CHECKBOX, -1, 0);
        pad_controls(t, 1);
        pad_variants(t, 1);

        // Label and span both aim at the box. In the compiler this is one seed plus the
        // downward sweep in `resolveActivation`; here it is two writes.
        t.set_i32(NODES, nodes::ACTIVATES, 0, 1);
        t.set_i32(NODES, nodes::ACTIVATES, 2, 1);
    }
    engine.tick().expect("tick");

    let box_half = |e: &mut Engine| pixel(e, 25, 50);

    assert_eq!(box_half(&mut engine), BLACK, "unchecked at rest");

    // The press lands in the *right* half — the text, never the box.
    engine.mouse_down(75.0, 50.0);
    assert_eq!(
        engine.input_state().pressed,
        2,
        "the span is what was hit, so the box is not what the press is aimed at"
    );
    engine.mouse_up(75.0, 50.0);
    engine.tick().expect("tick");

    assert_eq!(
        box_half(&mut engine),
        WHITE,
        "and the box ticked anyway, because the span forwards to it"
    );

    // **Focus went to the box, not to the span that was hit.** Measured 2026-08-04 and
    // unimplemented until A3 needed it: clicking a label leaves `:focus` on the control,
    // and the label never holds focus at all.
    //
    // It stayed invisible while the pointer was the only way to focus anything, because
    // nothing else had an opinion about where focus should be. Tab does — it lands on the
    // control — and `:focus` is an exact node match rather than a chain, so a click and a
    // Tab that disagreed would make `input:focus` match only one of the two ways of
    // getting there.
    assert_eq!(
        engine.focused(),
        1,
        "the control, not the span — a label never holds focus"
    );
}

/// A radio sets itself and clears its group, and re-clicking it is not a change.
///
/// Two radios side by side, each filling half the window, so both states are one
/// screenshot. The group is what is being tested: without the clear, both would end up
/// white and the picture would look like two independent checkboxes.
#[test]
fn picking_a_radio_clears_the_other_one() {
    let mut engine = Engine::new(&config(3, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_u32(STYLES, styles::BG, 0, BLACK);
        t.set_u32(STYLES, styles::BG, 1, WHITE);

        // A row of two, each growing to half the width.
        node(t, 0, 0, -1);
        t.set_u8(STYLES, styles::FLEX_DIRECTION, 0, flex_direction::ROW);
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        for child in [1usize, 2] {
            node(t, child, 0, 0);
            t.set_f32(STYLES, styles::FLEX_GROW, 0, 1.0);
        }
        t.set_i32(NODES, nodes::NEXT_SIBLING, 1, 2);
        // Each child needs its own grow, and they share style row 0, so grow is set on
        // that row above rather than per node.

        variant(t, 0, 1, predicate::CHECKED, 0, 0, 1);
        variant(t, 1, 2, predicate::CHECKED, 2, 0, 1);
        control(t, 0, 1, control_kind::RADIO, 7, control_flags::CHECKED);
        control(t, 1, 2, control_kind::RADIO, 7, 0);
        pad_controls(t, 2);
        pad_variants(t, 2);
    }
    engine.tick().expect("tick");

    let left = |e: &mut Engine| pixel(e, 25, 50);
    let right = |e: &mut Engine| pixel(e, 75, 50);

    assert_eq!(left(&mut engine), WHITE, "authored checked");
    assert_eq!(right(&mut engine), BLACK);

    engine.mouse_down(75.0, 50.0);
    engine.mouse_up(75.0, 50.0);
    engine.tick().expect("tick");
    assert_eq!(right(&mut engine), WHITE, "the one that was picked");
    assert_eq!(left(&mut engine), BLACK, "and its group-mate was cleared");

    // Again, on the one already checked. A radio cannot be unchecked by pointer.
    engine.mouse_down(75.0, 50.0);
    engine.mouse_up(75.0, 50.0);
    engine.tick().expect("tick");
    assert_eq!(right(&mut engine), WHITE, "still checked, not toggled off");
    assert_eq!(left(&mut engine), BLACK);
}

/// A press released somewhere else focuses the control without ticking it. Measured.
#[test]
fn dragging_off_a_checkbox_does_not_tick_it() {
    let mut engine = checkbox(0);
    assert_eq!(centre(&mut engine), BLACK);

    engine.mouse_down(50.0, 50.0);
    // Off the node entirely. The box fills the window, so "elsewhere" has to be
    // outside it — which is what a release outside the window is.
    engine.mouse_up(500.0, 500.0);
    engine.tick().expect("tick");

    assert_eq!(
        centre(&mut engine),
        BLACK,
        "press and release on different nodes is not a click"
    );
}

// ---------------------------------------------------------------------------
// The overlay layer, on a page that scrolls
// ---------------------------------------------------------------------------

/// A scrolling root with a select partway down it, so the picker has a scroll to survive.
///
/// The window is 100x100. Layout, unscrolled: a 60px spacer, then the select at 60..80,
/// then a second spacer that carries the content past the viewport so there is something to
/// scroll. The picker is out of flow and 20 tall, so it occupies 80..100 when open.
///
/// The two spacers are the point. One before the select puts it far enough down that a
/// scroll moves it visibly; one after makes the content overflow at all. With either
/// missing the test cannot tell a correct picker from one drawn at its unscrolled position.
fn scrolling_select() -> Engine {
    let mut engine = Engine::new(&config(5, 5)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..5 {
            init_style(t, slot);
        }
        t.set_u8(STYLES, styles::OVERFLOW_Y, 0, protocol::overflow::SCROLL);
        // 1 spacer above, 2 select, 3 picker, 4 spacer below.
        t.set_u32(STYLES, styles::BG, 1, BLACK);
        t.set_f32(STYLES, styles::HEIGHT, 1, 60.0);
        t.set_u32(STYLES, styles::BG, 2, GREY);
        t.set_f32(STYLES, styles::HEIGHT, 2, 20.0);
        t.set_u32(STYLES, styles::BG, 3, WHITE);
        t.set_f32(STYLES, styles::HEIGHT, 3, 20.0);
        t.set_u8(STYLES, styles::POSITION, 3, 1 /* absolute */);
        // An explicit width, because an absolutely positioned box with `auto` width and no
        // insets shrink-wraps its content — and this one's content is nothing, so Taffy
        // gives it zero and the picker paints an empty rect. The demo's stylesheet sets
        // `width: 220px` on its picker for the same reason.
        t.set_f32(STYLES, styles::WIDTH, 3, 100.0);
        t.set_u32(STYLES, styles::BG, 4, BLACK);
        t.set_f32(STYLES, styles::HEIGHT, 4, 200.0);

        // **`flex-shrink: 0` on every child, or none of the heights above survive.** The
        // root is a flex column and `init_style` gives each child CSS's initial shrink of
        // 1, so 280px of content in a 100px box is *distributed* rather than overflowing —
        // the select landed at 42.857 and there was nothing to scroll. Overflow is the
        // whole premise here, so the children have to refuse to shrink.
        for slot in 1..5 {
            t.set_f32(STYLES, styles::FLEX_SHRINK, slot, 0.0);
        }

        node(t, 0, 0, -1);
        node(t, 1, 1, 0);
        node(t, 2, 2, 0);
        node(t, 3, 3, 2);
        node(t, 4, 4, 0);
        // `INTERACTIVE` as well as `OVERLAY`, and setting only the latter is what made the
        // hit assertions below read -1: `node()` had put the interactive bit there and this
        // line replaced it rather than adding to it.
        //
        // In a compiled tree these are two nodes — the picker box is `generated` and
        // deliberately *not* interactive, while its options are — and `hit_overlay`
        // returning `Some(-1)` for a press on the box itself is the designed answer:
        // consumed by the overlay, but nothing chosen. Here one node plays both parts, so it
        // has to carry both bits.
        t.set_u8(
            NODES,
            nodes::FLAGS,
            3,
            protocol::flags::OVERLAY | protocol::flags::INTERACTIVE,
        );

        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        t.set_i32(NODES, nodes::NEXT_SIBLING, 1, 2);
        t.set_i32(NODES, nodes::NEXT_SIBLING, 2, 4);
        t.set_i32(NODES, nodes::FIRST_CHILD, 2, 3);

        control(t, 0, 2, control_kind::SELECT, -1, 0);
        control(t, 1, 3, control_kind::OPTION, 0, control_flags::CHECKED);
        // Every part of a select operates the select, as `resolveActivation` arranges. The
        // picker here doubles as the option, which keeps the tree to five nodes.
        pad_controls(t, 2);
        pad_variants(t, 0);
    }
    engine.tick().expect("tick");
    engine
}

/// Finishes a scroll glide and reports where the root ended up.
///
/// A wheel glides rather than jumping, and the glide is driven by *elapsed time* — so
/// spinning `tick` in a loop settles nothing: six hundred frames execute in microseconds and
/// the content barely moves. `advance_scrolls` takes the `dt` directly, which is the same
/// lever `--advance` gives a golden.
fn settle(engine: &mut Engine) -> f32 {
    engine.advance_scrolls(1.0);
    engine.tick().expect("tick");
    engine.scroll_of(0)[1]
}

/// A picker is drawn where its select **is**, not where its unscrolled box says.
///
/// The regression the demo found. `bounds` are unscrolled and the main paint walk subtracts
/// each node's ancestors' scroll as it descends; an overlay pass starts *at* the picker, so
/// it inherits none of that accumulation. The first version therefore drew the box at its
/// unscrolled position — and since the demo's window is 1040x700 while its selects sit at
/// y≈943, reaching one means scrolling, and the picker landed a screenful away. Pressing a
/// `<select>` looked like it did nothing at all.
///
/// Asserted on pixels and on the hit test rather than on the offset, because the offset is
/// what was wrong: a test that recomputed it would have agreed with the bug.
#[test]
fn a_pickers_position_follows_the_scroll_of_the_page_under_it() {
    let mut engine = scrolling_select();
    assert_eq!(
        engine.bounds_of(2).expect("select laid out")[1],
        60.0,
        "the select starts at 60 unscrolled"
    );

    // One notch is 48px, which leaves the select drawn at 12..32 — comfortably in view, and
    // far enough from its unscrolled 60..80 that the two cannot be confused.
    engine.scroll_at(50.0, 50.0, 0.0, 48.0);
    let scrolled = settle(&mut engine);
    assert_eq!(scrolled, 48.0, "the page scrolled a whole notch");

    let drawn_top = 60.0 - scrolled;
    engine.mouse_down(50.0, drawn_top + 10.0);
    engine.tick().expect("tick");
    assert_eq!(engine.open_selection().0, 2, "the press opened the picker");

    // The picker is white and sits against the select's *drawn* bottom edge, so 32..52.
    // Before the fix it was drawn at 80..100 and this pixel was the lower spacer's black.
    let mid = (drawn_top + 20.0 + 10.0) as usize;
    assert_eq!(
        pixel(&mut engine, 50, mid),
        WHITE,
        "the picker follows the select onto the screen"
    );
    assert_eq!(
        pixel(&mut engine, 50, 90),
        BLACK,
        "and is no longer drawn at its unscrolled position"
    );

    // The pointer has to agree with the pixels, which is the half that makes it usable:
    // two different offsets would put the clickable options somewhere else entirely.
    assert_eq!(
        engine.hit_test(50.0, mid as f32),
        3,
        "the option under the pointer is the one drawn there"
    );
}

/// The same picker, unscrolled — so a "fix" that subtracted something unconditionally
/// cannot satisfy both tests.
#[test]
fn an_unscrolled_pickers_position_is_unchanged() {
    let mut engine = scrolling_select();

    engine.mouse_down(50.0, 70.0);
    engine.tick().expect("tick");
    assert_eq!(engine.open_selection().0, 2);

    assert_eq!(
        pixel(&mut engine, 50, 90),
        WHITE,
        "the picker occupies 80..100"
    );
    assert_eq!(engine.hit_test(50.0, 90.0), 3);
}

/// The keyboard half of a `<select>` — which had **no test at all** until this.
///
/// Not an oversight in one file: `pump_input` returns immediately when there is no window, so
/// until `Engine::key_down` was extracted nothing headless could press a key, and every
/// keyboard behaviour in the engine was documented on the strength of code no test had run.
/// Keyboard operability is the half of accessibility dziri claims — ROADMAP's Accessibility
/// table says keyboard yes, assistive tech not yet — so untestable was the wrong state for it.
mod keyboard {
    use super::*;
    use dziri_engine::engine::keys;

    /// Node 2 is the select, 3 its picker, 4 and 5 the two options. Both options share a
    /// group, so committing behaves as the radio set it is.
    fn two_option_select() -> Engine {
        let mut engine = Engine::new(&config(6, 4)).expect("engine");
        {
            let t = engine.tables_mut();
            for slot in 0..4 {
                init_style(t, slot);
            }
            t.set_u32(STYLES, styles::BG, 1, GREY);
            t.set_f32(STYLES, styles::HEIGHT, 1, 40.0);
            t.set_u8(STYLES, styles::POSITION, 2, 1 /* absolute */);
            t.set_f32(STYLES, styles::WIDTH, 2, 100.0);
            t.set_f32(STYLES, styles::HEIGHT, 2, 40.0);
            t.set_u32(STYLES, styles::BG, 3, WHITE);
            t.set_f32(STYLES, styles::HEIGHT, 3, 20.0);

            node(t, 0, 0, -1);
            node(t, 1, 0, 0);
            node(t, 2, 1, 0);
            node(t, 3, 2, 2);
            node(t, 4, 3, 3);
            node(t, 5, 3, 3);
            t.set_u8(
                NODES,
                nodes::FLAGS,
                3,
                protocol::flags::OVERLAY | protocol::flags::INTERACTIVE,
            );

            t.set_i32(NODES, nodes::FIRST_CHILD, 0, 2);
            t.set_i32(NODES, nodes::FIRST_CHILD, 2, 3);
            t.set_i32(NODES, nodes::FIRST_CHILD, 3, 4);
            t.set_i32(NODES, nodes::NEXT_SIBLING, 4, 5);

            control(t, 0, 2, control_kind::SELECT, -1, 0);
            control(t, 1, 4, control_kind::OPTION, 7, control_flags::CHECKED);
            control(t, 2, 5, control_kind::OPTION, 7, 0);
            pad_controls(t, 3);
            pad_variants(t, 0);
        }
        engine.tick().expect("tick");
        engine
    }

    /// Focus the select the only way anything can today: by clicking it.
    ///
    /// **This is the honest limit of dziri's keyboard story and it deserves a comment rather
    /// than a helper name that hides it.** There is no Tab order (ROADMAP A3), so a `<select>`
    /// cannot be *reached* from the keyboard at all — every test below therefore starts with a
    /// pointer, which means the keyboard behaviour they prove is only available to someone who
    /// can already use a mouse. That is not keyboard accessible, and no amount of correct
    /// arrow handling makes it so.
    fn focus_by_clicking(engine: &mut Engine) {
        engine.mouse_down(50.0, 20.0);
        engine.mouse_up(50.0, 20.0);
        engine.tick().expect("tick");
        // The press opened it, since a select opens on `mouse_down`. Escape closes it and
        // leaves focus on the select, which is the state these tests start from.
        engine.key_down(keys::ESCAPE, 0);
        engine.tick().expect("tick");
        assert_eq!(
            engine.open_selection().0,
            -1,
            "closed, ready to open by key"
        );
    }

    /// Every measured way to open a closed select.
    ///
    /// Measured 2026-08-06, Chromium 151: ArrowDown, ArrowUp, **Enter**, Space, F4 and
    /// Alt+ArrowDown all open one.
    ///
    /// This test previously asserted the opposite for Enter, and named it as a refuted
    /// assumption, because the probe that "measured" it dispatched Enter with no text and
    /// Blink never ran its activation path. Both the test and the engine were written to a
    /// broken instrument, and the test passing is what made that comfortable — the assertion
    /// was faithful to the engine and the engine was faithful to nothing. Kept in the same
    /// shape, with the row corrected, so the loop stays the list of measured opening keys.
    #[test]
    fn every_measured_key_opens_a_closed_select() {
        for key in [keys::DOWN, keys::UP, keys::RETURN, keys::SPACE, keys::F4] {
            let mut engine = two_option_select();
            focus_by_clicking(&mut engine);
            engine.key_down(key, 0);
            engine.tick().expect("tick");
            assert_eq!(engine.open_selection().0, 2, "key {key} should open it");
        }
    }

    /// Enter means two things, and which one is decided by state rather than by the key.
    ///
    /// The pair worth asserting together: the same keycode that opens a closed picker commits
    /// an open one. Separately each looks like an ordinary row; together they are the reason
    /// the "a key cannot both open and commit" argument was wrong.
    #[test]
    fn enter_opens_a_closed_picker_and_commits_an_open_one() {
        let mut engine = two_option_select();
        focus_by_clicking(&mut engine);

        engine.key_down(keys::RETURN, 0);
        engine.tick().expect("tick");
        assert_eq!(
            engine.open_selection().0,
            2,
            "Enter on a closed select opens it"
        );
        assert_eq!(engine.focused(), 4, "and lands on the committed option");

        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.focused(), 5, "the arrow moved the highlight");
        assert_eq!(
            engine.open_selection().1,
            4,
            "and committed nothing — an arrow fires no change"
        );

        engine.key_down(keys::RETURN, 0);
        engine.tick().expect("tick");
        assert_eq!(
            engine.open_selection().0,
            -1,
            "the second Enter committed and closed, rather than reopening"
        );
    }

    /// **Tab with a picker open is Escape**, and it does not advance the tab order.
    ///
    /// Measured 2026-08-06 rather than chosen, because all three armchair answers are
    /// defensible: consume it, close and move on, or move and leave the picker up. Chromium
    /// closes, discards the highlight with the value untouched, returns focus to the select
    /// and stops there. The wrong one is visible — a dropdown hanging over a page whose
    /// focus has already moved somewhere else.
    #[test]
    fn tab_closes_an_open_picker_without_advancing_focus() {
        let mut engine = two_option_select();
        focus_by_clicking(&mut engine);
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(
            engine.focused(),
            5,
            "highlight moved off the committed option"
        );

        engine.key_down(keys::TAB, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.open_selection().0, -1, "Tab closed the picker");
        assert_eq!(
            engine.focused(),
            2,
            "focus is back on the select, not on the next stop"
        );
    }

    /// **A commit reports the select, not the option, and says which one.**
    ///
    /// Measured: `probes/select-picker.html` listens on the `<select>` and that is where
    /// `input` and `change` arrive. The engine named the option and carried a constant 1
    /// until an `onChange` handler existed to receive it — a queue nobody drains can be
    /// wrong indefinitely without anything failing, which is why this assertion is worth
    /// more than it looks.
    ///
    /// The index rather than the node id, because an id is an implementation detail an
    /// author never sees and the index is the position in the list they wrote.
    #[test]
    fn committing_reports_the_select_and_the_chosen_index() {
        let mut engine = two_option_select();
        focus_by_clicking(&mut engine);
        engine.key_down(keys::RETURN, 0);
        engine.tick().expect("tick");
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");

        let mut out = [dziri_engine::engine::Event::default(); 16];
        let n = engine.drain_events(&mut out);
        let _ = n;

        engine.key_down(keys::RETURN, 0);
        engine.tick().expect("tick");
        let n = engine.drain_events(&mut out);
        let change = out[..n]
            .iter()
            .find(|e| e.kind == protocol::event_kind::CHANGE)
            .expect("a commit fires CHANGE");

        assert_eq!(change.node, 2, "the select, not the option");
        assert_eq!(change.a, 1, "the second option, by index");

        // And the CLICK still names the row, because dziri has no bubbling — the two
        // events answer different questions and only one of them was retargeted.
        let click = out[..n]
            .iter()
            .find(|e| e.kind == protocol::event_kind::CLICK)
            .expect("a commit fires CLICK too");
        assert_eq!(click.node, 5, "the option that was chosen");
    }

    /// Home and End jump to the ends of the list. Measured 2026-08-06 in the run that
    /// settled the clamp, and absent until then — a list that answers arrows but not Home is
    /// one a keyboard user notices immediately.
    #[test]
    fn home_and_end_jump_to_the_ends_of_the_picker() {
        let mut engine = two_option_select();
        focus_by_clicking(&mut engine);
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");

        engine.key_down(keys::END, 0);
        engine.tick().expect("tick");
        let last = engine.focused();

        engine.key_down(keys::HOME, 0);
        engine.tick().expect("tick");
        let first = engine.focused();

        assert_ne!(first, last, "Home and End land on different options");
        assert!(first < last, "Home lands earlier in the list than End");

        // End again from the end is a no-op rather than a wrap — the same clamp the arrows
        // use, asserted here because Home/End take a different branch to reach it.
        engine.key_down(keys::END, 0);
        engine.tick().expect("tick");
        engine.key_down(keys::END, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.focused(), last, "End is idempotent");
    }

    /// Arrows move the highlight and commit nothing; Enter is what commits.
    #[test]
    fn arrows_move_the_highlight_and_enter_commits() {
        let mut engine = two_option_select();
        focus_by_clicking(&mut engine);

        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(
            engine.open_selection(),
            (2, 4),
            "opening lands on the committed option, so Down-then-Enter means the next one"
        );

        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        // Both halves, because this line used to assert only the second while its message
        // claimed the first. `open_selection().1` is the *committed* option and cannot move
        // on an arrow, so "the highlight moved" was being proven by a number incapable of
        // showing it. `focused` is the highlight; the pair says what the message says.
        assert_eq!(engine.focused(), 5, "the highlight moved");
        assert_eq!(
            engine.open_selection(),
            (2, 4),
            "and nothing committed — an arrow fires no change"
        );

        engine.key_down(keys::RETURN, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.open_selection().0, -1, "Enter closed it");

        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(
            engine.open_selection().1,
            5,
            "Enter committed the highlight"
        );
    }

    /// Escape closes with the value untouched, which is the point of the highlight being
    /// separable from the selection.
    #[test]
    fn escape_discards_the_highlight() {
        let mut engine = two_option_select();
        focus_by_clicking(&mut engine);

        engine.key_down(keys::DOWN, 0);
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        engine.key_down(keys::ESCAPE, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.open_selection().0, -1, "Escape closed it");

        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(
            engine.open_selection().1,
            4,
            "and the value is the one it started with"
        );
    }

    /// Clamped at both ends rather than wrapping. A browser's picker stops at the last
    /// option; wrapping would make a long list feel like it had lost the user's place.
    #[test]
    fn the_highlight_clamps_at_both_ends() {
        let mut engine = two_option_select();
        focus_by_clicking(&mut engine);
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");

        for _ in 0..5 {
            engine.key_down(keys::DOWN, 0);
        }
        engine.key_down(keys::RETURN, 0);
        engine.tick().expect("tick");
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.open_selection().1, 5, "clamped at the last option");

        for _ in 0..5 {
            engine.key_down(keys::UP, 0);
        }
        engine.key_down(keys::RETURN, 0);
        engine.tick().expect("tick");
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.open_selection().1, 4, "and at the first");
    }

    /// Whether the host was told about a key. `drain_events` fills a caller-owned buffer and
    /// returns how many it wrote, so a test needs somewhere for them to land.
    fn forwarded_a_key(engine: &mut Engine) -> bool {
        let mut out = [dziri_engine::engine::Event::default(); 16];
        let n = engine.drain_events(&mut out);
        out[..n]
            .iter()
            .any(|e| e.kind == protocol::event_kind::KEY_DOWN)
    }

    /// A key the picker claims is not forwarded; one it does not claim still reaches the host.
    ///
    /// The distinction is measured: an arrow with a picker open fires `keydown` and *nothing
    /// else* — no `input`, no `change`, and the value does not move — so a host that also
    /// received it could act on a key the engine had already handled.
    #[test]
    fn a_claimed_key_is_not_forwarded_and_an_unclaimed_one_is() {
        let mut engine = two_option_select();
        focus_by_clicking(&mut engine);
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        let _ = forwarded_a_key(&mut engine);

        engine.key_down(keys::DOWN, 0);
        assert!(
            !forwarded_a_key(&mut engine),
            "an arrow in an open picker is the engine's"
        );

        engine.key_down(0x7a, 0);
        assert!(
            forwarded_a_key(&mut engine),
            "a key the engine does not claim reaches the host"
        );
    }
}

/// Tab and Shift+Tab over the live tree — ROADMAP A3's focus walk.
///
/// Every fixture here builds the *set* by hand, as the compiler would: `TAB_STOP` on the
/// nodes that are stops and nothing else. What is being tested is the other half — that
/// the order is a walk, and that the three run-time exclusions the compiler cannot see
/// are applied by the engine.
mod tab_order {
    use super::*;
    use dziri_engine::engine::keys;

    /// A root with four tab stops as its children, in document order 1..=4.
    ///
    /// Style slot 1 is the ordinary one; slot 2 is `display: none`, used by one test and
    /// built here so every fixture has the same table shape.
    fn four_stops() -> Engine {
        let mut engine = Engine::new(&config(5, 3)).expect("engine");
        {
            let t = engine.tables_mut();
            for slot in 0..3 {
                init_style(t, slot);
            }
            t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
            t.set_u8(STYLES, styles::DISPLAY, 2, display::NONE);

            node(t, 0, 0, -1);
            for i in 1..5 {
                node(t, i, 1, 0);
                t.set_u8(
                    NODES,
                    nodes::FLAGS,
                    i,
                    protocol::flags::INTERACTIVE | protocol::flags::TAB_STOP,
                );
            }
            t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
            for i in 1..4 {
                t.set_i32(NODES, nodes::NEXT_SIBLING, i, (i + 1) as i32);
            }

            pad_controls(t, 0);
            pad_variants(t, 0);
        }
        engine.tick().expect("tick");
        engine
    }

    /// Press Tab `n` times and collect where focus landed after each.
    fn tab(engine: &mut Engine, n: usize, backward: bool) -> Vec<i32> {
        let mods = if backward { 1 << 0 } else { 0 };
        let mut seen = Vec::new();
        for _ in 0..n {
            engine.key_down(keys::TAB, mods);
            engine.tick().expect("tick");
            seen.push(engine.focused());
        }
        seen
    }

    #[test]
    fn tab_walks_document_order_and_wraps() {
        let mut engine = four_stops();
        assert_eq!(
            engine.focused(),
            -1,
            "nothing is focused when a window opens"
        );
        assert_eq!(
            tab(&mut engine, 5, false),
            vec![1, 2, 3, 4, 1],
            "the first Tab enters at the top, and the fifth wraps"
        );
    }

    /// Wrapping is a deliberate divergence, not the absence of a rule.
    ///
    /// A browser hands focus to its own chrome at the end of the document — measured as
    /// one stop on `BODY` before the cycle restarted — and dziri has no chrome to hand it
    /// to. The alternative is focus falling off the end with no keyboard way back.
    #[test]
    fn shift_tab_walks_the_same_list_backwards() {
        let mut engine = four_stops();
        assert_eq!(
            tab(&mut engine, 5, true),
            vec![4, 3, 2, 1, 4],
            "the first Shift+Tab enters at the bottom"
        );
    }

    /// `disabled` leaves the tab order and `readonly` does not — measured, and the two are
    /// easy to conflate. Only the first is expressible today, and it costs nothing because
    /// the engine already owns the bit for `:disabled`.
    #[test]
    fn a_disabled_control_is_skipped() {
        let mut engine = four_stops();
        {
            let t = engine.tables_mut();
            control(t, 0, 2, control_kind::CHECKBOX, -1, control_flags::DISABLED);
            pad_controls(t, 1);
        }
        engine.tick().expect("tick");

        assert_eq!(
            tab(&mut engine, 4, false),
            vec![1, 3, 4, 1],
            "node 2 is disabled, so the order steps over it"
        );
    }

    /// A node the user cannot see must not be a tab stop, and `display: none` is the case
    /// the compiler structurally cannot answer — it is a layout fact, and the same fact
    /// paint reads. Both answers come from one function so they cannot drift.
    #[test]
    fn a_display_none_node_is_not_in_the_order() {
        let mut engine = four_stops();
        {
            let t = engine.tables_mut();
            t.set_u16(NODES, nodes::STYLE, 3, 2);
        }
        engine.tick().expect("tick");

        assert_eq!(tab(&mut engine, 4, false), vec![1, 2, 4, 1]);
    }

    /// A route that is not showing takes its whole subtree with it.
    ///
    /// The demo has thirteen such routes on the first frame. Without this the tab order
    /// walks into pages the user cannot see and cannot leave — a keyboard trap arrived at
    /// by omission rather than by a wrong rule.
    #[test]
    fn a_hidden_subtree_is_not_in_the_order() {
        let mut engine = four_stops();
        {
            let t = engine.tables_mut();
            t.set_u8(NODES, nodes::HIDDEN, 2, 1);
        }
        engine.tick().expect("tick");

        assert_eq!(tab(&mut engine, 4, false), vec![1, 3, 4, 1]);
    }

    /// **A radio group is one tab stop, and it is the checked member.**
    ///
    /// Measured, `probes/tab-order.html`: a group with nothing checked stops on its first
    /// member; a group with a checked member stops on that one, skipping earlier siblings.
    /// This is ARIA's roving tabindex reached from the platform rather than from the
    /// pattern, and it is the first of the five controls A3 wants the mechanism for.
    #[test]
    fn a_radio_group_is_one_stop_on_the_checked_member() {
        let mut engine = four_stops();
        {
            let t = engine.tables_mut();
            control(t, 0, 1, control_kind::RADIO, 7, 0);
            control(t, 1, 2, control_kind::RADIO, 7, control_flags::CHECKED);
            control(t, 2, 3, control_kind::RADIO, 7, 0);
            pad_controls(t, 3);
        }
        engine.tick().expect("tick");

        assert_eq!(
            tab(&mut engine, 3, false),
            vec![2, 4, 2],
            "three radios are one stop, on the checked one, and node 4 is the next"
        );
    }

    /// With nothing checked the stop is the group's **first** member — which is a
    /// different rule from "the checked one", not a special case of it, and the one that
    /// decides where focus lands in a form nobody has filled in yet.
    #[test]
    fn an_unchecked_radio_group_stops_on_its_first_member() {
        let mut engine = four_stops();
        {
            let t = engine.tables_mut();
            control(t, 0, 2, control_kind::RADIO, 7, 0);
            control(t, 1, 3, control_kind::RADIO, 7, 0);
            pad_controls(t, 2);
        }
        engine.tick().expect("tick");

        assert_eq!(tab(&mut engine, 3, false), vec![1, 2, 4]);
    }

    /// The order is a walk, so re-parenting a node moves it in the order — which is the
    /// entire reason the order is not a sorted table of ids.
    ///
    /// Node 4 is spliced to the front of the sibling list, keeping its id. Ids are still
    /// ascending, so anything reading the *set* as a sequence would answer 1,2,3,4 and be
    /// wrong. A5's keyed lists reorder exactly like this.
    #[test]
    fn the_order_follows_the_tree_and_not_the_node_ids() {
        let mut engine = four_stops();
        {
            let t = engine.tables_mut();
            // 4 first, then 1, 2, 3.
            t.set_i32(NODES, nodes::FIRST_CHILD, 0, 4);
            t.set_i32(NODES, nodes::NEXT_SIBLING, 4, 1);
            t.set_i32(NODES, nodes::NEXT_SIBLING, 3, -1);
        }
        engine.tick().expect("tick");

        assert_eq!(
            tab(&mut engine, 4, false),
            vec![4, 1, 2, 3],
            "document order, which is now 4 1 2 3 — a sorted table would say 1 2 3 4"
        );
    }
}

/// Enter and Space on a focused control — ROADMAP A3's activation, measured per kind.
///
/// Every assertion here has a row in `probes/keyboard-activation.html`, and the two that
/// would most easily have been implemented backwards are the ones about *when*: Enter
/// fires on the press and Space on the release. The engine had no release to fire on
/// until this landed, so a plausible implementation would have put both on `key_down`,
/// passed every test anyone thought to write, and shipped a control that is not the one
/// browsers ship.
mod activation {
    use super::*;
    use dziri_engine::engine::keys;

    /// Root, a button (1) and a checkbox (2), both tab stops.
    fn button_and_checkbox() -> Engine {
        let mut engine = Engine::new(&config(3, 2)).expect("engine");
        {
            let t = engine.tables_mut();
            init_style(t, 0);
            init_style(t, 1);
            t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);

            node(t, 0, 0, -1);
            node(t, 1, 1, 0);
            node(t, 2, 1, 0);
            for i in 1..3 {
                t.set_u8(
                    NODES,
                    nodes::FLAGS,
                    i,
                    protocol::flags::INTERACTIVE | protocol::flags::TAB_STOP,
                );
            }
            t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
            t.set_i32(NODES, nodes::NEXT_SIBLING, 1, 2);

            control(t, 0, 1, control_kind::BUTTON, -1, 0);
            control(t, 1, 2, control_kind::CHECKBOX, -1, 0);
            pad_controls(t, 2);
            pad_variants(t, 0);
        }
        engine.tick().expect("tick");
        engine
    }

    /// Every event the engine has queued, as `(kind, node)`.
    fn drained(engine: &mut Engine) -> Vec<(u32, i32)> {
        let mut out = [dziri_engine::engine::Event::default(); 16];
        let n = engine.drain_events(&mut out);
        out[..n].iter().map(|e| (e.kind, e.node)).collect()
    }

    /// Focus the first tab stop and throw away the events that got us there.
    fn focus_first(engine: &mut Engine) {
        engine.key_down(keys::TAB, 0);
        engine.tick().expect("tick");
        drained(engine);
    }

    #[test]
    fn enter_clicks_a_button_on_the_press() {
        let mut engine = button_and_checkbox();
        focus_first(&mut engine);
        assert_eq!(engine.focused(), 1);

        engine.key_down(keys::RETURN, 0);
        engine.tick().expect("tick");
        let events = drained(&mut engine);

        // Both, in this order. A browser fires `keydown` *and* the synthesised click — the
        // key event is not swallowed by the activation, unlike an open picker's keys.
        assert_eq!(
            events,
            vec![
                (protocol::event_kind::KEY_DOWN, 1),
                (protocol::event_kind::CLICK, 1),
            ],
        );
    }

    #[test]
    fn space_clicks_a_button_on_the_release_and_not_on_the_press() {
        let mut engine = button_and_checkbox();
        focus_first(&mut engine);

        engine.key_down(keys::SPACE, 0);
        engine.tick().expect("tick");
        let pressed = drained(&mut engine);
        assert!(
            !pressed
                .iter()
                .any(|&(k, _)| k == protocol::event_kind::CLICK),
            "the press must not activate; measured, Space waits for the release"
        );

        engine.key_up(keys::SPACE);
        engine.tick().expect("tick");
        assert_eq!(drained(&mut engine), vec![(protocol::event_kind::CLICK, 1)]);
    }

    /// Space ticks a checkbox on the release, and both a `CLICK` and a `CHANGE` come out —
    /// which is the same pair a pointer produces, because a keyboard activation really is
    /// a click.
    #[test]
    fn space_ticks_a_focused_checkbox() {
        let mut engine = button_and_checkbox();
        focus_first(&mut engine);
        engine.key_down(keys::TAB, 0);
        engine.tick().expect("tick");
        drained(&mut engine);
        assert_eq!(engine.focused(), 2, "the checkbox");

        engine.key_up(keys::SPACE);
        engine.tick().expect("tick");
        assert_eq!(
            drained(&mut engine),
            vec![
                (protocol::event_kind::CLICK, 2),
                (protocol::event_kind::CHANGE, 2),
            ],
        );

        // And again, back off — a checkbox toggles, so the second release unticks it.
        engine.key_up(keys::SPACE);
        engine.tick().expect("tick");
        assert_eq!(
            drained(&mut engine),
            vec![
                (protocol::event_kind::CLICK, 2),
                (protocol::event_kind::CHANGE, 2),
            ],
        );
    }

    /// **Enter does nothing to a checkbox.** Measured, and the asymmetry that makes Enter
    /// and Space two rules rather than one "activate" key.
    #[test]
    fn enter_does_not_tick_a_checkbox() {
        let mut engine = button_and_checkbox();
        focus_first(&mut engine);
        engine.key_down(keys::TAB, 0);
        engine.tick().expect("tick");
        drained(&mut engine);

        engine.key_down(keys::RETURN, 0);
        engine.tick().expect("tick");
        let events = drained(&mut engine);
        assert!(
            !events
                .iter()
                .any(|&(k, _)| k == protocol::event_kind::CLICK),
            "no click, so no activation"
        );
        assert!(
            !events
                .iter()
                .any(|&(k, _)| k == protocol::event_kind::CHANGE),
            "and nothing changed"
        );
        // The key still reaches the host, which is the difference between "not activated"
        // and "swallowed".
        assert!(events
            .iter()
            .any(|&(k, _)| k == protocol::event_kind::KEY_DOWN));
    }

    /// Nothing focused is not an error, and it must not activate anything.
    #[test]
    fn a_key_with_nothing_focused_activates_nothing() {
        let mut engine = button_and_checkbox();
        engine.key_down(keys::RETURN, 0);
        engine.key_up(keys::SPACE);
        engine.tick().expect("tick");
        assert!(!drained(&mut engine)
            .iter()
            .any(|&(k, _)| k == protocol::event_kind::CLICK),);
    }
}

/// Arrows inside a radio group — the half of roving tabindex that makes the other half
/// safe.
///
/// A group is one tab stop on its checked member. On its own that is a trap: Space on an
/// already-checked radio fires nothing at all (measured), so a keyboard user could reach
/// the group and never change the answer. These tests are the escape from it.
mod group_arrows {
    use super::*;
    use dziri_engine::engine::keys;

    /// Root with three radios in one group (1, 2, 3) and a plain button (4) after them.
    /// The middle radio starts checked, so the group's tab stop is node 2.
    fn radio_group() -> Engine {
        let mut engine = Engine::new(&config(5, 2)).expect("engine");
        {
            let t = engine.tables_mut();
            init_style(t, 0);
            init_style(t, 1);
            t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);

            node(t, 0, 0, -1);
            for i in 1..5 {
                node(t, i, 1, 0);
                t.set_u8(
                    NODES,
                    nodes::FLAGS,
                    i,
                    protocol::flags::INTERACTIVE | protocol::flags::TAB_STOP,
                );
            }
            t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
            for i in 1..4 {
                t.set_i32(NODES, nodes::NEXT_SIBLING, i, (i + 1) as i32);
            }

            control(t, 0, 1, control_kind::RADIO, 7, 0);
            control(t, 1, 2, control_kind::RADIO, 7, control_flags::CHECKED);
            control(t, 2, 3, control_kind::RADIO, 7, 0);
            control(t, 3, 4, control_kind::BUTTON, -1, 0);
            pad_variants(t, 0);
        }
        engine.tick().expect("tick");
        engine
    }

    fn checked(engine: &Engine) -> Vec<i32> {
        (1..4)
            .filter(|&n| engine.is_checked(n))
            .collect::<Vec<i32>>()
    }

    fn tab_in(engine: &mut Engine) {
        engine.key_down(keys::TAB, 0);
        engine.tick().expect("tick");
    }

    /// The trap, closed. Tab lands on the checked member and every other member is
    /// reachable from there — which before this was not true of any of them.
    #[test]
    fn arrows_reach_the_members_tab_cannot() {
        let mut engine = radio_group();
        tab_in(&mut engine);
        assert_eq!(engine.focused(), 2, "the tab stop is the checked member");

        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.focused(), 3);

        engine.key_down(keys::UP, 0);
        engine.key_down(keys::UP, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.focused(), 1, "and back past where Tab put us");
    }

    /// **Landing selects**, which no other key in this engine does. Measured: one arrow
    /// press fires `click`, `input` and `change` on the newly focused radio.
    #[test]
    fn an_arrow_moves_the_selection_with_the_focus() {
        let mut engine = radio_group();
        tab_in(&mut engine);
        assert_eq!(checked(&engine), vec![2]);

        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(checked(&engine), vec![3], "arrowing changed the value");

        engine.key_down(keys::UP, 0);
        engine.tick().expect("tick");
        assert_eq!(checked(&engine), vec![2], "and back");
    }

    /// All four arrows work and the group has no orientation — Right is Down and Left is
    /// Up. A browser does not ask how the group was laid out, and neither can dziri:
    /// `flex-direction` is a style, and the keys are the same either way.
    #[test]
    fn right_is_down_and_left_is_up() {
        let mut engine = radio_group();
        tab_in(&mut engine);

        engine.key_down(keys::RIGHT, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.focused(), 3);

        engine.key_down(keys::LEFT, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.focused(), 2);
    }

    /// **A group wraps where a picker clamps.** Both measured, and the only difference
    /// between the two walks — which is why it is a flag on `arrow_nav` rather than a
    /// policy inside `step_within`.
    #[test]
    fn a_group_wraps_at_both_ends() {
        let mut engine = radio_group();
        tab_in(&mut engine);

        engine.key_down(keys::DOWN, 0);
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.focused(), 1, "off the end and round to the first");

        engine.key_down(keys::UP, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.focused(), 3, "and backwards off the start");
    }

    /// The tab stop follows the arrow, because the stop *is* the checked member and the
    /// arrow moves the check. Falls out rather than being arranged, and it is what makes
    /// tabbing away and back return to the user's choice rather than to where they started.
    #[test]
    fn the_groups_tab_stop_follows_the_selection() {
        let mut engine = radio_group();
        tab_in(&mut engine);
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(engine.focused(), 3);

        // Out of the group to the button, then round the cycle back in.
        tab_in(&mut engine);
        assert_eq!(engine.focused(), 4, "the button after the group");
        tab_in(&mut engine);
        assert_eq!(
            engine.focused(),
            3,
            "back into the group at what the arrow chose, not at the first member"
        );
    }

    /// A disabled member is not focusable, so an arrow must step over it — the arrow list
    /// and the tab order come from the same walk precisely so they cannot disagree about
    /// which nodes exist.
    #[test]
    fn an_arrow_steps_over_a_disabled_member() {
        let mut engine = radio_group();
        {
            let t = engine.tables_mut();
            t.set_u8(CONTROLS, controls::FLAGS, 2, control_flags::DISABLED);
        }
        engine.tick().expect("tick");

        tab_in(&mut engine);
        assert_eq!(engine.focused(), 2);
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        assert_eq!(
            engine.focused(),
            1,
            "node 3 is disabled, so Down wraps to 1"
        );
    }

    /// An arrow with a button focused is not the group's, and must reach the host — the
    /// engine claims only what it handles.
    #[test]
    fn an_arrow_outside_a_group_is_not_claimed() {
        let mut engine = radio_group();
        tab_in(&mut engine);
        tab_in(&mut engine);
        assert_eq!(engine.focused(), 4, "the button");

        let mut out = [dziri_engine::engine::Event::default(); 16];
        engine.key_down(keys::DOWN, 0);
        engine.tick().expect("tick");
        let n = engine.drain_events(&mut out);
        assert!(
            out[..n]
                .iter()
                .any(|e| e.kind == protocol::event_kind::KEY_DOWN),
            "an arrow the engine does not handle still reaches the host"
        );
        assert_eq!(checked(&engine), vec![2], "and nothing was selected");
    }
}
