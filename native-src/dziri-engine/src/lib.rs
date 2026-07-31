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
//! 3. **It validates its handle by looking it up, never by dereferencing it.**
//!    The handle is a `u32` index-plus-generation into [`REGISTRY`], so a handle
//!    used after `destroy` is a miss with a message — which matters because the
//!    host is a scripting language that can easily hold one past `destroy`, and
//!    because the previous scheme had to read the freed allocation to discover it
//!    had been freed.
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

use std::sync::{Mutex, MutexGuard};
use std::thread::ThreadId;

use engine::{Engine, EngineConfig, Event};
use error::{fail, guard, status};
use tables::SpanDesc;

/// An engine handle: a slot index and a generation, packed into one `u32`.
///
/// **Deliberately not a pointer.** It used to be `*mut Handle` with a magic number
/// at offset 0, and validating it meant *dereferencing it first* — so a handle used
/// after `destroy` read freed memory to discover that it was freed. That read is
/// undefined behaviour on the happy path and a segfault on the unhappy one, and
/// under an allocator that reuses the block it can read a valid magic number
/// belonging to a *different* engine, at which point the call operates on the wrong
/// one.
///
/// A generation-indexed table removes the dereference: the host's number is looked
/// *up*, and a stale one either names an empty slot or carries a generation the slot
/// has moved past. Double-destroy becomes a lookup miss with a message. It is also
/// the shape a render thread needs, since a `u32` crosses threads and a raw pointer
/// into a `!Send` engine does not.
///
/// Layout: low 8 bits are the slot (256 live engines, which is 255 more than any
/// app has needed), the top 24 are the generation. Generation starts at 1, so **0
/// is never a valid handle** and a zeroed variable fails the lookup rather than
/// naming slot 0. A slot reused 16.7 million times wraps and could accept a very
/// old handle; that is not reachable in a process that opens windows.
pub type Handle = u32;

const SLOT_BITS: u32 = 8;
const SLOT_MASK: u32 = (1 << SLOT_BITS) - 1;
const MAX_SLOTS: usize = 1 << SLOT_BITS;

/// What a slot is doing.
///
/// Three states, not `Option<Owned>`. `with` moves the engine out for the duration
/// of a call so the registry lock is not held across `tick` — which means "nobody
/// lives here" and "somebody lives here and is mid-call" would otherwise look
/// identical, and `create` would hand a live, in-use slot to a second engine. The
/// concurrent test harness caught exactly that, twice.
enum State {
    /// Nothing here. `create` may take it.
    Free,
    /// An engine, idle.
    Live(Owned),
    /// An engine, moved out for the duration of a call. A re-entrant call names this.
    InCall,
}

/// One engine, plus what a handle to it has to match.
struct Slot {
    /// Bumped by the `destroy` that frees the slot, so a handle from an earlier
    /// tenancy is stale even once the slot is live again.
    generation: u32,
    state: State,
    /// The thread that called `create`. SDL pins its window and event pump to one
    /// thread, and Skia's surface is not shared either, so every later call has to
    /// arrive on this one.
    owner: ThreadId,
}

/// An `Engine` that the registry may hold across threads.
///
/// The `Engine` itself is emphatically not `Send`: it owns an SDL window and a Skia
/// surface. What makes this sound is that the registry never *touches* one from a
/// foreign thread — `with` and `destroy` both compare `owner` against the calling
/// thread and refuse before taking the box out, so every dereference and the drop
/// all happen on the creating thread. The `unsafe impl` buys the ability to keep it
/// in a `static`, not the ability to use it from anywhere.
struct Owned(Box<Engine>);

// SAFETY: as documented above — access is gated on the owning-thread check in
// `with` and `dziri_engine_destroy`, which are the only two readers.
unsafe impl Send for Owned {}

/// Every live engine in the process.
///
/// A `static` rather than a thread-local, because the *point* is that a handle can
/// be validated from a thread that must then be refused: a thread-local registry
/// would report a foreign-thread handle as "no such engine", which is a different
/// and more confusing bug.
///
/// Statics are never dropped, so a process exiting with a live engine leaks it to
/// the OS rather than running SDL teardown on whatever thread called `exit` — which
/// is the outcome we want.
static REGISTRY: Mutex<Vec<Slot>> = Mutex::new(Vec::new());

fn registry() -> MutexGuard<'static, Vec<Slot>> {
    // Poisoning carries no information here: every panic that could escape a call
    // is already caught by `guard`, and a poisoned lock would turn one engine's
    // panic into every engine's.
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

fn pack(slot: usize, generation: u32) -> Handle {
    (generation << SLOT_BITS) | (slot as u32 & SLOT_MASK)
}

/// Resolves a handle to a slot index, or says why it cannot.
fn slot_of(table: &[Slot], handle: Handle) -> Result<usize, &'static str> {
    let index = (handle & SLOT_MASK) as usize;
    let generation = handle >> SLOT_BITS;
    if generation == 0 {
        return Err("not an engine handle");
    }
    match table.get(index) {
        Some(slot) if slot.generation == generation => Ok(index),
        Some(_) => Err("this engine was already destroyed"),
        None => Err("not an engine handle"),
    }
}

/// Runs `body` with a validated engine, containing panics and poisoning the
/// engine if one escapes.
///
/// The engine is moved out of its slot for the duration and moved back after, so
/// the registry lock is not held across `tick` — which pumps SDL and can block for
/// a whole frame — and a second call naming the same engine finds the slot empty
/// rather than deadlocking or aliasing.
fn with<F: FnOnce(&mut Engine) -> i32>(handle: Handle, body: F) -> i32 {
    let taken = {
        let mut table = registry();
        let index = match slot_of(&table, handle) {
            Ok(index) => index,
            Err(why) => return fail(status::INVALID_HANDLE, why),
        };

        let slot = &mut table[index];
        if slot.owner != std::thread::current().id() {
            return fail(
                status::INVALID_HANDLE,
                "this engine belongs to the thread that created it; SDL pins its window \
                 and event pump there",
            );
        }
        match std::mem::replace(&mut slot.state, State::InCall) {
            State::Live(engine) => engine,
            State::InCall => {
                slot.state = State::InCall;
                return fail(
                    status::INVALID_HANDLE,
                    "this engine is already inside a call — the ABI is not re-entrant",
                );
            }
            State::Free => {
                slot.state = State::Free;
                return fail(status::INVALID_HANDLE, "this engine was already destroyed");
            }
        }
    };

    let mut owned = taken;
    let poisoned = owned.0.poisoned;
    let code = if poisoned {
        fail(
            status::POISONED,
            "the engine panicked earlier and refuses further work",
        )
    } else {
        let code = guard(|| body(&mut owned.0));
        if code == status::PANIC {
            owned.0.poisoned = true;
        }
        code
    };

    // Unconditional: `guard` turns a panic into a status, so there is no path that
    // leaves the slot `InCall` and the engine unreachable.
    let index = (handle & SLOT_MASK) as usize;
    if let Some(slot) = registry().get_mut(index) {
        slot.state = State::Live(owned);
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
    // SAFETY: forwarding the caller's own promise about `buf` and `len`.
    unsafe { error::read_last_error(buf, len) }
}

/// Creates an engine. On success `*out` holds the handle.
///
/// # Safety
/// `config` must point to a valid [`EngineConfig`], and `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_create(config: *const EngineConfig, out: *mut Handle) -> i32 {
    error::install_hook();

    guard(|| {
        if config.is_null() || out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null config or out pointer");
        }
        // SAFETY: both pointers were just checked for null, and the caller
        // promises they are writable and point at a valid config. Zero first: it is
        // never a valid handle, so a caller who ignores the status still fails the
        // lookup rather than reaching slot 0.
        unsafe { *out = 0 };

        let config = unsafe { &*config };
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

        let engine = match Engine::new(config) {
            Ok(engine) => engine,
            Err(e) => return fail(e.status, e.detail),
        };

        let mut table = registry();
        // Reuse a free slot before growing, so a create/destroy loop does not walk
        // the handle space. The generation it issues was already bumped by the
        // `destroy` that freed it, so handles from the previous tenancy are stale.
        let free = table
            .iter()
            .position(|slot| matches!(slot.state, State::Free));
        let owner = std::thread::current().id();

        let (index, generation) = match free {
            Some(index) => {
                let slot = &mut table[index];
                slot.owner = owner;
                slot.state = State::Live(Owned(Box::new(engine)));
                (index, slot.generation)
            }
            None => {
                if table.len() >= MAX_SLOTS {
                    return fail(
                        status::CAPACITY,
                        format!("{MAX_SLOTS} engines are already open"),
                    );
                }
                table.push(Slot {
                    generation: 1,
                    state: State::Live(Owned(Box::new(engine))),
                    owner,
                });
                (table.len() - 1, 1)
            }
        };

        // SAFETY: as above — `out` is non-null and writable.
        unsafe { *out = pack(index, generation) };
        status::OK
    })
}

/// Destroys an engine.
///
/// Handle 0 succeeds, so teardown paths stay simple. A second call with the same
/// handle is a lookup miss: the slot is empty, and the generation has moved on. No
/// pointer is dereferenced to discover either, which is the whole point.
///
/// The engine is dropped on the calling thread, which is why a foreign thread is
/// refused rather than accommodated — SDL's window teardown belongs on the thread
/// that created it.
#[no_mangle]
pub extern "C" fn dziri_engine_destroy(handle: Handle) -> i32 {
    guard(|| {
        if handle == 0 {
            return status::OK;
        }

        let taken = {
            let mut table = registry();
            let index = match slot_of(&table, handle) {
                Ok(index) => index,
                Err(why) => return fail(status::INVALID_HANDLE, why),
            };

            let slot = &mut table[index];
            if slot.owner != std::thread::current().id() {
                return fail(
                    status::INVALID_HANDLE,
                    "this engine belongs to the thread that created it, and has to be \
                     destroyed there",
                );
            }
            let taken = match std::mem::replace(&mut slot.state, State::Free) {
                State::Live(engine) => engine,
                State::InCall => {
                    slot.state = State::InCall;
                    return fail(
                        status::INVALID_HANDLE,
                        "this engine is inside a call and cannot be destroyed from within it",
                    );
                }
                State::Free => {
                    slot.state = State::Free;
                    return fail(status::INVALID_HANDLE, "this engine was already destroyed");
                }
            };
            // The generation moves on *here*, with the engine, so the caller's
            // handle is stale from this moment and a second `destroy` is refused by
            // `slot_of` as "already destroyed" rather than mistaken for re-entrancy.
            // One bump per lifecycle: `create` reusing this slot issues the value
            // set here.
            slot.generation = slot.generation.wrapping_add(1).max(1);
            taken
        };

        // Outside the lock: dropping an engine closes an SDL window and frees a Skia
        // surface, and neither needs the registry held while it happens.
        drop(taken);
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
pub unsafe extern "C" fn dziri_engine_span_count(handle: Handle, out: *mut u32) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        // SAFETY: non-null, and writable by the caller's promise.
        unsafe { *out = engine.span_count() as u32 };
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
    handle: Handle,
    out: *mut SpanDesc,
    capacity: u32,
    written: *mut u32,
) -> i32 {
    with(handle, |engine| {
        if out.is_null() || written.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        if (capacity as usize) < engine.span_count() {
            // SAFETY: non-null, writable. Zero first: a partial descriptor is
            // worse than none, and this is the value the host keys on.
            unsafe { *written = 0 };
            return fail(
                status::CAPACITY,
                format!(
                    "descriptor needs {} spans, was given room for {capacity}",
                    engine.span_count()
                ),
            );
        }

        // SAFETY: the caller promises room for `capacity` records, and the check
        // above proved `capacity` covers every span. The slice does not outlive
        // this call, so nothing holds a Rust reference into host memory.
        let slice = unsafe { std::slice::from_raw_parts_mut(out, capacity as usize) };
        unsafe { *written = engine.describe(slice) as u32 };
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
pub unsafe extern "C" fn dziri_engine_generation(handle: Handle, out: *mut u64) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        // SAFETY: non-null, and writable by the caller's promise.
        unsafe { *out = engine.generation() };
        status::OK
    })
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/// Applies what the host staged, relays out what that invalidated, paints and
/// presents.
#[no_mangle]
pub extern "C" fn dziri_engine_tick(handle: Handle) -> i32 {
    // The status is the error's own, not one guessed per entry point. `tick`
    // reaches Taffy, Skia and SDL, and reporting all three as LAYOUT told a host
    // out of video memory that its tree was wrong.
    with(handle, |engine| match engine.tick() {
        Ok(()) => status::OK,
        Err(e) => fail(e.status, e.detail),
    })
}

/// Moves queued events to the host. `*written` is how many were moved; call
/// again while it equals `capacity`.
///
/// # Safety
/// `out` must be writable for `capacity` [`Event`] records.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_drain_events(
    handle: Handle,
    out: *mut Event,
    capacity: u32,
    written: *mut u32,
) -> i32 {
    with(handle, |engine| {
        if out.is_null() || written.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        // SAFETY: the caller promises room for `capacity` events, and
        // `drain_events` writes no more than the slice's length. Materialised
        // inside the call only, like every other view over host memory here.
        let slice = unsafe { std::slice::from_raw_parts_mut(out, capacity as usize) };
        unsafe { *written = engine.drain_events(slice) as u32 };
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
pub unsafe extern "C" fn dziri_engine_grow(handle: Handle, caps: *const tables::Capacities) -> i32 {
    with(handle, |engine| {
        if caps.is_null() {
            return fail(status::INVALID_ARGUMENT, "null capacities pointer");
        }
        // SAFETY: non-null, and the caller promises a valid `Capacities`.
        engine.grow(unsafe { *caps });
        status::OK
    })
}

#[no_mangle]
pub extern "C" fn dziri_engine_resize(handle: Handle, width: u32, height: u32) -> i32 {
    with(handle, |engine| match engine.resize(width, height) {
        Ok(()) => status::OK,
        Err(e) => fail(e.status, e.detail),
    })
}

/// Overrides hover/press/focus without a mouse, so interaction styles can be
/// rendered headlessly — the engine-side `--hover` and `--focus`.
#[no_mangle]
pub extern "C" fn dziri_engine_set_input_state(
    handle: Handle,
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
    handle: Handle,
    x: f32,
    y: f32,
    out: *mut i32,
) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        // SAFETY: non-null, and writable by the caller's promise.
        unsafe { *out = engine.hit_test(x, y) };
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
pub unsafe extern "C" fn dziri_engine_bounds(handle: Handle, node: u32, out: *mut f32) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        match engine.bounds_of(node as usize) {
            Some(rect) => {
                // SAFETY: non-null, and the caller promises room for four `f32`.
                unsafe { std::ptr::copy_nonoverlapping(rect.as_ptr(), out, 4) };
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
pub unsafe extern "C" fn dziri_engine_surface_info(handle: Handle, out: *mut u32) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        let (width, height) = engine.size();
        // SAFETY: non-null, and the caller promises room for four `u32` — so
        // `add(3)` is the last element rather than one past it.
        unsafe {
            *out = width;
            *out.add(1) = height;
            *out.add(2) = width * 4;
            *out.add(3) = engine.frame_count() as u32;
        }
        status::OK
    })
}

/// Copies the last painted frame out as BGRA_8888.
///
/// # Safety
/// `out` must be writable for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_read_pixels(handle: Handle, out: *mut u8, len: u32) -> i32 {
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
        // SAFETY: non-null, and the length check above proved the caller's buffer
        // is at least as long as the frame.
        unsafe { std::ptr::copy_nonoverlapping(pixels.as_ptr(), out, pixels.len()) };
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
pub unsafe extern "C" fn dziri_engine_encode_png(handle: Handle, out_len: *mut u32) -> i32 {
    with(handle, |engine| {
        if out_len.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        match engine.encode_png() {
            Some(len) => {
                // SAFETY: non-null, and writable by the caller's promise.
                unsafe { *out_len = len as u32 };
                status::OK
            }
            None => fail(status::SKIA, "Skia could not encode the frame as PNG"),
        }
    })
}

/// Copies out the bytes from the last [`dziri_engine_encode_png`] and clears them.
///
/// A refusal leaves the frame where it was, so the host can allocate properly and
/// call again. The check has to come before the take for that to be true: taking
/// first and checking after answers `CAPACITY` once and then `OK` with zero bytes
/// forever, which reads as a successful screenshot of nothing.
///
/// # Safety
/// `out` must be writable for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_take_png(handle: Handle, out: *mut u8, len: u32) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        let needed = engine.png_len();
        if (len as usize) < needed {
            return fail(
                status::CAPACITY,
                format!("PNG is {needed} bytes, was given {len}"),
            );
        }
        let png = engine.take_png();
        // SAFETY: non-null, and the capacity check above proved the buffer holds
        // the whole PNG.
        unsafe { std::ptr::copy_nonoverlapping(png.as_ptr(), out, png.len()) };
        status::OK
    })
}

/// The resolved font family, as UTF-8.
///
/// `*written` answers whichever question was asked, on the same terms as
/// [`dziri_last_error`]: with `buf` null it is the byte length the name needs,
/// with a buffer it is how many bytes were written — the longest whole-codepoint
/// prefix that fits.
///
/// # Safety
/// `buf` must be writable for `len` bytes, or null to query the length.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_font_family(
    handle: Handle,
    buf: *mut u8,
    len: u32,
    written: *mut u32,
) -> i32 {
    with(handle, |engine| {
        if written.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        // Whole codepoints only, and `written` reports what was written rather than
        // what was wanted — a system font family is exactly the kind of string that
        // is not ASCII ("宋体", "맑은 고딕"). Same rule as `dziri_last_error`,
        // because it is the same function.
        // SAFETY: `written` is non-null, and `buf`/`len` are the caller's promise.
        let n = unsafe { error::copy_utf8_prefix(engine.font_family(), buf, len) };
        unsafe { *written = n };
        status::OK
    })
}

/// Milliseconds spent in the last `tick`.
///
/// # Safety
/// `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn dziri_engine_last_frame_ms(handle: Handle, out: *mut f32) -> i32 {
    with(handle, |engine| {
        if out.is_null() {
            return fail(status::INVALID_ARGUMENT, "null out pointer");
        }
        // SAFETY: non-null, and writable by the caller's promise.
        unsafe { *out = engine.last_frame_ms() };
        status::OK
    })
}

/// Deliberately exported for the test suite: proves a panic inside the boundary
/// becomes a status code and a message instead of an aborted process.
#[no_mangle]
pub extern "C" fn dziri_engine_panic_for_testing(handle: Handle) -> i32 {
    with(handle, |_| {
        panic!("deliberate panic from dziri_engine_panic_for_testing")
    })
}
