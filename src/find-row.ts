/**
 * A binary search over a sorted `Int32Array`, in its own module so the runtime
 * can have it without having the compiler's tables.
 *
 * It lived in `ir.ts`, which is the natural home for it and cost more than it
 * looked. `list-runtime.ts` imports this one function; every other import it has
 * from `ir.ts` is type-only and erased. But a value import is not erased, so the
 * bundler pulled `ir.ts` in whole — and `ir.ts` builds `STYLE_FIELDS`,
 * `INITIAL_STYLE`, `INHERITED_FIELDS` and `LAYOUT_FIELDS` at module scope, the
 * last two by `.filter().map()` over the first. The runtime shipped the name and
 * initial value of every CSS field the compiler knows about, and used none of
 * them.
 *
 * `runtime-surface` is what noticed: adding fourteen transform fields moved the
 * *runtime* bundle by 884 bytes, which is exactly the shape of regression that
 * ratchet exists to catch — no new runtime surface, no new runtime behaviour,
 * just compile-time data quietly riding along. Splitting the file is the fix
 * rather than raising the limit.
 */

/**
 * Index of `value` in a sorted array, or -1.
 *
 * Used for the state and interactive tables, both of which are consulted only for
 * the handful of nodes involved in the current interaction.
 */
export function findRow(sorted: Int32Array, value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid]!;
    if (v === value) return mid;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
