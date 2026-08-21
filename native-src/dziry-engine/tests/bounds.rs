//! Feed the engine an IR, assert what comes out.
//!
//! Rust unit tests are necessary and nowhere near sufficient here: the
//! interesting failures live in the shared-memory protocol and the
//! layout/paint pipeline, both of which are integration surfaces. So these run a
//! *whole engine* — headless, no window — and assert on the bounds it publishes
//! into the layout table, which is the same memory Bun reads.
//!
//! Numbers are hand-computed, in the spirit of the nine TypeScript layout tests
//! this replaces.

use dziry_engine::engine::{Engine, EngineConfig};
use dziry_engine::protocol::{
    self, align, display, flex_direction, justify, layout as layout_f, nodes, styles, Table,
};
use dziry_engine::tables::Tables;

const NODES: usize = Table::Nodes as usize;
const STYLES: usize = Table::Styles as usize;
const VARIANTS: usize = Table::Variants as usize;
const VARIANT_SLOTS: usize = Table::VariantSlots as usize;
const MEDIA: usize = Table::Media as usize;

fn config(nodes: u32, styles: u32) -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 200,
        height: 100,
        node_capacity: nodes,
        style_capacity: styles,
        variant_capacity: 4,
        variant_slot_capacity: 8,
        media_capacity: 1,
        list_capacity: 2,
        tween_capacity: 1,
        keyframe_capacity: 1,
        control_capacity: 4,
        string_capacity: 8,
        string_bytes: 256,
        image_capacity: 1,
        root: 0,
        // Headless: no SDL, no window, no display needed. The same pipeline runs.
        windowed: 0,
        decorated: 1,
        _reserved: [0; 2],
        title: std::ptr::null(),
        title_len: 0,
    }
}

/// Every style field must be written, because zeroed memory means `0px` rather
/// than `auto`. This seeds one slot with CSS-ish initial values so a test only
/// has to state what it cares about.
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
    // The transform identities, and these are the sharpest case of the comment
    // above: a zeroed row is `scale(0)`, which is a node scaled to nothing rather
    // than a node with no transform. Leaving them out makes every box in the file
    // invisible *and* unhittable, which is how it presents — not as a transform
    // bug. `Uploader::uploadStyles` gives real tables the same values by deriving
    // every spare slot from `INITIAL_STYLE`.
    t.set_f32(STYLES, styles::SCALE_X, slot, 1.0);
    t.set_f32(STYLES, styles::SCALE_Y, slot, 1.0);
    t.set_f32(STYLES, styles::OPACITY, slot, 1.0);
    t.set_f32(STYLES, styles::TRANSFORM_ORIGIN_PERCENT_X, slot, 0.5);
    t.set_f32(STYLES, styles::TRANSFORM_ORIGIN_PERCENT_Y, slot, 0.5);
}

/// Links `children` under `parent` and gives every node its parent pointer.
fn link(t: &mut Tables, parent: usize, children: &[usize]) {
    t.set_i32(
        NODES,
        nodes::FIRST_CHILD,
        parent,
        children.first().map_or(-1, |c| *c as i32),
    );
    for (i, &child) in children.iter().enumerate() {
        t.set_i32(NODES, nodes::PARENT, child, parent as i32);
        let next = children.get(i + 1).map_or(-1, |c| *c as i32);
        t.set_i32(NODES, nodes::NEXT_SIBLING, child, next);
    }
}

fn leaf(t: &mut Tables, node: usize, style: usize) {
    t.set_u8(NODES, nodes::KIND, node, protocol::node_kind::BOX);
    t.set_u16(NODES, nodes::STYLE, node, style as u16);
    t.set_i32(NODES, nodes::TEXT, node, -1);
    t.set_i32(NODES, nodes::PARENT, node, -1);
    t.set_i32(NODES, nodes::FIRST_CHILD, node, -1);
    t.set_i32(NODES, nodes::NEXT_SIBLING, node, -1);
    t.set_i16(NODES, nodes::LIST, node, -1);
}

/// Reads a bound straight out of the layout table — the same span Bun views.
fn bound(engine: &Engine, node: usize) -> [f32; 4] {
    let t = engine.tables();
    [
        t.f32s(Table::Layout as usize, layout_f::X)[node],
        t.f32s(Table::Layout as usize, layout_f::Y)[node],
        t.f32s(Table::Layout as usize, layout_f::WIDTH)[node],
        t.f32s(Table::Layout as usize, layout_f::HEIGHT)[node],
    ]
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 0.01
}

#[test]
fn a_column_stacks_its_children_inside_the_padding() {
    let mut engine = Engine::new(&config(3, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);

        // Root: 200x100 column with 10px padding all round and an 8px gap.
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        for field in [
            styles::PAD_TOP,
            styles::PAD_RIGHT,
            styles::PAD_BOTTOM,
            styles::PAD_LEFT,
        ] {
            t.set_f32(STYLES, field, 0, 10.0);
        }
        t.set_f32(STYLES, styles::GAP_ROW, 0, 8.0);

        // Children: fixed boxes.
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 1);
        link(t, 0, &[1, 2]);
    }

    engine.tick().expect("tick");

    assert_eq!(
        bound(&engine, 0),
        [0.0, 0.0, 200.0, 100.0],
        "root fills the window"
    );
    assert_eq!(
        bound(&engine, 1),
        [10.0, 10.0, 50.0, 20.0],
        "first child at the padding"
    );
    assert_eq!(
        bound(&engine, 2),
        [10.0, 38.0, 50.0, 20.0],
        "second child below the first plus the gap"
    );
}

#[test]
fn a_row_centres_and_bounds_are_absolute() {
    let mut engine = Engine::new(&config(4, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);

        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_u8(STYLES, styles::FLEX_DIRECTION, 0, flex_direction::ROW);
        t.set_u8(STYLES, styles::JUSTIFY_CONTENT, 0, justify::CENTER);
        t.set_u8(STYLES, styles::ALIGN_ITEMS, 0, align::CENTER);

        t.set_f32(STYLES, styles::WIDTH, 1, 40.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 1);
        // A grandchild, to prove the read-back accumulates ancestor offsets
        // rather than reporting Taffy's parent-relative locations.
        leaf(t, 3, 1);
        link(t, 0, &[1, 2]);
        link(t, 1, &[3]);
    }

    engine.tick().expect("tick");

    // Two 40px boxes centred in 200px: (200 - 80) / 2 = 60.
    assert_eq!(bound(&engine, 1), [60.0, 40.0, 40.0, 20.0]);
    assert_eq!(bound(&engine, 2), [100.0, 40.0, 40.0, 20.0]);

    let child = bound(&engine, 3);
    assert!(
        close(child[0], 60.0) && close(child[1], 40.0),
        "grandchild should be absolute at (60, 40), got {child:?}"
    );
}

#[test]
fn text_is_measured_by_skia_not_guessed() {
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        // Without this the child stretches to the full 200px and the measured
        // advance never reaches the box — CSS's own `align-items: stretch`
        // default, which Taffy honours and the hand-written engine did not. The
        // compiler's `INITIAL_STYLE` says `flex-start`, so real IR looks like
        // this rather than like Taffy's default.
        t.set_u8(STYLES, styles::ALIGN_ITEMS, 0, align::FLEX_START);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);

        let mut cursor = 0;
        t.push_string(0, "Hello", &mut cursor)
            .expect("string arena");
        t.set_i32(NODES, nodes::TEXT, 1, 0);
        t.set_u8(NODES, nodes::KIND, 1, protocol::node_kind::TEXT);
        t.set_u8(NODES, nodes::FLAGS, 1, protocol::flags::MEASURABLE);
    }

    engine.tick().expect("tick");

    let [_, _, w, h] = bound(&engine, 1);
    assert!(w > 0.0 && h > 0.0, "text measured to nothing: {w}x{h}");
    if engine.font_family() == "Segoe UI" {
        // Skia measures "Hello" at 16px as 36.85 — the same figure the
        // libSkiaSharp path produced through `bun:ffi`, which is the evidence
        // that text survives the migration.
        //
        // Taffy then **rounds final layout to whole pixels**, so the published
        // bound is 37. That rounding is on by default and worth keeping: it is
        // what stops a column of boxes from landing on half-pixel edges and
        // rendering with soft antialiased seams. `TaffyTree::disable_rounding`
        // is the switch if HiDPI ever needs sub-pixel bounds.
        assert!(
            (w - 36.85).abs() <= 0.5,
            "expected Skia's 36.85px (rounded) for \"Hello\", got {w}"
        );
    }
}

/// A border reserves room the way padding does, and it stacks with padding.
///
/// This is the whole content-box question in one assertion: the 200x100 root with
/// a 10px border and 5px padding has a 170x70 content box starting at (15, 15).
/// While `style_of` skipped `borderWidth` the child sat at (5, 5) at 190x90 —
/// overlapping the border band, and 20px too big in each axis.
#[test]
fn a_border_reserves_room_like_padding() {
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);

        // The root's own size comes from the window (200x100), not the table.
        for field in [
            styles::BORDER_TOP_WIDTH,
            styles::BORDER_RIGHT_WIDTH,
            styles::BORDER_BOTTOM_WIDTH,
            styles::BORDER_LEFT_WIDTH,
        ] {
            t.set_f32(STYLES, field, 0, 10.0);
        }
        for field in [
            styles::PAD_TOP,
            styles::PAD_RIGHT,
            styles::PAD_BOTTOM,
            styles::PAD_LEFT,
        ] {
            t.set_f32(STYLES, field, 0, 5.0);
        }
        // The child takes the content box, so its bounds *are* the content box.
        t.set_u8(STYLES, styles::ALIGN_ITEMS, 0, align::STRETCH);
        t.set_f32(STYLES, styles::FLEX_GROW, 1, 1.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }

    engine.tick().expect("tick");

    assert_eq!(
        bound(&engine, 0),
        [0.0, 0.0, 200.0, 100.0],
        "the border is inside the box, not around it — border-box, as Tailwind assumes"
    );
    assert_eq!(
        bound(&engine, 1),
        [15.0, 15.0, 170.0, 70.0],
        "content starts inside border + padding"
    );
}

/// Non-finite is the "unset" sentinel everywhere in this table, and a negative
/// width is a host bug. Either would otherwise hand Taffy room to give away.
#[test]
fn a_nonsense_border_width_reserves_nothing() {
    for width in [f32::NAN, f32::INFINITY, -8.0] {
        let mut engine = Engine::new(&config(2, 2)).expect("engine");
        {
            let t = engine.tables_mut();
            init_style(t, 0);
            init_style(t, 1);
            for field in [
                styles::BORDER_TOP_WIDTH,
                styles::BORDER_RIGHT_WIDTH,
                styles::BORDER_BOTTOM_WIDTH,
                styles::BORDER_LEFT_WIDTH,
            ] {
                t.set_f32(STYLES, field, 0, width);
            }
            t.set_u8(STYLES, styles::ALIGN_ITEMS, 0, align::STRETCH);
            t.set_f32(STYLES, styles::FLEX_GROW, 1, 1.0);

            leaf(t, 0, 0);
            leaf(t, 1, 1);
            link(t, 0, &[1]);
        }

        engine.tick().expect("tick");

        assert_eq!(
            bound(&engine, 1),
            [0.0, 0.0, 200.0, 100.0],
            "border-width {width} should reserve nothing"
        );
    }
}

#[test]
fn hidden_removes_a_subtree_from_layout() {
    let mut engine = Engine::new(&config(3, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 1);
        link(t, 0, &[1, 2]);
        t.set_u8(NODES, nodes::HIDDEN, 1, 1);
    }

    engine.tick().expect("tick");

    assert_eq!(bound(&engine, 1)[3], 0.0, "a hidden node occupies nothing");
    assert_eq!(
        bound(&engine, 2)[1],
        0.0,
        "its sibling moves up to take the space"
    );
}

#[test]
fn a_style_patch_relays_out_without_touching_the_tree() {
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }
    engine.tick().expect("tick");
    assert_eq!(bound(&engine, 1)[3], 20.0);

    // What a `.compact` toggle does: rewrite a field of the style table. Node
    // style indices are never touched.
    engine.tables_mut().set_f32(STYLES, styles::HEIGHT, 1, 32.0);
    engine.tick().expect("tick");

    assert_eq!(bound(&engine, 1)[3], 32.0, "the patch reached layout");
}

#[test]
fn relinking_children_reorders_without_moving_nodes() {
    let mut engine = Engine::new(&config(3, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
        t.set_f32(STYLES, styles::WIDTH, 2, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 2, 30.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 2);
        link(t, 0, &[1, 2]);
    }
    engine.tick().expect("tick");
    assert_eq!(bound(&engine, 1)[1], 0.0);
    assert_eq!(bound(&engine, 2)[1], 20.0);

    // The list-arena reorder: rewrite the child chain, move nothing.
    {
        let t = engine.tables_mut();
        link(t, 0, &[2, 1]);
    }
    engine.tick().expect("tick");

    assert_eq!(bound(&engine, 2)[1], 0.0, "node 2 is now first");
    assert_eq!(bound(&engine, 1)[1], 30.0, "node 1 sits below it");
}

#[test]
fn a_colour_patch_repaints_without_relaying_out() {
    // The theme toggle. The compiler classifies `.light` as paint-only and says
    // so on every build; the engine used to relayout the document anyway.
    //
    // Both halves matter and they pull opposite ways: skipping Taffy is the
    // point, and a frame that skips Taffy *and* forgets to repaint is a worse
    // bug than the one being fixed. So this asserts the pixels moved and the
    // geometry did not.
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
        t.set_u32(STYLES, styles::BG, 1, 0xff00_00ff);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }
    engine.tick().expect("tick");

    let before = bound(&engine, 1);
    let (pixels, _) = engine.pixels().expect("pixels");
    let sample = |px: &[u8]| {
        // Row 10, column 10 — inside the child's 50x20 box.
        let i = (10 * 200 + 10) * 4;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    };
    let blue = sample(&pixels);

    {
        let t = engine.tables_mut();
        t.set_u32(STYLES, styles::BG, 1, 0xff00_ff00);
    }
    engine.tick().expect("tick");

    let (pixels, _) = engine.pixels().expect("pixels");
    assert_ne!(sample(&pixels), blue, "the recolour reached the frame");
    assert_eq!(bound(&engine, 1), before, "and moved nothing");
}

#[test]
fn removing_a_row_relinks_the_parent_it_left() {
    // The case an incremental relink gets wrong if it only relinks the nodes
    // whose own bytes moved. Dropping the middle row rewrites exactly one
    // integer — `nextSibling[1]` — and node 1 is a leaf, so relinking *it*
    // achieves nothing. What has to be relinked is node 0, which nothing in the
    // diff mentions. The engine finds it from its own record of who it last
    // linked node 1 under, rather than from the host's `nodes.parent`.
    let mut engine = Engine::new(&config(4, 4)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..4 {
            init_style(t, slot);
        }
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        for (slot, height) in [(1, 20.0), (2, 30.0), (3, 25.0)] {
            t.set_f32(STYLES, styles::WIDTH, slot, 50.0);
            t.set_f32(STYLES, styles::HEIGHT, slot, height);
        }

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 2);
        leaf(t, 3, 3);
        link(t, 0, &[1, 2, 3]);
    }
    engine.tick().expect("tick");
    assert_eq!(
        bound(&engine, 3)[1],
        50.0,
        "third row starts below the first two"
    );

    {
        // `firstChild[0]` is untouched: the chain still starts at node 1.
        let t = engine.tables_mut();
        t.set_i32(NODES, nodes::NEXT_SIBLING, 1, 3);
    }
    engine.tick().expect("tick");

    assert_eq!(
        bound(&engine, 3)[1],
        20.0,
        "the third row took the second's place"
    );
}

#[test]
fn a_node_moved_between_parents_relinks_both() {
    let mut engine = Engine::new(&config(4, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 100.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 40.0);
        t.set_f32(STYLES, styles::WIDTH, 2, 20.0);
        t.set_f32(STYLES, styles::HEIGHT, 2, 10.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1); // container A, at y = 0
        leaf(t, 2, 1); // container B, at y = 40
        leaf(t, 3, 2); // the child that moves
        link(t, 0, &[1, 2]);
        link(t, 1, &[3]);
    }
    engine.tick().expect("tick");
    assert_eq!(bound(&engine, 3)[1], 0.0, "the child starts inside A");

    {
        let t = engine.tables_mut();
        t.set_i32(NODES, nodes::FIRST_CHILD, 1, -1);
        link(t, 2, &[3]);
    }
    engine.tick().expect("tick");

    assert_eq!(bound(&engine, 3)[1], 40.0, "and lands inside B");
}

#[test]
fn a_cycle_introduced_after_the_first_tick_is_still_refused() {
    // The acyclicity proof used to live inside `rebuild`, and a structural
    // change used to mean a rebuild. Now it does not, so the check has to be on
    // the incremental path too — and if it were not, this test would take the
    // process down with it rather than fail, because a stack overflow is not a
    // panic and `catch_unwind` cannot contain one.
    let mut engine = Engine::new(&config(3, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 1);
        link(t, 0, &[1, 2]);
    }
    engine.tick().expect("tick");

    {
        let t = engine.tables_mut();
        t.set_i32(NODES, nodes::FIRST_CHILD, 1, 0);
    }
    let result = engine.tick();
    assert!(result.is_err(), "the root became its own descendant");
}

#[test]
fn repointing_a_node_at_another_style_slot_relayouts() {
    // `nodes.style` is the pointer, not the value: no style slot changed here,
    // so the slot-value path sees nothing and this has to come from the node
    // column's own changed set.
    let mut engine = Engine::new(&config(2, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
        t.set_f32(STYLES, styles::WIDTH, 2, 70.0);
        t.set_f32(STYLES, styles::HEIGHT, 2, 35.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }
    engine.tick().expect("tick");
    assert_eq!(bound(&engine, 1), [0.0, 0.0, 50.0, 20.0]);

    {
        let t = engine.tables_mut();
        t.set_u16(NODES, nodes::STYLE, 1, 2);
    }
    engine.tick().expect("tick");

    assert_eq!(
        bound(&engine, 1),
        [0.0, 0.0, 70.0, 35.0],
        "it wears slot 2 now"
    );
}

#[test]
fn a_cycle_in_the_child_chain_is_an_error_not_a_hang() {
    let mut engine = Engine::new(&config(3, 1)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        leaf(t, 0, 0);
        leaf(t, 1, 0);
        leaf(t, 2, 0);
        // Bun-written memory can say anything, including that node 1 is its own
        // next sibling forever.
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        t.set_i32(NODES, nodes::NEXT_SIBLING, 1, 2);
        t.set_i32(NODES, nodes::NEXT_SIBLING, 2, 1);
    }

    let result = engine.tick();
    assert!(result.is_err(), "a cycle must be reported, not spun on");
    let err = result.unwrap_err();
    assert!(
        err.detail.contains("cycle"),
        "the message should name the problem"
    );
    // And the *category* travels: a malformed tree is not Skia failing.
    assert_eq!(err.status, protocol::status::LAYOUT);
}

#[test]
fn a_parent_child_cycle_is_an_error_not_a_stack_overflow() {
    // The dangerous shape, and the one a budgeted walk cannot see: every child
    // chain here has length one, so `relink` completes and Taffy receives a tree
    // in which the root is its own descendant. `compute_layout` then recurses
    // until the stack is gone — and a stack overflow is not a panic, so
    // `catch_unwind` cannot contain it and the host just loses the process.
    let mut engine = Engine::new(&config(3, 1)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        leaf(t, 0, 0);
        leaf(t, 1, 0);
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        t.set_i32(NODES, nodes::FIRST_CHILD, 1, 0); // node 1's child is the root
    }

    let result = engine.tick();
    assert!(result.is_err(), "a parent/child cycle must be reported");
    let err = result.unwrap_err();
    assert!(
        err.detail.contains("reachable twice"),
        "the message should name the problem"
    );
    assert_eq!(err.status, protocol::status::LAYOUT);
}

#[test]
fn a_node_with_two_parents_is_refused() {
    // Not a cycle, but not a tree either: Taffy would accept it and lay the node
    // out twice, and the absolute-bounds read-back would report whichever parent
    // it reached last.
    let mut engine = Engine::new(&config(4, 1)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        for n in 0..4 {
            leaf(t, n, 0);
        }
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);
        t.set_i32(NODES, nodes::NEXT_SIBLING, 1, 2);
        t.set_i32(NODES, nodes::FIRST_CHILD, 1, 3);
        t.set_i32(NODES, nodes::FIRST_CHILD, 2, 3); // node 3 claimed twice
    }

    let result = engine.tick();
    assert!(result.is_err(), "a shared child must be reported");
    assert!(result.unwrap_err().detail.contains("reachable twice"));
}

#[test]
fn absurd_grid_inputs_are_clamped_rather_than_believed() {
    // `gridColumns` is a `u16`, so this is expressible from a bad host write —
    // and it used to allocate 65,535 tracks per grid node. Measured single frames
    // of 181 ms and 1.41 s, plus track arithmetic large enough to overflow inside
    // taffy, which panics in debug and wraps silently in release.
    let mut engine = Engine::new(&config(3, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_u8(STYLES, styles::DISPLAY, 0, display::GRID);
        t.set_u16(STYLES, styles::GRID_COLUMNS, 0, u16::MAX);
        t.set_u16(STYLES, styles::GRID_ROWS, 0, u16::MAX);
        t.set_i16(STYLES, styles::GRID_COLUMN_START, 1, i16::MAX);
        t.set_i16(STYLES, styles::GRID_ROW_SPAN, 1, i16::MAX);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }

    let started = std::time::Instant::now();
    engine.tick().expect("tick");
    let elapsed = started.elapsed();

    assert!(
        elapsed.as_millis() < 150,
        "a clamped grid should still be a normal frame, took {elapsed:?}"
    );
    assert_eq!(
        bound(&engine, 0),
        [0.0, 0.0, 200.0, 100.0],
        "the root still lays out"
    );
}

#[test]
fn hit_testing_finds_the_deepest_interactive_node() {
    let mut engine = Engine::new(&config(3, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 1);
        link(t, 0, &[1, 2]);
        // Only the second child is interactive — the case that used to be
        // inferred from `hover >= 0` and silently excluded clickable rows.
        t.set_u8(NODES, nodes::FLAGS, 2, protocol::flags::INTERACTIVE);
    }
    engine.tick().expect("tick");

    assert_eq!(
        engine.hit_test(10.0, 30.0),
        2,
        "inside the interactive child"
    );
    assert_eq!(engine.hit_test(10.0, 5.0), -1, "the non-interactive one");
    assert_eq!(engine.hit_test(500.0, 500.0), -1, "outside everything");
}

#[test]
fn a_translated_node_is_hit_where_it_was_drawn() {
    // The whole point of the inverse in `hit_test`. Layout puts the child at
    // y=0..20; a 60px translate draws it at y=60..80, and a click has to follow
    // the pixels rather than the layout rect.
    //
    // Both points stay inside the 200x100 viewport `config` builds — the root is
    // clamped to it, so a point below y=100 is rejected at the root and never
    // reaches the child, which says nothing about transforms.
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
        t.set_f32(STYLES, styles::TRANSLATE_Y, 1, 60.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
        t.set_u8(NODES, nodes::FLAGS, 1, protocol::flags::INTERACTIVE);
    }
    engine.tick().expect("tick");

    assert_eq!(
        engine.hit_test(10.0, 70.0),
        1,
        "where the translate actually drew it"
    );
    assert_eq!(
        engine.hit_test(10.0, 10.0),
        -1,
        "where layout put it, which is no longer where it is"
    );
}

#[test]
fn a_scaled_parent_moves_where_its_child_is_hit() {
    // Measured on Chromium 151: a parent's transform scales and moves the child's
    // reported rect. So the inverse has to compose down the tree rather than only
    // applying at the node that declared it — this test fails if the child is
    // hit-tested against its own untransformed box.
    //
    // The origin is the parent's top-left so the arithmetic stays obvious: a child
    // laid out at (0,0,50,20) is simply drawn at (0,0,100,40).
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
        // Scale the parent about its top-left, which keeps the arithmetic obvious:
        // the child's box simply doubles to (0,0,100,40).
        t.set_f32(STYLES, styles::SCALE_X, 0, 2.0);
        t.set_f32(STYLES, styles::SCALE_Y, 0, 2.0);
        t.set_f32(STYLES, styles::TRANSFORM_ORIGIN_PERCENT_X, 0, 0.0);
        t.set_f32(STYLES, styles::TRANSFORM_ORIGIN_PERCENT_Y, 0, 0.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
        t.set_u8(NODES, nodes::FLAGS, 1, protocol::flags::INTERACTIVE);
    }
    engine.tick().expect("tick");

    assert_eq!(
        engine.hit_test(80.0, 30.0),
        1,
        "inside the doubled child, outside the original"
    );
    assert_eq!(
        engine.hit_test(120.0, 30.0),
        -1,
        "past the doubled child's right edge"
    );
}

#[test]
fn hit_testing_starts_at_the_configured_root() {
    // `root` is a config field that everything except `hit_test` honoured. Node
    // 0 is deliberately left out of the tree: only the root's subtree is laid
    // out, so a walk that starts at 0 reads unwritten bounds and finds nothing.
    let mut config = config(3, 2);
    config.root = 1;
    let mut engine = Engine::new(&config).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 50.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);

        leaf(t, 0, 0);
        leaf(t, 1, 0);
        leaf(t, 2, 1);
        link(t, 1, &[2]);
        t.set_u8(NODES, nodes::FLAGS, 2, protocol::flags::INTERACTIVE);
    }
    engine.tick().expect("tick");

    assert_eq!(
        bound(&engine, 1),
        [0.0, 0.0, 200.0, 100.0],
        "the root fills the window"
    );
    assert_eq!(
        engine.hit_test(10.0, 10.0),
        2,
        "the interactive node under root 1"
    );
}

#[test]
fn overlapping_siblings_hit_test_to_the_one_on_top() {
    // Two absolute siblings in the same place. Paint draws them in document
    // order, so the *second* is on top and is the one being pointed at — but a
    // stack walk that pushes children forwards visits them backwards, and the
    // one underneath used to win.
    let mut engine = Engine::new(&config(3, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);

        t.set_u8(STYLES, styles::POSITION, 1, protocol::position::ABSOLUTE);
        t.set_f32(STYLES, styles::INSET_TOP, 1, 0.0);
        t.set_f32(STYLES, styles::INSET_LEFT, 1, 0.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 40.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 40.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 1);
        link(t, 0, &[1, 2]);
        t.set_u8(NODES, nodes::FLAGS, 1, protocol::flags::INTERACTIVE);
        t.set_u8(NODES, nodes::FLAGS, 2, protocol::flags::INTERACTIVE);
    }
    engine.tick().expect("tick");

    assert_eq!(
        bound(&engine, 1),
        bound(&engine, 2),
        "the two overlap exactly"
    );
    assert_eq!(
        engine.hit_test(20.0, 20.0),
        2,
        "the later sibling is painted on top"
    );
}

#[test]
fn the_descriptor_matches_the_generated_schema() {
    let engine = Engine::new(&config(8, 4)).expect("engine");
    let mut spans = vec![
        dziry_engine::tables::SpanDesc {
            table: 0,
            field: 0,
            ptr: 0,
            elem_size: 0,
            capacity: 0,
        };
        engine.span_count()
    ];
    assert_eq!(engine.describe(&mut spans), engine.span_count());

    // Every table's fields are present, in schema order, at the schema's widths.
    let mut i = 0;
    for table in 0..protocol::TABLE_COUNT {
        for (field, &size) in protocol::elem_sizes(table).iter().enumerate() {
            let span = spans[i];
            assert_eq!(span.table, table as i32, "span {i} is the wrong table");
            assert_eq!(span.field, field as i32, "span {i} is the wrong field");
            assert_eq!(
                span.elem_size as usize,
                size,
                "{}.{} is {} bytes, schema says {size}",
                protocol::TABLE_NAMES[table],
                protocol::field_names(table)[field],
                span.elem_size
            );
            assert_ne!(span.ptr, 0, "span {i} has no memory");
            i += 1;
        }
    }

    // Plus the string arena, which is a region rather than a table field.
    assert_eq!(spans[i].table, dziry_engine::tables::REGION);
    assert_eq!(spans[i].field, dziry_engine::tables::REGION_STRING_BYTES);
}

/// A resize repaints from inside the pump, without a `tick`.
///
/// This is the engine half of the live-resize fix: while the user drags a window
/// edge the host's frame loop gets no turn, so an SDL event watcher calls this
/// directly. The SDL wiring cannot be tested headlessly — there is no window — but
/// what it calls can be, and that is where the work is: a new surface, a relayout
/// against the new viewport, a painted frame.
#[test]
fn a_resize_repaints_without_waiting_for_a_tick() {
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        // The child fills the root, so its bounds *are* the viewport.
        t.set_u8(STYLES, styles::ALIGN_ITEMS, 0, align::STRETCH);
        t.set_f32(STYLES, styles::FLEX_GROW, 1, 1.0);
        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }
    engine.tick().expect("tick");

    assert_eq!(
        bound(&engine, 1),
        [0.0, 0.0, 200.0, 100.0],
        "the window size"
    );
    let frames = engine.frame_count();

    engine
        .resize_and_repaint(320, 240)
        .expect("resize and repaint");

    assert_eq!(
        bound(&engine, 1),
        [0.0, 0.0, 320.0, 240.0],
        "layout followed the new viewport, without a tick in between"
    );
    assert_eq!(
        engine.frame_count(),
        frames + 1,
        "and a frame was actually painted"
    );
    assert_eq!(engine.size(), (320, 240));

    // The next tick must not repaint what was already presented.
    engine.tick().expect("tick");
    assert_eq!(
        engine.frame_count(),
        frames + 1,
        "an idle tick after a mid-pump repaint draws nothing"
    );
}

/// A wheel over a scroll container moves its content, clamped to what overflows.
///
/// The offset is engine state rather than table state, so this asserts through the
/// scroll accessors: `bounds` deliberately keep meaning "where layout put this", and
/// paint translates instead. A test that expected bounds to move would be pinning the
/// wrong design.
///
/// Asserted on `scroll_target_of` rather than `scroll_of` because a wheel now aims the
/// content and the glide catches up over the next few frames — what this test is about is
/// the wheel's arithmetic and its clamping, both of which happen to the target. The glide
/// itself is `a_wheel_glides_rather_than_jumping`.
#[test]
fn a_wheel_scrolls_the_box_under_the_cursor_and_stops_at_the_end() {
    // Root is 200x100. A 200x100 scroll container holding 300px of content, so 200px
    // can scroll.
    let mut engine = Engine::new(&config(3, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_u8(STYLES, styles::OVERFLOW_Y, 0, protocol::overflow::SCROLL);
        t.set_f32(STYLES, styles::HEIGHT, 1, 300.0);
        t.set_f32(STYLES, styles::FLEX_SHRINK, 1, 0.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }
    engine.tick().expect("tick");

    assert_eq!(
        engine.scroll_target_of(0),
        [0.0, 0.0],
        "nothing has scrolled yet"
    );

    // Down a little: the content moves by the wheel delta.
    assert!(
        engine.scroll_at(100.0, 50.0, 0.0, 50.0),
        "the wheel scrolled"
    );
    assert_eq!(engine.scroll_target_of(0), [0.0, 50.0]);

    // Down a lot: clamped at 300 - 100 = 200, never past the end of the content.
    assert!(engine.scroll_at(100.0, 50.0, 0.0, 10_000.0));
    assert_eq!(
        engine.scroll_target_of(0),
        [0.0, 200.0],
        "clamped to what overflows"
    );
    assert!(
        !engine.scroll_at(100.0, 50.0, 0.0, 10_000.0),
        "already at the end, so nothing moved and nothing repaints"
    );

    // Back up, clamped at zero rather than going negative.
    assert!(engine.scroll_at(100.0, 50.0, 0.0, -10_000.0));
    assert_eq!(engine.scroll_target_of(0), [0.0, 0.0]);

    // The other axis never moves: `overflow-x` is visible, so there is no scroll
    // region horizontally no matter how much content there is.
    assert!(
        !engine.scroll_at(100.0, 50.0, 40.0, 0.0),
        "x does not scroll"
    );

    // And a wheel outside the container does nothing at all.
    assert!(!engine.scroll_at(1000.0, 1000.0, 0.0, 50.0));
}

/// Hit-testing follows the scroll, or clicking a row hits whatever used to be there.
#[test]
fn a_scrolled_child_is_hit_where_it_now_appears() {
    let mut engine = Engine::new(&config(3, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_u8(STYLES, styles::OVERFLOW_Y, 0, protocol::overflow::SCROLL);

        // Two 80px rows in a 100px viewport: the second starts at y=80, off screen
        // until the container scrolls.
        for node in [1usize, 2] {
            t.set_f32(STYLES, styles::HEIGHT, node, 80.0);
            t.set_f32(STYLES, styles::FLEX_SHRINK, node, 0.0);
        }
        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 2);
        t.set_u8(NODES, nodes::FLAGS, 2, protocol::flags::INTERACTIVE);
        link(t, 0, &[1, 2]);
    }
    engine.tick().expect("tick");

    // Node 2 is laid out at y = 80..160, so y=90 is inside it and on screen.
    assert_eq!(engine.hit_test(10.0, 90.0), 2, "before scrolling");
    // Scroll 60px: node 2 now appears at 20..100, so y=90 is still it, and y=10 is too.
    assert!(engine.scroll_at(10.0, 50.0, 0.0, 60.0));
    // Hit-testing reads where the content *is*, so the glide has to land first. A dt of
    // one second is "arrive now" at this time constant.
    engine.advance_scrolls(1.0);
    assert_eq!(engine.hit_test(10.0, 30.0), 2, "moved up under the cursor");
    // Its layout rect never moved, which is what the host still reads.
    assert_eq!(bound(&engine, 2)[1], 80.0);
}

#[test]
fn a_scaled_node_is_hit_where_it_appears_after_scrolling() {
    // The two features that broke each other. `hit_test` compares the pointer, which
    // is in window coordinates, against `bounds` minus the ancestors' scroll — so the
    // transform's origin has to be in that same space. Built from the raw layout rect
    // it turned the point about a centre displaced by however far the page had
    // scrolled, and `hover:scale-110` on a long page lost its own hover.
    //
    // Translation hid it: a translate is origin-independent, so the neighbouring
    // `hover:-translate-y-1` kept working, which made it look like a scale bug rather
    // than a coordinate-space one. A golden could not see it either — a screenshot
    // tall enough to show the whole page never scrolls.
    let mut engine = Engine::new(&config(3, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_u8(STYLES, styles::OVERFLOW_Y, 0, protocol::overflow::SCROLL);

        for node in [1usize, 2] {
            t.set_f32(STYLES, styles::HEIGHT, node, 80.0);
            t.set_f32(STYLES, styles::FLEX_SHRINK, node, 0.0);
        }
        // Node 2 doubles about its own centre, which is the case that only works if
        // the centre is computed in the space the pointer is in.
        t.set_f32(STYLES, styles::SCALE_X, 2, 2.0);
        t.set_f32(STYLES, styles::SCALE_Y, 2, 2.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 2);
        t.set_u8(NODES, nodes::FLAGS, 2, protocol::flags::INTERACTIVE);
        link(t, 0, &[1, 2]);
    }
    engine.tick().expect("tick");

    // Unscrolled first, so a failure here is a plain transform bug rather than a
    // scroll interaction. Node 2 is laid out at y = 80..160 and scaled 2x about its
    // centre at y=120, so it is drawn over y = 40..200 — and y=50 is inside the
    // drawn box while being outside the layout box.
    assert_eq!(
        engine.hit_test(10.0, 50.0),
        2,
        "inside the scaled box, unscrolled"
    );

    // Now scroll 60px. Node 2's unscaled box moves to y = 20..100, and scaling about
    // its new centre at y=60 draws it over y = -20..140.
    assert!(engine.scroll_at(10.0, 50.0, 0.0, 60.0));
    engine.advance_scrolls(1.0);

    // y=85, which has to be inside the container to be reachable at all — the
    // container is the scroll box, so a point past y=100 is pruned at the root and
    // would test nothing about transforms.
    //
    // It is the discriminating point. Turning about the scrolled centre (y=60) maps
    // it to 72.5, inside the box. Turning about the *layout* centre (y=120), as the
    // bug did, maps it to 102.5 — outside, and the hover is lost.
    assert_eq!(
        engine.hit_test(10.0, 85.0),
        2,
        "inside the scaled box, scrolled"
    );
}

/// The page scrolls when the document is taller than the window.
///
/// The shape `app.css` uses, and what a browser does: the root keeps its children at
/// their natural size — `min-height: auto` is what allows that — and the *viewport*
/// moves. Asserted separately from the inner-container case because the root is the
/// one box whose size the engine forces to the window, so "content is taller than the
/// box" is reached differently.
///
/// The alternative shape, a fixed shell with one scrolling pane, needs `min-height: 0`
/// down the whole ancestor chain so the middle may collapse. Both are real CSS; this
/// pins the one the sample uses.
#[test]
fn a_document_taller_than_the_window_scrolls_the_page() {
    // Root is 200x100 with 10px padding, holding 240px of content.
    let mut engine = Engine::new(&config(4, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_u8(STYLES, styles::OVERFLOW_Y, 0, protocol::overflow::SCROLL);
        for field in [
            styles::PAD_TOP,
            styles::PAD_RIGHT,
            styles::PAD_BOTTOM,
            styles::PAD_LEFT,
        ] {
            t.set_f32(STYLES, field, 0, 10.0);
        }
        // Three 80px blocks that refuse to shrink, as content-sized children do
        // once `min-height` is `auto`.
        t.set_f32(STYLES, styles::HEIGHT, 1, 80.0);
        t.set_f32(STYLES, styles::FLEX_SHRINK, 1, 0.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 1);
        leaf(t, 3, 1);
        link(t, 0, &[1, 2, 3]);
    }
    engine.tick().expect("tick");

    // Content is 240 tall inside a 100 box with 20 of padding: the third block starts
    // below the window and stays its full height rather than being squeezed.
    assert_eq!(bound(&engine, 3), [10.0, 170.0, 180.0, 80.0]);

    // So the page scrolls, by content + padding - box.
    assert!(
        engine.scroll_at(100.0, 50.0, 0.0, 10_000.0),
        "the page scrolls"
    );
    engine.advance_scrolls(1.0);
    let scrolled = engine.scroll_of(0)[1];
    assert!(
        (scrolled - 160.0).abs() < 1.0,
        "expected ~160px of scroll (240 content + 20 padding - 100 box), got {scrolled}"
    );

    // And the layout is untouched by scrolling: only paint and hit-testing move.
    assert_eq!(bound(&engine, 3), [10.0, 170.0, 180.0, 80.0]);
}

/// A media query changes the *layout*, not only the paint.
///
/// This is the assertion the whole media-query design rests on. The variant
/// machinery was paint-only before: a node declared a predicate mask, and only
/// `Painter::style_for` ever resolved it. That was invisible while the predicates
/// were `:hover`, `:active` and `:focus`, which almost always change colours —
/// and would have made `@media` useless, because a breakpoint exists precisely to
/// rearrange boxes.
///
/// The tree is a row of two fixed boxes. One media row says "at 500px and below",
/// and the variant run gives the container `flex-direction: column` when that bit
/// is live. Above the threshold the children sit side by side; below it they
/// stack — and nothing in this test touches paint.
#[test]
fn a_media_query_relays_out_rather_than_only_repainting() {
    let mut engine = Engine::new(&config(3, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        // Slot 0: the container as a row. Slot 1: the same, as a column.
        // Slot 2: a fixed child box, so any change in position is the container's.
        init_style(t, 0);
        init_style(t, 1);
        init_style(t, 2);
        t.set_u8(STYLES, styles::FLEX_DIRECTION, 0, flex_direction::ROW);
        t.set_u8(STYLES, styles::FLEX_DIRECTION, 1, flex_direction::COLUMN);
        t.set_f32(STYLES, styles::WIDTH, 2, 40.0);
        t.set_f32(STYLES, styles::HEIGHT, 2, 20.0);

        leaf(t, 0, 0);
        leaf(t, 1, 2);
        leaf(t, 2, 2);
        link(t, 0, &[1, 2]);

        // The container reads one global predicate and owns a two-entry run:
        // entry 0 is the row, entry 1 the column.
        t.set_i32(VARIANTS, protocol::variants::NODE, 0, 0);
        t.set_u32(
            VARIANTS,
            protocol::variants::MASK,
            0,
            protocol::predicate::FIRST_GLOBAL,
        );
        t.set_i32(VARIANTS, protocol::variants::RUN_START, 0, 0);
        t.set_u16(VARIANT_SLOTS, protocol::variant_slots::STYLE, 0, 0);
        t.set_u16(VARIANT_SLOTS, protocol::variant_slots::STYLE, 1, 1);
        // Spare rows sort *last*, not first: the column is binary-searched, so
        // filling it with -1 would leave it unsorted and the search for node 0
        // would walk into the spares and report it absent.
        for row in 1..4 {
            t.set_i32(VARIANTS, protocol::variants::NODE, row, i32::MAX);
        }

        // `max-width: 500px` -> the bit above.
        t.set_u32(
            MEDIA,
            protocol::media::BIT,
            0,
            protocol::predicate::FIRST_GLOBAL,
        );
        t.set_u8(
            MEDIA,
            protocol::media::KIND,
            0,
            protocol::media_kind::MAX_WIDTH,
        );
        t.set_f32(MEDIA, protocol::media::VALUE, 0, 500.0);
    }

    // 200x100, which is at or below 500 — the query holds, so: a column.
    engine.tick().expect("tick");
    let stacked = (bound(&engine, 1), bound(&engine, 2));
    assert!(
        stacked.1[1] > stacked.0[1],
        "below the breakpoint the second child should be *under* the first: {stacked:?}"
    );

    // Past the threshold the query stops holding and the row comes back.
    engine.resize(900, 400).expect("resize");
    engine.tick().expect("tick");
    let side_by_side = (bound(&engine, 1), bound(&engine, 2));
    assert!(
        side_by_side.1[0] > side_by_side.0[0],
        "above the breakpoint the second child should be *beside* the first: {side_by_side:?}"
    );
    assert_eq!(side_by_side.1[1], side_by_side.0[1], "and on the same row");
}

// ---------------------------------------------------------------------------
// Field mapping into Taffy
//
// Five claims that used to live in `src/engine/upload.test.ts`, asserted against
// the *demo page* — "the node with four grid tracks", "the ones with width 32".
// They moved here because they are not claims about dziry's plumbing at all; they
// are claims that one style field reaches the corresponding Taffy input, and that
// file's own header already says layout correctness belongs to the engine's Rust
// tests.
//
// The move is not tidying. Those queries were unique in the demo when they were
// written and stopped being so as the page grew: adding `flex-wrap` to the demo's
// navigation made the wrap query match four nodes instead of two, and the test —
// which took the first — silently began measuring the navigation bar and kept
// passing, because a wrapped nav also wraps onto two lines and also stays inside
// its container. A test that quietly changes what it measures is worse than one
// that breaks. A fixture the test owns cannot drift.
// ---------------------------------------------------------------------------

/// Four explicit tracks, and a cell spanning two of them covers the gap between.
#[test]
fn grid_places_explicit_tracks_and_a_span_covers_the_gap() {
    let mut engine = Engine::new(&config(4, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        // 0: the grid — four tracks with 10px gaps, filling the 200px window.
        t.set_u8(STYLES, styles::DISPLAY, 0, display::GRID);
        t.set_u16(STYLES, styles::GRID_COLUMNS, 0, 4);
        t.set_f32(STYLES, styles::GAP_COLUMN, 0, 10.0);
        // 1: a cell spanning two tracks. 2: an ordinary cell, used by both others.
        t.set_i16(STYLES, styles::GRID_COLUMN_SPAN, 1, 2);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 2);
        leaf(t, 3, 2);
        link(t, 0, &[1, 2, 3]);
    }
    engine.tick().expect("tick");

    let grid = bound(&engine, 0);
    let track = (grid[2] - 3.0 * 10.0) / 4.0;
    let (wide, a, b) = (bound(&engine, 1), bound(&engine, 2), bound(&engine, 3));

    // Taffy rounds final layout to whole pixels, and a quarter of the grid is not
    // an integer — the rounding is what keeps adjacent cells off half-pixel edges.
    assert!(
        (wide[2] - (track * 2.0 + 10.0)).abs() <= 1.0,
        "a spanning cell covers two tracks plus the gap: {wide:?}, track {track}"
    );
    assert!((a[2] - track).abs() <= 1.0, "{a:?} vs track {track}");
    assert!((b[2] - track).abs() <= 1.0, "{b:?} vs track {track}");

    assert_eq!(a[1], wide[1], "one row, so every cell shares a y");
    assert_eq!(b[1], wide[1]);
    assert!(a[0] >= wide[0] + wide[2], "left to right, no overlap");
    assert!(b[0] >= a[0] + a[2]);
}

/// `flex-wrap: wrap` starts a second line, and nothing escapes sideways.
#[test]
fn flex_wrap_starts_a_second_line_when_the_first_runs_out() {
    let mut engine = Engine::new(&config(4, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        // A 200px window holding three 80px children that refuse to shrink: two fit
        // and the third cannot. Forced by arithmetic rather than by text, so the
        // assertion does not depend on a font.
        t.set_u8(STYLES, styles::FLEX_DIRECTION, 0, flex_direction::ROW);
        t.set_u8(STYLES, styles::FLEX_WRAP, 0, protocol::flex_wrap::WRAP);
        t.set_f32(STYLES, styles::WIDTH, 1, 80.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
        t.set_f32(STYLES, styles::FLEX_SHRINK, 1, 0.0);

        leaf(t, 0, 0);
        for child in 1..4 {
            leaf(t, child, 1);
        }
        link(t, 0, &[1, 2, 3]);
    }
    engine.tick().expect("tick");

    let row = bound(&engine, 0);
    let boxes = [bound(&engine, 1), bound(&engine, 2), bound(&engine, 3)];

    assert_eq!(boxes[0][1], boxes[1][1], "the first two share a line");
    assert!(
        boxes[2][1] > boxes[0][1],
        "and the third starts a second one: {boxes:?}"
    );

    for b in boxes {
        assert!(
            b[0] + b[2] <= row[0] + row[2] + 0.5,
            "nothing escapes the container it wrapped inside: {b:?} in {row:?}"
        );
    }
}

/// `align-self` beats the parent's `align-items`, per item.
#[test]
fn align_self_overrides_the_parents_align_items() {
    let mut engine = Engine::new(&config(5, 5)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..5 {
            init_style(t, slot);
        }
        // A 60px-tall row whose own default is `center`, holding one child per
        // `align-self` value so all four are compared in one layout.
        t.set_u8(STYLES, styles::FLEX_DIRECTION, 0, flex_direction::ROW);
        t.set_u8(STYLES, styles::ALIGN_ITEMS, 0, align::CENTER);
        t.set_f32(STYLES, styles::HEIGHT, 0, 60.0);

        for (slot, value) in [
            (1usize, align::FLEX_START),
            (2, align::CENTER),
            (3, align::FLEX_END),
            (4, align::STRETCH),
        ] {
            t.set_u8(STYLES, styles::ALIGN_SELF, slot, value);
            t.set_f32(STYLES, styles::WIDTH, slot, 20.0);
            // Every child but `stretch` is a fixed square, so a height difference
            // can only have come from the cross-axis stretch.
            if value != align::STRETCH {
                t.set_f32(STYLES, styles::HEIGHT, slot, 20.0);
            }
        }

        leaf(t, 0, 0);
        for child in 1..5 {
            leaf(t, child, child);
        }
        link(t, 0, &[1, 2, 3, 4]);
    }
    engine.tick().expect("tick");

    let row = bound(&engine, 0);
    let (start, mid, end, stretch) = (
        bound(&engine, 1),
        bound(&engine, 2),
        bound(&engine, 3),
        bound(&engine, 4),
    );

    assert!(
        close(start[1], row[1]),
        "flex-start hugs the top: {start:?}"
    );
    assert!(mid[1] > start[1], "center sits below it: {mid:?}");
    assert!(
        close(end[1] + end[3], row[1] + row[3]),
        "flex-end hugs the bottom: {end:?} in {row:?}"
    );
    assert!(
        stretch[3] > start[3],
        "stretch fills the cross axis, so it is taller than a square: {stretch:?}"
    );
}

/// `aspect-ratio` gives a box its height from its width alone.
#[test]
fn aspect_ratio_squares_a_box_from_its_width_alone() {
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        // Width only. No height anywhere and no content, so a square can only have
        // come from the ratio.
        t.set_f32(STYLES, styles::WIDTH, 1, 32.0);
        t.set_f32(STYLES, styles::ASPECT_RATIO, 1, 1.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }
    engine.tick().expect("tick");

    let [_, _, w, h] = bound(&engine, 1);
    assert_eq!(w, 32.0);
    assert_eq!(h, 32.0, "height came from the ratio, not from content");
}

/// An absolute child insets from its parent's **padding** box, not its border box.
///
/// The border term is the point of the test, and it is a dziry claim rather than a
/// Taffy one: it is what caught `borderWidth` reaching Taffy as a layout input. The
/// bounds the engine publishes are border boxes, so a bordered parent moves its
/// absolute children in by the border width — and a 4px border with a 9px inset
/// distinguishes the two, where a border of 0 could not.
#[test]
fn an_absolute_child_insets_from_its_parents_padding_box() {
    let mut engine = Engine::new(&config(3, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_f32(STYLES, styles::WIDTH, 0, 100.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 60.0);
        for field in [
            styles::BORDER_TOP_WIDTH,
            styles::BORDER_RIGHT_WIDTH,
            styles::BORDER_BOTTOM_WIDTH,
            styles::BORDER_LEFT_WIDTH,
        ] {
            t.set_f32(STYLES, field, 0, 4.0);
        }
        for pad in [
            styles::PAD_TOP,
            styles::PAD_RIGHT,
            styles::PAD_BOTTOM,
            styles::PAD_LEFT,
        ] {
            t.set_f32(STYLES, pad, 0, 5.0);
        }

        // 1: absolute, inset from the top and left. 2: an ordinary in-flow sibling,
        // present so "out of flow" is asserted rather than assumed.
        t.set_u8(STYLES, styles::POSITION, 1, protocol::position::ABSOLUTE);
        t.set_f32(STYLES, styles::INSET_TOP, 1, 7.0);
        t.set_f32(STYLES, styles::INSET_LEFT, 1, 9.0);
        t.set_f32(STYLES, styles::WIDTH, 1, 10.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 10.0);

        t.set_f32(STYLES, styles::WIDTH, 2, 10.0);
        t.set_f32(STYLES, styles::HEIGHT, 2, 10.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 2);
        link(t, 0, &[1, 2]);
    }
    engine.tick().expect("tick");

    let parent = bound(&engine, 0);
    let abs = bound(&engine, 1);
    let flow = bound(&engine, 2);

    // The padding box starts one border in on every side.
    let inner = [parent[0] + 4.0, parent[1] + 4.0];
    assert!(
        close(abs[0], inner[0] + 9.0),
        "left inset is from the padding box: {abs:?}, which starts at {inner:?}"
    );
    assert!(
        close(abs[1], inner[1] + 7.0),
        "top inset is from the padding box: {abs:?}"
    );

    // Out of flow: the in-flow sibling is placed as though the absolute one were
    // not there, so it sits at the top of the content box rather than below it.
    assert!(
        close(flow[1], parent[1] + 4.0 + 5.0),
        "the in-flow sibling ignores the absolute one: {flow:?} in {parent:?}"
    );
}

/// An empty *field* is one line high; an empty anything else is nothing.
///
/// The rule `NodeFlags::EDITABLE` exists for, asserted from both sides in one test
/// because it is the *contrast* that is the rule — either half alone is satisfied by
/// a wrong implementation. Measured, `probes/text-field-box.html`: an `<input>` is
/// 15.0px high with no text, one character and forty, while `<div></div>` is 0.
///
/// Two flagged shapes, both leaves, because a field has two forms. A **bound** field
/// owns a text run and layout measures that — an empty string in the arena. An
/// **unbound** `<input>` has no run at all, so `TEXT` is -1 and it is not
/// `MEASURABLE`; a browser still gives it a full-height box, which is why the flag is
/// checked before that gate rather than after.
///
/// Without this the height came out 0 and a field rendered as a bare line, then
/// jumped to full height on the first keystroke.
#[test]
fn an_empty_field_is_one_line_high_and_an_empty_box_is_not() {
    let mut engine = Engine::new(&config(5, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 0, 200.0);
        t.set_f32(STYLES, styles::HEIGHT, 0, 100.0);
        t.set_u8(STYLES, styles::ALIGN_ITEMS, 0, align::FLEX_START);

        for n in 0..5 {
            leaf(t, n, if n == 0 { 0 } else { 1 });
        }
        link(t, 0, &[1, 2, 3, 4]);

        let mut cursor = 0;
        t.push_string(0, "", &mut cursor).expect("string arena");

        // 1: a bound field's run — an empty string, flagged.
        t.set_i32(NODES, nodes::TEXT, 1, 0);
        t.set_u8(NODES, nodes::KIND, 1, protocol::node_kind::TEXT);
        t.set_u8(
            NODES,
            nodes::FLAGS,
            1,
            protocol::flags::MEASURABLE | protocol::flags::EDITABLE,
        );

        // 2: the same empty run *without* the flag — an ordinary binding that happens
        // to render nothing, which Chrome gives no height at all.
        t.set_i32(NODES, nodes::TEXT, 2, 0);
        t.set_u8(NODES, nodes::KIND, 2, protocol::node_kind::TEXT);
        t.set_u8(NODES, nodes::FLAGS, 2, protocol::flags::MEASURABLE);

        // 3: an unbound `<input>` — no text at all, so not measurable, but flagged.
        t.set_u8(NODES, nodes::FLAGS, 3, protocol::flags::EDITABLE);

        // 4: a plain empty box, the control for node 3.
        t.set_u8(NODES, nodes::FLAGS, 4, 0);
    }

    engine.tick().expect("tick");

    let field = bound(&engine, 1)[3];
    let plain_run = bound(&engine, 2)[3];
    let unbound = bound(&engine, 3)[3];
    let empty_box = bound(&engine, 4)[3];

    assert!(
        field > 0.0,
        "an empty bound field collapsed to {field}; it must be one line high"
    );
    assert!(
        close(unbound, field),
        "an unbound field is {unbound} and a bound one {field} — a browser gives both \
         the same box, since it does not ask who owns the value"
    );
    assert!(
        close(plain_run, 0.0),
        "an unflagged empty run took {plain_run}; only a *field* has a floor, or every \
         binding that renders \"\" silently reserves a line"
    );
    assert!(
        close(empty_box, 0.0),
        "an empty box took {empty_box}, but <div></div> is 0 high"
    );

    // The floor is the font's line height, so it has to be in the same neighbourhood
    // as a line of real text at the same size rather than an arbitrary constant —
    // and it must equal what the field reports once it *has* text, or the box moves
    // on the first keystroke.
    assert!(
        field > 16.0 && field < 32.0,
        "a 16px font's line box should be a little over 16px, got {field}"
    );
}

// ---------------------------------------------------------------------------
// Percentage and viewport lengths
//
// A length on the wire is a sum of channels — px the compiler resolved, a
// fraction of the containing block (`Pct`), a fraction of the window (`Vp`) —
// and these pin what each channel resolves against, and when.
// ---------------------------------------------------------------------------

/// `width: 50%` is half the *parent*, not half the window.
#[test]
fn a_percentage_width_resolves_against_the_parent() {
    let mut engine = Engine::new(&config(3, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        // Root fills the 200px window; the middle box is a fixed 120px wide, so
        // 50% on the leaf can only be 60 — half of 200 would be 100.
        t.set_f32(STYLES, styles::WIDTH, 1, 120.0);
        t.set_f32(STYLES, styles::WIDTH_PCT, 2, 0.5);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 2);
        link(t, 0, &[1]);
        link(t, 1, &[2]);
    }
    engine.tick().expect("tick");
    assert_eq!(bound(&engine, 2)[2], 60.0, "50% of the 120px parent");
}

/// `height: 100vh` is the window's height, whatever the parent is.
#[test]
fn a_viewport_length_resolves_against_the_window() {
    let mut engine = Engine::new(&config(3, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        // The parent is 20px high; the leaf asks for the full window — 100, not 20.
        // `flex-shrink: 0` because the default 1 would shrink it back into the
        // parent — which is correct CSS, and not what this test is about.
        t.set_f32(STYLES, styles::HEIGHT, 1, 20.0);
        t.set_f32(STYLES, styles::HEIGHT, 2, f32::NAN);
        t.set_f32(STYLES, styles::HEIGHT_VP, 2, 1.0);
        t.set_f32(STYLES, styles::FLEX_SHRINK, 2, 0.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        leaf(t, 2, 2);
        link(t, 0, &[1]);
        link(t, 1, &[2]);
    }
    engine.tick().expect("tick");
    assert_eq!(bound(&engine, 2)[3], 100.0, "100vh is the 100px window");
}

/// `calc(100vh - 4rem)` — the header-offset pattern — is px and viewport summed.
#[test]
fn a_viewport_length_sums_with_the_px_part() {
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::HEIGHT, 1, f32::NAN);
        t.set_f32(STYLES, styles::HEIGHT_VP, 1, 1.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, -64.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }
    engine.tick().expect("tick");
    assert_eq!(bound(&engine, 1)[3], 36.0, "100vh - 64px in a 100px window");
}

/// A viewport length is resolved when the style is built, so a resize restyles.
#[test]
fn a_resize_re_resolves_viewport_lengths() {
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_f32(STYLES, styles::WIDTH, 1, f32::NAN);
        t.set_f32(STYLES, styles::WIDTH_VP, 1, 0.5);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }
    engine.tick().expect("tick");
    assert_eq!(bound(&engine, 1)[2], 100.0, "50vw of the 200px window");

    engine.resize(400, 200).expect("resize");
    engine.tick().expect("tick");
    assert_eq!(
        bound(&engine, 1)[2],
        200.0,
        "after the resize it is 50vw of 400px, not the stale 100"
    );
}

/// `top: 25%` positions from the containing block, like CSS.
#[test]
fn a_percentage_inset_offsets_from_the_parent() {
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_u8(STYLES, styles::POSITION, 1, protocol::position::ABSOLUTE);
        t.set_f32(STYLES, styles::INSET_TOP, 1, 0.0);
        t.set_f32(STYLES, styles::INSET_TOP_PCT, 1, 0.25);
        t.set_f32(STYLES, styles::WIDTH, 1, 10.0);
        t.set_f32(STYLES, styles::HEIGHT, 1, 10.0);

        leaf(t, 0, 0);
        leaf(t, 1, 1);
        link(t, 0, &[1]);
    }
    engine.tick().expect("tick");
    // The root is the 200x100 window, so 25% of its height is 25.
    assert_eq!(bound(&engine, 1), [0.0, 25.0, 10.0, 10.0]);
}
