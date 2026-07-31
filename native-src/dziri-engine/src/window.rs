//! SDL3 window, event pump, and presenting a CPU raster frame.
//!
//! Deliberately knows nothing about Skia: it takes bytes and a pitch. That keeps
//! the headless path — which has no window at all — from having to pretend.
//!
//! # Why SDL3 rather than winit
//!
//! winit links statically, which is a real distribution win, but its IME is
//! documented as unstable for CJK. Static linking is an optimisation; CJK users
//! unable to type is a catastrophe, and it is invisible from a machine that only
//! types Latin. SDL is built from source and linked statically here anyway, so
//! most of winit's advantage is recovered.
//!
//! # Pixel format
//!
//! Skia's `n32` is BGRA_8888 on little-endian, which is byte-identical to SDL's
//! packed `ARGB8888`. So presenting is a straight upload with no swizzle — the
//! same property the TypeScript runtime relied on.

use sdl3::event::{Event as SdlEvent, EventWatch, EventWatchCallback, WindowEvent};
use sdl3::keyboard::Mod;
use sdl3::mouse::MouseButton;
use sdl3::pixels::{Color as SdlColor, PixelFormat};
use sdl3::rect::Rect;
use sdl3::render::FRect;
use sdl3::render::{Texture, TextureCreator, WindowCanvas};
use sdl3::video::WindowContext;
use sdl3::{EventPump, Sdl, VideoSubsystem};

use crate::error::EngineError;

/// Input as the platform reports it, before the engine decides what it means.
#[derive(Debug, Clone)]
pub enum RawInput {
    Quit,
    Resized {
        width: u32,
        height: u32,
    },
    MouseMotion {
        x: f32,
        y: f32,
    },
    /// A wheel or trackpad scroll, with the cursor position it happened at.
    ///
    /// The position matters as much as the delta: which box scrolls is decided by
    /// what is under the pointer, not by what has focus.
    Wheel {
        x: f32,
        y: f32,
        dx: f32,
        dy: f32,
        /// Whether shift was held, which every platform reads as "scroll sideways".
        ///
        /// Reported rather than applied here: SDL's wheel event carries no modifier
        /// state at all, so this comes from a separate `SDL_GetModState` query, and what
        /// to *do* about it is the engine's policy — the same division that keeps
        /// notches-to-pixels out of this file.
        shift: bool,
    },
    MouseDown {
        x: f32,
        y: f32,
    },
    MouseUp {
        x: f32,
        y: f32,
    },
    /// `mods` is SDL's modifier bitmask. Without it a host cannot tell `A` from
    /// `Ctrl-A`, which makes every shortcut unimplementable.
    KeyDown {
        keycode: i32,
        mods: u16,
    },
    Text {
        text: String,
    },
    /// The window gained or lost keyboard focus; a caret should stop blinking.
    FocusChanged {
        focused: bool,
    },
}

/// How coarsely the upload texture is sized. See `Window::resize`.
const TEXTURE_GRID: u32 = 256;

/// The narrowest the OS will let the user drag the window.
///
/// 564 is Chrome's own floor on Windows, which is a better source than a round number:
/// it is the width a browser team settled on for "a page still works here", and dziri's
/// layouts are the same shape as pages. Below it a card grid becomes a column of clipped
/// words, and the resulting bug reports are about the layout rather than the size.
const MIN_WINDOW_WIDTH: u32 = 564;

/// And a floor on height, which no browser publishes. This one is chosen: two rows of
/// cards plus chrome, i.e. enough that a vertical scrollbar has somewhere to be.
const MIN_WINDOW_HEIGHT: u32 = 320;

fn round_up(n: u32, to: u32) -> u32 {
    n.div_ceil(to) * to
}

/// Forwards a resize seen mid-pump to the engine that is pumping.
///
/// Deliberately stateless. The engine cannot be captured here — the callback has to
/// be `Send + 'static`, and the engine is neither — so it is fetched from the
/// thread-local the pump parks it in. That also means the watcher is inert whenever
/// nothing is pumping, which is what makes a stray SDL event harmless.
struct ResizeWatch;

impl EventWatchCallback for ResizeWatch {
    fn callback(&mut self, event: SdlEvent) {
        // `PixelSizeChanged` rather than `Resized`: on HiDPI the two differ, and the
        // surface is measured in pixels. `Exposed` is *not* handled — it fires for
        // occlusion too, and repainting on it would relayout on every window that
        // passes over this one.
        if let SdlEvent::Window {
            win_event: WindowEvent::PixelSizeChanged(width, height),
            ..
        } = event
        {
            if width > 0 && height > 0 {
                crate::engine::repaint_pumping_engine(width as u32, height as u32);
            }
        }
    }
}

pub struct Window {
    /// Kept for `SDL_GetModState`, which a wheel needs and its event does not carry.
    sdl: Sdl,
    _video: VideoSubsystem,
    /// Removed from SDL when this is dropped, so it must outlive the window.
    _resize_watch: EventWatch<ResizeWatch>,
    events: EventPump,
    canvas: WindowCanvas,
    creator: TextureCreator<WindowContext>,
    texture: Texture,
    /// The window, in pixels.
    width: u32,
    height: u32,
    /// The texture, which is allowed to be larger than the window — see `resize`.
    texture_width: u32,
    texture_height: u32,
}

impl Window {
    pub fn new(title: &str, width: u32, height: u32, decorated: bool) -> Result<Self, EngineError> {
        let sdl = sdl3::init().map_err(|e| EngineError::sdl(format!("SDL_Init: {e}")))?;
        let video = sdl
            .video()
            .map_err(|e| EngineError::sdl(format!("SDL video subsystem: {e}")))?;

        let mut builder = video.window(title, width, height);
        builder.position_centered().resizable();
        // Window chrome has to be decided when the window is created — macOS
        // traffic lights, Windows DWM dark title bars and Linux CSD all hang off
        // it, and none can be changed afterwards without recreating the window.
        if !decorated {
            builder.borderless();
        }

        let mut window = builder
            .build()
            .map_err(|e| EngineError::sdl(format!("SDL_CreateWindow: {e}")))?;

        // A floor on the window, not on the layout. Below this every app is a column of
        // clipped words, and letting the user drag there produces bug reports about the
        // layout rather than about the size — a narrow window is a real case worth
        // supporting, an 80 px one is not.
        //
        // The OS enforces it, so no code here has to defend against a smaller surface.
        window
            .set_minimum_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
            .map_err(|e| EngineError::sdl(format!("SDL_SetWindowMinimumSize: {e}")))?;

        // Without this SDL delivers **no** `TextInput` events at all — not for
        // IME composition and not for plain Latin keys either. The event arm in
        // `poll` was written and has never once fired, so typing into an editable
        // has been broken since the engine landed.
        //
        // It also matters more than it looks: SDL3 over winit was chosen *because*
        // of IME, and this is the call that turns IME on. Until now the argument
        // that decided the windowing dependency was completely unexercised.
        //
        // `SDL_SetTextInputArea` (where the candidate window is drawn) needs the
        // focused editable's rect, which the engine knows only after layout — that
        // belongs in A5 with the caret, and is the remaining half of real IME.
        video.text_input().start(&window);

        let canvas = window.into_canvas();
        let creator = canvas.texture_creator();
        // On the same grid `resize` uses, so the first resize does not reallocate a
        // texture that was already big enough.
        let texture_width = round_up(width, TEXTURE_GRID);
        let texture_height = round_up(height, TEXTURE_GRID);
        let texture = creator
            .create_texture_streaming(PixelFormat::ARGB8888, texture_width, texture_height)
            .map_err(|e| EngineError::sdl(format!("SDL_CreateTexture: {e}")))?;

        let events = sdl
            .event_pump()
            .map_err(|e| EngineError::sdl(format!("SDL event pump: {e}")))?;

        // Draw *during* a live resize, not after it.
        //
        // While the user drags a window edge, macOS and Windows both run a nested
        // modal event loop inside the pump: `poll` does not return, so the host's
        // frame loop gets no turn and the window shows a stretched or stale frame
        // until the mouse comes up. An event watcher is called from inside that
        // nested loop, which makes it the only place a frame can come from.
        //
        // The watcher is kept alive by living in this struct — dropping the handle
        // removes it from SDL — and it does nothing except forward the new size to
        // the engine that is currently pumping. That indirection is what keeps this
        // file free of engine internals.
        let event_subsystem = sdl
            .event()
            .map_err(|e| EngineError::sdl(format!("SDL event subsystem: {e}")))?;
        let resize_watch = event_subsystem.add_event_watch(ResizeWatch);

        Ok(Self {
            sdl,
            _video: video,
            _resize_watch: resize_watch,
            events,
            canvas,
            creator,
            texture,
            width,
            height,
            texture_width,
            texture_height,
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// The window's size in *pixels*, which is not its size in points on a HiDPI
    /// display. Polled rather than trusted from a resize event, so one fewer
    /// constant has to be right — the same call the TypeScript host made.
    pub fn size_in_pixels(&self) -> (u32, u32) {
        self.canvas.window().size_in_pixels()
    }

    /// Reallocates the upload texture. The caller owns resizing its own surface.
    /// The colour the renderer clears to.
    ///
    /// Set from the root's own background, because this colour is what the user sees
    /// in any frame that is not ours: the moment after a resize when the OS has
    /// enlarged the window and we have not presented yet, and whatever DWM or the
    /// compositor decides to fill with during a drag. It defaulted to black, which
    /// is why a resize flashed black on a dark app and would have flashed black on a
    /// light one.
    pub fn set_clear_color(&mut self, argb: u32) {
        self.canvas.set_draw_color(SdlColor::RGB(
            ((argb >> 16) & 0xff) as u8,
            ((argb >> 8) & 0xff) as u8,
            (argb & 0xff) as u8,
        ));
    }

    /// Grows the upload texture. The caller owns resizing its own surface.
    ///
    /// Grow-only, and deliberately: a live resize delivers a size change every few
    /// milliseconds, and destroying plus recreating a texture that often is both an
    /// allocation per frame and a window in which the renderer has no texture to
    /// present — which is what the black flash during a drag actually was. The
    /// texture is therefore allowed to be *larger* than the window, and `present`
    /// uploads and copies only the used rectangle.
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), EngineError> {
        if width == 0 || height == 0 {
            return Ok(());
        }
        self.width = width;
        self.height = height;

        // Rounded to a coarse grid rather than to a power of two. A power of two
        // sounds free and is not: a maximized 1920x1080 window rounds to 2048x2048,
        // which is 16.8 MB of texture for 8.3 MB of pixels, and the height nearly
        // doubles. A 256-pixel grid costs 2048x1280 — 10.5 MB — and a drag still
        // crosses a boundary only every 256 pixels.
        let texture_width = round_up(width, TEXTURE_GRID);
        let texture_height = round_up(height, TEXTURE_GRID);

        let too_small = width > self.texture_width || height > self.texture_height;
        // Shrink as well as grow, or restoring a maximized window keeps its texture
        // for the rest of the process. Only when it is *far* too big, so ordinary
        // dragging never trips it.
        let far_too_big =
            self.texture_width >= texture_width * 2 || self.texture_height >= texture_height * 2;
        if !too_small && !far_too_big {
            return Ok(());
        }

        let texture = self
            .creator
            .create_texture_streaming(PixelFormat::ARGB8888, texture_width, texture_height)
            .map_err(|e| EngineError::sdl(format!("SDL_CreateTexture on resize: {e}")))?;

        let old = std::mem::replace(&mut self.texture, texture);
        // `unsafe_textures` trades the borrow checker's help for a texture with
        // no lifetime, which is what lets the canvas and the texture live in the
        // same struct. The cost is this line.
        unsafe { old.destroy() };

        self.texture_width = texture_width;
        self.texture_height = texture_height;
        Ok(())
    }

    pub fn present(&mut self, pixels: &[u8], pitch: usize) -> Result<(), EngineError> {
        // Only the window-sized rectangle, since the texture may be larger. The
        // copy takes float rects and the upload takes integer ones, hence both.
        let used = Rect::new(0, 0, self.width, self.height);
        let used_f = FRect::new(0.0, 0.0, self.width as f32, self.height as f32);
        self.texture
            .update(Some(used), pixels, pitch)
            .map_err(|e| EngineError::sdl(format!("SDL_UpdateTexture: {e}")))?;

        self.canvas.clear();
        self.canvas
            .copy(&self.texture, Some(used_f), None)
            .map_err(|e| EngineError::sdl(format!("SDL_RenderTexture: {e}")))?;
        self.canvas.present();
        Ok(())
    }

    /// Drains the platform queue. Returns what happened, in order.
    pub fn poll(&mut self) -> Vec<RawInput> {
        let mut out = Vec::new();
        for event in self.events.poll_iter() {
            match event {
                SdlEvent::Quit { .. } => out.push(RawInput::Quit),

                SdlEvent::Window { win_event, .. } => match win_event {
                    WindowEvent::PixelSizeChanged(w, h) | WindowEvent::Resized(w, h) => {
                        out.push(RawInput::Resized {
                            width: w.max(0) as u32,
                            height: h.max(0) as u32,
                        })
                    }
                    WindowEvent::FocusGained => out.push(RawInput::FocusChanged { focused: true }),
                    WindowEvent::FocusLost => out.push(RawInput::FocusChanged { focused: false }),
                    WindowEvent::CloseRequested => out.push(RawInput::Quit),
                    _ => {}
                },

                SdlEvent::MouseMotion { x, y, .. } => out.push(RawInput::MouseMotion { x, y }),

                // SDL reports wheel deltas in *notches*, positive up and right, and
                // separately reports where the pointer was. Converting notches to
                // pixels is a policy decision, so it belongs in the engine rather
                // than here — this layer says what the platform said.
                //
                // `y` is negated so positive means "content moves up", which is what
                // a scroll offset counts.
                SdlEvent::MouseWheel {
                    x,
                    y,
                    mouse_x,
                    mouse_y,
                    ..
                } => out.push(RawInput::Wheel {
                    x: mouse_x,
                    y: mouse_y,
                    dx: -x,
                    dy: -y,
                    // Queried now rather than tracked from key events: SDL's wheel event
                    // has no modifier field, and a shift press that arrived while the
                    // window was not focused would never have been seen. `SDL_GetModState`
                    // is the platform's own answer and cannot drift out of sync.
                    shift: self
                        .sdl
                        .keyboard()
                        .mod_state()
                        .intersects(Mod::LSHIFTMOD | Mod::RSHIFTMOD),
                }),

                SdlEvent::MouseButtonDown {
                    mouse_btn: MouseButton::Left,
                    x,
                    y,
                    ..
                } => out.push(RawInput::MouseDown { x, y }),

                SdlEvent::MouseButtonUp {
                    mouse_btn: MouseButton::Left,
                    x,
                    y,
                    ..
                } => out.push(RawInput::MouseUp { x, y }),

                SdlEvent::KeyDown {
                    keycode: Some(code),
                    keymod,
                    ..
                } => out.push(RawInput::KeyDown {
                    // SDL keycodes are Unicode scalar values for printable keys
                    // and masked scancodes above that, so `u32` is the honest
                    // width and `i32` is what crosses the boundary.
                    keycode: code.to_ll().0 as i32,
                    mods: keymod.bits(),
                }),

                SdlEvent::TextInput { text, .. } => out.push(RawInput::Text { text }),

                _ => {}
            }
        }
        out
    }
}

// No `Drop` for the texture: SDL destroys a renderer's textures with the
// renderer, and `destroy` is documented as undefined behaviour once the parent
// canvas is gone. Dropping the canvas is the correct teardown, and `resize` is
// the one place a texture is orphaned early enough to destroy by hand.
