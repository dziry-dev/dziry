//! `dziri_engine` — the C ABI Bun opens with `bun:ffi`.
//!
//! Everything public here is `extern "C"`, and every one of those functions has
//! the same three properties:
//!
//! 1. **It cannot unwind.** [`error::guard`] catches panics and turns them into a
//!    status code, because a panic crossing into Bun aborts the process with no
//!    diagnostic at all.
//! 2. **It returns a status, never a value.** Results go through out-pointers, so
//!    failure is always distinguishable from a legitimate `0` or null.
//! 3. **It validates its handle.** A stale pointer is a magic-number mismatch
//!    rather than a segfault, which matters because the host is a scripting
//!    language that can easily hold one past `destroy`.
//!
//! The bulk data path is deliberately *not* here: Bun writes the tables through
//! typed-array views over engine memory, so a style patch, a list relink and a
//! hidden byte cost no FFI call at all. See [`tables`].

pub mod engine;
pub mod error;
pub mod layout;
pub mod paint;
pub mod protocol;
pub mod tables;
pub mod text;
pub mod window;

use engine::{Engine, EngineConfig, Event};
use error::{fail, guard, status};
use tables::SpanDesc;

/// Sanity-checks a handle before it is dereferenced. A freed or wild pointer is
/// then a clean `INVALID_HANDLE` in almost every case, rather than a crash.
const MAGIC: u64 = 0x647A_6972_695F_0001;

#[repr(C)]
pub struct Handle {
    magic: u64,
    engine: Engine,
}

/// Runs `body` with a validated engine, containing panics and poisoning the
/// engine if one escapes.
fn with<F: FnOnce(&mut Engine) -> i32>(handle: *mut Handle, body: F) -> i32 {
    if handle.is_null() {
        return fail(status::INVALID_HANDLE, "null engine handle");
    }

    // SAFETY: checked non-null; the magic number then rules out most pointers
    // that are not ours. This cannot be sound against a genuinely arbitrary
    // pointer — nothing can — but it catches the realistic mistake, which is
    // using a handle after `destroy`.
    let handle = unsafe { &mut *handle };
    if handle.magic != MAGIC {
        return fail(
            status::INVALID_HANDLE,
            "not an engine handle, or one that was already destroyed",
        );
    }
    if handle.engine.poisoned {
        return fail(
            status::POISONED,
            "the engine panicked earlier and refuses further work",
        );
    }

    let code = guard(|| body(&mut handle.engine));
    if code == status::PANIC {
        handle.engine.poisoned = true;
    }
    code
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// The protocol this binary speaks. Read before creating anything, so a version
/// skew is a message rather than a corrupt frame.
#[no_mangle]
pub extern "C" fn dziri_protocol_version() -> u32 {
    protocol::PROTOCOL_VERSION
}

/// Structural fingerprint of the schema this binary was generated from.
///
/// The version catches a deliberate protocol change; this catches an accidental
/// one. A renamed field, two same-width fields swapped, or an `i32` retyped to
/// `f32` all leave [`dziri_protocol_version`] and every field *count* untouched
/// while changing what the bytes mean — so the host compares this too, and a
/// mismatch means "the engine binary is older than the generated modules".
#[no_mangle]
pub extern "C" fn dziri_schema_hash() -> u32 {
    protocol::SCHEMA_HASH
}

/// Copies the calling thread's last error into `buf` as UTF-8. Returns the full
/// byte length, which may exceed `len`.
///
/// # Safety
/// `buf` must be writable for `len` bytes, or null to query the length.
#[no_mangle]
pub unsafe extern "C" fn dziri_last_error(buf: *mut u8, len: u32) -> u32 {
    error::read_last_error(buf, len)
}

/// Creates an engine. On success `*out` holds the handle.
///
/// # Safety
/// `config` must point to a valid [`EngineConfig`], and `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_create(
    config: *const EngineConfig,
    out: *mut *mut Handle,
) -> i32 {
    error::install_hook();

    guard(|| {
        if config.is_null() || out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null config or out pointer");
        }
        *out = std::ptr::null_mut();

        let config = &*config;
        if config.protocol_version != protocol::PROTOCOL_VERSION {
            return fail(
                status::PROTOCOL_MISMATCH,
                format!(
                    "protocol mismatch: the host speaks v{}, this engine speaks v{}",
                    config.protocol_version,
                    protocol::PROTOCOL_VERSION
                ),
            );
        }

        match Engine::new(config) {
            Ok(engine) => {
                let handle = Box::new(Handle {
                    magic: MAGIC,
                    engine,
                });
                *out = Box::into_raw(handle);
                status::OK
            }
            Err(message) => fail(status::SDL, message),
        }
    })
}

/// Destroys an engine. Safe to call with null; calling twice is caught by the
/// magic number rather than double-freeing.
///
/// # Safety
/// `handle` must be a handle from [`dziri_engine_create`], or null.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_destroy(handle: *mut Handle) -> i32 {
    guard(|| {
        if handle.is_null() {
            return status::OK;
        }
        if (*handle).magic != MAGIC {
            return fail(status::INVALID_HANDLE, "not an engine handle");
        }
        // Cleared first, so a second `destroy` on the same pointer is refused
        // instead of freeing memory twice.
        (*handle).magic = 0;
        drop(Box::from_raw(handle));
        status::OK
    })
}

// ---------------------------------------------------------------------------
// The shared-memory descriptor
// ---------------------------------------------------------------------------

/// How many spans [`dziri_engine_describe`] will report.
///
/// # Safety
/// `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_span_count(handle: *mut Handle, out: *mut u32) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        *out = engine.span_count() as u32;
        status::OK
    })
}

/// Fills `out` with `(table, field, ptr, elemSize, capacity)` per span.
///
/// Bun wraps each with `toArrayBuffer(ptr, 0, elemSize * capacity)` — and must
/// pass **no finalizer**, because this memory belongs to Rust and freeing it
/// from the JS side would be a double free.
///
/// # Safety
/// `out` must be writable for `capacity` [`SpanDesc`] records.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_describe(
    handle: *mut Handle,
    out: *mut SpanDesc,
    capacity: u32,
    written: *mut u32,
) -> i32 {
    with(handle, |engine| {
        if out.is_null() || written.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        if (capacity as usize) < engine.span_count() {
            *written = 0;
            return fail(
                status::CAPACITY,
                format!(
                    "descriptor needs {} spans, was given room for {capacity}",
                    engine.span_count()
                ),
            );
        }

        let slice = std::slice::from_raw_parts_mut(out, capacity as usize);
        *written = engine.describe(slice) as u32;
        status::OK
    })
}

/// Bumped whenever the tables are reallocated — a list arena outgrowing its
/// capacity. Every pointer from a previous descriptor is dangling after that, so
/// the host re-reads it whenever this changes.
///
/// # Safety
/// `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_generation(handle: *mut Handle, out: *mut u64) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        *out = engine.generation();
        status::OK
    })
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/// Applies what the host staged, relays out what that invalidated, paints and
/// presents.
#[no_mangle]
pub extern "C" fn dziri_engine_tick(handle: *mut Handle) -> i32 {
    with(handle, |engine| match engine.tick() {
        Ok(()) => status::OK,
        Err(message) => fail(status::LAYOUT, message),
    })
}

/// Moves queued events to the host. `*written` is how many were moved; call
/// again while it equals `capacity`.
///
/// # Safety
/// `out` must be writable for `capacity` [`Event`] records.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_drain_events(
    handle: *mut Handle,
    out: *mut Event,
    capacity: u32,
    written: *mut u32,
) -> i32 {
    with(handle, |engine| {
        if out.is_null() || written.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        let slice = std::slice::from_raw_parts_mut(out, capacity as usize);
        *written = engine.drain_events(slice) as u32;
        status::OK
    })
}

/// Grows the tables to hold at least the requested capacities.
///
/// Call when a list arena outgrows its capacity. On success, check
/// [`dziri_engine_generation`]: if it changed, every pointer from the previous
/// descriptor is dangling and the host must re-read it and re-upload.
///
/// # Safety
/// `caps` must point to a valid [`tables::Capacities`].
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_grow(
    handle: *mut Handle,
    caps: *const tables::Capacities,
) -> i32 {
    with(handle, |engine| {
        if caps.is_null() {
            return fail(status::INVALID_ARGUMENT, "null capacities pointer");
        }
        engine.grow(*caps);
        status::OK
    })
}

#[no_mangle]
pub extern "C" fn dziri_engine_resize(handle: *mut Handle, width: u32, height: u32) -> i32 {
    with(handle, |engine| match engine.resize(width, height) {
        Ok(()) => status::OK,
        Err(message) => fail(status::SDL, message),
    })
}

/// Overrides hover/press/focus without a mouse, so interaction styles can be
/// rendered headlessly — the engine-side `--hover` and `--focus`.
#[no_mangle]
pub extern "C" fn dziri_engine_set_input_state(
    handle: *mut Handle,
    hovered: i32,
    pressed: i32,
    focused: i32,
) -> i32 {
    with(handle, |engine| {
        engine.set_input_state(hovered, pressed, focused);
        status::OK
    })
}

/// Deepest interactive node at a point, or -1.
///
/// # Safety
/// `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_hit_test(
    handle: *mut Handle,
    x: f32,
    y: f32,
    out: *mut i32,
) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        *out = engine.hit_test(x, y);
        status::OK
    })
}

/// A node's absolute bounds as `[x, y, width, height]`.
///
/// The host can also read these straight out of the layout table; this exists
/// for one-off queries where wrapping a view would cost more than the call.
///
/// # Safety
/// `out` must be writable for four `f32`.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_bounds(
    handle: *mut Handle,
    node: u32,
    out: *mut f32,
) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        match engine.bounds_of(node as usize) {
            Some(rect) => {
                std::ptr::copy_nonoverlapping(rect.as_ptr(), out, 4);
                status::OK
            }
            None => fail(status::INVALID_ARGUMENT, format!("no node {node}")),
        }
    })
}

/// `[width, height, rowBytes, frames]` — everything a screenshot needs to size
/// its buffer, plus the frame counter for diagnostics.
///
/// # Safety
/// `out` must be writable for four `u32`.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_surface_info(handle: *mut Handle, out: *mut u32) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        let (width, height) = engine.size();
        *out = width;
        *out.add(1) = height;
        *out.add(2) = width * 4;
        *out.add(3) = engine.frame_count() as u32;
        status::OK
    })
}

/// Copies the last painted frame out as BGRA_8888.
///
/// # Safety
/// `out` must be writable for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_read_pixels(
    handle: *mut Handle,
    out: *mut u8,
    len: u32,
) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        let Some((pixels, _)) = engine.pixels() else {
            return fail(status::SKIA, "the surface has no readable pixels");
        };
        if (len as usize) < pixels.len() {
            return fail(
                status::CAPACITY,
                format!("frame is {} bytes, was given {len}", pixels.len()),
            );
        }
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), out, pixels.len());
        status::OK
    })
}

/// Encodes the last painted frame as a PNG and reports its byte length.
///
/// Two calls rather than one, because the size is not knowable before encoding:
/// this leaves the bytes in the engine, and [`dziri_engine_take_png`] copies them
/// out. Skia already has the encoder, which is why the TypeScript runtime's
/// hand-written one retires.
///
/// # Safety
/// `out_len` must be writable.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_encode_png(handle: *mut Handle, out_len: *mut u32) -> i32 {
    with(handle, |engine| {
        if out_len.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        match engine.encode_png() {
            Some(len) => {
                *out_len = len as u32;
                status::OK
            }
            None => fail(status::SKIA, "Skia could not encode the frame as PNG"),
        }
    })
}

/// Copies out the bytes from the last [`dziri_engine_encode_png`] and clears them.
///
/// # Safety
/// `out` must be writable for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_take_png(
    handle: *mut Handle,
    out: *mut u8,
    len: u32,
) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        let png = engine.take_png();
        if (len as usize) < png.len() {
            return fail(
                status::CAPACITY,
                format!("PNG is {} bytes, was given {len}", png.len()),
            );
        }
        std::ptr::copy_nonoverlapping(png.as_ptr(), out, png.len());
        status::OK
    })
}

/// The resolved font family, as UTF-8. Returns its byte length.
///
/// # Safety
/// `buf` must be writable for `len` bytes, or null to query the length.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_font_family(
    handle: *mut Handle,
    buf: *mut u8,
    len: u32,
    written: *mut u32,
) -> i32 {
    with(handle, |engine| {
        if written.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        let bytes = engine.font_family().as_bytes();
        *written = bytes.len() as u32;
        if !buf.is_null() && len > 0 {
            let n = bytes.len().min(len as usize);
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf, n);
        }
        status::OK
    })
}

/// Milliseconds spent in the last `tick`.
///
/// # Safety
/// `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_last_frame_ms(handle: *mut Handle, out: *mut f32) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        *out = engine.last_frame_ms();
        status::OK
    })
}

/// Deliberately exported for the test suite: proves a panic inside the boundary
/// becomes a status code and a message instead of an aborted process.
#[no_mangle]
pub extern "C" fn dziri_engine_panic_for_testing(handle: *mut Handle) -> i32 {
    with(handle, |_| panic!("deliberate panic from dziri_engine_panic_for_testing"))
}
