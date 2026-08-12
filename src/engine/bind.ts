/**
 * Turning the engine's span descriptor into typed-array views.
 *
 * Split out of `Engine` because **this is the half that crosses threads.** The
 * engine handle does not: the registry pins it to the thread that called
 * `create`, since SDL pins its window and event pump there. The *memory* has no
 * such restriction — a pointer is a pointer in one address space, and Bun's
 * Workers are threads in the same process, so a Worker can wrap the engine's
 * tables with `toArrayBuffer` and write them directly.
 *
 * That is what keeps the zero-copy protocol intact once app code moves off the
 * main thread. The alternative — the Worker keeping its own arrays and posting
 * diffs — would put a serialize/copy step back in the middle of the one path this
 * whole design exists to keep free of one.
 *
 * So the main thread asks the engine to describe itself and forwards the answer;
 * the Worker binds it here. Both sides run the same function, which is the point:
 * a discrepancy between how the two threads interpret a span is exactly the class
 * of bug the generated schema exists to prevent.
 */
import { toArrayBuffer, type Pointer } from "bun:ffi";
import {
  FIELD_COUNTS,
  FIELD_NAMES,
  FIELD_SIZES,
  FIELD_VIEWS,
  F,
  TABLE_NAMES,
  type SharedTables,
  type TableName,
} from "../protocol/generated.ts";
import type { Capacities } from "./upload.ts";

/** Matches `SpanDesc` in `tables.rs`: two `i32`, a `u64` (8-aligned), two `u32`. */
export const SPAN_SIZE = 24;

/** A span belonging to a named region rather than a table field. */
export const REGION = -1;
export const REGION_STRING_BYTES = 0;

/**
 * One span, as plain numbers.
 *
 * Plain because it is `postMessage`d to the Worker: an address has to survive
 * structured cloning, and a `Pointer` does not mean anything on the far side
 * until it is turned back into a view there.
 */
export type Span = {
  table: number;
  field: number;
  address: number;
  elemSize: number;
  capacity: number;
};

export type Bound = {
  tables: SharedTables;
  stringBytes: Uint8Array;
  capacities: Capacities;
  /** Held so the wrapped buffers stay reachable for as long as the tables are used. */
  buffers: ArrayBuffer[];
};

/** Parses the raw descriptor the engine wrote. */
export function readSpans(raw: ArrayBuffer, count: number): Span[] {
  const view = new DataView(raw);
  const spans: Span[] = [];

  for (let i = 0; i < count; i++) {
    const at = i * SPAN_SIZE;
    spans.push({
      table: view.getInt32(at, true),
      field: view.getInt32(at + 4, true),
      address: Number(view.getBigUint64(at + 8, true)),
      elemSize: view.getUint32(at + 16, true),
      capacity: view.getUint32(at + 20, true),
    });
  }
  return spans;
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

/**
 * Wraps every span as a typed array over the engine's own memory.
 *
 * **No finalizer is passed to `toArrayBuffer`.** The three-argument form attaches
 * none, which is what makes this safe: the memory belongs to Rust, and a JS-side
 * deallocator would free it out from under the engine. Rust allocating and Bun
 * viewing is the only direction that works — and it is doubly true from a Worker,
 * where the collector that would run the finalizer is not even the one the engine
 * shares a thread with.
 */
export function bindSpans(spans: readonly Span[]): Bound {
  const byIndex: Record<string, Record<string, unknown>> = {};
  const seen: Record<string, number> = {};
  const buffers: ArrayBuffer[] = [];
  const capacity: Record<string, number> = {};
  let stringBytes: Uint8Array | undefined;

  for (const span of spans) {
    const buffer = toArrayBuffer(span.address as Pointer, 0, span.elemSize * span.capacity);
    buffers.push(buffer);

    if (span.table === REGION) {
      if (span.field === REGION_STRING_BYTES) {
        stringBytes = new Uint8Array(buffer);
        capacity["stringBytes"] = span.capacity;
      }
      continue;
    }

    const name = TABLE_NAMES[span.table];
    if (!name) throw new Error(`descriptor names table ${span.table}, which the schema does not`);

    const Ctor = (FIELD_VIEWS[name] as Array<new (b: ArrayBuffer) => unknown>)[span.field];
    if (!Ctor) {
      throw new Error(
        `descriptor has ${name}.${span.field}, but the schema stops at ` +
          `${FIELD_COUNTS[name]} fields — regenerate and rebuild`,
      );
    }

    /* Width is checked per span, not assumed.
       `elemSize` used to be read here and never validated, which meant the
       descriptor could disagree with the schema about a field's *type* and
       still bind cleanly — an `i32` column wrapped as `Float32Array` reads
       every value as a denormal rather than raising anything. */
    const expected = FIELD_SIZES[name][span.field];
    if (span.elemSize !== expected) {
      throw new Error(
        `${name}.${FIELD_NAMES[name][span.field] ?? span.field}: the engine reports ` +
          `${span.elemSize}-byte elements, the schema says ${expected}. ` +
          `Rebuild the engine (\`bun run engine\`).`,
      );
    }

    (byIndex[name] ??= {})[String(span.field)] = new Ctor(buffer);
    seen[name] = (seen[name] ?? 0) + 1;
    capacity[name] = span.capacity;
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

  if (stringBytes === undefined) {
    throw new Error("descriptor carried no string arena — rebuild the engine");
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

  /* `layout` is sized by `nodes` and has no capacity of its own, so it is not
     asked for here — the eleven names below are exactly `Capacities` in
     `tables.rs`, which is what `grow` takes. */
  const capacities: Capacities = {
    nodes: capacity["nodes"] ?? 0,
    styles: capacity["styles"] ?? 0,
    variants: capacity["variants"] ?? 0,
    variantSlots: capacity["variantSlots"] ?? 0,
    media: capacity["media"] ?? 0,
    lists: capacity["lists"] ?? 0,
    tweens: capacity["tweens"] ?? 0,
    keyframes: capacity["keyframes"] ?? 0,
    controls: capacity["controls"] ?? 0,
    images: capacity["images"] ?? 0,
    strings: capacity["strings"] ?? 0,
    stringBytes: capacity["stringBytes"] ?? 0,
  };

  return { tables: named as unknown as SharedTables, stringBytes, capacities, buffers };
}
