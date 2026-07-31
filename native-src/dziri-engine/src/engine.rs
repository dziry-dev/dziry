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

use skia_safe::{surfaces, Color, Surface};

use crate::layout::LayoutTree;
use crate::paint::{hit_test, InputState, Painter};
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
    pub list_capacity: u32,
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
    /// The most recently encoded PNG, waiting to be copied out.
    png: Vec<u8>,
}

impl Engine {
    pub fn new(config: &EngineConfig) -> Result<Self, String> {
        if config.protocol_version != protocol::PROTOCOL_VERSION {
            return Err(format!(
                "protocol mismatch: the host speaks v{}, this engine speaks v{}",
                config.protocol_version,
                protocol::PROTOCOL_VERSION
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
            lists: config.list_capacity.max(1),
            strings: config.string_capacity.max(1),
            string_bytes: config.string_bytes.max(1),
        };

        let surface = surfaces::raster_n32_premul((width as i32, height as i32))
            .ok_or_else(|| format!("Skia could not allocate a {width}x{height} raster surface"))?;

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
    pub fn tick(&mut self) -> Result<(), String> {
        let started = std::time::Instant::now();

        // Input first, so a click staged by Bun last frame and a click arriving
        // this frame are never resolved against different layouts.
        self.pump_input()?;

        let diff = self.tables.commit();
        self.resync(&diff)?;

        if self.fresh || diff.any {
            self.tree
                .compute(&self.tables, &mut self.measurer, self.width as f32, self.height as f32)?;
            let bounds = self.tree.bounds().to_vec();
            self.tables.write_bounds(&bounds);
            self.fresh = false;
            self.needs_paint = true;
        }

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

    /// Turns a commit's diff into the minimum work Taffy needs.
    ///
    /// The whole point of staging is here: a colour-only theme patch touches no
    /// geometry, so it reaches paint without Taffy hearing about it at all.
    fn resync(&mut self, diff: &Diff) -> Result<(), String> {
        if self.fresh || diff.structure || self.tree.node_count() != self.tables.capacities().nodes as usize {
            self.tree.rebuild(&self.tables, self.root)?;
            self.tree.apply_all_styles(&self.tables)?;
            self.fresh = false;
            return Ok(());
        }

        if diff.node_styles {
            // Which node points where changed; every node's style is suspect.
            self.tree.apply_all_styles(&self.tables)?;
        } else if diff.styles && !diff.changed_styles.is_empty() {
            // Only nodes wearing a changed slot need re-pushing. `nodes.style` is
            // immutable by design, so this is a scan rather than a lookup — and a
            // scan over one `u16` column is cheaper than a map that has to be
            // maintained.
            let slots = self.tables.u16s(
                protocol::Table::Nodes as usize,
                protocol::nodes::STYLE,
            );
            let changed = &diff.changed_styles;
            let affected: Vec<usize> = (0..slots.len())
                .filter(|&i| changed.binary_search(&(slots[i] as u32)).is_ok())
                .collect();
            for node in affected {
                self.tree.apply_style(&self.tables, node)?;
            }
        }

        if diff.text {
            // A changed string has a changed advance width, so its node needs
            // re-measuring — and nothing else does.
            let text = self
                .tables
                .i32s(protocol::Table::Nodes as usize, protocol::nodes::TEXT);
            let changed = &diff.changed_strings;
            let stale: Vec<usize> = (0..text.len())
                .filter(|&i| {
                    let slot = text[i];
                    slot >= 0 && (changed.is_empty() || changed.binary_search(&(slot as u32)).is_ok())
                })
                .collect();
            for node in stale {
                self.tree.mark_dirty(node);
            }
        }

        Ok(())
    }

    fn draw(&mut self) {
        let canvas = self.surface.canvas();
        // Clear first: the root only covers the window if its own background is
        // opaque, and an unpainted frame should not show the last one.
        canvas.clear(Color::BLACK);
        self.painter.paint(
            canvas,
            &self.tables,
            self.tree.bounds(),
            &self.state,
            &mut self.measurer,
            self.root,
        );
    }

    fn present(&mut self) -> Result<(), String> {
        if self.window.is_none() {
            return Ok(());
        }
        let Some(pixmap) = self.surface.peek_pixels() else {
            return Err("Skia surface has no readable pixels".into());
        };
        let row_bytes = pixmap.row_bytes();
        let Some(bytes) = pixmap.bytes() else {
            return Err("Skia surface has no readable pixels".into());
        };

        // Borrowed separately because `bytes` borrows the surface.
        let window = self.window.as_mut().expect("checked above");
        window.present(bytes, row_bytes)
    }

    /// Drains the platform queue, resolves hits, and records what Bun needs.
    fn pump_input(&mut self) -> Result<(), String> {
        let Some(window) = self.window.as_mut() else {
            return Ok(());
        };

        let raw = window.poll();
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

                RawInput::MouseMotion { x, y } => {
                    let hit = hit_test(&self.tables, self.tree.bounds(), self.root, x, y);
                    if hit != self.state.hovered {
                        self.state.hovered = hit;
                        // A hover is a repaint the host never hears about until
                        // it drains, so the engine decides this itself.
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

                RawInput::MouseDown { x, y } => {
                    let hit = hit_test(&self.tables, self.tree.bounds(), self.root, x, y);
                    // Clicking is the only way to acquire focus for now;
                    // keyboard traversal is A3.
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

                RawInput::MouseUp { x, y } => {
                    let hit = hit_test(&self.tables, self.tree.bounds(), self.root, x, y);
                    // A click is press and release on the *same* node, which is
                    // what makes dragging off a button cancel it.
                    if self.state.pressed != -1 && hit == self.state.pressed {
                        self.events.push(Event {
                            kind: event_kind::CLICK,
                            node: hit,
                            x,
                            y,
                            ..Default::default()
                        });
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
        self.fresh = true;
        true
    }

    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        let width = width.max(1);
        let height = height.max(1);
        if width == self.width && height == self.height {
            return Ok(());
        }

        self.surface = surfaces::raster_n32_premul((width as i32, height as i32))
            .ok_or_else(|| format!("Skia could not allocate a {width}x{height} raster surface"))?;
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
        };
        self.needs_paint = true;
    }

    pub fn hit_test(&self, x: f32, y: f32) -> i32 {
        hit_test(&self.tables, self.tree.bounds(), self.root, x, y)
    }
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
