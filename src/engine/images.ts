/**
 * Loading images into the engine — the host half of `images.rs`.
 *
 * The split is deliberate and matches the module's counterpart: the *tables* say
 * which node wants which `src`; getting the bytes is I/O, which is Bun's job;
 * decoding and painting is the engine's. This module is the middle step. It
 * reads the staged images table directly out of shared memory — the whole point
 * of the protocol is that a table scan needs no call — and hands resolved bytes
 * back over the one FFI entry point that does copy: `dziri_engine_provide_image`.
 *
 * ## What counts as resolved
 *
 * `http:` and `https:` fetch; everything else is a file path, read from disk.
 * Either failing is *content*, not a host error — a 404 is a broken image, and a
 * browser renders one of those without throwing — so a failure offers the engine
 * zero bytes, which its decoder rejects and caches as failed. "Offered, whatever
 * the answer" is what stops the scan from refetching the same URL every frame:
 * the engine caches by `src`, and this set mirrors that on the host side, keyed
 * per engine because two engines do not share a cache.
 */

import type { Engine } from "./host.ts";
import type { SharedTables } from "../protocol/generated.ts";

/** `src` values already offered to this engine — successfully or not. */
const offered = new WeakMap<Engine, Set<string>>();

/** Loads in flight, so `pollImages` kicked twice starts one fetch. */
const pending = new WeakMap<Engine, Map<string, Promise<void>>>();

/** Reads a string slot out of the shared arena. */
function readString(tables: SharedTables, arena: Uint8Array, slot: number): string {
  if (slot < 0 || slot >= tables.strings.offset.length) return "";
  const start = tables.strings.offset[slot]!;
  const end = start + tables.strings.length[slot]!;
  return new TextDecoder().decode(arena.subarray(start, Math.min(end, arena.length)));
}

/** The bytes behind `src`: the network for a URL, the disk for anything else. */
async function resolve(src: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await Bun.file(src).arrayBuffer());
}

/**
 * Starts loading every image the table names that has not been offered yet.
 *
 * Called once per tick from the host loop. Cheap on the steady state: the scan
 * is one pass over a small sparse table, and the `offered` set short-circuits
 * everything already seen — which matters, because the app thread republishes
 * the table on every signal change and "there is a row" cannot mean "fetch".
 */
export function pollImages(engine: Engine): void {
  const tables = engine.tables;
  const count = tables.images.node.length;
  let seen = offered.get(engine);
  if (seen === undefined) {
    seen = new Set();
    offered.set(engine, seen);
  }

  for (let row = 0; row < count; row++) {
    const node = tables.images.node[row]!;
    // The spare-row sentinel: `uploadImages` pads with i32::MAX.
    if (node < 0 || node === 0x7fffffff) continue;
    const src = readString(tables, engine.stringBytes, tables.images.src[row]!);
    if (src === "" || seen.has(src)) continue;
    seen.add(src);

    const offer = resolve(src)
      .catch(() => new Uint8Array(0))
      .then((bytes) => engine.provideImage(src, bytes));
    let flights = pending.get(engine);
    if (flights === undefined) {
      flights = new Map();
      pending.set(engine, flights);
    }
    flights.set(src, offer);
    void offer.finally(() => pending.get(engine)?.delete(src));
  }
}

/**
 * `pollImages`, plus waiting for everything it started. The headless path's
 * version: a screenshot taken before the bytes land is a picture of empty boxes,
 * and "wait for the images" is exactly what a real page load does before
 * `load` fires.
 */
export async function loadImages(engine: Engine): Promise<void> {
  pollImages(engine);
  await Promise.all([...(pending.get(engine)?.values() ?? [])]);
}
