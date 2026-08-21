//! A window, by hand.
//!
//! ```sh
//! cargo run --release --example window
//! ```
//!
//! No Bun, no compiler — the tables are written here directly, which is the
//! whole point: the engine's input is memory, not an API. Everything this proves
//! (SDL3 window, Skia raster surface, Taffy layout, text through the platform
//! font manager, hover and press states, hit-testing, event delivery) is what
//! Bun will drive over the same tables in step 4.
//!
//! Close the window to exit.

use dziry_engine::engine::{Engine, EngineConfig};
use dziry_engine::protocol::{
    self, align, display, event_kind, flags, flex_direction, justify, node_kind, nodes, predicate,
    styles, variant_slots, variants, Table,
};
use dziry_engine::tables::Tables;

const NODES: usize = Table::Nodes as usize;
const STYLES: usize = Table::Styles as usize;
const VARIANTS: usize = Table::Variants as usize;
const VARIANT_SLOTS: usize = Table::VariantSlots as usize;

/// Style slots, in the shape the compiler's interning produces.
const ROOT: usize = 0;
const CARD: usize = 1;
const TITLE: usize = 2;
const BODY: usize = 3;
const BUTTON: usize = 4;
const BUTTON_HOVER: usize = 5;
const BUTTON_ACTIVE: usize = 6;
const STYLE_SLOTS: usize = 7;

fn init_style(t: &mut Tables, slot: usize) {
    t.set_u32(STYLES, styles::BG, slot, 0x0000_0000);
    t.set_u32(STYLES, styles::FG, slot, 0xff00_0000);
    t.set_u8(STYLES, styles::DISPLAY, slot, display::FLEX);
    t.set_u8(STYLES, styles::FLEX_DIRECTION, slot, flex_direction::COLUMN);
    t.set_u8(STYLES, styles::JUSTIFY_CONTENT, slot, justify::FLEX_START);
    t.set_u8(STYLES, styles::ALIGN_ITEMS, slot, align::FLEX_START);
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

/// One radius on all four corners — what a single `border-radius` means.
fn radius(t: &mut Tables, slot: usize, value: f32) {
    for field in [
        styles::RADIUS_TOP_LEFT,
        styles::RADIUS_TOP_RIGHT,
        styles::RADIUS_BOTTOM_RIGHT,
        styles::RADIUS_BOTTOM_LEFT,
    ] {
        t.set_f32(STYLES, field, slot, value);
    }
}

fn pad(t: &mut Tables, slot: usize, value: f32) {
    for field in [
        styles::PAD_TOP,
        styles::PAD_RIGHT,
        styles::PAD_BOTTOM,
        styles::PAD_LEFT,
    ] {
        t.set_f32(STYLES, field, slot, value);
    }
}

fn node(t: &mut Tables, id: usize, kind: u8, style: usize, text: i32) {
    t.set_u8(NODES, nodes::KIND, id, kind);
    t.set_u16(NODES, nodes::STYLE, id, style as u16);
    t.set_i32(NODES, nodes::TEXT, id, text);
}

fn link(t: &mut Tables, parent: usize, children: &[usize]) {
    t.set_i32(
        NODES,
        nodes::FIRST_CHILD,
        parent,
        children.first().map_or(-1, |c| *c as i32),
    );
    for (i, &child) in children.iter().enumerate() {
        t.set_i32(NODES, nodes::PARENT, child, parent as i32);
        t.set_i32(
            NODES,
            nodes::NEXT_SIBLING,
            child,
            children.get(i + 1).map_or(-1, |c| *c as i32),
        );
    }
}

fn main() {
    // `--screenshot out.png` renders one frame with no window at all and exits,
    // which is how this gets verified without a human looking at it.
    let args: Vec<String> = std::env::args().collect();
    let screenshot = args
        .iter()
        .position(|a| a == "--screenshot")
        .and_then(|i| args.get(i + 1))
        .cloned();
    // `--hover N` / `--focus N` drive interaction styles headlessly.
    let flag = |name: &str| -> i32 {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(-1)
    };

    let title = "dziry engine — A0";
    let config = EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 720,
        height: 420,
        node_capacity: 8,
        style_capacity: STYLE_SLOTS as u32,
        // Exactly one node has interaction states, and the row count is the
        // capacity — this table is never headroom.
        variant_capacity: 1,
        variant_slot_capacity: 8,
        media_capacity: 1,
        list_capacity: 1,
        tween_capacity: 1,
        keyframe_capacity: 1,
        control_capacity: 4,
        string_capacity: 4,
        string_bytes: 256,
        image_capacity: 1,
        root: 0,
        windowed: u8::from(screenshot.is_none()),
        decorated: 1,
        _reserved: [0; 2],
        title: title.as_ptr(),
        title_len: title.len() as u32,
    };

    let mut engine = match Engine::new(&config) {
        Ok(engine) => engine,
        Err(message) => {
            eprintln!("could not start the engine: {message}");
            std::process::exit(1);
        }
    };

    {
        let t = engine.tables_mut();
        for slot in 0..STYLE_SLOTS {
            init_style(t, slot);
        }

        // Root: the window's background, with padding and a gap.
        t.set_u32(STYLES, styles::BG, ROOT, 0xff0f_1115);
        pad(t, ROOT, 24.0);
        t.set_f32(STYLES, styles::GAP_ROW, ROOT, 16.0);

        // Card: a rounded panel with a border.
        t.set_u32(STYLES, styles::BG, CARD, 0xff1a_1d24);
        for (i, field) in [
            styles::BORDER_TOP_COLOR,
            styles::BORDER_RIGHT_COLOR,
            styles::BORDER_BOTTOM_COLOR,
            styles::BORDER_LEFT_COLOR,
        ]
        .into_iter()
        .enumerate()
        {
            t.set_u32(STYLES, field, CARD, 0xff2f_3540);
            let width = [
                styles::BORDER_TOP_WIDTH,
                styles::BORDER_RIGHT_WIDTH,
                styles::BORDER_BOTTOM_WIDTH,
                styles::BORDER_LEFT_WIDTH,
            ][i];
            t.set_f32(STYLES, width, CARD, 1.0);
        }
        radius(t, CARD, 10.0);
        pad(t, CARD, 20.0);
        t.set_f32(STYLES, styles::GAP_ROW, CARD, 12.0);
        t.set_f32(STYLES, styles::WIDTH, CARD, 420.0);

        // Title text.
        t.set_u32(STYLES, styles::FG, TITLE, 0xffe6_e9ef);
        t.set_f32(STYLES, styles::FONT_SIZE, TITLE, 22.0);
        t.set_u16(STYLES, styles::FONT_WEIGHT, TITLE, 600);

        // Body copy. Its own slot: a text node wearing the card's style would
        // inherit the card's border and padding, which is exactly the bug the
        // first screenshot showed.
        t.set_u32(STYLES, styles::FG, BODY, 0xff9d_a5b4);

        // Button, and its hover and active variants — precompiled styles the
        // engine picks between, not values it computes.
        for (slot, bg) in [
            (BUTTON, 0xff3b_82f6u32),
            (BUTTON_HOVER, 0xff60_a5fa),
            (BUTTON_ACTIVE, 0xff25_63eb),
        ] {
            t.set_u32(STYLES, styles::BG, slot, bg);
            t.set_u32(STYLES, styles::FG, slot, 0xffff_ffff);
            radius(t, slot, 8.0);
            t.set_f32(STYLES, styles::PAD_TOP, slot, 10.0);
            t.set_f32(STYLES, styles::PAD_BOTTOM, slot, 10.0);
            t.set_f32(STYLES, styles::PAD_LEFT, slot, 18.0);
            t.set_f32(STYLES, styles::PAD_RIGHT, slot, 18.0);
            t.set_u16(STYLES, styles::FONT_WEIGHT, slot, 600);
        }

        let mut cursor = 0;
        t.push_string(0, "Hello from the engine", &mut cursor)
            .unwrap();
        t.push_string(
            1,
            "Taffy laid this out. Skia painted it. SDL3 owns the window.",
            &mut cursor,
        )
        .unwrap();
        t.push_string(2, "Click me", &mut cursor).unwrap();

        node(t, 0, node_kind::BOX, ROOT, -1);
        node(t, 1, node_kind::BOX, CARD, -1);
        node(t, 2, node_kind::TEXT, TITLE, 0);
        node(t, 3, node_kind::TEXT, BODY, 1);
        node(t, 4, node_kind::BUTTON, BUTTON, 2);

        // Text nodes are the only ones that cost a measurement.
        t.set_u8(NODES, nodes::FLAGS, 2, flags::MEASURABLE);
        t.set_u8(NODES, nodes::FLAGS, 3, flags::MEASURABLE);
        t.set_u8(
            NODES,
            nodes::FLAGS,
            4,
            flags::MEASURABLE | flags::INTERACTIVE,
        );

        link(t, 0, &[1]);
        link(t, 1, &[2, 3, 4]);

        // One conditional node. It reads hover and active, so its run is four
        // entries — base, hover, active, hover+active — indexed by those bits
        // compacted down. Pressing while hovering now has its own entry rather
        // than losing one of the two.
        t.set_i32(VARIANTS, variants::NODE, 0, 4);
        t.set_u32(
            VARIANTS,
            variants::MASK,
            0,
            predicate::HOVER | predicate::ACTIVE,
        );
        t.set_i32(VARIANTS, variants::RUN_START, 0, 0);
        for (i, slot) in [BUTTON, BUTTON_HOVER, BUTTON_ACTIVE, BUTTON_ACTIVE]
            .iter()
            .enumerate()
        {
            t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, i, *slot as u16);
        }
    }

    println!(
        "engine up — protocol v{}, font {}, {} spans in the descriptor",
        protocol::PROTOCOL_VERSION,
        engine.font_family(),
        engine.span_count()
    );
    if let Some(path) = screenshot {
        engine.set_input_state(flag("--hover"), -1, flag("--focus"));
        engine.tick().expect("tick");

        let size = engine.encode_png().expect("Skia PNG encoder");
        std::fs::write(&path, engine.take_png()).expect("write the screenshot");

        let button = engine.bounds_of(4).unwrap_or_default();
        println!(
            "wrote {path} — {size} bytes, tick {:.3} ms, button at {:?}",
            engine.last_frame_ms(),
            button
        );
        return;
    }

    println!("hover and click the button; close the window to exit.");

    let mut events = vec![Default::default(); 32];
    let mut clicks = 0u32;

    loop {
        if let Err(message) = engine.tick() {
            eprintln!("tick failed: {message}");
            break;
        }

        let n = engine.drain_events(&mut events);
        let mut quit = false;
        for event in &events[..n] {
            match event.kind {
                event_kind::QUIT => quit = true,
                event_kind::CLICK => {
                    clicks += 1;
                    println!("click -> node {} (total {clicks})", event.node);
                }
                event_kind::RESIZE => println!("resize -> {}x{}", event.a, event.b),
                _ => {}
            }
        }
        if quit {
            break;
        }

        // Crude pacing until the engine owns its own frame loop (A0 step 3).
        std::thread::sleep(std::time::Duration::from_millis(8));
    }

    println!(
        "{} frames, last tick {:.3} ms",
        engine.frame_count(),
        engine.last_frame_ms()
    );
}
