//! The FFI boundary's failure behaviour, exercised through the C ABI itself.
//!
//! These matter more than they look. A Rust panic unwinding into Bun aborts the
//! process with no diagnostic — the user sees the app vanish — and a stale handle
//! dereferenced is a segfault a scripting host cannot report either. Both are
//! easy to regress and impossible to notice from the happy path.

use dziri_engine::engine::EngineConfig;
use dziri_engine::protocol::{self, status};
use dziri_engine::tables::SpanDesc;
use dziri_engine::*;

fn config() -> EngineConfig {
    EngineConfig {
        protocol_version: protocol::PROTOCOL_VERSION,
        width: 64,
        height: 64,
        node_capacity: 4,
        style_capacity: 2,
        variant_capacity: 1,
        variant_slot_capacity: 8,
        media_capacity: 1,
        list_capacity: 1,
        tween_capacity: 1,
        keyframe_capacity: 1,
        control_capacity: 4,
        string_capacity: 2,
        string_bytes: 32,
        root: 0,
        windowed: 0,
        decorated: 1,
        _reserved: [0; 2],
        title: std::ptr::null(),
        title_len: 0,
    }
}

fn last_error() -> String {
    unsafe {
        let len = dziri_last_error(std::ptr::null_mut(), 0);
        let mut buf = vec![0u8; len as usize];
        dziri_last_error(buf.as_mut_ptr(), len);
        String::from_utf8_lossy(&buf).into_owned()
    }
}

fn create() -> Handle {
    let mut handle: Handle = 0;
    let code = unsafe { dziri_engine_create(&config(), &mut handle) };
    assert_eq!(code, status::OK, "create failed: {}", last_error());
    assert_ne!(handle, 0, "0 is never a valid handle");
    handle
}

#[test]
fn the_host_can_ask_what_protocol_this_binary_speaks() {
    assert_eq!(dziri_protocol_version(), protocol::PROTOCOL_VERSION);
}

#[test]
fn a_protocol_mismatch_refuses_to_start() {
    let mut config = config();
    config.protocol_version = protocol::PROTOCOL_VERSION + 99;

    let mut handle: Handle = 0;
    let code = unsafe { dziri_engine_create(&config, &mut handle) };

    assert_eq!(code, status::PROTOCOL_MISMATCH);
    assert_eq!(handle, 0, "nothing is allocated on refusal");
    assert!(
        last_error().contains("protocol mismatch"),
        "the message should say what happened: {}",
        last_error()
    );
}

#[test]
fn a_panic_becomes_a_status_code_and_poisons_the_engine() {
    let handle = create();

    // Would abort the process without `catch_unwind` at the entry point.
    let code = dziri_engine_panic_for_testing(handle);
    assert_eq!(code, status::PANIC);

    let message = last_error();
    assert!(
        message.contains("deliberate panic"),
        "the panic message should reach the host: {message}"
    );
    assert!(
        message.contains("lib.rs") || message.contains("panic at"),
        "and so should where it happened: {message}"
    );

    // The engine's invariants are now unknown, so it refuses to render rather
    // than painting from half-updated state.
    assert_eq!(dziri_engine_tick(handle), status::POISONED);

    dziri_engine_destroy(handle);
}

#[test]
fn a_destroyed_handle_is_refused_rather_than_dereferenced() {
    let handle = create();
    assert_eq!(dziri_engine_destroy(handle), status::OK);

    // A lookup miss, not a read of freed memory: the slot is empty and its
    // generation has moved past this handle. Double-destroy is the mistake a
    // scripting host makes most easily, and it used to be caught by dereferencing
    // the pointer to find a cleared magic number — reading the very allocation it
    // was checking had been freed.
    assert_eq!(dziri_engine_destroy(handle), status::INVALID_HANDLE);
    assert!(
        last_error().contains("already destroyed"),
        "the message should say which mistake this was: {}",
        last_error()
    );
    assert_eq!(dziri_engine_tick(handle), status::INVALID_HANDLE);
}

/// The case a magic number could not catch: the slot is live, the handle is not.
///
/// A stale pointer under the old scheme could land on a reallocated block whose
/// first eight bytes happen to be a valid magic number, and the call would then run
/// against a *different* engine. Only a generation distinguishes those.
///
/// Constructed rather than provoked: the handle is `(generation << 8) | slot`, so
/// the neighbouring generations on a live slot are arithmetic. Waiting for a
/// destroy/create pair to reuse a slot would depend on what the other tests in this
/// binary are doing on their own threads, which is not a thing to assert on.
#[test]
fn a_wrong_generation_on_a_live_slot_is_refused() {
    let live = create();
    let slot = live & 0xff;

    for (handle, what) in [
        (live + (1 << 8), "a generation this slot has not reached"),
        (live - (1 << 8), "the generation before this one"),
        (slot, "generation 0, which is never issued"),
    ] {
        assert_eq!(
            dziri_engine_tick(handle),
            status::INVALID_HANDLE,
            "{what} should be refused"
        );
    }

    // And none of that disturbed the engine that does exist.
    assert_eq!(dziri_engine_tick(live), status::OK, "{}", last_error());
    assert_eq!(dziri_engine_destroy(live), status::OK);
}

#[test]
fn a_zero_handle_is_an_error_not_a_crash() {
    assert_eq!(dziri_engine_tick(0), status::INVALID_HANDLE);
    assert_eq!(
        dziri_engine_destroy(0),
        status::OK,
        "destroying nothing succeeds, so teardown paths stay simple"
    );
    // A number the host invented rather than received. There is no pointer to
    // dereference, so this is a bounds check.
    assert_eq!(dziri_engine_tick(0xdead_beef), status::INVALID_HANDLE);
}

/// SDL pins its window and event pump to the thread that initialised video, and
/// Skia's surface is not shared either — so a handle reaching a foreign thread has
/// to be refused rather than accommodated. The registry records the creating thread
/// precisely so this can be a message instead of a crash inside Cocoa or a driver.
#[test]
fn a_handle_used_from_another_thread_is_refused() {
    let handle = create();

    let code = std::thread::spawn(move || dziri_engine_tick(handle))
        .join()
        .expect("the foreign thread should return a status, not panic");
    assert_eq!(code, status::INVALID_HANDLE);

    // And the engine is untouched: the owning thread still has it.
    assert_eq!(dziri_engine_tick(handle), status::OK, "{}", last_error());
    assert_eq!(dziri_engine_destroy(handle), status::OK);
}

#[test]
fn a_short_descriptor_buffer_is_refused_before_it_is_written() {
    let handle = create();

    let mut count = 0u32;
    assert_eq!(
        unsafe { dziri_engine_span_count(handle, &mut count) },
        status::OK
    );
    assert!(count > 0);

    let mut one = [SpanDesc {
        table: 0,
        field: 0,
        ptr: 0,
        elem_size: 0,
        capacity: 0,
    }];
    let mut written = 99u32;
    let code = unsafe { dziri_engine_describe(handle, one.as_mut_ptr(), 1, &mut written) };

    assert_eq!(code, status::CAPACITY);
    assert_eq!(written, 0, "a partial descriptor is worse than none");
    assert!(last_error().contains("needs"), "{}", last_error());

    dziri_engine_destroy(handle);
}

#[test]
fn the_descriptor_survives_a_round_trip_through_the_abi() {
    let handle = create();

    let mut count = 0u32;
    unsafe { dziri_engine_span_count(handle, &mut count) };

    let mut spans = vec![
        SpanDesc {
            table: -9,
            field: -9,
            ptr: 0,
            elem_size: 0,
            capacity: 0,
        };
        count as usize
    ];
    let mut written = 0u32;
    let code = unsafe { dziri_engine_describe(handle, spans.as_mut_ptr(), count, &mut written) };

    assert_eq!(code, status::OK);
    assert_eq!(written, count);
    for span in &spans {
        assert_ne!(span.ptr, 0, "every span must have memory behind it");
        assert!(span.elem_size > 0);
    }

    // A generation change is the host's signal that these pointers are stale.
    let mut generation = 0u64;
    unsafe { dziri_engine_generation(handle, &mut generation) };
    assert!(generation > 0);

    dziri_engine_destroy(handle);
}

#[test]
fn a_skia_failure_reports_skia_and_not_the_entry_point_s_guess() {
    // `dziri_engine_resize` used to map every failure beneath it to `SDL`,
    // including this one — Skia refusing to allocate the surface, before SDL is
    // reached at all. The status is the host's only machine-readable signal, so
    // the guess made "out of video memory" indistinguishable from "the window
    // manager refused", and no host could key recovery on either.
    //
    // `u32::MAX as i32` is -1, which is the cheapest way to make the allocation
    // fail without actually exhausting memory.
    let handle = create();
    let code = dziri_engine_resize(handle, u32::MAX, u32::MAX);

    assert_eq!(code, status::SKIA, "{}", last_error());
    assert!(
        last_error().contains("raster surface"),
        "the detail should still say what happened: {}",
        last_error()
    );

    dziri_engine_destroy(handle);
}

/// A refused copy must not consume the frame.
///
/// The failure this pins is quiet: `take_png` used to empty the engine's buffer
/// and *then* compare capacity, so a host that guessed the size low got
/// `CAPACITY` once and `OK` with zero bytes on every retry — a screenshot that
/// succeeded and wrote an empty file.
#[test]
fn a_short_png_buffer_leaves_the_frame_to_retry() {
    let handle = create();
    assert_eq!(dziri_engine_tick(handle), status::OK, "{}", last_error());

    let mut size = 0u32;
    assert_eq!(
        unsafe { dziri_engine_encode_png(handle, &mut size) },
        status::OK,
        "{}",
        last_error()
    );
    assert!(size > 8, "a PNG is at least a signature");

    let mut short = vec![0u8; (size - 1) as usize];
    assert_eq!(
        unsafe { dziri_engine_take_png(handle, short.as_mut_ptr(), short.len() as u32) },
        status::CAPACITY,
    );
    assert!(
        last_error().contains(&size.to_string()),
        "the refusal should say how much room it needs: {}",
        last_error()
    );

    // The retry the host would actually make.
    let mut png = vec![0u8; size as usize];
    assert_eq!(
        unsafe { dziri_engine_take_png(handle, png.as_mut_ptr(), png.len() as u32) },
        status::OK,
        "{}",
        last_error()
    );
    assert_eq!(
        &png[..8],
        b"\x89PNG\r\n\x1a\n",
        "and it should be the frame, not zeros"
    );

    dziri_engine_destroy(handle);
}

/// `written` means written, not wanted.
///
/// The boundary logic lives in `error::copy_utf8_prefix` and is tested there with
/// strings a test can choose; the platform decides the font family, so what this
/// pins is the contract at the ABI: a short buffer reports how much of the name it
/// received, so the host cannot decode past it into whatever the buffer held
/// before. It used to report the full length regardless.
#[test]
fn a_short_font_family_buffer_reports_what_it_wrote() {
    let handle = create();

    let mut needed = 0u32;
    assert_eq!(
        unsafe { dziri_engine_font_family(handle, std::ptr::null_mut(), 0, &mut needed) },
        status::OK
    );
    assert!(needed > 4, "no platform resolves a family this short");

    let mut buf = [0u8; 4];
    let mut written = 99u32;
    assert_eq!(
        unsafe { dziri_engine_font_family(handle, buf.as_mut_ptr(), 4, &mut written) },
        status::OK
    );
    assert_eq!(written, 4, "four bytes fit, and four were written");
    assert!(
        std::str::from_utf8(&buf[..written as usize]).is_ok(),
        "whatever it wrote is a whole number of characters"
    );

    dziri_engine_destroy(handle);
}

#[test]
fn a_headless_engine_paints_pixels() {
    let handle = create();
    assert_eq!(dziri_engine_tick(handle), status::OK, "{}", last_error());

    let mut info = [0u32; 4];
    assert_eq!(
        unsafe { dziri_engine_surface_info(handle, info.as_mut_ptr()) },
        status::OK
    );
    assert_eq!(info[0], 64);
    assert_eq!(info[1], 64);
    assert_eq!(info[3], 1, "one frame ticked");

    let mut pixels = vec![0u8; (info[1] * info[2]) as usize];
    assert_eq!(
        unsafe { dziri_engine_read_pixels(handle, pixels.as_mut_ptr(), pixels.len() as u32) },
        status::OK
    );
    // The canvas is cleared to opaque black before painting, so every pixel has
    // full alpha even with nothing drawn.
    assert!(
        pixels.chunks(4).all(|p| p[3] == 0xff),
        "the frame should be opaque"
    );

    dziri_engine_destroy(handle);
}
