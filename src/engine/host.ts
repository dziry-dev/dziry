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
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  F,
  FIELD_COUNTS,
  FIELD_NAMES,
  FIELD_SIZES,
  FIELD_VIEWS,
  PROTOCOL_VERSION,
  SCHEMA_HASH,
  Status,
  TABLE_NAMES,
  type SharedTables,
  type TableName,
} from "../protocol/generated.ts";

const { i32, u32, f32, ptr: PTR } = FFIType;

/** Matches `SpanDesc` in `tables.rs`: two `i32`, a `u64` (8-aligned), two `u32`. */
const SPAN_SIZE = 24;
/** Matches `EngineConfig` in `engine.rs`, including the pointer's alignment padding. */
const CONFIG_SIZE = 64;
/** Matches `Event` in `engine.rs`: six 4-byte fields plus 32 inline text bytes. */
export const EVENT_SIZE = 56;

/** A span belonging to a named region rather than a table field. */
const REGION = -1;
const REGION_STRING_BYTES = 0;

const SYMBOLS = {
  dziri_protocol_version: { args: [], returns: u32 },
  dziri_schema_hash: { args: [], returns: u32 },
  dziri_last_error: { args: [PTR, u32], returns: u32 },
  dziri_engine_create: { args: [PTR, PTR], returns: i32 },
  dziri_engine_destroy: { args: [PTR], returns: i32 },
  dziri_engine_span_count: { args: [PTR, PTR], returns: i32 },
  dziri_engine_describe: { args: [PTR, PTR, u32, PTR], returns: i32 },
  dziri_engine_generation: { args: [PTR, PTR], returns: i32 },
  dziri_engine_tick: { args: [PTR], returns: i32 },
  dziri_engine_drain_events: { args: [PTR, PTR, u32, PTR], returns: i32 },
  dziri_engine_grow: { args: [PTR, PTR], returns: i32 },
  dziri_engine_resize: { args: [PTR, u32, u32], returns: i32 },
  dziri_engine_set_input_state: { args: [PTR, i32, i32, i32], returns: i32 },
  dziri_engine_hit_test: { args: [PTR, f32, f32, PTR], returns: i32 },
  dziri_engine_bounds: { args: [PTR, u32, PTR], returns: i32 },
  dziri_engine_surface_info: { args: [PTR, PTR], returns: i32 },
  dziri_engine_read_pixels: { args: [PTR, PTR, u32], returns: i32 },
  dziri_engine_encode_png: { args: [PTR, PTR], returns: i32 },
  dziri_engine_take_png: { args: [PTR, PTR, u32], returns: i32 },
  dziri_engine_font_family: { args: [PTR, PTR, u32, PTR], returns: i32 },
  dziri_engine_last_frame_ms: { args: [PTR, PTR], returns: i32 },
  dziri_engine_panic_for_testing: { args: [PTR], returns: i32 },
} as const;

function libraryPath(): string {
  const name =
    process.platform === "win32"
      ? "dziri_engine.dll"
      : process.platform === "darwin"
        ? "libdziri_engine.dylib"
        : "libdziri_engine.so";

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

const lib = dlopen(libraryPath(), SYMBOLS);
const engine = lib.symbols;

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
  #handle: Pointer;
  #generation = 0n;
  #tables!: SharedTables;
  #stringBytes!: Uint8Array;
  /** Keeps the wrapped buffers reachable for as long as the engine is alive. */
  #buffers: ArrayBuffer[] = [];

  private constructor(handle: Pointer) {
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

    u32v[0] = PROTOCOL_VERSION;
    u32v[1] = options.width ?? 720;
    u32v[2] = options.height ?? 420;
    u32v[3] = options.nodes;
    u32v[4] = options.styles;
    u32v[5] = options.variants;
    u32v[6] = options.variantSlots;
    u32v[7] = options.lists;
    u32v[8] = options.strings;
    u32v[9] = options.stringBytes;
    u32v[10] = options.root ?? 0;
    u8v[44] = options.windowed === false ? 0 : 1;
    u8v[45] = options.decorated === false ? 0 : 1;
    /* The title pointer sits at byte 48, not 44: `#[repr(C)]` aligns it to 8. */
    u64v[6] = BigInt(ptr(title));
    u32v[14] = title.length;

    const out = new BigUint64Array(1);
    check(
      engine.dziri_engine_create(ptr(config) as Pointer, ptr(out) as Pointer),
      "dziri_engine_create",
    );

    const handle = Number(out[0]!) as Pointer;
    if (!handle) throw new Error("engine_create reported success but returned null");
    return new Engine(handle);
  }

  /**
   * Wraps every span as a typed array over the engine's own memory.
   *
   * **No finalizer is passed to `toArrayBuffer`.** The three-argument form
   * attaches none, which is what makes this safe: the memory belongs to Rust,
   * and a JS-side deallocator would free it out from under the engine. Rust
   * allocating and Bun viewing is the only direction that works.
   */
  #bindTables(): void {
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

    const view = new DataView(raw);
    const byIndex: Record<string, Record<string, unknown>> = {};
    const seen: Record<string, number> = {};
    this.#buffers = [];

    for (let i = 0; i < written[0]!; i++) {
      const at = i * SPAN_SIZE;
      const table = view.getInt32(at, true);
      const field = view.getInt32(at + 4, true);
      const address = Number(view.getBigUint64(at + 8, true));
      const elemSize = view.getUint32(at + 16, true);
      const capacity = view.getUint32(at + 20, true);

      const buffer = toArrayBuffer(address as Pointer, 0, elemSize * capacity);
      this.#buffers.push(buffer);

      if (table === REGION) {
        if (field === REGION_STRING_BYTES) this.#stringBytes = new Uint8Array(buffer);
        continue;
      }

      const name = TABLE_NAMES[table];
      if (!name) throw new Error(`descriptor names table ${table}, which the schema does not`);

      const Ctor = (FIELD_VIEWS[name] as Array<new (b: ArrayBuffer) => unknown>)[field];
      if (!Ctor) {
        throw new Error(
          `descriptor has ${name}.${field}, but the schema stops at ` +
            `${FIELD_COUNTS[name]} fields — regenerate and rebuild`,
        );
      }

      /* Width is checked per span, not assumed.
         `elemSize` used to be read here and never validated, which meant the
         descriptor could disagree with the schema about a field's *type* and
         still bind cleanly — an `i32` column wrapped as `Float32Array` reads
         every value as a denormal rather than raising anything. */
      const expected = FIELD_SIZES[name][field];
      if (elemSize !== expected) {
        throw new Error(
          `${name}.${FIELD_NAMES[name][field] ?? field}: the engine reports ` +
            `${elemSize}-byte elements, the schema says ${expected}. ` +
            `Rebuild the engine (\`bun run engine\`).`,
        );
      }

      (byIndex[name] ??= {})[String(field)] = new Ctor(buffer);
      seen[name] = (seen[name] ?? 0) + 1;
    }

    /* The startup backstop. `SCHEMA_HASH` already proved both sides came from
       the same schema, so this can only fire if the descriptor itself is built
       wrong — a bug in `Tables::plan` rather than a version skew. */
    for (const name of TABLE_NAMES) {
      if (seen[name] !== FIELD_COUNTS[name]) {
        throw new Error(
          `table ${name}: the engine reported ${seen[name] ?? 0} fields, ` +
            `the schema says ${FIELD_COUNTS[name]}. Rebuild the engine.`,
        );
      }
    }

    /* The descriptor carries field *indices*; the rest of the runtime wants
       names. `FIELD_ORDER` comes from the same generated map, so the two cannot
       drift apart. */
    const named: Record<string, Record<string, unknown>> = {};
    for (const name of TABLE_NAMES) {
      named[name] = {};
      FIELD_ORDER[name].forEach((fieldName, index) => {
        named[name]![fieldName] = byIndex[name]![String(index)];
      });
    }
    this.#tables = named as unknown as SharedTables;

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

  /**
   * Applies staged writes, relays out what that invalidated, paints, presents.
   *
   * Re-reads the descriptor when the engine reports a new generation: a list
   * arena regrowing reallocates the tables, and every view held before that is
   * dangling.
   */
  tick(): void {
    check(engine.dziri_engine_tick(this.#handle), "dziri_engine_tick");

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
    lists: number;
    strings: number;
    stringBytes: number;
  }): boolean {
    /* Matches `Capacities` in `tables.rs`: six `u32`, no padding. */
    const buf = new Uint32Array(7);
    buf[0] = caps.nodes;
    buf[1] = caps.styles;
    buf[2] = caps.variants;
    buf[3] = caps.variantSlots;
    buf[4] = caps.lists;
    buf[5] = caps.strings;
    buf[6] = caps.stringBytes;

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
    if (!this.#handle) return;
    check(engine.dziri_engine_destroy(this.#handle), "dziri_engine_destroy");
    this.#handle = 0 as Pointer;
    /* Dropped together: every view points into memory the engine just freed. */
    this.#buffers = [];
  }
}

/**
 * Field names per table, in descriptor order.
 *
 * Derived from the generated `F` map rather than restated, so it cannot drift.
 */
const FIELD_ORDER: Record<TableName, string[]> = (() => {
  const out = {} as Record<TableName, string[]>;
  for (const table of TABLE_NAMES) {
    const fields = F[table] as Record<string, number>;
    out[table] = Object.keys(fields).sort((a, b) => fields[a]! - fields[b]!);
  }
  return out;
})();

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
