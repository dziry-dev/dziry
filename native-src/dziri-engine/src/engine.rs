//! The engine: one frame, start to finish.
//!
//! ```text
//! Bun writes staged tables ──▶ tick() ──▶ commit ──▶ resync ──▶ layout ──▶ paint ──▶ present
//!                                            │                                        │
//!                                            └── diff drives what is redone           └── events queued for Bun
//! ```
//!
//! # Who drives
//!
//! Today Bun calls `tick()`. The roadmap has the engine owning the frame loop on
//! its own thread, so a resize or a caret blink repaints while Bun is busy —
//! [`Tables`]'s staged/live split is already the mechanism that makes that safe,
//! and the ordering above does not change when the caller becomes a render
//! thread. That move is A0's step 3 and is deliberately not made yet: a render
//! thread with a synchronous descriptor and no thread-safe handle would be a
//! second unfinished thing rather than a finished first one.
//!
//! # Headless
//!
//! With no window the engine still commits, lays out and paints, into a Skia
//! surface it can hand back as pixels. That is what the Rust tests use, and what
//! `--screenshot` becomes.

use skia_safe::{
    surfaces, Color, ImageInfo, PixelGeometry, Surface, SurfaceProps, SurfacePropsFlags,
};

use crate::error::EngineError;
use crate::layout::LayoutTree;
use crate::paint::{
    hit_test, is_scrollable, scrollable_at, Bar, BarHover, Geometry, InputState, Painter,
};
use crate::protocol::{self, event_kind};
use crate::tables::{Capacities, Diff, SpanDesc, Tables};
use crate::text::Measurer;
use crate::window::{RawInput, Window};

/// One entry in the queue Bun drains after `tick()`.
///
/// Fixed size and `#[repr(C)]` so the host reads it as a struct rather than
/// parsing anything. `text` is inline because an IME commit is a handful of
/// bytes and a pointer would need a lifetime the host cannot honour.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Event {
    pub kind: u32,
    /// The node involved, or -1.
    pub node: i32,
    /// Key code, or the byte length of `text`.
    pub a: i32,
    pub b: i32,
    pub x: f32,
    pub y: f32,
    pub text: [u8; 32],
}

impl Default for Event {
    fn default() -> Self {
        Self {
            kind: event_kind::NONE,
            node: -1,
            a: 0,
            b: 0,
            x: 0.0,
            y: 0.0,
            text: [0; 32],
        }
    }
}

impl Event {
    fn of(kind: u32) -> Self {
        Self {
            kind,
            ..Default::default()
        }
    }
}

/// What the host asks for at startup. Passed by pointer, never by value: a
/// struct return or argument across `bun:ffi` is one more ABI detail to get
/// right, and there is nothing to gain from it.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct EngineConfig {
    pub protocol_version: u32,
    pub width: u32,
    pub height: u32,
    pub node_capacity: u32,
    pub style_capacity: u32,
    pub variant_capacity: u32,
    pub variant_slot_capacity: u32,
    /// Rows in the media table — atomic conditions, not `@media` blocks.
    pub media_capacity: u32,
    pub list_capacity: u32,
    /// Rows in the tween table — interned transition and animation specs.
    pub tween_capacity: u32,
    /// Rows in the keyframe table, summed over every animation on the page.
    pub keyframe_capacity: u32,
    /// Rows in the controls table — one per form control, not per node.
    pub control_capacity: u32,
    pub string_capacity: u32,
    pub string_bytes: u32,
    pub root: u32,
    /// Non-zero opens a window. Zero renders offscreen, for tests and
    /// screenshots.
    pub windowed: u8,
    /// Non-zero asks for native window chrome. Fixed at creation because macOS
    /// traffic lights, Windows DWM title bars and Linux CSD all are.
    pub decorated: u8,
    pub _reserved: [u8; 2],
    /// UTF-8, not NUL-terminated; `title_len` is authoritative.
    pub title: *const u8,
    pub title_len: u32,
}

/// A scrollbar being dragged.
///
/// `grab` is what makes a drag feel right: the offset from the thumb's start to where it
/// was actually picked up, held constant for the whole gesture. Without it the thumb
/// centres itself on the cursor at the first move, which reads as the content lurching
/// the instant you touch the bar.
#[derive(Clone, Copy, Debug)]
struct BarDrag {
    node: usize,
    vertical: bool,
    grab: f32,
}

pub struct Engine {
    tables: Tables,
    tree: LayoutTree,
    measurer: Measurer,
    painter: Painter,
    surface: Surface,
    window: Option<Window>,
    state: InputState,
    events: Vec<Event>,
    width: u32,
    height: u32,
    root: usize,
    /// Set when a caught panic leaves the engine's invariants unknown. Every
    /// later call fails fast rather than rendering from half-updated state.
    pub poisoned: bool,
    /// Bumped every completed frame, for the host's diagnostics.
    frame: u64,
    /// The tree has never been built; the first tick must rebuild regardless of
    /// what the diff says.
    fresh: bool,
    /// Something changed since the last frame was presented.
    ///
    /// Event-driven repaint, kept as an optimisation now that the engine paints
    /// rather than the host: with nothing staged, nothing hovered and nothing
    /// animating, a tick is an event-queue drain and no pixels at all.
    needs_paint: bool,
    last_frame_ms: f32,
    /// When the event watcher last drew mid-pump, for coalescing a live resize.
    last_live_repaint: std::time::Instant,
    /// Per node, how far its content is scrolled: `[x, y]`, both >= 0.
    ///
    /// Engine state, not table state, and that is the point. A scroll position is
    /// not something the host authored — it is where the user left this box — so it
    /// must survive a patch, a relink and a list reorder, all of which rewrite the
    /// tables. Keyed by node id, which append-and-abandon list growth never
    /// invalidates.
    scroll: Vec<[f32; 2]>,
    /// Where each of those offsets is heading.
    ///
    /// The gate's question 1 answered "no": a scroll position depends on the wheel and
    /// the clock, and neither exists at build time. Nothing else about it is dynamic —
    /// the curve and its time constant are compile-time constants, the host is never
    /// told, and the runtime trace is this one `[f32; 2]` per node plus one
    /// interpolation in `tick`.
    ///
    /// Separate from `scroll` rather than replacing it, because paint needs where the
    /// content *is* and input needs where it is *going*: a second wheel notch during a
    /// glide has to add to the destination, not to the current position, or a fast
    /// scroll ends up slower than a slow one.
    scroll_target: Vec<[f32; 2]>,
    /// Whether any offset is still catching up, so an idle frame stays free.
    scroll_animating: bool,
    /// When `scroll` was last advanced, for a frame-rate-independent step.
    last_advance: std::time::Instant,
    /// A fixed `dt` for every frame, replacing the wall clock.
    ///
    /// Not a debugging affordance. `dt` being a parameter all the way down — through
    /// `advance_scrolls` and `advance_animations` — is only worth something if
    /// something can actually supply one, and this is that something: a golden
    /// screenshot of an animation is a frame at an *exact* `t`, and a wall-clock
    /// reading would make the same scenario a different picture every run.
    ///
    /// `None` is the clock, which is what a real window uses.
    time_step: Option<f32>,
    /// A scrollbar drag in progress.
    ///
    /// Engine state for the same reason a scroll offset is: nothing the host authored,
    /// and it has to survive the frames in between. It also *is* the pointer capture —
    /// while this is set the pointer's position means "where the thumb goes" and nothing
    /// else, whether or not it is still over the bar.
    drag: Option<BarDrag>,
    /// The most recently encoded PNG, waiting to be copied out.
    png: Vec<u8>,
}

impl Engine {
    pub fn new(config: &EngineConfig) -> Result<Self, EngineError> {
        if config.protocol_version != protocol::PROTOCOL_VERSION {
            return Err(EngineError::new(
                protocol::status::PROTOCOL_MISMATCH,
                format!(
                    "protocol mismatch: the host speaks v{}, this engine speaks v{}",
                    config.protocol_version,
                    protocol::PROTOCOL_VERSION
                ),
            ));
        }

        let width = config.width.max(1);
        let height = config.height.max(1);

        // `nodes` and `strings` are headroom — a list arena grows into them.
        // `states` and `lists` are exact counts: every row is meaningful, which
        // is what lets the state lookup binary-search the whole span.
        let caps = Capacities {
            nodes: config.node_capacity.max(1),
            styles: config.style_capacity.max(1),
            variants: config.variant_capacity.max(1),
            variant_slots: config.variant_slot_capacity.max(1),
            media: config.media_capacity.max(1),
            lists: config.list_capacity.max(1),
            tweens: config.tween_capacity.max(1),
            keyframes: config.keyframe_capacity.max(1),
            controls: config.control_capacity.max(1),
            strings: config.string_capacity.max(1),
            string_bytes: config.string_bytes.max(1),
        };

        let surface = raster_surface(width, height)?;

        let window = if config.windowed != 0 {
            let title = read_title(config);
            Some(Window::new(&title, width, height, config.decorated != 0)?)
        } else {
            None
        };

        Ok(Self {
            tables: Tables::new(caps),
            tree: LayoutTree::new(),
            measurer: Measurer::new()?,
            painter: Painter::new(),
            surface,
            window,
            state: InputState::none(),
            events: Vec::new(),
            width,
            height,
            root: config.root as usize,
            poisoned: false,
            frame: 0,
            fresh: true,
            needs_paint: true,
            last_frame_ms: 0.0,
            last_live_repaint: std::time::Instant::now(),
            scroll: vec![[0.0; 2]; caps.nodes as usize],
            scroll_target: vec![[0.0; 2]; caps.nodes as usize],
            scroll_animating: false,
            last_advance: std::time::Instant::now(),
            time_step: None,
            drag: None,
            png: Vec::new(),
        })
    }

    pub fn tables(&self) -> &Tables {
        &self.tables
    }

    pub fn tables_mut(&mut self) -> &mut Tables {
        &mut self.tables
    }

    pub fn describe(&self, out: &mut [SpanDesc]) -> usize {
        self.tables.describe(out)
    }

    pub fn span_count(&self) -> usize {
        self.tables.span_count()
    }

    pub fn generation(&self) -> u64 {
        self.tables.generation()
    }

    pub fn frame_count(&self) -> u64 {
        self.frame
    }

    pub fn last_frame_ms(&self) -> f32 {
        self.last_frame_ms
    }

    pub fn font_family(&self) -> &str {
        self.measurer.family()
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn input_state(&self) -> InputState {
        self.state
    }

    pub fn bounds_of(&self, node: usize) -> Option<[f32; 4]> {
        self.tree.bounds_of(node)
    }

    /// Encodes the last painted frame as a PNG, held until [`Self::take_png`].
    ///
    /// Skia already has the encoder, so the TypeScript runtime's hand-written
    /// one retires with it. This is what makes a headless engine a golden-image
    /// harness rather than just a layout oracle.
    pub fn encode_png(&mut self) -> Option<usize> {
        let image = self.surface.image_snapshot();
        // No GPU context: this surface is CPU raster, which is the whole
        // reason the pixel buffer can be handed straight to SDL.
        let data = image.encode(None, skia_safe::EncodedImageFormat::PNG, 100)?;
        self.png = data.as_bytes().to_vec();
        Some(self.png.len())
    }

    /// How many bytes the last [`Self::encode_png`] produced, without consuming
    /// them. A caller with a fixed buffer must ask this *before* taking: the take
    /// is destructive, so checking capacity afterwards throws away the only copy
    /// of the frame and leaves the retry nothing to return.
    pub fn png_len(&self) -> usize {
        self.png.len()
    }

    /// Takes the encoded bytes, leaving the buffer empty.
    pub fn take_png(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.png)
    }

    /// The pixels of the last painted frame, as BGRA_8888.
    pub fn pixels(&mut self) -> Option<(Vec<u8>, usize)> {
        let pixmap = self.surface.peek_pixels()?;
        let row_bytes = pixmap.row_bytes();
        Some((pixmap.bytes()?.to_vec(), row_bytes))
    }

    /// One frame: apply what Bun staged, relayout what that invalidated, paint,
    /// present, and collect input.
    pub fn tick(&mut self) -> Result<(), EngineError> {
        let started = std::time::Instant::now();

        // Input first, so a click staged by Bun last frame and a click arriving
        // this frame are never resolved against different layouts.
        self.pump_input()?;

        let diff = self.tables.commit();
        self.resync(&diff)?;

        if self.fresh || diff.any {
            self.relayout()?;
            self.needs_paint = true;
        }

        // The one place wall-clock time enters the frame, and after the relayout
        // because the clamp above can move a target this then has to chase.
        //
        // Both advances share the one `dt`, which is the whole reason it is read here
        // and passed down rather than sampled inside each. Two clocks would drift
        // against each other, and neither could be driven from a test.
        // The hover and press chains, before anything reads a predicate. Here rather
        // than inside `draw` because `advance_animations` below is what notices a slot
        // change and starts a transition — resolving that against last frame's chain
        // would make every hover a frame late. After `resync`, because the chains are
        // walked up `nodes.parent` and a commit can move it.
        self.painter.set_input_chains(&self.tables, &self.state);

        let dt = self.frame_dt();
        self.advance_scrolls(dt);
        self.advance_animations(dt);

        // An idle tick is an event drain and nothing else. The window keeps the
        // last frame it was given, so not presenting is not the same as
        // presenting nothing.
        if !self.needs_paint {
            self.last_frame_ms = started.elapsed().as_secs_f32() * 1000.0;
            return Ok(());
        }

        self.draw();
        self.present()?;
        self.needs_paint = false;

        self.frame += 1;
        self.last_frame_ms = started.elapsed().as_secs_f32() * 1000.0;
        Ok(())
    }

    /// A frame that services the window without reading what the host staged.
    ///
    /// `tick` minus the commit, and it exists for exactly one caller: a host whose
    /// app code runs on another thread. The staged tables are that thread's to
    /// write, and a `commit` racing a half-finished batch is not merely a frame of
    /// wrong pixels — a link column caught mid-splice is a malformed chain, which
    /// the traversal budget reports as an error and which poisons the engine.
    ///
    /// So the host takes a lock it can *fail* to take. Holding it means the writer
    /// is between batches and `tick` is safe; failing to take it means calling
    /// this instead. Either way the platform queue is drained, a resize is honoured
    /// and a damaged surface is repainted on time, which is the whole point: the
    /// window must not stop answering the OS because the app is busy.
    ///
    /// Input is still pumped, so hover, press, scroll and resize all keep working
    /// during a long computation on the app thread. What does *not* happen is any
    /// new application state reaching the screen, which is correct — there is none
    /// to read until the writer says so.
    pub fn pump(&mut self) -> Result<(), EngineError> {
        let started = std::time::Instant::now();

        self.pump_input()?;

        // A resize inside `pump_input` sets `fresh`, and a fresh tree has no layout
        // — painting it would blank the window. Same rule as `tick`, minus the diff
        // that cannot exist here.
        if self.fresh {
            self.relayout()?;
            self.needs_paint = true;
        }

        // The hover and press chains, before anything reads a predicate. Here rather
        // than inside `draw` because `advance_animations` below is what notices a slot
        // change and starts a transition — resolving that against last frame's chain
        // would make every hover a frame late. After `resync`, because the chains are
        // walked up `nodes.parent` and a commit can move it.
        self.painter.set_input_chains(&self.tables, &self.state);

        let dt = self.frame_dt();
        self.advance_scrolls(dt);
        self.advance_animations(dt);

        if !self.needs_paint {
            self.last_frame_ms = started.elapsed().as_secs_f32() * 1000.0;
            return Ok(());
        }

        self.draw();
        self.present()?;
        self.needs_paint = false;

        self.frame += 1;
        self.last_frame_ms = started.elapsed().as_secs_f32() * 1000.0;
        Ok(())
    }

    /// How long this frame is, and the one place wall-clock time enters.
    ///
    /// Both advances share it, which is why it is read once here rather than sampled
    /// inside each: two clocks would drift against each other, and neither could be
    /// driven from a test.
    fn frame_dt(&mut self) -> f32 {
        let elapsed = self.last_advance.elapsed().as_secs_f32();
        self.last_advance = std::time::Instant::now();
        self.time_step.unwrap_or(elapsed)
    }

    /// Fixes every subsequent frame's length, or restores the wall clock.
    ///
    /// A non-finite or negative `dt` means "use the clock". That is the whole
    /// signalling convention, and it is one value rather than a pair of calls because
    /// it crosses the FFI: a nullable float would be an out-pointer.
    pub fn set_time_step(&mut self, dt: f32) {
        self.time_step = if dt.is_finite() && dt >= 0.0 {
            Some(dt)
        } else {
            None
        };
    }

    /// Moves every transition and animation `dt` seconds forward.
    ///
    /// Returns whether anything moved, which is what decides the repaint — the same
    /// two-answers-not-one split `advance_scrolls` documents, and for the same reason:
    /// the last frame of a tween moves the pixels and then stops, so conflating
    /// "moved" with "still running" either drops that frame or animates forever.
    ///
    /// `dt` is a parameter rather than read from the clock here, so a frame is
    /// reproducible and a golden can be screenshot at an exact `t`. `tick` stays the
    /// one place wall-clock time enters.
    pub fn advance_animations(&mut self, dt: f32) -> bool {
        // Two disjoint fields of `self`, which is what lets the painter hold `&mut` on
        // its tween state while reading the tables.
        let moved = self
            .painter
            .advance_animations(&self.tables, &self.state, dt);
        if moved {
            self.needs_paint = true;
        }
        moved
    }

    /// Whether any tween is in flight, so a host can tell an idle frame from a live one.
    pub fn animating(&self) -> bool {
        self.painter.animating()
    }

    /// Which global predicates the current surface satisfies.
    ///
    /// Read straight from the media table each time rather than cached against a
    /// size: the table is a handful of rows, and a cache keyed on the window would
    /// have to be invalidated by an upload as well as by a resize.
    fn evaluate_media(&self) -> u32 {
        const MEDIA: usize = protocol::Table::Media as usize;
        let bits = self.tables.u32s(MEDIA, protocol::media::BIT);
        let kinds = self.tables.u8s(MEDIA, protocol::media::KIND);
        let values = self.tables.f32s(MEDIA, protocol::media::VALUE);

        let w = self.width as f32;
        let h = self.height as f32;

        let mut live = 0;
        for i in 0..bits.len().min(kinds.len()).min(values.len()) {
            let bit = bits[i];
            // Spare rows are filled with bit 0, which no condition owns.
            if bit == 0 {
                continue;
            }
            let v = values[i];
            // Inclusive on both sides, as CSS is: at exactly 768 both a
            // `min-width: 768px` and a `max-width: 768px` query hold.
            let holds = match kinds[i] {
                protocol::media_kind::MIN_WIDTH => w >= v,
                protocol::media_kind::MAX_WIDTH => w <= v,
                protocol::media_kind::MIN_HEIGHT => h >= v,
                protocol::media_kind::MAX_HEIGHT => h <= v,
                _ => false,
            };
            if holds {
                live |= bit;
            }
        }
        live
    }

    /// Lays out, publishes the bounds, and reconciles the state layout invalidates.
    ///
    /// One function because there are two callers — a tick and a live resize — and the
    /// second forgetting a step is not a hypothetical: the scroll clamp below was
    /// missing from both, and it took the window blank.
    fn relayout(&mut self) -> Result<(), EngineError> {
        // Media queries are evaluated *here*, between the resize and the layout,
        // which is the whole reason they are engine-side. Routing a resize out to
        // Bun to re-apply styles would lag a frame and stall whenever Bun is busy.
        //
        // Both consumers are updated, and they are different: paint reads globals
        // to pick a style per node, and layout has to be told because a breakpoint
        // that changes `flex-direction` has to produce a different *layout*, not
        // just different colours.
        let globals = self.evaluate_media();
        self.painter.set_globals(globals);
        self.tree.set_globals(&self.tables, globals)?;

        self.tree.compute(
            &self.tables,
            &mut self.measurer,
            self.width as f32,
            self.height as f32,
        )?;
        let bounds = self.tree.bounds().to_vec();
        self.tables.write_bounds(&bounds);
        self.fresh = false;
        self.clamp_scrolls();
        Ok(())
    }

    /// Shortens every scroll offset to what the new layout can actually give.
    ///
    /// A scroll offset deliberately outlives relayout — a box the user scrolled must
    /// stay where they put it across a list edit or a resize, which is what makes it
    /// engine state rather than table state. But *surviving* is not the same as
    /// surviving unchanged: an offset earned when there were 350 px to scroll is not
    /// meaningful in a layout with 100, and translating the content by it anyway walks
    /// the whole subtree off the screen. That was reported as "sometimes it hides all
    /// elements", and it is worst exactly where it is hardest to diagnose: once the
    /// extent reaches 0 no scrollbar is drawn either, so nothing on screen says the
    /// content is merely somewhere else.
    ///
    /// Clamped rather than reset, because reaching for zero would throw away the
    /// position in the common case where the box still scrolls, just less far.
    fn clamp_scrolls(&mut self) {
        for node in 0..self.scroll.len() {
            let offset = self.scroll[node];
            let target = self.scroll_target_of(node);
            if offset == [0.0, 0.0] && target == [0.0, 0.0] {
                continue;
            }
            let extent = self.tree.overflow_of(node);
            let clamp = |v: [f32; 2]| [v[0].clamp(0.0, extent[0]), v[1].clamp(0.0, extent[1])];

            // The target as well as the position, or a glide would immediately pull the
            // content back out to an offset the new layout cannot justify — the same bug,
            // one frame later and much harder to see.
            let clamped_target = clamp(target);
            if clamped_target != target {
                self.scroll_target[node] = clamped_target;
            }
            let clamped = clamp(offset);
            if clamped != offset {
                self.scroll[node] = clamped;
                // The content is about to move without anyone having scrolled it, so
                // the frame on screen is stale even if nothing else changed.
                self.needs_paint = true;
            }
        }
    }

    /// A resize repainted immediately, from inside the OS's own event handling.
    ///
    /// This is what an event watcher calls, and it exists because of a platform
    /// behaviour no threading model can dodge: while the user drags a window edge,
    /// macOS and Windows both run a *nested* modal event loop inside the pump. The
    /// host's `while (running) { tick() }` does not get another turn until the drag
    /// ends, so the window shows a stretched or stale frame for as long as the user
    /// holds the mouse down.
    ///
    /// The roadmap's answer was A0 step 3, an engine-owned render thread. That does
    /// not work: the nested loop blocks whichever thread owns the window, so a
    /// render thread would be stuck behind exactly the same modal loop, and on macOS
    /// it cannot own the window at all. Being *called by* the pump is the only way to
    /// draw during it.
    ///
    /// Layout is recomputed rather than the last frame being rescaled: a resize
    /// changes what the layout *is*, and a stretched bitmap is the artefact this is
    /// meant to remove.
    pub fn resize_and_repaint(&mut self, width: u32, height: u32) -> Result<(), EngineError> {
        self.resize(width, height)?;

        // The third and last place that draws, so the third that needs the chains. A
        // resize does not move the pointer, but `relayout` below can relink the tree the
        // chains were walked from — and a mid-drag repaint is exactly when nobody is
        // watching closely enough to notice a stale highlight.
        self.painter.set_input_chains(&self.tables, &self.state);

        // `resize` set `fresh`, so this is a full relayout — which is the honest
        // cost of a resize, and the advance cache means it is not a re-shape.
        self.relayout()?;

        self.draw();
        self.present()?;
        self.needs_paint = false;
        self.frame += 1;
        Ok(())
    }

    /// Turns a commit's diff into the minimum work Taffy needs.
    ///
    /// The whole point of staging is here: a colour-only theme patch touches no
    /// geometry, so it reaches paint without Taffy hearing about it at all.
    ///
    /// A full rebuild is now reserved for the two cases that genuinely need one
    /// — the first tick, and a capacity change, which appends a fresh larger
    /// arena and so needs ids that do not exist yet. Everything else works from
    /// the changed index set. Before this, *any* link write allocated a new
    /// `TaffyTree` with a leaf per node and pushed a style per node, over table
    /// capacity, for one appended list row.
    fn resync(&mut self, diff: &Diff) -> Result<(), EngineError> {
        // Which nodes could ever animate is a property of the tables, so it is
        // recomputed exactly when they change rather than once per frame — and it has
        // to be, because a node's transition may live only in its `:hover` variant and
        // the watch list is what makes the hover noticeable in the first place.
        //
        // Live tweens are dropped here too: a commit that repointed a node at a
        // different style row is precisely the case where continuing to interpolate
        // towards a remembered row would be interpolating towards someone else's
        // colour.
        if self.fresh || diff.any {
            let nodes = self.tables.capacities().nodes as usize;
            self.painter.rescan_animations(&self.tables, nodes);
        }

        if self.fresh || self.tree.node_count() != self.tables.capacities().nodes as usize {
            self.tree.rebuild(&self.tables, self.root)?;
            self.tree.apply_all_styles(&self.tables)?;
            // `fresh` stays set: it says "this tree has no layout", and `rebuild` is
            // what made that true — it zeroes every bound. Clearing it here is what
            // blanked the window. `tick` then read `fresh` as false, found an empty
            // diff, skipped `compute` entirely, and painted a tree in which every node
            // was a 0x0 box at the origin: no fill, no text, everything rejected by the
            // viewport test, nothing left but the clear colour. Only `relayout` may
            // clear this, because only `relayout` makes it untrue.
            return Ok(());
        }

        if !diff.changed_links.is_empty() {
            self.tree.relink_nodes(&self.tables, &diff.changed_links)?;
        }

        // Restyling is a union rather than a chain of `else if`: one frame can
        // move a node's style pointer *and* change the value of a slot some
        // other node wears, and those are two reasons for the same call rather
        // than two competing ones. The old code took the first branch it
        // matched, and the first branch was "restyle everything".
        let mut restyle = diff.changed_nodes.clone();

        if !diff.changed_styles.is_empty() {
            // Only nodes wearing a changed slot need re-pushing. This scans the
            // `style` column rather than keeping a slot -> nodes index, because a
            // scan over one `u16` column is cheaper than a map that has to be
            // maintained — and it would have to be. `nodes.style` is *not*
            // immutable: a node can be repointed at a different slot at runtime,
            // which is why `changed_nodes` above is a union rather than an
            // alternative. A reverse index would need invalidating on exactly the
            // frames that already do the most work.
            let slots = self
                .tables
                .u16s(protocol::Table::Nodes as usize, protocol::nodes::STYLE);
            let changed = &diff.changed_styles;
            restyle.extend(
                (0..slots.len())
                    .filter(|&i| changed.binary_search(&(slots[i] as u32)).is_ok())
                    .map(|i| i as u32),
            );
        }

        if !restyle.is_empty() {
            restyle.sort_unstable();
            restyle.dedup();
            self.tree.apply_styles_of(&self.tables, &restyle)?;
        }

        // A stale *measurement* has three causes, and they narrow differently.
        let mut stale = diff.changed_texts.clone();
        if diff.string_bytes && diff.changed_strings.is_empty() {
            // Bytes rewritten underneath unchanged `(offset, length)` slots.
            // Nothing points at what moved, so every node with text is suspect.
            let text = self
                .tables
                .i32s(protocol::Table::Nodes as usize, protocol::nodes::TEXT);
            stale.extend((0..text.len()).filter(|&i| text[i] >= 0).map(|i| i as u32));
        } else if !diff.changed_strings.is_empty() {
            let text = self
                .tables
                .i32s(protocol::Table::Nodes as usize, protocol::nodes::TEXT);
            let changed = &diff.changed_strings;
            stale.extend(
                (0..text.len())
                    .filter(|&i| text[i] >= 0 && changed.binary_search(&(text[i] as u32)).is_ok())
                    .map(|i| i as u32),
            );
        }
        for node in stale {
            self.tree.mark_dirty(node as usize);
        }

        Ok(())
    }

    /// The root's own background, or black when it has none.
    ///
    /// Used for both clears — Skia's and the renderer's — so that every surface the
    /// user can see between two of our frames is the colour the app is *supposed* to
    /// be. Black was visible as a flash during a resize, and would have been a much
    /// worse flash on a light theme.
    fn clear_color(&self) -> u32 {
        let styles = protocol::Table::Styles as usize;
        let slot = self
            .tables
            .u16s(protocol::Table::Nodes as usize, protocol::nodes::STYLE)
            .get(self.root)
            .copied()
            .unwrap_or(0) as usize;

        match self
            .tables
            .u32s(styles, protocol::styles::BG)
            .get(slot)
            .copied()
        {
            // A transparent root says nothing about what should be behind it.
            Some(argb) if argb >> 24 != 0 => argb,
            _ => 0xff00_0000,
        }
    }

    fn draw(&mut self) {
        let clear = self.clear_color();
        if let Some(window) = self.window.as_mut() {
            window.set_clear_color(clear);
        }

        // Destructured because the borrows genuinely are disjoint and the compiler
        // cannot see that through `self`: the canvas comes from `&mut surface`, the
        // painter and measurer are `&mut`, and the tables, tree and scroll offsets are
        // shared. Spelling the fields out is the honest way to say so — the
        // alternative is cloning the bounds every frame to dodge a borrow.
        let Self {
            surface,
            painter,
            measurer,
            tables,
            tree,
            scroll,
            state,
            root,
            ..
        } = self;

        let canvas = surface.canvas();
        // Clear first: the root only covers the window if its own background is
        // opaque, and an unpainted frame should not show the last one.
        canvas.clear(Color::from(clear));
        painter.paint(
            canvas,
            tables,
            Geometry {
                bounds: tree.bounds(),
                scroll,
                extent: tree.overflow(),
            },
            state,
            measurer,
            *root,
        );
    }

    fn present(&mut self) -> Result<(), EngineError> {
        if self.window.is_none() {
            return Ok(());
        }
        let Some(pixmap) = self.surface.peek_pixels() else {
            return Err(EngineError::skia("Skia surface has no readable pixels"));
        };
        let row_bytes = pixmap.row_bytes();
        let Some(bytes) = pixmap.bytes() else {
            return Err(EngineError::skia("Skia surface has no readable pixels"));
        };

        // Borrowed separately because `bytes` borrows the surface.
        let window = self.window.as_mut().expect("checked above");
        window.present(bytes, row_bytes)
    }

    /// Drains the platform queue, resolves hits, and records what Bun needs.
    fn pump_input(&mut self) -> Result<(), EngineError> {
        if self.window.is_none() {
            return Ok(());
        }

        // The one re-entrant window in the engine, and it is deliberate.
        //
        // SDL calls event watchers from inside the pump, which is the only moment a
        // frame can be drawn during a live resize (see `resize_and_repaint`). The
        // watcher therefore has to reach this engine while this call is on the
        // stack, so the pointer is parked in a thread-local for exactly the duration
        // of `poll` and cleared after — `Pumping` is an RAII guard so an early
        // return or a panic cannot leave a stale pointer behind.
        //
        // What makes it defensible rather than merely conventional: the parked
        // pointer is only ever readable while this frame is suspended inside
        // `SDL_PumpEvents`, and this frame touches nothing until `poll` returns.
        // Nothing else in the process can reach it — the handle table marks the slot
        // `InCall`, so a re-entrant *host* call is refused rather than aliasing.
        //
        // The rejected alternative is the sound-by-construction one: split `Engine`
        // into `Engine { inner: RefCell<Inner> }`, release the borrow before pumping,
        // and let the watcher take its own. That is the right shape and it is a
        // refactor of every method here, so it is written down (ROADMAP, "Live resize")
        // rather than half-done. Until then this is a raw pointer with a documented
        // invariant, which is what the SDL C API expects of its callers anyway.
        let raw = {
            let _pumping = Pumping::park(self);
            // SAFETY: checked non-none above, and `poll` does not move the window.
            self.window.as_mut().expect("checked").poll()
        };

        if raw.is_empty() {
            return Ok(());
        }

        // Collected before touching `self.tables`, so the borrows do not overlap.
        let mut resize: Option<(u32, u32)> = None;
        let mut queued: Vec<RawInput> = Vec::with_capacity(raw.len());
        for input in raw {
            match input {
                RawInput::Resized { width, height } => resize = Some((width, height)),
                other => queued.push(other),
            }
        }

        if let Some((w, h)) = resize {
            self.resize(w, h)?;
        }

        for input in queued {
            match input {
                RawInput::Quit => self.events.push(Event::of(event_kind::QUIT)),

                // A wheel is handled entirely by the engine: it changes where content
                // sits, which is not something the host authored and not something it
                // needs to hear about. No event is queued, so app code cannot be the
                // thing that makes scrolling feel slow.
                RawInput::Wheel {
                    x,
                    y,
                    dx,
                    dy,
                    shift,
                } => self.wheel(x, y, dx, dy, shift),

                RawInput::MouseMotion { x, y } => self.mouse_move(x, y),
                RawInput::MouseDown { x, y } => self.mouse_down(x, y),
                RawInput::MouseUp { x, y } => self.mouse_up(x, y),

                RawInput::KeyDown { keycode, mods } => self.events.push(Event {
                    kind: event_kind::KEY_DOWN,
                    node: self.state.focused,
                    a: keycode,
                    b: mods as i32,
                    ..Default::default()
                }),

                RawInput::Text { text } => {
                    let mut event = Event {
                        kind: event_kind::TEXT_INPUT,
                        node: self.state.focused,
                        ..Default::default()
                    };
                    let bytes = text.as_bytes();
                    // Truncated on a UTF-8 boundary rather than mid-codepoint: a
                    // split sequence would reach Bun as broken text.
                    let mut n = bytes.len().min(event.text.len());
                    while n > 0 && !text.is_char_boundary(n) {
                        n -= 1;
                    }
                    event.text[..n].copy_from_slice(&bytes[..n]);
                    event.a = n as i32;
                    self.events.push(event);
                }

                RawInput::FocusChanged { focused } => self.events.push(Event {
                    kind: event_kind::FOCUS,
                    a: focused as i32,
                    ..Default::default()
                }),

                RawInput::Resized { .. } => unreachable!("handled above"),
            }
        }

        Ok(())
    }

    /// Grows the tables to hold at least `caps`.
    ///
    /// The Taffy tree is rebuilt on the next tick because the node table moved,
    /// and the host re-reads the descriptor because every pointer did.
    pub fn grow(&mut self, caps: Capacities) -> bool {
        if !self.tables.grow(caps) {
            return false;
        }
        // Grown, not rebuilt: a node keeps its id across growth — that is what
        // append-and-abandon list arenas buy — so a box the user had scrolled must
        // still be scrolled to the same place afterwards.
        self.scroll.resize(caps.nodes as usize, [0.0, 0.0]);
        self.scroll_target.resize(caps.nodes as usize, [0.0, 0.0]);
        self.fresh = true;
        true
    }

    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), EngineError> {
        let width = width.max(1);
        let height = height.max(1);
        if width == self.width && height == self.height {
            return Ok(());
        }

        self.surface = raster_surface(width, height)?;
        if let Some(window) = self.window.as_mut() {
            window.resize(width, height)?;
        }

        self.width = width;
        self.height = height;
        // Intrinsic sizes do not depend on the window, so nothing needs
        // re-measuring — but positions do, so the next tick must arrange.
        self.fresh = true;

        self.events.push(Event {
            kind: event_kind::RESIZE,
            a: width as i32,
            b: height as i32,
            ..Default::default()
        });
        Ok(())
    }

    /// Moves up to `out.len()` events to the host. Returns how many.
    pub fn drain_events(&mut self, out: &mut [Event]) -> usize {
        let n = out.len().min(self.events.len());
        for (slot, event) in out.iter_mut().zip(self.events.drain(..n)) {
            *slot = event;
        }
        n
    }

    pub fn pending_events(&self) -> usize {
        self.events.len()
    }

    /// Headless state overrides, so interaction styles can be verified without a
    /// mouse — the engine-side equivalent of `--hover` and `--focus`.
    pub fn set_input_state(&mut self, hovered: i32, pressed: i32, focused: i32) {
        self.state = InputState {
            hovered,
            pressed,
            focused,
            // A scrollbar hover has no node to name, so there is nothing for these
            // three integers to say about it. Left alone rather than cleared: this
            // override exists to stand in for a mouse, and a screenshot taken with
            // `--hover` should not also decide that no bar is under the cursor.
            bar: self.state.bar,
        };
        self.needs_paint = true;
    }

    pub fn hit_test(&self, x: f32, y: f32) -> i32 {
        // The painter and the state come along because a transform can live in a
        // variant slot: `hover:scale-105` is only visible through the resolved
        // style, and hit-testing the base box would miss exactly the case
        // transforms are most used for.
        hit_test(
            &self.painter,
            &self.tables,
            self.geometry(),
            &self.state,
            self.root,
            x,
            y,
        )
    }

    /// Where a node's content currently sits, `[x, y]`, both >= 0.
    ///
    /// Where it *is*, which is what paint and hit-testing need. Mid-glide this is not
    /// where the last gesture asked it to go — see [`Engine::scroll_target_of`].
    pub fn scroll_of(&self, node: usize) -> [f32; 2] {
        self.scroll.get(node).copied().unwrap_or([0.0, 0.0])
    }

    /// Where a node's content is heading.
    ///
    /// What a gesture reads and writes: a wheel notch adds to the destination, not to the
    /// position, so a burst of notches goes as far as the sum of its parts.
    pub fn scroll_target_of(&self, node: usize) -> [f32; 2] {
        self.scroll_target.get(node).copied().unwrap_or([0.0, 0.0])
    }

    /// Layout rects plus scroll offsets, which every walk needs together.
    fn geometry(&self) -> Geometry<'_> {
        Geometry {
            bounds: self.tree.bounds(),
            scroll: &self.scroll,
            extent: self.tree.overflow(),
        }
    }

    /// The pointer moved to `(x, y)`, in window coordinates.
    ///
    /// A method rather than a match arm because these three are the whole pointer
    /// state machine — drag, then bars, then the tree — and a test has no SDL to ask.
    /// The order is the substance: an overlay bar is drawn on top of content, so
    /// whatever is under it is not what the pointer is on.
    pub fn mouse_move(&mut self, x: f32, y: f32) {
        // A drag owns the pointer: while one is live the cursor means "where the thumb
        // goes" and nothing else, which is what pointer capture buys and why the drag
        // is checked before anything else.
        if self.drag_to(x, y) {
            return;
        }

        // Then the bars, before the tree. An overlay bar is drawn on top of content, so
        // the content under it is not what the pointer is on.
        let bar = self.bar_hover_at(x, y, false);
        if bar != self.state.bar {
            self.state.bar = bar;
            self.needs_paint = true;
        }
        if bar.is_some() {
            // Whatever the bar covers stops being hovered, or a row's hover style
            // would stay lit while the pointer is demonstrably on something else.
            if self.state.hovered != -1 {
                self.state.hovered = -1;
                self.needs_paint = true;
            }
            return;
        }

        let hit = self.hit_test(x, y);
        if hit != self.state.hovered {
            self.state.hovered = hit;
            // A hover is a repaint the host never hears about until it drains, so the
            // engine decides this itself.
            self.needs_paint = true;
            self.events.push(Event {
                kind: event_kind::MOUSE_MOVE,
                node: hit,
                x,
                y,
                ..Default::default()
            });
        }
    }

    /// A wheel or trackpad scroll of `(dx, dy)` notches at `(x, y)`.
    ///
    /// Notches to pixels happens here rather than in `window.rs`, which reports what the
    /// platform said and nothing more.
    ///
    /// Shift turns a vertical wheel sideways. Every desktop platform does this, and with
    /// a plain mouse it is the *only* way to reach a horizontal scroll region — SDL does
    /// not do it for you, and its wheel event does not even carry the modifier.
    ///
    /// Only when the device sent nothing horizontal of its own, which is the part worth
    /// getting right: a trackpad reports both axes, and swapping there would discard a
    /// real `dx` and turn a diagonal gesture into a wrong one.
    pub fn wheel(&mut self, x: f32, y: f32, dx: f32, dy: f32, shift: bool) {
        let (dx, dy) = if shift && dx == 0.0 {
            (dy, 0.0)
        } else {
            (dx, dy)
        };
        self.scroll_at(x, y, dx * WHEEL_NOTCH_PX, dy * WHEEL_NOTCH_PX);
    }

    /// A press at `(x, y)`.
    pub fn mouse_down(&mut self, x: f32, y: f32) {
        // A press on a bar is consumed entirely: no `pressed`, no focus change, and no
        // event for the host. The row under an overlay bar must not be clicked by
        // someone reaching for the thumb.
        if self.press_bar(x, y) {
            return;
        }

        let hit = self.hit_test(x, y);

        // A disabled control receives no button events at all — not a click that gets
        // ignored, no events. Measured, `probes/control-activation.html`: pressing one
        // produced no `mousedown`, no `mouseup` and no `click`, and it never took focus.
        // So the press is dropped here, before anything is recorded.
        //
        // Its *label* is deliberately not covered by this. A label of a disabled
        // control still presses and still joins the `:active` chain; it simply forwards
        // nothing, which `Controls::activate` refuses on its own.
        if self.painter.press_is_swallowed(hit) {
            return;
        }

        // Clicking is the only way to acquire focus for now; keyboard traversal is A3.
        self.state.pressed = hit;
        self.state.focused = hit;
        self.needs_paint = true;
        self.events.push(Event {
            kind: event_kind::MOUSE_DOWN,
            node: hit,
            x,
            y,
            ..Default::default()
        });
    }

    /// A release at `(x, y)`.
    pub fn mouse_up(&mut self, x: f32, y: f32) {
        if self.drag.take().is_some() {
            // The bar keeps its hover if the pointer ended up back on it, and loses it
            // if the drag finished somewhere else.
            self.state.bar = self.bar_hover_at(x, y, false);
            self.needs_paint = true;
            return;
        }

        let hit = self.hit_test(x, y);

        // The other half of "a disabled control receives no button events at all".
        // `mouse_down` has dropped the press since v13, but the *release* was pushed
        // unconditionally at the end of this function, so a host still saw a `MOUSE_UP`
        // over a disabled field — and since a text field had no `controls` row at all
        // until now, a disabled one also took focus and matched no `:disabled` rule.
        //
        // The bookkeeping still runs: returning without clearing `pressed` would leave
        // a stale press that the next release anywhere could complete.
        if self.painter.press_is_swallowed(hit) {
            self.state.pressed = -1;
            self.state.hovered = hit;
            self.needs_paint = true;
            return;
        }

        // A click is press and release on the *same* node, which is what makes
        // dragging off a button cancel it. Measured too: pressing a checkbox and
        // releasing away from it focused the box without ticking it.
        if self.state.pressed != -1 && hit == self.state.pressed {
            // The activation behaviour runs *before* the click event, not after. That
            // ordering is measured rather than chosen: a `mouseup` handler still sees
            // the old checkedness while a `click` handler sees the new one, which is
            // the spec's pre-click activation behaviour. So a host handler reading the
            // state on CLICK reads the state after the flip, as it should.
            let activation = self.painter.activate_control(&self.tables, hit);

            self.events.push(Event {
                kind: event_kind::CLICK,
                node: hit,
                x,
                y,
                ..Default::default()
            });

            if let Some(act) = activation {
                self.needs_paint = true;

                // The second click a browser dispatches at the control when a *label*
                // was what got clicked. Only when the two differ: the forwarding is
                // skipped when the target already is the control, which is measured and
                // is the only thing stopping a wrapping label from acting twice.
                if act.node != hit {
                    self.events.push(Event {
                        kind: event_kind::CLICK,
                        node: act.node,
                        x,
                        y,
                        ..Default::default()
                    });
                }

                // `change` and `click` are not the same event, and the difference is
                // measured: re-clicking an already-checked radio fires `click` and no
                // `change`. A host counting clicks cannot recover that.
                if act.changed {
                    self.events.push(Event {
                        kind: event_kind::CHANGE,
                        node: act.node,
                        a: i32::from(act.checked),
                        x,
                        y,
                        ..Default::default()
                    });
                }
            }
        }
        self.state.pressed = -1;
        self.state.hovered = hit;
        self.needs_paint = true;
        self.events.push(Event {
            kind: event_kind::MOUSE_UP,
            node: hit,
            x,
            y,
            ..Default::default()
        });
    }

    /// A node's two scrollbars, `(horizontal, vertical)`, exactly as this frame draws
    /// them.
    ///
    /// The same call paint and hit-testing make, exposed so a test can assert on the
    /// geometry rather than infer it from pixels — a thumb's thickness is a two-pixel
    /// claim that antialiasing makes miserable to read back.
    pub fn bars_of(&self, node: usize) -> (Option<Bar>, Option<Bar>) {
        self.painter
            .bars_of(&self.tables, self.geometry(), &self.state, node)
    }

    /// What scrollbar is under `(px, py)`, as hover state.
    ///
    /// `held` is the caller's to state rather than something this can know: the same
    /// point means "hovered" after a move and "held" after a press.
    fn bar_hover_at(&self, px: f32, py: f32, held: bool) -> Option<BarHover> {
        self.painter
            .bar_at(
                &self.tables,
                self.geometry(),
                &self.state,
                self.root,
                px,
                py,
            )
            .map(|bar| BarHover {
                node: bar.node,
                vertical: bar.vertical,
                held,
            })
    }

    /// How far `node`'s ancestors have scrolled it, summed.
    ///
    /// A bar's geometry is in its container's unscrolled layout space, so a pointer in
    /// window coordinates has to be moved into that space before it can be compared
    /// against one. The paint and hit-test walks accumulate this on the way down; a
    /// drag has no walk, so it climbs instead.
    ///
    /// Summing every ancestor's offset is right because only a scroll *container* ever
    /// has a non-zero one, and a container always clips — so the set of ancestors that
    /// translate is exactly the set with an offset to add.
    fn ancestor_scroll(&self, node: usize) -> [f32; 2] {
        let mut total = [0.0, 0.0];
        let mut up = self.tree.parent_of(node);
        let mut budget = self.scroll.len() + 1;
        while let Some(parent) = up {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let own = self.scroll_of(parent);
            total[0] += own[0];
            total[1] += own[1];
            up = self.tree.parent_of(parent);
        }
        total
    }

    /// Starts a drag, or pages the track. Returns whether the press was a bar's.
    ///
    /// Two gestures on one target, told apart by where along the bar the press landed.
    /// On the thumb it is a grab, and the grab point is remembered so the thumb does not
    /// jump under the cursor — the single most noticeable way to get a scrollbar wrong.
    /// Elsewhere on the track it is a page, which is the desktop convention and what
    /// Chromium does on the platform this runs on.
    fn press_bar(&mut self, px: f32, py: f32) -> bool {
        let Some(bar) = self.painter.bar_at(
            &self.tables,
            self.geometry(),
            &self.state,
            self.root,
            px,
            py,
        ) else {
            return false;
        };

        let shift = self.ancestor_scroll(bar.node);
        let (at_x, at_y) = (px + shift[0], py + shift[1]);
        let axis = usize::from(bar.vertical);

        if bar.on_thumb(at_x, at_y) {
            let (thumb_start, _) = bar.thumb_span();
            self.drag = Some(BarDrag {
                node: bar.node,
                vertical: bar.vertical,
                grab: bar.along(at_x, at_y) - thumb_start,
            });
        } else {
            // A page, towards the click. `viewport` rather than the thumb's length,
            // because a page is what the user can see, not what the bar happens to
            // show.
            let (thumb_start, thumb_len) = bar.thumb_span();
            let forward = bar.along(at_x, at_y) >= thumb_start + thumb_len;
            let by = if forward { bar.viewport } else { -bar.viewport };
            // From the *target*, so holding a click through several pages accumulates
            // rather than each one restarting from wherever the glide happens to be.
            let mut wanted = self.scroll_target_of(bar.node);
            wanted[axis] = (wanted[axis] + by).clamp(0.0, bar.extent);
            // Glided, unlike a drag: a whole viewport arriving in one frame gives no
            // sense of which direction the content went.
            self.aim_scroll(bar.node, wanted);
        }

        self.state.bar = Some(BarHover {
            node: bar.node,
            vertical: bar.vertical,
            held: true,
        });
        self.needs_paint = true;
        true
    }

    /// Moves a live drag to follow the pointer. Returns whether there was one.
    fn drag_to(&mut self, px: f32, py: f32) -> bool {
        let Some(drag) = self.drag else {
            return false;
        };

        // Re-derived from the current layout rather than remembered from the press: a
        // list can grow under a drag, and a thumb that keeps a stale track walks away
        // from the cursor.
        let (bar_x, bar_y) =
            self.painter
                .bars_of(&self.tables, self.geometry(), &self.state, drag.node);
        let Some(bar) = (if drag.vertical { bar_y } else { bar_x }) else {
            // The bar stopped existing mid-drag — the content shrank to fit. Nothing
            // left to drag, so let go rather than keep applying a dead mapping.
            self.drag = None;
            self.state.bar = None;
            self.needs_paint = true;
            return true;
        };

        let shift = self.ancestor_scroll(drag.node);
        let at = bar.along(px + shift[0], py + shift[1]);
        let mut wanted = self.scroll_of(drag.node);
        wanted[usize::from(drag.vertical)] = bar.offset_at(at - drag.grab);
        self.set_scroll(drag.node, wanted);
        true
    }

    /// Puts a node's content at `to` immediately, with no glide.
    ///
    /// For a drag, and only for a drag. Direct manipulation must track the cursor
    /// exactly: easing a thumb the user is holding adds lag between the mouse and the
    /// thing it is visibly attached to, which reads as the bar being broken rather than
    /// as smoothness. The target moves too, or the glide would fight the hand.
    fn set_scroll(&mut self, node: usize, to: [f32; 2]) {
        if let Some(slot) = self.scroll_target.get_mut(node) {
            *slot = to;
        }
        if let Some(slot) = self.scroll.get_mut(node) {
            if *slot != to {
                *slot = to;
                self.needs_paint = true;
            }
        }
    }

    /// Aims a node's content at `to`, to be glided towards over the next few frames.
    fn aim_scroll(&mut self, node: usize, to: [f32; 2]) {
        if let Some(slot) = self.scroll_target.get_mut(node) {
            if *slot != to {
                *slot = to;
                self.scroll_animating = true;
                self.needs_paint = true;
            }
        }
    }

    /// Moves every offset `dt` seconds closer to its target. Returns whether any moved.
    ///
    /// Exponential approach rather than a fixed-duration tween, for two reasons that both
    /// come from the wheel. A tween has to be restarted on every notch, and notches
    /// arrive in bursts — so a tween either stutters as each one resets the clock, or
    /// needs a queue. And a tween has a *start*, which means a second notch mid-glide
    /// either snaps the origin forward or slows the whole thing down. An exponential
    /// approach has neither: the state is one number, the target can change at any moment,
    /// and the motion stays continuous through it.
    ///
    /// `dt` is a parameter rather than read from the clock here so the motion is
    /// deterministic and testable; `tick` is the one place wall-clock time enters.
    /// Frame-rate independent by construction — `exp(-dt/τ)` composes over any split of
    /// `dt`, which a naive `delta * 0.2` per frame does not.
    pub fn advance_scrolls(&mut self, dt: f32) -> bool {
        if !self.scroll_animating {
            return false;
        }

        // A pathological `dt` — a debugger pause, a first frame — must not overshoot or
        // produce a NaN. `1.0` is already "arrive now" at this time constant.
        let dt = if dt.is_finite() {
            dt.clamp(0.0, 1.0)
        } else {
            1.0
        };
        let step = 1.0 - (-dt / SCROLL_GLIDE_TAU).exp();

        // Two answers, not one: `moving` decides whether to keep animating, `changed`
        // decides whether to repaint. They differ on exactly one frame — the last, which
        // moves the content and then stops — and conflating them either drops that frame
        // or animates forever.
        let mut moving = false;
        let mut changed = false;

        for (current, target) in self.scroll.iter_mut().zip(&self.scroll_target) {
            for axis in 0..2 {
                let delta = target[axis] - current[axis];
                if delta == 0.0 {
                    continue;
                }
                let next = current[axis] + delta * step;
                // Snapped rather than approached forever: an exponential never arrives,
                // and a scroll offset 0.03 px from its target is a repaint every frame for
                // nothing. Tested on where the step *lands* rather than where it started,
                // so the frame that gets within half a pixel is also the frame that
                // finishes — otherwise every glide costs one more frame to travel a
                // distance nothing can display.
                if (target[axis] - next).abs() <= SCROLL_SNAP_PX {
                    current[axis] = target[axis];
                } else {
                    current[axis] = next;
                    moving = true;
                }
                changed = true;
            }
        }

        self.scroll_animating = moving;
        if changed {
            self.needs_paint = true;
        }
        changed
    }

    /// Scrolls the innermost scrollable box under `(px, py)` by `(dx, dy)` pixels.
    ///
    /// Returns whether anything moved, which is what decides a repaint. "Innermost"
    /// and "under the cursor" together are what make nested scroll areas behave: a
    /// list inside a page consumes the wheel, and the page only moves when the list
    /// has nothing left to give.
    ///
    /// A box that cannot move in the requested direction passes the gesture to its
    /// ancestors rather than swallowing it, which is the behaviour every platform
    /// has and the reason this walks *up* from the deepest hit.
    pub fn scroll_at(&mut self, px: f32, py: f32, dx: f32, dy: f32) -> bool {
        let mut node = scrollable_at(&self.tables, self.geometry(), self.root, px, py);

        while let Some(index) = node {
            let extent = self.tree.overflow_of(index);
            // Against the *target*, not the current offset. Notches arrive in bursts, and
            // a second notch has to add to where the content is heading — measuring from
            // where it happens to be mid-glide makes a fast scroll travel less far than a
            // slow one, which is the opposite of what the gesture means.
            //
            // It is also what decides the escape: a box whose target is already pinned at
            // its extent has nothing left to give, however far its content still has to
            // glide, so the gesture belongs to an ancestor.
            let current = self.scroll_target_of(index);
            let wanted = [
                (current[0] + dx).clamp(0.0, extent[0]),
                (current[1] + dy).clamp(0.0, extent[1]),
            ];

            // The bounds check is part of the condition rather than nested inside it: a
            // node past the end of the arrays has nothing to aim, and must fall through
            // to the ancestor walk rather than swallowing the gesture.
            if wanted != current && index < self.scroll_target.len() {
                self.aim_scroll(index, wanted);
                return true;
            }

            // Nothing left in this box: hand the gesture to whatever contains it.
            node = {
                let mut up = self.tree.parent_of(index);
                while let Some(candidate) = up {
                    if is_scrollable(&self.tables, candidate) {
                        break;
                    }
                    up = self.tree.parent_of(candidate);
                }
                up
            };
        }
        false
    }
}

thread_local! {
    /// The engine whose `poll` is running on this thread, or null.
    ///
    /// A thread-local rather than a global: SDL delivers watcher callbacks on the
    /// pumping thread, so this is the narrowest scope that reaches them, and it
    /// cannot be observed by any other thread even in principle.
    static PUMPING: std::cell::Cell<*mut Engine> = const { std::cell::Cell::new(std::ptr::null_mut()) };
}

/// Parks an engine pointer for the duration of one `poll`, and clears it after.
struct Pumping;

impl Pumping {
    fn park(engine: &mut Engine) -> Self {
        PUMPING.set(engine as *mut Engine);
        Self
    }

    /// The engine currently pumping on this thread, for an event watcher.
    ///
    /// # Safety
    /// The caller must be inside a watcher invoked by `SDL_PumpEvents` on this
    /// thread, which is the only context in which the parked pointer is live and the
    /// parking frame is known to be suspended.
    unsafe fn engine() -> Option<&'static mut Engine> {
        let ptr = PUMPING.get();
        if ptr.is_null() {
            return None;
        }
        // SAFETY: the caller's promise, plus `park` only ever storing a pointer to a
        // live engine and clearing it on drop.
        Some(unsafe { &mut *ptr })
    }
}

impl Drop for Pumping {
    fn drop(&mut self) {
        PUMPING.set(std::ptr::null_mut());
    }
}

/// Repaints the engine currently pumping, if a watcher saw a resize.
///
/// Errors are swallowed on purpose: a frame that could not be drawn *during a drag*
/// is a cosmetic loss, and the next `tick` reports the same failure through the
/// normal path where the host can act on it. Returning a status into SDL's event
/// filter would achieve nothing.
pub(crate) fn repaint_pumping_engine(width: u32, height: u32) {
    // SAFETY: called only from the event watcher installed in `Window::new`, which
    // SDL invokes from inside the pump on the pumping thread.
    let Some(engine) = (unsafe { Pumping::engine() }) else {
        return;
    };

    // Coalesced, because a drag delivers a size change every few milliseconds and
    // each one costs a full relayout, a repaint and a texture upload. Drawing every
    // one of them makes dragging *slower* the faster you drag, which is exactly what
    // it looked like: the window falls behind and shows unpainted background.
    //
    // Skipping is safe rather than merely tolerable: SDL also delivers the same size
    // change through `poll`, so `pump_input` resizes and the following `tick` paints
    // the final size regardless. What is dropped here is intermediate frames, which
    // is the correct thing to drop under load.
    if engine.last_live_repaint.elapsed() < LIVE_REPAINT_INTERVAL {
        return;
    }
    engine.last_live_repaint = std::time::Instant::now();
    let _ = engine.resize_and_repaint(width, height);
}

/// Pixels per wheel notch.
///
/// SDL reports wheel deltas in notches, not pixels, so somebody has to choose. 48 is
/// three 16px lines, which is what Windows defaults to and close enough to what a
/// browser does that a trackpad feels ordinary. A trackpad sends fractional notches,
/// so this multiplies rather than steps.
const WHEEL_NOTCH_PX: f32 = 48.0;

/// The glide's time constant, in seconds: how long to cover 63% of the remaining gap.
///
/// 70 ms is short enough that a single notch feels like a response rather than an
/// animation, and long enough that a burst of notches reads as one continuous movement.
/// Chromium's own wheel smoothing is in the same range. Raising it makes scrolling feel
/// heavy and laggy well before it looks smoother.
const SCROLL_GLIDE_TAU: f32 = 0.07;

/// How close counts as arrived.
///
/// Half a pixel is below what anything can show, and an exponential approach never
/// arrives on its own — without this, every scrolled box repaints forever.
const SCROLL_SNAP_PX: f32 = 0.5;

/// One frame at 60 Hz. A drag is a continuous gesture, so there is nothing to gain
/// from painting faster than the display, and a great deal to lose: at 1040x560 a
/// frame is ~4 ms, so an uncapped watcher can spend the whole drag repainting.
const LIVE_REPAINT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);

/// The CPU raster surface every frame is painted into.
///
/// Not `surfaces::raster_n32_premul`, which is the same thing with default surface
/// properties — and the default pixel geometry is `Unknown`, which silently turns
/// subpixel text off. `Font::set_edging(SubpixelAntiAlias)` is a *request*: the
/// device decides, and a device that does not know its subpixel layout correctly
/// refuses to guess and falls back to greyscale. So the two-line font change on its
/// own changed nothing, which a test caught by looking for coloured glyph edges and
/// finding 485 lit pixels and none.
///
/// `RGBH` is the near-universal desktop LCD layout and what Windows assumes by
/// default. It is a claim about the *display*, so it is wrong on a BGR or vertical
/// panel — the same bet ClearType makes, and the reason a future translucent or
/// rotated-display path has to fall back to `Edging::AntiAlias` rather than change
/// this.
fn raster_surface(width: u32, height: u32) -> Result<Surface, EngineError> {
    let info = ImageInfo::new_n32_premul((width as i32, height as i32), None);
    let props = SurfaceProps::new(SurfacePropsFlags::default(), PixelGeometry::RGBH);
    surfaces::raster(&info, None, Some(&props)).ok_or_else(|| {
        EngineError::skia(format!(
            "Skia could not allocate a {width}x{height} raster surface"
        ))
    })
}

fn read_title(config: &EngineConfig) -> String {
    if config.title.is_null() || config.title_len == 0 {
        return "dziri".to_string();
    }
    // SAFETY: the host promises `title_len` readable bytes at `title`. It is
    // copied immediately, so nothing outlives the call.
    let bytes = unsafe { std::slice::from_raw_parts(config.title, config.title_len as usize) };
    String::from_utf8_lossy(bytes).into_owned()
}
