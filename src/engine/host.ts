/**
 * Opening the engine from Bun: `dlopen`, the descriptor, and the typed-array
 * views the rest of the runtime writes through.
 *
 * This is the *whole* FFI surface. Everything else — a style patch, a list
 * relink, a hidden byte, a string — is a direct memory write with no call at
 * all, which is the point of the shared-memory protocol.
 *
 * Field identity comes from `src/protocol/generated.ts`; byte offsets come from
 * the engine at run time, because they depend on capacity and a list arena can
 * regrow. Neither side hardcodes the other's layout.
 */
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  SCHEMA_HASH,
  Status,
  type SharedTables,
} from "../protocol/generated.ts";
import { bindSpans, readSpans, SPAN_SIZE, type Span } from "./bind.ts";
import type { Capacities } from "./upload.ts";

const { i32, u32, f32, ptr: PTR } = FFIType;

/**
 * Matches `EngineConfig` in `engine.rs`, including the pointer's alignment padding.
 *
 * 12 `u32` (48) + two `u8` and two reserved (52) + 4 bytes of padding so the title
 * pointer lands 8-aligned at 56 (64) + a `u32` length (68) + 4 to a multiple of 8.
 */
const CONFIG_SIZE = 72;
/** Matches `Event` in `engine.rs`: six 4-byte fields plus 32 inline text bytes. */
export const EVENT_SIZE = 56;

/**
 * The engine handle is a `u32`, not a pointer.
 *
 * It is an index plus a generation into a table the engine owns, so a handle used
 * after `close()` is a lookup miss rather than a dereference of freed memory —
 * which is what the old pointer-plus-magic-number scheme had to do to discover
 * that it had been freed. Nothing on this side may do arithmetic on it or attempt
 * to read through it; it is a token.
 */
const SYMBOLS = {
  dziri_protocol_version: { args: [], returns: u32 },
  dziri_schema_hash: { args: [], returns: u32 },
  dziri_last_error: { args: [PTR, u32], returns: u32 },
  dziri_engine_create: { args: [PTR, PTR], returns: i32 },
  dziri_engine_destroy: { args: [u32], returns: i32 },
  dziri_engine_span_count: { args: [u32, PTR], returns: i32 },
  dziri_engine_describe: { args: [u32, PTR, u32, PTR], returns: i32 },
  dziri_engine_generation: { args: [u32, PTR], returns: i32 },
  dziri_engine_tick: { args: [u32], returns: i32 },
  dziri_engine_pump: { args: [u32], returns: i32 },
  dziri_engine_drain_events: { args: [u32, PTR, u32, PTR], returns: i32 },
  dziri_engine_grow: { args: [u32, PTR], returns: i32 },
  dziri_engine_resize: { args: [u32, u32, u32], returns: i32 },
  dziri_engine_set_input_state: { args: [u32, i32, i32, i32], returns: i32 },
  dziri_engine_hit_test: { args: [u32, f32, f32, PTR], returns: i32 },
  dziri_engine_bounds: { args: [u32, u32, PTR], returns: i32 },
  dziri_engine_surface_info: { args: [u32, PTR], returns: i32 },
  dziri_engine_read_pixels: { args: [u32, PTR, u32], returns: i32 },
  dziri_engine_encode_png: { args: [u32, PTR], returns: i32 },
  dziri_engine_take_png: { args: [u32, PTR, u32], returns: i32 },
  dziri_engine_font_family: { args: [u32, PTR, u32, PTR], returns: i32 },
  dziri_engine_last_frame_ms: { args: [u32, PTR], returns: i32 },
  dziri_engine_panic_for_testing: { args: [u32], returns: i32 },
} as const;

/** The engine's file name on this platform. */
export function libraryName(): string {
  return process.platform === "win32"
    ? "dziri_engine.dll"
    : process.platform === "darwin"
      ? "libdziri_engine.dylib"
      : "libdziri_engine.so";
}

/** Where the engine is, when something already knows. See {@link useEngineLibrary}. */
let override: string | null = null;

/**
 * Names the engine binary to open, ahead of the search.
 *
 * A standalone build embeds the library and extracts it to a real path — `dlopen`
 * needs a file on disk, and on macOS so does code signing — so by the time the app
 * starts, the answer is known and no search should run. Must be called before the
 * first `Engine.open`, which is why the `dlopen` below is lazy: this module used to
 * open the library while it was being imported, so importing it *to* set the path
 * had already lost the race.
 */
export function useEngineLibrary(path: string): void {
  if (loaded !== null && override !== path) {
    throw new Error(
      `the engine is already open from ${override ?? "the search path"}; ` +
        `useEngineLibrary must be called before the first Engine.open`,
    );
  }
  override = path;
}

function libraryPath(): string {
  if (override !== null) return override;
  const name = libraryName();

  const candidates = [
    join(import.meta.dir, "..", "..", "native-src", "dziri-engine", "target", "release", name),
    join(import.meta.dir, "..", "..", "native", `${process.platform}-${process.arch}`, name),
  ];

  for (const path of candidates) if (existsSync(path)) return path;
  throw new Error(
    `no engine binary found. Run \`bun run engine\` to build it.\n  looked in:\n` +
      candidates.map((c) => `    ${c}`).join("\n"),
  );
}

/**
 * The opened library, or null until something needs it.
 *
 * Lazy on purpose. Opening at module scope meant every importer paid for a
 * `dlopen` — `bun test` loading a module that merely re-exports a type, the CLI
 * printing `--help` — and, more importantly, it made the library path unsettable
 * from TypeScript, because the only way to reach the setter was to import the
 * module that had already used it.
 */
function openLibrary() {
  return dlopen(libraryPath(), SYMBOLS).symbols;
}

type EngineSymbols = ReturnType<typeof openLibrary>;

let loaded: EngineSymbols | null = null;

function symbols(): EngineSymbols {
  return (loaded ??= openLibrary());
}

/**
 * A proxy over the symbol table, so the call sites below stay `engine.foo(…)`.
 *
 * The alternative was `symbols().foo(…)` at each of thirty call sites, which reads
 * as though the load might be doing something at each one.
 */
const engine = new Proxy({} as EngineSymbols, {
  get: (_, name: string) => symbols()[name as keyof EngineSymbols],
});

const STATUS_NAMES = Object.fromEntries(
  Object.entries(Status).map(([name, value]) => [value, name]),
) as Record<number, string>;

/**
 * Scratch for out-parameters, reused so a frame allocates nothing.
 *
 * **`ptr()` is taken at each use, never cached.** A pointer captured once at
 * module load goes stale: JavaScriptCore can relocate a typed array's backing
 * store, and the engine then writes its result into memory we no longer own —
 * which reads back as zeros and corrupts whatever now lives there. This cost an
 * hour: `bounds()`, `hitTest()` and `lastFrameMs()` all returned 0 while
 * `surfaceInfo()`, which allocated its buffer per call, worked fine.
 *
 * Taking the address at the call site is safe because JS is single-threaded and
 * the call is synchronous, so nothing can move underneath it.
 */
const scratch = new BigUint64Array(4);
const scratch32 = new Int32Array(scratch.buffer);
const scratchF32 = new Float32Array(scratch.buffer);

const errorBuf = new Uint8Array(1024);
const decoder = new TextDecoder();

/**
 * The detail behind a failure status.
 *
 * The engine returns how many bytes it *wrote*, which is the longest whole-
 * codepoint prefix that fits — so a message longer than `errorBuf` arrives cut
 * short rather than ending in a half-decoded character. The clamp stays as a
 * bound on a number that crossed the ABI, not because the engine needs it.
 */
export function lastError(): string {
  const written = engine.dziri_last_error(ptr(errorBuf) as Pointer, errorBuf.length);
  return decoder.decode(errorBuf.subarray(0, Math.min(written, errorBuf.length)));
}

function check(code: number, what: string): void {
  if (code === Status.OK) return;
  throw new Error(`${what} failed: ${STATUS_NAMES[code] ?? code} — ${lastError()}`);
}

export type EngineOptions = {
  width?: number;
  height?: number;
  title?: string;
  /** Node table capacity. Headroom: a list arena grows into it. */
  nodes: number;
  styles: number;
  /** Exact row counts, not headroom — every row is searched. */
  variants: number;
  variantSlots: number;
  media: number;
  lists: number;
  strings: number;
  stringBytes: number;
  root?: number;
  /** False renders offscreen, for screenshots and tests. */
  windowed?: boolean;
  /** Native window chrome. Fixed at creation; it cannot change afterwards. */
  decorated?: boolean;
};

export type EngineEvent = {
  kind: number;
  node: number;
  a: number;
  b: number;
  x: number;
  y: number;
  text: string;
};

export class Engine {
  /** An opaque token from the engine's handle table. Never a pointer. */
  #handle: number;
  #generation = 0n;
  #tables!: SharedTables;
  #stringBytes!: Uint8Array;
  /** Keeps the wrapped buffers reachable for as long as the engine is alive. */
  #buffers: ArrayBuffer[] = [];
  #capacities!: Capacities;

  private constructor(handle: number) {
    this.#handle = handle;
    this.#bindTables();
  }

  static open(options: EngineOptions): Engine {
    const version = engine.dziri_protocol_version();
    if (version !== PROTOCOL_VERSION) {
      throw new Error(
        `protocol mismatch: this build speaks v${PROTOCOL_VERSION}, ` +
          `the engine binary speaks v${version}. Run \`bun run gen:protocol\` and rebuild.`,
      );
    }

    /* Identity, not just version. A field rename, a reorder of two same-width
       fields, or a retype all keep the version and every field count identical
       while changing what the bytes mean — so the version alone cannot tell a
       matching pair from a stale binary. */
    const hash = engine.dziri_schema_hash();
    if (hash !== SCHEMA_HASH) {
      throw new Error(
        `schema mismatch: the generated modules hash to ` +
          `0x${SCHEMA_HASH.toString(16).padStart(8, "0")}, the engine binary to ` +
          `0x${hash.toString(16).padStart(8, "0")}.\n` +
          `  Both sides are generated from src/protocol/schema.ts, so they have drifted:\n` +
          `  run \`bun run gen:protocol\` and then \`bun run engine\`.`,
      );
    }

    const title = new TextEncoder().encode(options.title ?? "dziri");
    const config = new ArrayBuffer(CONFIG_SIZE);
    const u32v = new Uint32Array(config);
    const u8v = new Uint8Array(config);
    const u64v = new BigUint64Array(config);

    /* Field order mirrors `EngineConfig` in engine.rs exactly, and the capacity
       order mirrors `TABLES` — `media` sits between `variantSlots` and `lists`
       in both. Inserting it moved every offset after it, which is what
       PROTOCOL_VERSION 7 announces: a v6 host against a v7 binary would write
       its list capacity into the media slot and be refused at the version check
       rather than misread. */
    u32v[0] = PROTOCOL_VERSION;
    u32v[1] = options.width ?? 720;
    u32v[2] = options.height ?? 420;
    u32v[3] = options.nodes;
    u32v[4] = options.styles;
    u32v[5] = options.variants;
    u32v[6] = options.variantSlots;
    u32v[7] = options.media;
    u32v[8] = options.lists;
    u32v[9] = options.strings;
    u32v[10] = options.stringBytes;
    u32v[11] = options.root ?? 0;
    u8v[48] = options.windowed === false ? 0 : 1;
    u8v[49] = options.decorated === false ? 0 : 1;
    /* The title pointer sits at byte 56, not 52: `#[repr(C)]` aligns it to 8. */
    u64v[7] = BigInt(ptr(title));
    u32v[16] = title.length;

    // One `u32`, not a pointer-sized slot: the handle is a table token.
    const out = new Uint32Array(1);
    check(
      engine.dziri_engine_create(ptr(config) as Pointer, ptr(out) as Pointer),
      "dziri_engine_create",
    );

    const handle = out[0]!;
    // 0 is never issued, so this catches an engine that returned OK without
    // writing — which is the failure the status code alone cannot express.
    if (handle === 0) throw new Error("engine_create reported success but issued no handle");
    return new Engine(handle);
  }

  /**
   * The engine's own account of where its tables are.
   *
   * Public because the main thread forwards it verbatim to the Worker, which
   * binds the same addresses with the same function. Plain numbers, so it
   * survives `postMessage` — see `bind.ts` for why sharing the memory rather
   * than copying it is the whole point.
   */
  describe(): Span[] {
    const count = new Uint32Array(1);
    check(
      engine.dziri_engine_span_count(this.#handle, ptr(count) as Pointer),
      "dziri_engine_span_count",
    );

    const raw = new ArrayBuffer(count[0]! * SPAN_SIZE);
    const written = new Uint32Array(1);
    check(
      engine.dziri_engine_describe(
        this.#handle,
        ptr(raw) as Pointer,
        count[0]!,
        ptr(written) as Pointer,
      ),
      "dziri_engine_describe",
    );

    return readSpans(raw, written[0]!);
  }

  #bindTables(): void {
    const bound = bindSpans(this.describe());
    this.#tables = bound.tables;
    this.#stringBytes = bound.stringBytes;
    this.#capacities = bound.capacities;
    this.#buffers = bound.buffers;

    const generation = new BigUint64Array(1);
    check(
      engine.dziri_engine_generation(this.#handle, ptr(generation) as Pointer),
      "dziri_engine_generation",
    );
    this.#generation = generation[0]!;
  }

  /** The staged tables. Writes here are picked up by the next `tick`. */
  get tables(): SharedTables {
    return this.#tables;
  }

  /** The UTF-8 arena the string slot table points into. */
  get stringBytes(): Uint8Array {
    return this.#stringBytes;
  }

  /** What the tables can currently hold. Satisfies `TableHost`. */
  capacities(): Capacities {
    return this.#capacities;
  }

  /**
   * Applies staged writes, relays out what that invalidated, paints, presents.
   *
   * Re-reads the descriptor when the engine reports a new generation: a list
   * arena regrowing reallocates the tables, and every view held before that is
   * dangling.
   */
  tick(): void {
    check(engine.dziri_engine_tick(this.#handle), "dziri_engine_tick");
    this.#rebindIfMoved();
  }

  /**
   * A frame that services the window without reading the staged tables.
   *
   * What the main thread calls when the Worker holds the staging lock. See
   * `Engine::pump` in `engine.rs` for why the commit has to be skippable rather
   * than merely delayed: a link column caught mid-splice is a malformed chain,
   * not a frame of wrong pixels.
   */
  pump(): void {
    check(engine.dziri_engine_pump(this.#handle), "dziri_engine_pump");
    this.#rebindIfMoved();
  }

  #rebindIfMoved(): void {
    const generation = new BigUint64Array(1);
    check(
      engine.dziri_engine_generation(this.#handle, ptr(generation) as Pointer),
      "dziri_engine_generation",
    );
    if (generation[0]! !== this.#generation) this.#bindTables();
  }

  drainEvents(max = 32): EngineEvent[] {
    const raw = new ArrayBuffer(max * EVENT_SIZE);
    const written = new Uint32Array(1);
    check(
      engine.dziri_engine_drain_events(
        this.#handle,
        ptr(raw) as Pointer,
        max,
        ptr(written) as Pointer,
      ),
      "dziri_engine_drain_events",
    );

    const view = new DataView(raw);
    const bytes = new Uint8Array(raw);
    const out: EngineEvent[] = [];

    for (let i = 0; i < written[0]!; i++) {
      const at = i * EVENT_SIZE;
      /* `a` is the byte length for TEXT_INPUT and a key code otherwise. */
      const a = view.getInt32(at + 8, true);
      const textLen = Math.max(0, Math.min(a, 32));
      out.push({
        kind: view.getUint32(at, true),
        node: view.getInt32(at + 4, true),
        a,
        b: view.getInt32(at + 12, true),
        x: view.getFloat32(at + 16, true),
        y: view.getFloat32(at + 20, true),
        text: decoder.decode(bytes.subarray(at + 24, at + 24 + textLen)),
      });
    }
    return out;
  }

  bounds(node: number): [number, number, number, number] {
    check(
      engine.dziri_engine_bounds(this.#handle, node, ptr(scratch) as Pointer),
      "dziri_engine_bounds",
    );
    return [scratchF32[0]!, scratchF32[1]!, scratchF32[2]!, scratchF32[3]!];
  }

  hitTest(x: number, y: number): number {
    check(
      engine.dziri_engine_hit_test(this.#handle, x, y, ptr(scratch) as Pointer),
      "dziri_engine_hit_test",
    );
    return scratch32[0]!;
  }

  setInputState(hovered: number, pressed: number, focused: number): void {
    check(
      engine.dziri_engine_set_input_state(this.#handle, hovered, pressed, focused),
      "dziri_engine_set_input_state",
    );
  }

  /**
   * Grows the tables to hold at least these capacities.
   *
   * Returns whether they moved. When they did, every view handed out before is
   * dangling and has been replaced — the caller must re-read `tables` and
   * re-upload everything.
   */
  grow(caps: {
    nodes: number;
    styles: number;
    variants: number;
    variantSlots: number;
    media: number;
    lists: number;
    strings: number;
    stringBytes: number;
  }): boolean {
    /* Matches `Capacities` in `tables.rs`: eight `u32`, no padding, same order. */
    const buf = new Uint32Array(8);
    buf[0] = caps.nodes;
    buf[1] = caps.styles;
    buf[2] = caps.variants;
    buf[3] = caps.variantSlots;
    buf[4] = caps.media;
    buf[5] = caps.lists;
    buf[6] = caps.strings;
    buf[7] = caps.stringBytes;

    check(engine.dziri_engine_grow(this.#handle, ptr(buf) as Pointer), "dziri_engine_grow");

    const generation = new BigUint64Array(1);
    check(
      engine.dziri_engine_generation(this.#handle, ptr(generation) as Pointer),
      "dziri_engine_generation",
    );
    if (generation[0]! === this.#generation) return false;

    this.#bindTables();
    return true;
  }

  resize(width: number, height: number): void {
    check(engine.dziri_engine_resize(this.#handle, width, height), "dziri_engine_resize");
  }

  /** `[width, height, rowBytes, frames]`. */
  surfaceInfo(): [number, number, number, number] {
    const out = new Uint32Array(4);
    check(
      engine.dziri_engine_surface_info(this.#handle, ptr(out) as Pointer),
      "dziri_engine_surface_info",
    );
    return [out[0]!, out[1]!, out[2]!, out[3]!];
  }

  /** The last painted frame as BGRA_8888. */
  readPixels(): Uint8Array {
    const [, height, rowBytes] = this.surfaceInfo();
    const out = new Uint8Array(height * rowBytes);
    check(
      engine.dziri_engine_read_pixels(this.#handle, ptr(out) as Pointer, out.length),
      "dziri_engine_read_pixels",
    );
    return out;
  }

  /**
   * The last painted frame as a PNG.
   *
   * Two calls because the encoded size is not knowable in advance — Skia encodes
   * into the engine, then the bytes are copied out.
   */
  readPng(): Uint8Array {
    const size = new Uint32Array(1);
    check(
      engine.dziri_engine_encode_png(this.#handle, ptr(size) as Pointer),
      "dziri_engine_encode_png",
    );

    const out = new Uint8Array(size[0]!);
    check(
      engine.dziri_engine_take_png(this.#handle, ptr(out) as Pointer, out.length),
      "dziri_engine_take_png",
    );
    return out;
  }

  fontFamily(): string {
    const buf = new Uint8Array(128);
    const written = new Uint32Array(1);
    check(
      engine.dziri_engine_font_family(
        this.#handle,
        ptr(buf) as Pointer,
        buf.length,
        ptr(written) as Pointer,
      ),
      "dziri_engine_font_family",
    );
    return decoder.decode(buf.subarray(0, Math.min(written[0]!, buf.length)));
  }

  lastFrameMs(): number {
    check(
      engine.dziri_engine_last_frame_ms(this.#handle, ptr(scratch) as Pointer),
      "dziri_engine_last_frame_ms",
    );
    return scratchF32[0]!;
  }

  /** Proves a Rust panic reaches here as a status code rather than an abort. */
  panicForTesting(): number {
    return engine.dziri_engine_panic_for_testing(this.#handle);
  }

  close(): void {
    if (this.#handle === 0) return;
    check(engine.dziri_engine_destroy(this.#handle), "dziri_engine_destroy");
    // 0 is never a valid handle, so a call after `close` is refused by the engine's
    // handle table even if this object is still reachable.
    this.#handle = 0;
    /* Dropped together: every view points into memory the engine just freed. */
    this.#buffers = [];
  }
}

/** Writes a string into the arena and points a slot at it. Returns the new cursor. */
export function writeString(
  target: Engine,
  slot: number,
  text: string,
  cursor: number,
): number {
  const bytes = new TextEncoder().encode(text);
  const arena = target.stringBytes;
  if (cursor + bytes.length > arena.length) {
    throw new Error(
      `string arena is full: ${cursor} + ${bytes.length} > ${arena.length}. ` +
        `Raise \`stringBytes\`.`,
    );
  }
  arena.set(bytes, cursor);
  target.tables.strings.offset[slot] = cursor;
  target.tables.strings.length[slot] = bytes.length;
  return cursor + bytes.length;
}
