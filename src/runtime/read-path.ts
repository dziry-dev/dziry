/**
 * Reads a recorded path out of a real value.
 *
 * The other half of item-path.ts: the compiler records t.title as ["title"],
 * and this is what turns that back into a value once one exists. It lives here
 * rather than beside the recorder because the split follows *when the code runs* —
 * recording is build-time only, reading happens every update — and the import went
 * the wrong way across that line. ../compiler/item-path.ts is a compiler module
 * carrying build-time proxies and error classes; importing a function out of it put
 * all of that in the runtime bundle, where none of it can ever execute.
 *
 * The type still comes from there, because a type erases and the two halves have to
 * agree on the shape they exchange.
 *
 * Shared rather than duplicated: list rows read item paths, and route loaders read
 * data/error paths off their exit values — the same walk, two callers, one definition.
 */
import type { ItemPath } from "../compiler/item-path.ts";

export function readPath(item: unknown, path: ItemPath): unknown {
  let current: unknown = item;
  for (const step of path) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}
