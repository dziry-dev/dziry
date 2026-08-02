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

import { collectReads, computed, signal, type ReadonlySignal } from "../runtime/signal.ts";

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

// ---------------------------------------------------------------------------
// Component-local state
// ---------------------------------------------------------------------------

/** A signal declared inside a component, and how the artifact will re-create it. */
export type Local = { signal: ReadonlySignal<unknown>; initial: unknown; name: string };

const locals: Local[] = [];
const localIndex = new WeakMap<object, number>();

export class LocalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStateError";
  }
}

/**
 * A signal declared inside a component.
 *
 * There is no render and no unmount here, and that is what makes this work rather
 * than what makes it hard: a component body runs *once*, at build time, and is then
 * erased. So this signal is created exactly once — the semantics `useState` is
 * approximating, arrived at for free. What a component-local signal lacks is not a
 * lifecycle but a **name**: `ui.gen.ts` holds `{ signal: count }`, and `resolve-refs`
 * finds that name by matching identity against module exports.
 *
 * So the compiler declares it. Each call takes a slot in a registry, and the emitter
 * writes `const locals = [signal(0), …]` into the artifact — which means the *initial
 * value* has to survive being written down, and one that cannot is a named error
 * rather than a broken module.
 *
 * A registry rather than hoisting the declaration to module scope, which is the
 * obvious alternative and needs scope analysis to be safe: the initialiser may close
 * over a parameter, every reference has to be renamed, and a nested shadow would be
 * renamed wrongly — each of those failing silently. Naming by identity is what the
 * compiler already does for everything else.
 */
export function local<T>(initial: T, name: string): ReadonlySignal<T> {
  if (!emittable(initial)) {
    throw new LocalStateError(
      `\`${name}\` is a component-local signal whose initial value cannot be written down.\n` +
        `  The generated module re-creates it — \`const locals = [signal(…)]\` — so the initial\n` +
        `  value has to be JSON-shaped: a number, string, boolean, null, or an array or plain\n` +
        `  object of those. Got ${describe(initial)}.\n` +
        `  Declare it in the window's state module instead, where it is created once and\n` +
        `  imported by name.`,
    );
  }

  const cell = signal(initial);
  localIndex.set(cell as unknown as object, locals.length);
  locals.push({ signal: cell as ReadonlySignal<unknown>, initial, name });
  return cell as unknown as ReadonlySignal<T>;
}

/** The registry slot a local occupies, or undefined for anything else. */
export function localSlotOf(value: unknown): number | undefined {
  return typeof value === "object" && value !== null ? localIndex.get(value) : undefined;
}

export function allLocals(): readonly Local[] {
  return locals;
}

/**
 * Cleared between windows, because the registry is per artifact.
 *
 * Module-level state in the compiler is safe where it is the compiler's own cursor
 * over one thing at a time — but this one is emitted, so two windows sharing it would
 * put the first window's locals in the second window's module.
 */
export function resetLocals(): void {
  locals.length = 0;
}

// ---------------------------------------------------------------------------
// Inline handlers
// ---------------------------------------------------------------------------

/** The source text an inline handler was written as, keyed by the function. */
const handlerSources = new WeakMap<object, string>();

/**
 * `onClick={() => count.set(count + 1)}` — an arrow with no export name.
 *
 * The same problem local state has, and the same answer: the artifact contains the
 * text rather than a name for it. Which is also why local state needed this — a
 * component-local signal nothing can write to is not state.
 *
 * Only the text is kept. Unlike an inline *expression*, a handler is never run at
 * build time, so there is nothing to discover by running it: whichever locals it
 * mentions are substituted by name when the artifact is written.
 */
export function handler<T extends (...args: never[]) => unknown>(fn: T, text: string): T {
  handlerSources.set(fn, text);
  return fn;
}

/** The source of an inline handler, or undefined. */
export function handlerSourceOf(value: unknown): string | undefined {
  return typeof value === "function" ? handlerSources.get(value) : undefined;
}

function emittable(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean") return true;
  if (Array.isArray(value)) return value.every(emittable);
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every(emittable);
  }
  return false;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "function") return "a function";
  if (typeof value === "object") return `a ${value.constructor?.name ?? "non-plain"} object`;
  return typeof value;
}
