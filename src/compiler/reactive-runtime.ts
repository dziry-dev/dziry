/**
 * What a rewritten window module imports.
 *
 * A compiler module rather than a runtime one, and that placement is the point:
 * files under `windows/` are only ever *imported by the compiler*, so nothing here
 * reaches the shipped bundle. `$` and `$m` are re-exported from `signal.ts` because
 * the generated artifact needs them too — an emitted expression contains `$(count)`
 * — but `inline` is build-time only and would be dead weight in the runtime.
 */
export { $, $m } from "../runtime/signal.ts";

import { collectReads, computed, type ReadonlySignal } from "../runtime/signal.ts";

/** The source text an inline cell was compiled from, keyed by the cell. */
const sources = new WeakMap<object, string>();

/** The signals it read, discovered by running it once. */
const deps = new WeakMap<object, ReadonlySignal<unknown>[]>();

/**
 * A `computed` that remembers the expression it came from.
 *
 * Every other reference survives the compiler/runtime boundary by being a
 * module-level export the artifact can import by name. A cell the transform created
 * cannot be: it is born inside a component, and components are erased. What it
 * *can* do is carry its own source, and the transform is holding that text anyway —
 * so the artifact contains the expression rather than a name for it.
 *
 * The same device `router.matches()` already uses, with the difference that nothing
 * has to be reconstructed here. `resolve-refs` rebuilds a match from `{signal, path}`
 * by hand; this hands over what the author actually wrote.
 */
export function inline<T>(compute: () => T, text: string): unknown {
  // Run it once, now, for two answers at once: what it reads, and what it is.
  //
  // `computed` tracks dependencies well enough to invalidate but never reports them,
  // so the list has to be collected here — the compiler needs it to import each
  // signal into the artifact.
  let value!: T;
  const read = collectReads(() => {
    value = compute();
  });

  // Nothing reactive was read, so this is a constant and returning it plainly is
  // both cheaper and more honest than a cell that can never change. `{1 + 1}` is the
  // obvious case.
  //
  // It is also how the route keeps working. `router.path.value` yields a marker
  // rather than going through `$`, so an expression interpolating it reads no signal
  // *here* — and handing the marker back unchanged lets the existing route binding
  // claim it, instead of two mechanisms fighting over the same expression. That
  // stops mattering when §5.3 deletes the route's marker and it becomes an ordinary
  // signal like any other.
  if (read.size === 0) return value;

  const cell = computed(compute);
  sources.set(cell, text);
  deps.set(cell, [...read]);
  return cell;
}

/** The expression behind an inline cell, or undefined. */
export function inlineSourceOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? sources.get(value) : undefined;
}

/** The signals an inline cell reads. Empty for anything that is not one. */
export function depsOf(value: unknown): ReadonlySignal<unknown>[] {
  return (typeof value === "object" && value !== null ? deps.get(value) : undefined) ?? [];
}
