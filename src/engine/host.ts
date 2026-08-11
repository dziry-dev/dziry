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
  EventKind,
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
 * 14 `u32` (56) + two `u8` and two reserved (60) + 4 bytes of padding so the title
 * pointer lands 8-aligned at 64 (72) + a `u32` length (76) + 4 to a multiple of 8.
 *
 * The two extra `u32` over v11 are `tween_capacity` and `keyframe_capacity`, and
 * they moved every byte after them — which is one of the reasons v12 is a version
 * bump and not only a hash change. `dziri_protocol_version` takes no arguments, so
 * it is still answerable by a binary of any vintage and the refusal happens before
 * anything reads this struct.
 */
const CONFIG_SIZE = 80;
/**
 * Matches `Event` in `engine.rs`: seven 4-byte fields plus 32 inline text bytes.
 *
 * **Checked against the engine at open time**, by `dziri_engine_event_size`. Every table
 * layout in this codebase is generated from `schema.ts` and every offset is reported by the
 * engine at runtime; `Event` is the one struct outside that, written there and again as byte
 * offsets below. The two agreed on 56 bytes only because somebody kept them in step by hand,
 * and the change that grew it to 60 — a selection anchor — would otherwise have shifted
 * `text` under a reader still using the old stride. The symptom is keystrokes arriving as
 * mojibake, not an error, which is why the check exists rather than a comment asking for care.
 */
export const EVENT_SIZE = 60;

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
  dziri_engine_event_size: { args: [], returns: u32 },
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
  dziri_engine_set_time_step: { args: [u32, f32], returns: i32 },
  dziri_engine_hit_test: { args: [u32, f32, f32, PTR], returns: i32 },
  dziri_engine_mouse_down: { args: [u32, f32, f32], returns: i32 },
  dziri_engine_mouse_move: { args: [u32, f32, f32], returns: i32 },
  dziri_engine_mouse_down_with: { args: [u32, f32, f32, u32, u32], returns: i32 },
  dziri_engine_mouse_up: { args: [u32, f32, f32], returns: i32 },
  dziri_engine_bounds: { args: [u32, u32, PTR], returns: i32 },
  dziri_engine_selection: { args: [u32, i32, PTR], returns: i32 },
  dziri_engine_open_select: { args: [u32, PTR], returns: i32 },
  dziri_engine_listbox_selection: { args: [u32, i32, PTR, u32, PTR], returns: i32 },
  dziri_engine_scroll: { args: [u32, f32, f32, f32, f32, PTR], returns: i32 },
  dziri_engine_surface_info: { args: [u32, PTR], returns: i32 },
  dziri_engine_read_pixels: { args: [u32, PTR, u32], returns: i32 },
  dziri_engine_encode_png: { args: [u32, PTR], returns: i32 },
  dziri_engine_take_png: { args: [u32, PTR, u32], returns: i32 },
  dziri_engine_font_family: { args: [u32, PTR, u32, PTR], returns: i32 },
  dziri_engine_alert: { args: [u32, u32, PTR, u32, PTR, u32], returns: i32 },
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
 * The `selected` of every event that is not a list box's `CHANGE`.
 *
 * One shared frozen array rather than a fresh `[]` per event, because this is on the drain
 * path and a mouse move produces one of these every frame. Frozen so a consumer that
 * mutated it could not reach the next event's.
 */
const EMPTY: readonly number[] = Object.freeze([]) as readonly number[];

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
  tweens: number;
  keyframes: number;
  controls: number;
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
  /** The caret — the selection focus — for the editing events, or -1. */
  b: number;
  /** The selection anchor. Equal to `b` when collapsed, which is an ordinary caret. */
  c: number;
  x: number;
  y: number;
  text: string;
  /**
   * A list box's selected option indices, on a `CHANGE` and nowhere else.
   *
   * Attached at drain time rather than packed into the record, because the record is a
   * fixed `#[repr(C)]` struct and this is a set of unbounded size. It travels *in the
   * event* because the worker — which dispatches handlers — never holds the engine handle,
   * so it could not ask for it later even though the accessor exists.
   *
   * Empty for every other event and for a list box with nothing selected. Those two are
   * not distinguished here on purpose: the runtime already knows which it is from
   * `ui.controls.kind`, and inventing a null to carry the same fact twice is how the two
   * get to disagree.
   */
  selected: readonly number[];
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

    /* `Event` is the one struct the generator does not own — its fields are written in
       `engine.rs` and again as byte offsets in `drainEvents` — so its stride is checked here
       rather than assumed. The version and the hash cannot catch it: neither is derived from
       `Event`, so growing it by a field leaves both untouched while moving `text` under a
       reader still using the old stride. That reads as keystrokes arriving corrupted, which
       is a much worse thing to debug than this message. */
    const eventSize = engine.dziri_engine_event_size();
    if (eventSize !== EVENT_SIZE) {
      throw new Error(
        `event layout mismatch: this build decodes ${EVENT_SIZE}-byte events, the engine ` +
          `binary writes ${eventSize}.\n` +
          `  \`Event\` in engine.rs and EVENT_SIZE in host.ts are two hand-written copies of ` +
          `one layout; they have drifted.`,
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
    u32v[9] = options.tweens;
    u32v[10] = options.keyframes;
    u32v[11] = options.controls;
    u32v[12] = options.strings;
    u32v[13] = options.stringBytes;
    u32v[14] = options.root ?? 0;
    u8v[60] = options.windowed === false ? 0 : 1;
    u8v[61] = options.decorated === false ? 0 : 1;
    /* The title pointer sits at byte 64, not 64-adjacent by accident: `#[repr(C)]`
       aligns it to 8, and with `controls` added the two flag bytes plus their two
       reserved bytes now fill 60..64 exactly rather than leaving a 4-byte hole. */
    u64v[8] = BigInt(ptr(title));
    u32v[18] = title.length;

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
      const kind = view.getUint32(at, true);
      const node = view.getInt32(at + 4, true);
      const b = view.getInt32(at + 12, true);
      out.push({
        kind,
        node,
        a,
        b,
        c: view.getInt32(at + 16, true),
        x: view.getFloat32(at + 20, true),
        y: view.getFloat32(at + 24, true),
        text: decoder.decode(bytes.subarray(at + 28, at + 28 + textLen)),
        // A list box's `CHANGE` carries how many options are selected in `b`, and every
        // other `CHANGE` leaves it 0 — so `b` doubles as both the gate and the exact
        // buffer size, and the read cannot truncate. The set itself is fetched here,
        // where the engine handle is, because the worker that will dispatch the handler
        // does not have one.
        selected:
          kind === EventKind.CHANGE && b > 0 ? this.listboxSelection(node, b) : EMPTY,
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

  /**
   * A real press and release at a point, as the window pump would deliver it.
   *
   * Distinct from `setInputState` in kind, not just in spelling: that one *declares* a
   * hover, this one *happens*. Hit-testing runs, a disabled control swallows it, a
   * label forwards it, and a checkbox ticks — none of which can be reached by
   * asserting the state a press would have left behind.
   *
   * Split into two calls so a caller can hold the button down, which is the only way
   * to render `:active`.
   */
  mouseDown(x: number, y: number): void {
    check(engine.dziri_engine_mouse_down(this.#handle, x, y), "dziri_engine_mouse_down");
  }

  mouseUp(x: number, y: number): void {
    check(engine.dziri_engine_mouse_up(this.#handle, x, y), "dziri_engine_mouse_up");
  }

  mouseMove(x: number, y: number): void {
    check(engine.dziri_engine_mouse_move(this.#handle, x, y), "dziri_engine_mouse_move");
  }

  /** A press carrying a click count and Shift, for a double click or a Shift+click. */
  mouseDownWith(x: number, y: number, clicks: number, shift: boolean): void {
    check(
      engine.dziri_engine_mouse_down_with(this.#handle, x, y, clicks, shift ? 1 : 0),
      "dziri_engine_mouse_down_with",
    );
  }

  /**
   * Presses and releases at the centre of a node's layout box.
   *
   * A node id rather than a coordinate pair, because a golden addressed by pixels
   * stops pointing at the thing it names the first time the layout above it changes —
   * the same argument the browser probes make for reading coordinates off real rects.
   * The press itself is still a press at a point, so nothing about the path is
   * shortcut.
   */
  clickNode(node: number): void {
    const [x, y, w, h] = this.bounds(node);
    this.mouseDown(x + w / 2, y + h / 2);
    this.mouseUp(x + w / 2, y + h / 2);
  }

  /**
   * Drags across a node's box, from `from` to `to` as fractions of its width.
   *
   * Fractions rather than pixels for the reason `clickNode` takes a node id: a golden
   * addressed in pixels stops pointing at what it names the first time the layout above it
   * moves.
   *
   * The motion step is what makes this a drag rather than two clicks, and it is not
   * optional — a selection's focus follows `mouse_move`, so a press and a release at
   * different points select nothing at all.
   */
  dragNode(node: number, from: number, to: number): void {
    const [x, y, w, h] = this.bounds(node);
    const mid = y + h / 2;
    this.mouseDown(x + w * from, mid);
    this.mouseMove(x + w * to, mid);
    this.mouseUp(x + w * to, mid);
  }

  /**
   * Shows the platform's own modal message box, and **blocks until it is dismissed**.
   *
   * `SDL_ShowSimpleMessageBox` behind the FFI, so it is a Win32 task dialog, an `NSAlert`, or
   * the GTK/portal box — nothing dziri draws. There was no need to vendor anyone's
   * implementation of this: SDL3 is already linked, and a dialog drawn by dziri would be the
   * one part of an app that does not look like the system it is running on.
   *
   * **Must be called on the engine thread**, which the handle guard enforces anyway: SDL
   * requires a message box to be shown from the thread that initialised video. That is why
   * `alert()` in app code posts a message rather than calling this — see `runtime/alert.ts`.
   *
   * Headless is a no-op, so a handler ending in `alert("saved")` does not break a screenshot
   * or a golden scenario.
   *
   * The strings go across as pointer + byte length, UTF-8, no terminator — the first text to
   * cross this boundary *inbound*, and the convention chosen because a length is what this
   * side already has.
   */
  alert(message: string, title = "", level: 0 | 1 | 2 = 0): void {
    const titleBytes = new TextEncoder().encode(title);
    const messageBytes = new TextEncoder().encode(message);
    check(
      engine.dziri_engine_alert(
        this.#handle,
        level,
        // A zero-length `Uint8Array` has no address to take, so an empty title is passed as a
        // null pointer with a length of 0 — which the Rust side reads as an empty string.
        titleBytes.length === 0 ? null : (ptr(titleBytes) as Pointer),
        titleBytes.length,
        messageBytes.length === 0 ? null : (ptr(messageBytes) as Pointer),
        messageBytes.length,
      ),
      "dziri_engine_alert",
    );
  }

  /**
   * The selected range in a field, in document order, or null when nothing is selected.
   *
   * The selection has no signal — it crosses to Bun only as two numbers beside a keystroke —
   * so this is the only way to ask what a drag built. Without it the pointer half of
   * selecting could only be checked through the value after an edit, which tests two things
   * at once and blames the wrong one when it fails.
   */
  selectionOf(node: number): [number, number] | null {
    check(
      engine.dziri_engine_selection(this.#handle, node, ptr(scratch) as Pointer),
      "dziri_engine_selection",
    );
    const [start, end] = [scratch32[0]!, scratch32[1]!];
    return start < 0 ? null : [start, end];
  }

  /**
   * The open `<select>` and the option it shows, or null when no picker is open.
   *
   * The only way to ask, for the reason {@link Engine.selectionOf} is: openness is engine
   * state that reaches Bun as an event and nothing else. Both numbers together because both
   * are always wanted at once — a golden can show that *a* dropdown is open, and is at its
   * worst at showing *which option is highlighted in it*, since a highlight is a few pixels
   * of background colour.
   */
  openSelect(): { select: number; option: number } | null {
    check(
      engine.dziri_engine_open_select(this.#handle, ptr(scratch) as Pointer),
      "dziri_engine_open_select",
    );
    const [select, option] = [scratch32[0]!, scratch32[1]!];
    return select < 0 ? null : { select, option };
  }

  /**
   * Which options of a `<select multiple>` are selected, as indices in document order.
   *
   * The only way to ask, for the reason {@link Engine.selectionOf} is — a list box's
   * selection is engine state with no signal behind it. Unlike a single select's, it is a
   * *set*, so it cannot ride in the `CHANGE` event: one `i32` does not hold one, and a
   * bitmask would be silently wrong past 31 options.
   *
   * `cap` is the option count, so it cannot truncate: a list box has as many selectable
   * options as it has options, and the buffer is sized from the same table the engine walks.
   */
  listboxSelection(node: number, cap: number): number[] {
    if (cap <= 0) return [];
    const out = new Int32Array(cap);
    const written = new Uint32Array(1);
    check(
      engine.dziri_engine_listbox_selection(
        this.#handle,
        node,
        ptr(out) as Pointer,
        cap,
        ptr(written) as Pointer,
      ),
      "dziri_engine_listbox_selection",
    );
    return Array.from(out.subarray(0, written[0]!));
  }

  /**
   * Scrolls whatever box is under `(x, y)` by `(dx, dy)` pixels, glide already settled.
   *
   * Settled deliberately: a wheel glides, so the position right after aiming one depends on
   * how many frames happened to run, and a screenshot of that is not reproducible. Pixels
   * rather than wheel notches, so a scenario does not encode the engine's 48px notch.
   *
   * Returns where the scrolled box actually settled, `[x, y]` — not what was asked for. A
   * scroll is clamped to what the content can give, so a caller that aims a later press by
   * subtracting its own request misses by the difference.
   */
  scroll(x: number, y: number, dx: number, dy: number): [number, number] {
    check(
      engine.dziri_engine_scroll(this.#handle, x, y, dx, dy, ptr(scratch) as Pointer),
      "dziri_engine_scroll",
    );
    return [scratchF32[0]!, scratchF32[1]!];
  }

  /** Presses `clicks` times at a node's centre — 2 for a word, 3 for the whole value. */
  clickNodeTimes(node: number, clicks: number, shift = false): void {
    const [x, y, w, h] = this.bounds(node);
    this.mouseDownWith(x + w / 2, y + h / 2, clicks, shift);
    this.mouseUp(x + w / 2, y + h / 2);
  }

  setInputState(hovered: number, pressed: number, focused: number): void {
    check(
      engine.dziri_engine_set_input_state(this.#handle, hovered, pressed, focused),
      "dziri_engine_set_input_state",
    );
  }

  /**
   * Fixes every subsequent frame's length in seconds, or restores the wall clock.
   *
   * A negative `dt` restores the clock. This is what makes an animation
   * screenshottable: `tick()` normally reads the clock, so the same scenario would be
   * a different picture every run — and an animation golden is, by definition, a
   * frame at an exact `t`.
   */
  setTimeStep(dt: number): void {
    check(engine.dziri_engine_set_time_step(this.#handle, dt), "dziri_engine_set_time_step");
  }

  /**
   * Grows the tables to hold at least these capacities.
   *
   * Returns whether they moved. When they did, every view handed out before is
   * dangling and has been replaced — the caller must re-read `tables` and
   * re-upload everything.
   */
  grow(caps: Capacities): boolean {
    /* Matches `Capacities` in `tables.rs`: eleven `u32`, no padding, same order. */
    const buf = new Uint32Array(11);
    buf[0] = caps.nodes;
    buf[1] = caps.styles;
    buf[2] = caps.variants;
    buf[3] = caps.variantSlots;
    buf[4] = caps.media;
    buf[5] = caps.lists;
    buf[6] = caps.tweens;
    buf[7] = caps.keyframes;
    buf[8] = caps.controls;
    buf[9] = caps.strings;
    buf[10] = caps.stringBytes;

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
