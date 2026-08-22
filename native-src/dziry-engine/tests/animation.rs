//! What a transition and a `@keyframes` animation actually paint, at an exact `t`.
//!
//! The unit tests in `anim.rs` prove the curve reproduces Chromium's measured
//! progress table, and the compiler tests prove the right rows and offsets reach the
//! tables. Neither proves a pixel moved: between them sit the retarget pass, the
//! blend the paint reads through, and the fixed frame length that makes any of it
//! reproducible. This file is the seam.
//!
//! Everything here reads the raster surface the window would have presented, and
//! everything is driven by `set_time_step` rather than by the clock — which is what
//! makes an assertion about `t = 0.5` an assertion rather than a hope. A test that
//! read the wall clock would pass or fail by how busy the machine was.

use dziry_engine::engine::{Engine, EngineConfig};
use dziry_engine::protocol::{
    self, align, display, easing, flex_direction, justify, keyframes, nodes, predicate, styles,
    tweens, variant_slots, variants, Table,
};
use dziry_engine::tables::Tables;

const NODES: usize = Table::Nodes as usize;
const STYLES: usize = Table::Styles as usize;
const VARIANTS: usize = Table::Variants as usize;
const VARIANT_SLOTS: usize = Table::VariantSlots as usize;
const TWEENS: usize = Table::Tweens as usize;
const KEYFRAMES: usize = Table::Keyframes as usize;

/// Black and white, because their midpoint is the whole question for a colour
/// transition: measured, Chromium reads `rgb(128,128,128)` halfway, which is a plain
/// lerp of the gamma-encoded bytes rather than of linear light.
const BLACK: u32 = 0xff00_0000;
const WHITE: u32 = 0xffff_ffff;

fn config(nodes: u32, styles: u32) -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 100,
        height: 100,
        node_capacity: nodes,
        style_capacity: styles,
        variant_capacity: 1,
        variant_slot_capacity: 4,
        media_capacity: 1,
        list_capacity: 1,
        tween_capacity: 2,
        keyframe_capacity: 4,
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

/// A style row at its initial values.
///
/// The transform identities are not optional and not decoration: a zeroed row is
/// `scale(0)`, so a row that omits them is a node scaled to nothing — invisible and
/// unhittable, with nothing in the failure naming transforms. `Uploader.uploadStyles`
/// derives the same values from `INITIAL_STYLE` for real tables.
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

fn root_node(t: &mut Tables, slot: u16) {
    t.set_u8(NODES, nodes::KIND, 0, protocol::node_kind::BOX);
    t.set_u16(NODES, nodes::STYLE, 0, slot);
    t.set_i32(NODES, nodes::TEXT, 0, -1);
    t.set_i32(NODES, nodes::PARENT, 0, -1);
    t.set_i32(NODES, nodes::FIRST_CHILD, 0, -1);
    t.set_i32(NODES, nodes::NEXT_SIBLING, 0, -1);
    t.set_i16(NODES, nodes::LIST, 0, -1);
    t.set_u8(NODES, nodes::FLAGS, 0, protocol::flags::INTERACTIVE);
}

/// A linear tween over `bg` and `opacity` alone, so a mask that is too wide shows up
/// as a field that moved when it should not have.
fn linear_tween(t: &mut Tables, row: usize, duration: f32) {
    let bit = |field: usize| 1u32 << styles::ANIM_BIT[field];
    t.set_u32(
        TWEENS,
        tweens::MASK,
        row,
        bit(styles::BG) | bit(styles::OPACITY),
    );
    t.set_f32(TWEENS, tweens::DURATION, row, duration);
    t.set_f32(TWEENS, tweens::DELAY, row, 0.0);
    t.set_f32(TWEENS, tweens::ITERATIONS, row, 1.0);
    t.set_i32(TWEENS, tweens::FIRST_SEGMENT, row, -1);
    t.set_u16(TWEENS, tweens::SEGMENT_COUNT, row, 0);
    t.set_u8(TWEENS, tweens::EASING, row, easing::LINEAR);
}

/// One pixel as 0xAARRGGBB, from the BGRA_8888 buffer the window presents.
fn pixel(engine: &mut Engine, x: usize, y: usize) -> u32 {
    let (bytes, row_bytes) = engine.pixels().expect("surface pixels");
    let i = y * row_bytes + x * 4;
    let (b, g, r, a) = (bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    (u32::from(a) << 24) | (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b)
}

/// The grey level at the centre of a full-window box, as a byte.
///
/// One channel rather than the whole colour because the endpoints here are greys, so
/// every channel carries the same number and naming one keeps the assertions readable.
fn grey(engine: &mut Engine) -> i32 {
    ((pixel(engine, 50, 50) >> 16) & 0xff) as i32
}

/// The root, black at rest and white on hover, with a `duration`-second transition.
///
/// The variant table is what makes this a *transition* rather than a repaint: the
/// node's style changes because a predicate changed, which is the only thing that
/// can start one. Nothing here writes a colour per frame.
fn hover_fade(duration: f32) -> Engine {
    let mut engine = Engine::new(&config(1, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_u32(STYLES, styles::BG, 0, BLACK);
        t.set_u32(STYLES, styles::BG, 1, WHITE);
        // The spec is read from the row being moved *to*, as CSS says — so both rows
        // carry it, exactly as `transition-colors` on a base class would.
        t.set_u16(STYLES, styles::TRANSITION, 0, 1);
        t.set_u16(STYLES, styles::TRANSITION, 1, 1);
        linear_tween(t, 0, duration);

        root_node(t, 0);

        // One node, one predicate: run[0] is the resting row, run[1] the hovered one.
        t.set_i32(VARIANTS, variants::NODE, 0, 0);
        t.set_u32(VARIANTS, variants::MASK, 0, predicate::HOVER);
        t.set_i32(VARIANTS, variants::RUN_START, 0, 0);
        t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, 0, 0);
        t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, 1, 1);
    }

    // A fixed frame length from the start, so the first tick — which is where the
    // resting row is recorded — cannot itself advance anything.
    engine.set_time_step(0.0);
    engine.tick().expect("tick");
    engine
}

/// A transition moves the pixels, and it moves them by the eased fraction.
///
/// The three interior samples are the assertion. A jump straight to white would pass
/// a test that only looked at the end, and reading the destination row outright —
/// which is what every field *outside* the mask does — is exactly the bug a
/// single-sample test cannot see.
#[test]
fn a_hover_fade_lands_on_the_measured_midpoint() {
    let mut engine = hover_fade(1.0);
    assert_eq!(grey(&mut engine), 0, "at rest the box is black");

    engine.set_input_state(0, -1, -1);
    engine.set_time_step(0.5);
    engine.tick().expect("tick");

    // 128, not 188. sRGB per channel, measured — `color-mix(in oklab, black, white)`
    // is the visibly lighter grey, and the two features do not share a space.
    let half = grey(&mut engine);
    assert!(
        (half - 128).abs() <= 1,
        "halfway through a black->white fade should read 128, got {half}"
    );

    engine.tick().expect("tick");
    let done = grey(&mut engine);
    assert_eq!(done, 255, "a second half-second arrives, got {done}");
}

/// A quarter and three quarters, which separate a plain lerp from anything else.
///
/// 64 and 191 are Chromium's own readings for `t = 0.25` and `0.75`. A linear-light
/// interpolation would give 137 and 216 — not subtly different, and the reason this
/// samples two points rather than trusting the midpoint, which is the one value every
/// candidate implementation agrees on.
#[test]
fn the_interior_of_a_fade_is_a_plain_srgb_lerp() {
    for (step, want) in [(0.25f32, 64), (0.75, 191)] {
        let mut engine = hover_fade(1.0);
        engine.set_input_state(0, -1, -1);
        engine.set_time_step(step);
        engine.tick().expect("tick");
        let got = grey(&mut engine);
        assert!(
            (got - want).abs() <= 2,
            "at t={step} expected {want}, got {got}"
        );
    }
}

/// An interruption is a **rewind of the same pair**, at the same rate.
///
/// Measured: interrupted at t=0.4, the way back takes 400 ms of a 1000 ms transition
/// and starts from the value already reached. Both fall out of `t` moving at
/// ±1/duration, which is the whole reason no row anywhere holds an interpolated
/// value — interned rows are shared between nodes, so there would be nowhere to put
/// one.
///
/// The test is that 0.4 out and 0.4 back is *black again*, and that 0.2 back is
/// halfway. A tween that restarted from zero on the way out would arrive early; one
/// that ran the full duration back would still be grey.
#[test]
fn a_reversal_rewinds_at_the_same_rate() {
    let mut engine = hover_fade(1.0);

    engine.set_input_state(0, -1, -1);
    engine.set_time_step(0.4);
    engine.tick().expect("tick");
    let out = grey(&mut engine);
    assert!((out - 102).abs() <= 2, "0.4 of the way is 102, got {out}");

    // Away. The target is the row this tween came from, so it is the same pair
    // traversed backwards from wherever `t` had got to.
    engine.set_input_state(-1, -1, -1);
    engine.set_time_step(0.2);
    engine.tick().expect("tick");
    let back = grey(&mut engine);
    assert!(
        (back - 51).abs() <= 2,
        "half of the way back is 51, got {back}"
    );

    engine.tick().expect("tick");
    assert_eq!(grey(&mut engine), 0, "the remaining 0.2 arrives at black");
}

/// A delay holds the resting value, and its overshoot is carried rather than dropped.
///
/// The second claim is the one worth a test: a frame longer than the remaining delay
/// must spend the difference on `t`, or a 16 ms delay behaves like 32 and every
/// staggered sequence drifts.
#[test]
fn a_delay_holds_the_start_and_then_spends_its_overshoot() {
    let mut engine = hover_fade(1.0);
    {
        let t = engine.tables_mut();
        t.set_f32(TWEENS, tweens::DELAY, 0, 0.5);
    }
    engine.tick().expect("tick");

    engine.set_input_state(0, -1, -1);
    engine.set_time_step(0.25);
    engine.tick().expect("tick");
    assert_eq!(grey(&mut engine), 0, "still inside the delay");

    // 0.75 total: 0.5 of delay and 0.25 of transition, so a quarter of the way.
    engine.set_time_step(0.5);
    engine.tick().expect("tick");
    let got = grey(&mut engine);
    assert!(
        (got - 64).abs() <= 2,
        "the 0.25 past the delay should be spent, got {got}"
    );
}

/// A `@keyframes` animation runs on the clock, with no predicate change at all.
///
/// Three keyframes so the segment search is exercised, and the interesting sample is
/// the *last* one: an animation with `iterations: 1` and no fill mode returns the
/// element to its own style, which is CSS's default and the only one dziry
/// implements. A tween that held its final keyframe would read 255 there.
#[test]
fn an_animation_runs_without_any_predicate_and_then_lets_go() {
    let mut engine = Engine::new(&config(1, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        // The element itself is black; the middle keyframe is white.
        t.set_u32(STYLES, styles::BG, 0, BLACK);
        t.set_u32(STYLES, styles::BG, 1, BLACK);
        t.set_u32(STYLES, styles::BG, 2, WHITE);
        t.set_u16(STYLES, styles::ANIMATION, 0, 1);

        let bit = 1u32 << styles::ANIM_BIT[styles::BG];
        t.set_u32(TWEENS, tweens::MASK, 0, bit);
        t.set_f32(TWEENS, tweens::DURATION, 0, 1.0);
        t.set_f32(TWEENS, tweens::DELAY, 0, 0.0);
        t.set_f32(TWEENS, tweens::ITERATIONS, 0, 1.0);
        t.set_i32(TWEENS, tweens::FIRST_SEGMENT, 0, 0);
        t.set_u16(TWEENS, tweens::SEGMENT_COUNT, 0, 3);
        t.set_u8(TWEENS, tweens::EASING, 0, easing::LINEAR);

        // 0 -> black, 0.5 -> white, 1 -> black. The compiler synthesises both
        // endpoints from the element's own row when the author omitted them, which is
        // what makes a `50% { … }`-only block work.
        for (row, offset, style) in [(0usize, 0.0f32, 1u16), (1, 0.5, 2), (2, 1.0, 1)] {
            t.set_u16(KEYFRAMES, keyframes::STYLE, row, style);
            t.set_f32(KEYFRAMES, keyframes::OFFSET, row, offset);
            t.set_u8(KEYFRAMES, keyframes::EASING, row, easing::INHERIT);
        }

        root_node(t, 0);
    }

    engine.set_time_step(0.0);
    engine.tick().expect("tick");
    assert_eq!(grey(&mut engine), 0, "the first frame is the 0% keyframe");

    engine.set_time_step(0.25);
    engine.tick().expect("tick");
    let quarter = grey(&mut engine);
    assert!(
        (quarter - 128).abs() <= 2,
        "a quarter through is halfway up the first segment, got {quarter}"
    );

    engine.tick().expect("tick");
    assert_eq!(grey(&mut engine), 255, "halfway is the 50% keyframe");

    engine.tick().expect("tick");
    let three = grey(&mut engine);
    assert!(
        (three - 128).abs() <= 2,
        "three quarters is halfway down the second segment, got {three}"
    );

    // Past the single iteration. No fill mode, so the element wears its own style.
    engine.tick().expect("tick");
    assert_eq!(grey(&mut engine), 0, "one iteration and then let go");
    assert!(!engine.animating(), "a finished animation stops the loop");
}

/// A keyframe's own easing governs the segment **leaving** it.
///
/// Measured, and it is the row that makes Tailwind's `bounce` expressible without a
/// second concept. `steps(1, end)` holds a segment at its start value for the whole
/// segment, which makes the question decidable in one reading: with it on the `0%`
/// keyframe, a quarter of the way through is still the *start* colour.
#[test]
fn a_keyframes_easing_governs_the_segment_leaving_it() {
    let mut engine = Engine::new(&config(1, 3)).expect("engine");
    {
        let t = engine.tables_mut();
        for slot in 0..3 {
            init_style(t, slot);
        }
        t.set_u32(STYLES, styles::BG, 0, BLACK);
        t.set_u32(STYLES, styles::BG, 1, BLACK);
        t.set_u32(STYLES, styles::BG, 2, WHITE);
        t.set_u16(STYLES, styles::ANIMATION, 0, 1);

        t.set_u32(
            TWEENS,
            tweens::MASK,
            0,
            1u32 << styles::ANIM_BIT[styles::BG],
        );
        t.set_f32(TWEENS, tweens::DURATION, 0, 1.0);
        t.set_f32(TWEENS, tweens::ITERATIONS, 0, f32::INFINITY);
        t.set_i32(TWEENS, tweens::FIRST_SEGMENT, 0, 0);
        t.set_u16(TWEENS, tweens::SEGMENT_COUNT, 0, 2);
        t.set_u8(TWEENS, tweens::EASING, 0, easing::LINEAR);

        // 0% black, holding for the whole segment; 100% white.
        t.set_u16(KEYFRAMES, keyframes::STYLE, 0, 1);
        t.set_f32(KEYFRAMES, keyframes::OFFSET, 0, 0.0);
        t.set_u8(KEYFRAMES, keyframes::EASING, 0, easing::STEPS);
        t.set_f32(KEYFRAMES, keyframes::EASE_A, 0, 1.0);
        t.set_f32(
            KEYFRAMES,
            keyframes::EASE_B,
            0,
            protocol::step_position::JUMP_END as f32,
        );

        t.set_u16(KEYFRAMES, keyframes::STYLE, 1, 2);
        t.set_f32(KEYFRAMES, keyframes::OFFSET, 1, 1.0);
        t.set_u8(KEYFRAMES, keyframes::EASING, 1, easing::INHERIT);

        root_node(t, 0);
    }

    engine.set_time_step(0.0);
    engine.tick().expect("tick");

    // Held at the start value across the segment the `0%` keyframe leaves. Without
    // the per-segment curve this would read 128 and 255 — the animation's own
    // `linear` — and `bounce` would be a straight line.
    for (step, expected) in [(0.25f32, 0), (0.25, 0), (0.25, 0)] {
        engine.set_time_step(step);
        engine.tick().expect("tick");
        assert_eq!(grey(&mut engine), expected, "held by steps(1, end)");
    }

    // Into the next iteration, where `local` wraps and the step starts again.
    engine.set_time_step(0.3);
    engine.tick().expect("tick");
    assert_eq!(grey(&mut engine), 0, "the second iteration holds too");
    assert!(
        engine.animating(),
        "an infinite animation keeps the loop alive"
    );
}

/// A node with no tween costs nothing, which is what makes this free to ship.
///
/// `animating()` is the observable half of that: with nothing to advance, the loop
/// treats a tick as an event drain and presents no pixels. A watch list that included
/// every node, or a tween left behind after it finished, would both show up here.
#[test]
fn a_page_with_no_tween_never_animates() {
    let mut engine = Engine::new(&config(1, 1)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        t.set_u32(STYLES, styles::BG, 0, WHITE);
        root_node(t, 0);
    }
    engine.set_time_step(0.016);
    engine.tick().expect("tick");
    assert!(!engine.animating());

    // Hovering a node with no transition is an instant change, not a tween.
    engine.set_input_state(0, -1, -1);
    engine.tick().expect("tick");
    assert!(!engine.animating());
    assert_eq!(grey(&mut engine), 255);
}

/// Hovering a *button* fades the **card** it sits in, at the pixel level.
///
/// The two features meet here, and the meeting is what made the older bug worth fixing
/// rather than documenting. `:hover` matches the pointed element and every ancestor of
/// it — measured, `guards/probes/hover-propagation.html` — and a transition starts only when a
/// node's resolved slot *changes*. So an exact-equality hover test did not merely leave
/// the card unhighlighted: it left the card's slot unchanged, which meant the transition
/// never started either. One wrong comparison, two features silently doing nothing.
///
/// The card fills the window and the button is a child of it, so sampling the card's own
/// area is sampling the card. Only the button is pointed at; the card is never
/// `state.hovered`.
#[test]
fn hovering_a_button_fades_the_card_it_sits_in() {
    let mut engine = Engine::new(&config(2, 2)).expect("engine");
    {
        let t = engine.tables_mut();
        init_style(t, 0);
        init_style(t, 1);
        t.set_u32(STYLES, styles::BG, 0, BLACK);
        t.set_u32(STYLES, styles::BG, 1, WHITE);
        t.set_u16(STYLES, styles::TRANSITION, 0, 1);
        t.set_u16(STYLES, styles::TRANSITION, 1, 1);
        linear_tween(t, 0, 1.0);

        // The card: node 0, the root, with the button as its only child.
        root_node(t, 0);
        t.set_i32(NODES, nodes::FIRST_CHILD, 0, 1);

        // The button: node 1. Transparent, so it does not paint over the card's fill and
        // the sample below reads the card rather than the thing being hovered.
        t.set_u8(NODES, nodes::KIND, 1, protocol::node_kind::BOX);
        t.set_u16(NODES, nodes::STYLE, 1, 0);
        t.set_i32(NODES, nodes::TEXT, 1, -1);
        t.set_i32(NODES, nodes::PARENT, 1, 0);
        t.set_i32(NODES, nodes::FIRST_CHILD, 1, -1);
        t.set_i32(NODES, nodes::NEXT_SIBLING, 1, -1);
        t.set_i16(NODES, nodes::LIST, 1, -1);
        t.set_u8(NODES, nodes::FLAGS, 1, protocol::flags::INTERACTIVE);

        // Only the **card** carries a HOVER variant. The button has none, which is the
        // realistic shape — `.card:hover` with a plain button inside it — and it means
        // nothing about this can pass by accident through the button's own styling.
        t.set_i32(VARIANTS, variants::NODE, 0, 0);
        t.set_u32(VARIANTS, variants::MASK, 0, predicate::HOVER);
        t.set_i32(VARIANTS, variants::RUN_START, 0, 0);
        t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, 0, 0);
        t.set_u16(VARIANT_SLOTS, variant_slots::STYLE, 1, 1);
    }

    engine.set_time_step(0.0);
    engine.tick().expect("tick");
    assert_eq!(grey(&mut engine), 0, "at rest the card is black");

    // The pointer is on the **button**, never on the card.
    engine.set_input_state(1, -1, -1);
    engine.set_time_step(0.5);
    engine.tick().expect("tick");
    let half = grey(&mut engine);
    assert!(
        (half - 128).abs() <= 1,
        "the card should be halfway through its fade with the pointer on its child, got {half}"
    );

    engine.tick().expect("tick");
    assert_eq!(grey(&mut engine), 255, "and arrive");

    // Away. The outgoing transition had *completed*, so the way back gets the full
    // duration rather than a shortened one — measured, and the reason a finished tween is
    // dropped rather than kept settled: a new one starting at `t = 0` on the flipped pair
    // is exactly what "the full duration" means.
    engine.set_input_state(-1, -1, -1);
    engine.tick().expect("tick");
    let back = grey(&mut engine);
    assert!(
        (back - 128).abs() <= 1,
        "half a second back is halfway, not home, got {back}"
    );

    engine.tick().expect("tick");
    assert_eq!(grey(&mut engine), 0, "and black once the second half runs");
}
