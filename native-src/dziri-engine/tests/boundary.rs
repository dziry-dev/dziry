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
        list_capacity: 1,
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

fn create() -> *mut Handle {
    let mut handle = std::ptr::null_mut();
    let code = unsafe { dziri_engine_create(&config(), &mut handle) };
    assert_eq!(code, status::OK, "create failed: {}", last_error());
    assert!(!handle.is_null());
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

    let mut handle = std::ptr::null_mut();
    let code = unsafe { dziri_engine_create(&config, &mut handle) };

    assert_eq!(code, status::PROTOCOL_MISMATCH);
    assert!(handle.is_null(), "nothing is allocated on refusal");
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

    unsafe { dziri_engine_destroy(handle) };
}

#[test]
fn a_destroyed_handle_is_refused_rather_than_dereferenced() {
    let handle = create();
    assert_eq!(unsafe { dziri_engine_destroy(handle) }, status::OK);

    // The magic number is cleared before the free, so this is a refusal instead
    // of a double free — the mistake a scripting host makes most easily.
    assert_eq!(
        unsafe { dziri_engine_destroy(handle) },
        status::INVALID_HANDLE
    );
    assert_eq!(dziri_engine_tick(handle), status::INVALID_HANDLE);
}

#[test]
fn a_null_handle_is_an_error_not_a_crash() {
    assert_eq!(
        dziri_engine_tick(std::ptr::null_mut()),
        status::INVALID_HANDLE
    );
    assert_eq!(
        unsafe { dziri_engine_destroy(std::ptr::null_mut()) },
        status::OK,
        "destroying nothing succeeds, so teardown paths stay simple"
    );
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

    unsafe { dziri_engine_destroy(handle) };
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

    unsafe { dziri_engine_destroy(handle) };
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

    unsafe { dziri_engine_destroy(handle) };
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

    unsafe { dziri_engine_destroy(handle) };
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

    unsafe { dziri_engine_destroy(handle) };
}
