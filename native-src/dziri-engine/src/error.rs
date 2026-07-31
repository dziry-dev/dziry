//! The boundary's failure story.
//!
//! A Rust panic unwinds past the FFI frame into Bun's C++ stack, which is
//! undefined behaviour and in practice a process abort — Bun reports nothing,
//! so a bad grid definition looks like the app vanishing. Every entry point
//! therefore runs inside [`guard`], which catches the unwind, records a message,
//! and returns a status code.
//!
//! Two things follow that are easy to get wrong:
//!
//! - **`catch_unwind` needs `UnwindSafe`, and `&mut Engine` is not.** Asserting
//!   it is only honest if the observer cannot then read half-updated state, so a
//!   caught panic *poisons* the engine and every later call fails fast with
//!   `POISONED`. See [`crate::engine::Engine::poisoned`].
//! - **The payload has no location.** `catch_unwind` hands back the panic value,
//!   not the file and line, so a hook records those into a thread-local before
//!   the unwind starts.

use std::cell::RefCell;
use std::panic::{self, AssertUnwindSafe};
use std::sync::Once;

pub use crate::protocol::status;

thread_local! {
    /// Detail for the most recent failure on this thread. Read by
    /// `dziri_last_error`, cleared by the next successful call that sets it.
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };

    /// Written by the panic hook, consumed by [`guard`].
    static LAST_PANIC: RefCell<Option<String>> = const { RefCell::new(None) };
}

static HOOK: Once = Once::new();

/// Installs a panic hook that records the message *and* its source location.
///
/// This replaces the process-wide Rust hook, which is fine: a `cdylib` links its
/// own copy of `std`, so this hook only sees panics raised inside the engine.
pub fn install_hook() {
    HOOK.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "<unknown location>".into());

            let message = payload_message(info.payload());
            LAST_PANIC.with(|slot| {
                *slot.borrow_mut() = Some(format!("panic at {location}: {message}"));
            });

            // Still print, because a panic is a bug in the engine and a silent
            // one is worse than a noisy one.
            previous(info);
        }));
    });
}

fn payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

/// A failure, carrying the category as well as the words.
///
/// Internal fallible operations used to return `Result<_, String>`, which says
/// what happened and not what kind of thing it was — so each FFI entry point had
/// to pick one status for every path beneath it, and the picks were wrong for
/// most of them. `tick()` reported `LAYOUT` whether Taffy refused a tree, Skia
/// failed to allocate a surface, or SDL failed to upload a texture; `resize()`
/// reported `SDL` even when it was Skia that ran out of memory.
///
/// The detail stays a `String` deliberately. It is only ever read by a human
/// through `dziri_last_error`, and an error hierarchy would buy nothing across
/// an `i32` boundary. What has to travel is the *category*, because the status
/// code is the host's only machine-readable signal and it is the thing a host
/// would key recovery on — retry a resize on `SDL`, surface a driver message on
/// `SKIA`, refuse to render on `LAYOUT`.
///
/// There is deliberately no `From<String>`: a conversion would let a call site
/// skip choosing, which is the habit this replaces.
#[derive(Debug, Clone)]
pub struct EngineError {
    /// One of [`status`]. Never `OK`.
    pub status: i32,
    pub detail: String,
}

impl EngineError {
    pub fn new(status: i32, detail: impl Into<String>) -> Self {
        Self { status, detail: detail.into() }
    }

    /// Skia refused: surface allocation, encoding, no readable pixels.
    pub fn skia(detail: impl Into<String>) -> Self {
        Self::new(status::SKIA, detail)
    }

    /// SDL refused: window, texture, renderer, event pump.
    pub fn sdl(detail: impl Into<String>) -> Self {
        Self::new(status::SDL, detail)
    }

    /// Taffy refused, or the host-written tree is not one.
    pub fn layout(detail: impl Into<String>) -> Self {
        Self::new(status::LAYOUT, detail)
    }

    /// A request that does not fit, or an index outside the tables.
    pub fn capacity(detail: impl Into<String>) -> Self {
        Self::new(status::CAPACITY, detail)
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for EngineError {}

/// Records the detail behind a failure status.
pub fn set_error(message: impl Into<String>) {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = message.into());
}

/// Records `message` and returns `code`, so call sites read as one expression.
pub fn fail(code: i32, message: impl Into<String>) -> i32 {
    set_error(message);
    code
}

/// Copies the last error into a caller-owned buffer as UTF-8, and returns the
/// number of bytes it *would* need — so a caller can size a buffer by asking
/// once with a small one.
///
/// # Safety
/// `buf` must be writable for `len` bytes, or null when only the size is wanted.
pub unsafe fn read_last_error(buf: *mut u8, len: u32) -> u32 {
    LAST_ERROR.with(|slot| {
        let text = slot.borrow();
        let bytes = text.as_bytes();
        if !buf.is_null() && len > 0 {
            let n = bytes.len().min(len as usize);
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf, n);
        }
        bytes.len() as u32
    })
}

/// Runs `body` with panics contained, returning a status code either way.
///
/// The closure returns a status itself, so an ordinary failure and a panic take
/// the same path out.
pub fn guard<F: FnOnce() -> i32>(body: F) -> i32 {
    LAST_PANIC.with(|slot| *slot.borrow_mut() = None);

    match panic::catch_unwind(AssertUnwindSafe(body)) {
        Ok(code) => code,
        Err(payload) => {
            let detail = LAST_PANIC
                .with(|slot| slot.borrow_mut().take())
                .unwrap_or_else(|| payload_message(&*payload));
            set_error(detail);
            status::PANIC
        }
    }
}
