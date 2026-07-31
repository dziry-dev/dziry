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

use sdl3::event::{Event as SdlEvent, WindowEvent};
use sdl3::mouse::MouseButton;
use sdl3::pixels::PixelFormat;
use sdl3::render::{Texture, TextureCreator, WindowCanvas};
use sdl3::video::WindowContext;
use sdl3::{EventPump, Sdl, VideoSubsystem};

use crate::error::EngineError;

/// Input as the platform reports it, before the engine decides what it means.
#[derive(Debug, Clone)]
pub enum RawInput {
    Quit,
    Resized { width: u32, height: u32 },
    MouseMotion { x: f32, y: f32 },
    MouseDown { x: f32, y: f32 },
    MouseUp { x: f32, y: f32 },
    /// `mods` is SDL's modifier bitmask. Without it a host cannot tell `A` from
    /// `Ctrl-A`, which makes every shortcut unimplementable.
    KeyDown { keycode: i32, mods: u16 },
    Text { text: String },
    /// The window gained or lost keyboard focus; a caret should stop blinking.
    FocusChanged { focused: bool },
}

pub struct Window {
    _sdl: Sdl,
    _video: VideoSubsystem,
    events: EventPump,
    canvas: WindowCanvas,
    creator: TextureCreator<WindowContext>,
    texture: Texture,
    width: u32,
    height: u32,
}

impl Window {
    pub fn new(title: &str, width: u32, height: u32, decorated: bool) -> Result<Self, EngineError> {
        let sdl = sdl3::init().map_err(|e| EngineError::sdl(format!("SDL_Init: {e}")))?;
        let video = sdl.video().map_err(|e| EngineError::sdl(format!("SDL video subsystem: {e}")))?;

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

        let events = sdl.event_pump().map_err(|e| EngineError::sdl(format!("SDL event pump: {e}")))?;

        Ok(Self {
            _sdl: sdl,
            _video: video,
            events,
            canvas,
            creator,
            texture,
            width,
            height,
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
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), EngineError> {
        if width == 0 || height == 0 || (width == self.width && height == self.height) {
            return Ok(());
        }
        let texture = self
            .creator
            .create_texture_streaming(PixelFormat::ARGB8888, width, height)
            .map_err(|e| EngineError::sdl(format!("SDL_CreateTexture on resize: {e}")))?;

        let old = std::mem::replace(&mut self.texture, texture);
        // `unsafe_textures` trades the borrow checker's help for a texture with
        // no lifetime, which is what lets the canvas and the texture live in the
        // same struct. The cost is this line.
        unsafe { old.destroy() };

        self.width = width;
        self.height = height;
        Ok(())
    }

    pub fn present(&mut self, pixels: &[u8], pitch: usize) -> Result<(), EngineError> {
        self.texture
            .update(None, pixels, pitch)
            .map_err(|e| EngineError::sdl(format!("SDL_UpdateTexture: {e}")))?;

        self.canvas.clear();
        self.canvas
            .copy(&self.texture, None, None)
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
                    WindowEvent::FocusGained => {
                        out.push(RawInput::FocusChanged { focused: true })
                    }
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
