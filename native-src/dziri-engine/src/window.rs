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
    _sdl: Sdl,
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

        let window = builder
            .build()
            .map_err(|e| EngineError::sdl(format!("SDL_CreateWindow: {e}")))?;

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
        let texture = creator
            .create_texture_streaming(PixelFormat::ARGB8888, width, height)
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
            _sdl: sdl,
            _video: video,
            _resize_watch: resize_watch,
            events,
            canvas,
            creator,
            texture,
            width,
            height,
            texture_width: width,
            texture_height: height,
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

        if width <= self.texture_width && height <= self.texture_height {
            return Ok(());
        }

        // Grow past what was asked for, so dragging an edge outward does not
        // reallocate on every pixel.
        let texture_width = width.max(self.texture_width).next_power_of_two();
        let texture_height = height.max(self.texture_height).next_power_of_two();

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
