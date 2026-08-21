//! The clipboard, end to end through `key_down`.
//!
//! Every gesture here is the public one — Tab to focus, Ctrl+A to select, then the
//! clipboard trio — because that is the whole point of `key_down` being `pub`: no
//! test presses a key by reaching into the painter. Headless engines have no SDL
//! video subsystem, so these run against the process-local fallback clipboard,
//! which exists precisely so this file can.
//!
//! What is asserted is the *contract with the host*: which events a shortcut queues
//! (and which it must not), what `take_paste_text` pairs with them, and where the
//! optimistic caret lands. The splice itself is Bun's and is tested in
//! `bindings.test.ts`; the normalisation table is unit-tested beside
//! `normalize_paste` in `engine.rs`.

use dziri_engine::engine::{keys, Engine, EngineConfig, Event, COMMAND};
use dziri_engine::protocol::{self, display, flex_direction, nodes, styles, Table};
use dziri_engine::tables::Tables;

const NODES: usize = Table::Nodes as usize;
const STYLES: usize = Table::Styles as usize;
const CONTROLS: usize = Table::Controls as usize;
const VARIANTS: usize = Table::Variants as usize;

/// A spare row's sentinel — see `NO_CONTROL_NODE` in `upload.ts` and the same
/// constant in `controls.rs`: padding must sort *after* every real node.
const NO_NODE: i32 = i32::MAX;

fn config(node_count: u32) -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 100,
        height: 100,
        node_capacity: node_count,
        style_capacity: 2,
        variant_capacity: 4,
        variant_slot_capacity: 8,
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
    for field in [
        styles::WIDTH,
        styles::HEIGHT,
        styles::MIN_WIDTH,
        styles::MIN_HEIGHT,
        styles::MAX_WIDTH,
        styles::MAX_HEIGHT,
        styles::FLEX_BASIS,
        styles::ASPECT_RATIO,
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
    t.set_u8(NODES, nodes::FLAGS, i, 0);
    t.set_i32(NODES, nodes::ACTIVATES, i, -1);
}

fn pad_controls(t: &mut Tables) {
    for row in 0..4 {
        t.set_i32(CONTROLS, protocol::controls::NODE, row, NO_NODE);
        t.set_i32(CONTROLS, protocol::controls::GROUP, row, -1);
        t.set_u8(
            CONTROLS,
            protocol::controls::KIND,
            row,
            protocol::control_kind::NONE,
        );
        t.set_u8(CONTROLS, protocol::controls::FLAGS, row, 0);
    }
}

fn pad_variants(t: &mut Tables) {
    for row in 0..4 {
        t.set_i32(VARIANTS, protocol::variants::NODE, row, NO_NODE);
        t.set_u32(VARIANTS, protocol::variants::MASK, row, 0);
        t.set_i32(VARIANTS, protocol::variants::RUN_START, row, -1);
    }
}

/// A field (node 1, a tab stop) whose value run (node 2) holds `text` — the shape
/// the compiler emits for a text `<input>`: the run wears `EDITABLE`, the field
/// takes the focus.
fn field_holding(text: &str) -> Engine {
    let mut engine = Engine::new(&config(3)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);

        node(t, 0, 0, -1);
        node(t, 1, 1, 0);
        node(t, 2, 1, 1);
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        t.set_i32(NODES, nodes::FIRST_CHILD, 1, 2);
        t.set_u8(
            NODES,
            nodes::FLAGS,
            1,
            protocol::flags::INTERACTIVE | protocol::flags::TAB_STOP,
        );
        t.set_u8(NODES, nodes::KIND, 2, protocol::node_kind::TEXT);
        t.set_u8(NODES, nodes::FLAGS, 2, protocol::flags::EDITABLE);
        let mut cursor = 0u32;
        t.push_string(0, text, &mut cursor).expect("string fits");
        t.set_i32(NODES, nodes::TEXT, 2, 0);

        pad_controls(t);
        pad_variants(t);
    }
    engine.tick().expect("tick");
    engine
}

/// Tab into the field, select everything, and throw the focus events away.
fn focused_and_selected(engine: &mut Engine) {
    engine.key_down(keys::TAB, 0);
    engine.key_down(keys::A, COMMAND);
    engine.tick().expect("tick");
    let mut out = [Event::default(); 16];
    engine.drain_events(&mut out);
}

fn drained(engine: &mut Engine) -> Vec<Event> {
    let mut out = [Event::default(); 16];
    let n = engine.drain_events(&mut out);
    out[..n].to_vec()
}

#[test]
fn copy_then_paste_round_trips_and_pairs_the_event_with_its_text() {
    let mut engine = field_holding("hello world");
    focused_and_selected(&mut engine);

    engine.key_down(keys::C, COMMAND);
    // Copying queues nothing — the host is not involved in a copy at all.
    assert_eq!(drained(&mut engine).len(), 0);

    engine.key_down(keys::V, COMMAND);
    let events = drained(&mut engine);
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!(e.kind, protocol::event_kind::PASTE);
    assert_eq!(e.node, 1, "the event names the field, as TEXT_INPUT does");
    assert_eq!(
        e.a, 11,
        "a is the byte length, so the host can size the fetch"
    );
    // The selection was live, so the trio matches what typing over it would
    // carry: caret at the focus end, anchor at the other.
    assert_eq!((e.b, e.c), (11, 0));

    assert_eq!(engine.take_paste_text().as_deref(), Some("hello world"));
    assert_eq!(
        engine.take_paste_text(),
        None,
        "one string per PASTE event — the queue must not over-serve"
    );
}

#[test]
fn a_pasted_line_break_arrives_as_a_space() {
    // The field's own value can hold a newline — the file-dialog path puts one
    // there deliberately — so copying it out and pasting it back is exactly the
    // round trip that must normalise: the paste, not the copy.
    let mut engine = field_holding("a\nb");
    focused_and_selected(&mut engine);

    engine.key_down(keys::C, COMMAND);
    engine.key_down(keys::V, COMMAND);

    let events = drained(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, protocol::event_kind::PASTE);
    assert_eq!(events[0].a, 3);
    assert_eq!(engine.take_paste_text().as_deref(), Some("a b"));
}

#[test]
fn cut_copies_and_queues_the_same_backspace_a_range_erase_queues() {
    let mut engine = field_holding("hello world");
    focused_and_selected(&mut engine);

    engine.key_down(keys::X, COMMAND);
    let events = drained(&mut engine);
    assert_eq!(events.len(), 1);
    let e = &events[0];
    // Literally Backspace over the live range — the host-side splice needs no
    // new case, because over a range Backspace erases the range and nothing more.
    assert_eq!(e.kind, protocol::event_kind::KEY_DOWN);
    assert_eq!(e.node, 1);
    assert_eq!(e.a, keys::BACKSPACE);
    assert_eq!((e.b, e.c), (11, 0));

    // The copy half took: pasting now hands back what was cut.
    engine.key_down(keys::V, COMMAND);
    assert_eq!(engine.take_paste_text().as_deref(), Some("hello world"));
    // And the paste landed at the collapsed caret — the cut's local shift put it
    // at the range's start, so both ends carry 0.
    let paste = drained(&mut engine);
    assert_eq!(paste.len(), 1);
    assert_eq!((paste[0].b, paste[0].c), (0, 0));
}

#[test]
fn a_collapsed_or_absent_caret_copies_nothing_and_still_consumes_the_keys() {
    let mut engine = field_holding("hello world");
    // Focused but never selected: Tab places no caret — only a click or Ctrl+A
    // does — so there is nothing to copy and nowhere to paste.
    engine.key_down(keys::TAB, 0);
    engine.tick().expect("tick");
    drained(&mut engine);

    engine.key_down(keys::C, COMMAND);
    engine.key_down(keys::V, COMMAND);
    engine.key_down(keys::X, COMMAND);

    // Consumed, not forwarded: no KEY_DOWN for the letters — Ctrl+C must not
    // reach the host looking like a `c` — and no PASTE from an empty clipboard.
    assert_eq!(drained(&mut engine).len(), 0);
    assert_eq!(engine.take_paste_text(), None);
}

#[test]
fn a_paste_over_a_collapsed_caret_carries_equal_ends() {
    let mut engine = field_holding("hello world");
    focused_and_selected(&mut engine);
    engine.key_down(keys::C, COMMAND);
    // ArrowRight collapses the selection to its matching end — measured, see
    // `move_to` — leaving a plain caret at 11.
    engine.key_down(keys::RIGHT, 0);
    drained(&mut engine);

    engine.key_down(keys::V, COMMAND);
    let events = drained(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, protocol::event_kind::PASTE);
    assert_eq!(
        (events[0].b, events[0].c),
        (11, 11),
        "equal ends is how the host tells insert from replace"
    );
}
