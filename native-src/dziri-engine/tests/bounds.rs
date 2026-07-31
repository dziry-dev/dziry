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

use dziri_engine::engine::{Engine, EngineConfig};
use dziri_engine::protocol::{
    self, align, display, flex_direction, justify, layout as layout_f, nodes, styles, Table,
};
use dziri_engine::tables::Tables;

const NODES: usize = Table::Nodes as usize;
const STYLES: usize = Table::Styles as usize;

fn config(nodes: u32, styles: u32) -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 200,
        height: 100,
        node_capacity: nodes,
        style_capacity: styles,
        variant_capacity: 4,
        variant_slot_capacity: 8,
        list_capacity: 2,
        string_capacity: 8,
        string_bytes: 256,
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
}

/// Links `children` under `parent` and gives every node its parent pointer.
fn link(t: &mut Tables, parent: usize, children: &[usize]) {
    t.set_i32(NODES, nodes::FIRST_CHILD, parent, children.first().map_or(-1, |c| *c as i32));
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

    assert_eq!(bound(&engine, 0), [0.0, 0.0, 200.0, 100.0], "root fills the window");
    assert_eq!(bound(&engine, 1), [10.0, 10.0, 50.0, 20.0], "first child at the padding");
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
        t.push_string(0, "Hello", &mut cursor).expect("string arena");
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
    engine
        .tables_mut()
        .set_f32(STYLES, styles::HEIGHT, 1, 32.0);
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
    assert_eq!(bound(&engine, 3)[1], 50.0, "third row starts below the first two");

    {
        // `firstChild[0]` is untouched: the chain still starts at node 1.
        let t = engine.tables_mut();
        t.set_i32(NODES, nodes::NEXT_SIBLING, 1, 3);
    }
    engine.tick().expect("tick");

    assert_eq!(bound(&engine, 3)[1], 20.0, "the third row took the second's place");
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

    assert_eq!(bound(&engine, 1), [0.0, 0.0, 70.0, 35.0], "it wears slot 2 now");
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
    assert!(
        result.unwrap_err().contains("cycle"),
        "the message should name the problem"
    );
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
    assert!(
        result.unwrap_err().contains("reachable twice"),
        "the message should name the problem"
    );
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
    assert!(result.unwrap_err().contains("reachable twice"));
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
    assert_eq!(bound(&engine, 0), [0.0, 0.0, 200.0, 100.0], "the root still lays out");
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

    assert_eq!(engine.hit_test(10.0, 30.0), 2, "inside the interactive child");
    assert_eq!(engine.hit_test(10.0, 5.0), -1, "the non-interactive one");
    assert_eq!(engine.hit_test(500.0, 500.0), -1, "outside everything");
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

    assert_eq!(bound(&engine, 1), [0.0, 0.0, 200.0, 100.0], "the root fills the window");
    assert_eq!(engine.hit_test(10.0, 10.0), 2, "the interactive node under root 1");
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

    assert_eq!(bound(&engine, 1), bound(&engine, 2), "the two overlap exactly");
    assert_eq!(engine.hit_test(20.0, 20.0), 2, "the later sibling is painted on top");
}

#[test]
fn the_descriptor_matches_the_generated_schema() {
    let engine = Engine::new(&config(8, 4)).expect("engine");
    let mut spans = vec![
        dziri_engine::tables::SpanDesc {
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
                span.elem_size as usize, size,
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
    assert_eq!(spans[i].table, dziri_engine::tables::REGION);
    assert_eq!(spans[i].field, dziri_engine::tables::REGION_STRING_BYTES);
}
