//! `<select multiple>` — the selection rules, driven through real presses and keys.
//!
//! Every rule asserted here was measured first, in `guards/probes/select-multiple.html` and
//! `guards/probes/select-listbox.html`, and this file exists because most of them are the
//! *opposite* of the single `<select>` sitting beside them in the same tag:
//!
//! | | `<select>` | `<select multiple>` |
//! |---|---|---|
//! | options | browser chrome, in an overlay | ordinary in-flow boxes |
//! | acts on | the **press** | the **release** |
//! | selection | one, cleared on each commit | a set |
//! | re-choosing the current one | not a change | a change (it deselects) |
//!
//! So a test that only checked "clicking an option selects it" would pass against the
//! radio-set path the `OPTION` kind already had, which is exactly what this had to be
//! stopped from doing: that path *refuses to unselect*, so ctrl+clicking a selected row
//! would silently do nothing.
//!
//! Presses go through `mouse_down`/`mouse_up_with` at coordinates read back from layout,
//! for the reason `controls.rs` gives: nothing can declare a click, and a selection that
//! only moves when a state setter pokes it would pass every test that skipped the press.

use dziry_engine::engine::{Engine, EngineConfig};
use dziry_engine::protocol::{
    self, control_flags, control_kind, controls, display, event_kind, flex_direction, nodes,
    styles, Table,
};
use dziry_engine::tables::Tables;

const NODES: usize = Table::Nodes as usize;
const STYLES: usize = Table::Styles as usize;
const CONTROLS: usize = Table::Controls as usize;

const NO_NODE: i32 = i32::MAX;
/// SDL's masks, as `engine::mod_bits` reads them. Left-hand keys.
const SHIFT: u16 = 0x0001;
const CTRL: u16 = 0x0040;

/// The list box is node 0 and its four options are 1..=4.
const LISTBOX: i32 = 0;
const OPTIONS: [i32; 4] = [1, 2, 3, 4];
const ROWS: i32 = 4;

fn config() -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 200,
        height: 200,
        node_capacity: 5,
        style_capacity: 2,
        variant_capacity: 1,
        variant_slot_capacity: 1,
        media_capacity: 1,
        list_capacity: 1,
        tween_capacity: 1,
        keyframe_capacity: 1,
        control_capacity: 8,
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

/// A style row at its initial values — `NaN` is "unset" for every length.
fn init_style(t: &mut Tables, slot: usize) {
    t.set_u8(STYLES, styles::DISPLAY, slot, display::FLEX);
    t.set_u8(STYLES, styles::FLEX_DIRECTION, slot, flex_direction::COLUMN);
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
    t.set_f32(STYLES, styles::FLEX_SHRINK, slot, 0.0);
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

fn control(t: &mut Tables, row: usize, target: i32, kind: u8, group: i32, flags: u8, rows: i32) {
    t.set_i32(CONTROLS, controls::NODE, row, target);
    t.set_u8(CONTROLS, controls::KIND, row, kind);
    t.set_i32(CONTROLS, controls::GROUP, row, group);
    t.set_u8(CONTROLS, controls::FLAGS, row, flags);
    t.set_i32(CONTROLS, controls::LABEL, row, -1);
    t.set_i32(CONTROLS, controls::ROWS, row, rows);
    t.set_i32(NODES, nodes::ACTIVATES, target as usize, target);
}

/// A list box of four options, each 20px tall, filling the top-left of the window.
///
/// `multiple` chooses between `<select multiple>` and `<select size="4">` — two shapes
/// that lay out identically and select differently, which is the pair
/// `guards/probes/select-listbox.html` was written to separate.
///
/// `selected` seeds `ControlFlags::CHECKED` on those option indices, standing in for the
/// `selected` attribute the compiler resolves.
fn listbox(multiple: bool, selected: &[usize]) -> Engine {
    let mut engine = Engine::new(&config()).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        // Slot 1 is an option: a fixed 20px row, so a click coordinate is arithmetic
        // rather than a guess about font metrics.
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 80.0);

        node(t, 0, 0, -1);
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        for (i, &option) in OPTIONS.iter().enumerate() {
            node(t, option as usize, 1, LISTBOX);
            let next = OPTIONS.get(i + 1).copied().unwrap_or(-1);
            t.set_i32(NODES, nodes::NEXT_SIBLING, option as usize, next);
        }

        let flags = if multiple { control_flags::MULTIPLE } else { 0 };
        control(t, 0, LISTBOX, control_kind::LISTBOX, -1, flags, ROWS);
        for (i, &option) in OPTIONS.iter().enumerate() {
            let checked = if selected.contains(&i) {
                control_flags::CHECKED
            } else {
                0
            };
            // Group 7 for all of them — an option's group is its select, exactly as the
            // compiler interns it, and it is what `select_set` scans.
            control(t, i + 1, option, control_kind::OPTION, 7, checked, 0);
        }
        for row in OPTIONS.len() + 1..8 {
            t.set_i32(CONTROLS, controls::NODE, row, NO_NODE);
            t.set_i32(CONTROLS, controls::GROUP, row, -1);
            t.set_u8(CONTROLS, controls::KIND, row, control_kind::NONE);
            t.set_u8(CONTROLS, controls::FLAGS, row, 0);
            t.set_i32(CONTROLS, controls::ROWS, row, 0);
        }
    }
    engine.tick().expect("tick");
    engine
}

/// The centre of an option's laid-out box. Read back, never assumed.
fn centre_of(engine: &Engine, option: i32) -> (f32, f32) {
    let [x, y, w, h] = engine
        .bounds_of(option as usize)
        .expect("the option was laid out");
    (x + w / 2.0, y + h / 2.0)
}

/// A press and release on an option, with a modifier mask.
fn click(engine: &mut Engine, option: i32, mods: u16) {
    let (x, y) = centre_of(engine, option);
    engine.mouse_down(x, y);
    engine.mouse_up_with(x, y, mods);
    engine.tick().expect("tick");
}

fn key(engine: &mut Engine, keycode: i32, mods: u16) {
    engine.key_down(keycode, mods);
    engine.tick().expect("tick");
}

/// Which options are selected, by index — the same currency the host receives.
fn selection(engine: &Engine) -> Vec<i32> {
    engine.listbox_selection(LISTBOX)
}

/// Every `CHANGE` queued since the last drain, as `(node, a, b)`.
fn changes(engine: &mut Engine) -> Vec<(i32, i32, i32)> {
    let mut buf = [dziry_engine::engine::Event::default(); 32];
    let n = engine.drain_events(&mut buf);
    buf[..n]
        .iter()
        .filter(|e| e.kind == event_kind::CHANGE)
        .map(|e| (e.node, e.a, e.b))
        .collect()
}

// --- the pointer -----------------------------------------------------------------

/// The measured gesture table, in one run, because the rows are not independent: the
/// shift+click at the end only takes the whole list because the ctrl+click before it
/// moved the anchor.
#[test]
fn plain_click_replaces_ctrl_toggles_and_shift_extends_from_the_anchor() {
    let mut engine = listbox(true, &[]);

    click(&mut engine, OPTIONS[0], 0);
    assert_eq!(selection(&engine), vec![0], "a plain click selects one");

    click(&mut engine, OPTIONS[2], CTRL);
    assert_eq!(selection(&engine), vec![0, 2], "ctrl adds without clearing");

    click(&mut engine, OPTIONS[2], CTRL);
    assert_eq!(
        selection(&engine),
        vec![0],
        "and ctrl-clicking it again removes it — the radio path cannot do this at all"
    );

    click(&mut engine, OPTIONS[1], 0);
    assert_eq!(
        selection(&engine),
        vec![1],
        "a plain click replaces the whole selection, it does not add"
    );

    // The anchor is at option 1 from the plain click above. Extending to 3 takes 1..=3
    // and drops nothing else, because there is nothing else.
    click(&mut engine, OPTIONS[3], SHIFT);
    assert_eq!(selection(&engine), vec![1, 2, 3], "shift extends a range");

    // Shrinking the range back proves the anchor stayed at 1 rather than following the
    // last click to 3 — a ratcheting range is the bug this row exists for.
    click(&mut engine, OPTIONS[2], SHIFT);
    assert_eq!(
        selection(&engine),
        vec![1, 2],
        "and the range shrinks again"
    );
}

/// Ctrl+click **moves the anchor**, which is measured and has a visible consequence.
///
/// The probe's own row: after ctrl-clicking `foxtrot`, shift+clicking `alpha` took the
/// whole list rather than stopping at the previously selected `delta`. Without the anchor
/// move the range below would be 0..=1 instead of 0..=3.
#[test]
fn a_ctrl_click_moves_the_anchor_the_next_shift_click_measures_from() {
    let mut engine = listbox(true, &[]);

    click(&mut engine, OPTIONS[1], 0);
    click(&mut engine, OPTIONS[3], CTRL);
    assert_eq!(selection(&engine), vec![1, 3]);

    click(&mut engine, OPTIONS[0], SHIFT);
    assert_eq!(
        selection(&engine),
        vec![0, 1, 2, 3],
        "the range runs from the ctrl-clicked option, not from the plain-clicked one"
    );
}

/// **The selection changes on the release**, which is the opposite of a single `<select>`.
///
/// Worth its own test rather than trusting the helper, because the two shapes share the
/// tag and a reader reasonably expects them to share the trigger. They do not: a
/// `<select>` opens its picker on `mouse_down`, and this moves nothing until `mouse_up`.
#[test]
fn the_selection_moves_on_the_release_not_the_press() {
    let mut engine = listbox(true, &[]);

    let (x, y) = centre_of(&engine, OPTIONS[1]);
    engine.mouse_down(x, y);
    engine.tick().expect("tick");
    assert!(
        selection(&engine).is_empty(),
        "the press alone selects nothing"
    );

    engine.mouse_up_with(x, y, 0);
    engine.tick().expect("tick");
    assert_eq!(selection(&engine), vec![1]);
}

/// A `<select size="4">` with no `multiple` ignores the modifiers.
///
/// Measured that the shape exists and lays out as a list; its modifier behaviour is *not*
/// measured, so the modifiers collapse to a plain click — which is measured. The test
/// pins the conservative choice so that changing it is a decision rather than a drift.
#[test]
fn a_single_selection_list_box_replaces_however_the_modifiers_are_held() {
    let mut engine = listbox(false, &[]);

    click(&mut engine, OPTIONS[0], 0);
    click(&mut engine, OPTIONS[2], CTRL);
    assert_eq!(selection(&engine), vec![2], "ctrl does not add here");

    click(&mut engine, OPTIONS[3], SHIFT);
    assert_eq!(selection(&engine), vec![3], "and shift does not extend");
}

// --- the keyboard ----------------------------------------------------------------

/// The measured key table. Three of these rows would be guessed wrong.
#[test]
fn the_keyboard_rules_are_the_measured_ones() {
    use dziry_engine::engine::keys;

    let mut engine = listbox(true, &[]);
    engine.set_input_state(-1, -1, LISTBOX);

    key(&mut engine, keys::DOWN, 0);
    assert_eq!(selection(&engine), vec![0], "an arrow selects as it moves");

    key(&mut engine, keys::DOWN, 0);
    assert_eq!(
        selection(&engine),
        vec![1],
        "and replaces rather than adding"
    );

    key(&mut engine, keys::DOWN, SHIFT);
    assert_eq!(selection(&engine), vec![1, 2], "shift extends");

    key(&mut engine, keys::DOWN, CTRL);
    assert_eq!(
        selection(&engine),
        vec![1, 2],
        "Ctrl+Arrow does nothing at all — measured, and the most surprising row"
    );

    key(&mut engine, keys::SPACE, 0);
    assert_eq!(
        selection(&engine),
        vec![1, 2],
        "plain Space does nothing, though it ticks a checkbox and opens a <select>"
    );

    key(&mut engine, keys::SPACE, CTRL);
    assert_eq!(
        selection(&engine),
        vec![1],
        "Ctrl+Space toggles the current option out of the selection"
    );

    key(&mut engine, keys::A, CTRL);
    assert_eq!(
        selection(&engine),
        vec![0, 1, 2, 3],
        "Ctrl+A takes everything"
    );

    key(&mut engine, keys::HOME, 0);
    assert_eq!(
        selection(&engine),
        vec![0],
        "Home selects the first, replacing"
    );

    key(&mut engine, keys::END, 0);
    assert_eq!(selection(&engine), vec![3], "End the last");

    key(&mut engine, keys::DOWN, 0);
    assert_eq!(
        selection(&engine),
        vec![3],
        "and an arrow clamps at the end"
    );
}

/// Ctrl+Space needs a *current* option distinct from the selection, and this is the row
/// that proves dziry has one: it toggled `f` out of a selection of `e,f` in the probe.
///
/// Focus is that state — the same thing `option:focus` draws for a picker — so the
/// assertion is on `focused` as much as on the selection.
#[test]
fn the_current_option_is_focus_and_it_follows_the_keys() {
    use dziry_engine::engine::keys;

    let mut engine = listbox(true, &[]);
    engine.set_input_state(-1, -1, LISTBOX);

    key(&mut engine, keys::DOWN, 0);
    key(&mut engine, keys::DOWN, 0);
    assert_eq!(engine.focused(), OPTIONS[1]);

    // Shift+Arrow moves where you are while extending, so the current option leads the
    // range rather than staying at the anchor.
    key(&mut engine, keys::DOWN, SHIFT);
    assert_eq!(engine.focused(), OPTIONS[2]);
    assert_eq!(selection(&engine), vec![1, 2]);
}

/// A list box with an authored selection arrows on from it rather than from the top.
#[test]
fn arrowing_into_a_list_continues_from_the_selected_option() {
    use dziry_engine::engine::keys;

    let mut engine = listbox(true, &[2]);
    assert_eq!(
        selection(&engine),
        vec![2],
        "seeded from ControlFlags::CHECKED"
    );

    engine.set_input_state(-1, -1, LISTBOX);
    key(&mut engine, keys::DOWN, 0);
    assert_eq!(
        selection(&engine),
        vec![3],
        "moved on from 2, not from the top"
    );
}

// --- the event -------------------------------------------------------------------

/// **Exactly one `CHANGE` per gesture**, however many rows moved.
///
/// The measured count, and it is the one this file most needs to hold: the earlier reading
/// said one pair *per option changed*, that reading was a probe artifact, and it had
/// already been used to argue a different event shape. See BROWSER-FACTS.
#[test]
fn one_change_per_gesture_however_many_rows_moved() {
    let mut engine = listbox(true, &[]);

    click(&mut engine, OPTIONS[0], 0);
    let _ = changes(&mut engine);

    // Extends across four rows, three of which change.
    click(&mut engine, OPTIONS[3], SHIFT);
    let events = changes(&mut engine);
    assert_eq!(events.len(), 1, "one CHANGE, not one per row");

    let (node, index, count) = events[0];
    assert_eq!(node, LISTBOX, "on the list box, not on the option");
    assert_eq!(index, 3, "`a` is the option the gesture landed on");
    assert_eq!(count, 4, "`b` is how many are selected now");
}

/// A gesture that moves nothing fires nothing — the same rule a re-clicked radio follows.
#[test]
fn re_clicking_the_only_selected_option_is_not_a_change() {
    let mut engine = listbox(true, &[]);

    click(&mut engine, OPTIONS[1], 0);
    assert_eq!(changes(&mut engine).len(), 1);

    click(&mut engine, OPTIONS[1], 0);
    assert!(
        changes(&mut engine).is_empty(),
        "the selection was already exactly this option"
    );
}

// --- the box ---------------------------------------------------------------------

/// The height is `rows` times **an option's** row, not one line of the list box's font.
///
/// The demo caught the difference the moment it rendered: its options carry `padding: 6px
/// 8px` and a smaller `font-size`, so four rows of the *select's* line height held two and
/// a half options and clipped the third mid-word. A row is the option's box.
#[test]
fn the_height_is_rows_times_an_options_row_and_not_the_selects() {
    // Slot 1 — the option — is a fixed 20px, so four rows is exactly 80.
    let engine = listbox(true, &[]);
    let [_, _, _, h] = engine.bounds_of(LISTBOX as usize).expect("laid out");
    assert_eq!(h, 80.0, "four 20px rows");

    // Restyling the *list box's* own font changes nothing, because it is not what a row is
    // made of. This is the assertion that would have passed against the first version.
    let mut restyled = listbox(true, &[]);
    restyled
        .tables_mut()
        .set_f32(STYLES, styles::FONT_SIZE, 0, 32.0);
    restyled.tick().expect("tick");
    let [_, _, _, same] = restyled.bounds_of(LISTBOX as usize).expect("laid out");
    assert_eq!(same, 80.0, "the select's font is not the row height");

    // And a row includes the option's padding, which is what the demo's options have and
    // the first version dropped: 6px top and bottom adds 12 to each of four rows.
    let mut padded = listbox(true, &[]);
    {
        let t = padded.tables_mut();
        t.set_f32(STYLES, styles::PAD_TOP, 1, 6.0);
        t.set_f32(STYLES, styles::PAD_BOTTOM, 1, 6.0);
    }
    padded.tick().expect("tick");
    let [_, _, _, taller] = padded.bounds_of(LISTBOX as usize).expect("laid out");
    assert_eq!(taller, 80.0 + 4.0 * 12.0, "padding counts toward the row");
}

/// With no authored height a row comes from the font — a *ratio*, not a constant.
///
/// The reason `controls.rows` crosses the boundary as a count rather than as pixels:
/// measured across a 4x font-size range, a list box's content height is `size` times the
/// option's row height, and that row is Skia's ascent + descent + line gap. A compiled
/// pixel height could not do this, which is what this asserts.
#[test]
fn without_an_authored_height_a_row_scales_with_the_option_font() {
    let heights = [12.0f32, 32.0].map(|size| {
        let mut engine = listbox(true, &[]);
        {
            let t = engine.tables_mut();
            // Unset, so the measured row is what decides — `NaN` is "no length here".
            t.set_f32(STYLES, styles::HEIGHT, 1, f32::NAN);
            t.set_f32(STYLES, styles::FONT_SIZE, 1, size);
        }
        engine.tick().expect("tick");
        let [_, _, _, h] = engine.bounds_of(LISTBOX as usize).expect("laid out");
        h
    });

    let [small, large] = heights;
    assert!(
        small > 0.0 && large > small * 1.5,
        "tripling the option's font-size should scale the box: {small} -> {large}"
    );
}
