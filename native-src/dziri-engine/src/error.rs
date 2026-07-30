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
