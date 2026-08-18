/**
 * `source()` — a signal fed from outside the process.
 *
 * The push half of dziri's reactivity: `signal` and `computed` are written
 * from inside; `source` is written by an external subscription. Two shapes,
 * one function — the second argument is the initial value, and the first is
 * "how to subscribe", a function that receives `set`:
 *
 * ```ts
 * // a callback source — no dependency but dziri
 * export const config = source<Config>(
 *   (set) => {
 *     const w = fs.watch("config.json", async () => set(await readConfig()));
 *     return () => w.close();               // the unsubscribe
 *   },
 *   readConfigSync(),
 * );
 *
 * // an Effect Stream — the subscribe returns a Stream, recognised structurally
 * export const todos = source<Todo[]>(() => liveTodos(), []);
 * ```
 *
 * The subscribe runs once, at launch (`effects.ts::startSources`), not at module
 * eval — so it does not fire while the compiler imports the module. dziri calls it
 * with `set` and inspects what it returned: an unsubscribe function is kept for
 * window close; an Effect `Stream` (recognised by `Symbol.for("effect/Stream")`)
 * is run with `Stream.runForEach`, and quitting interrupts it.
 *
 * Effect stays optional: the callback shape never imports `effect`; the package
 * loads only when a returned value is a Stream. dziri cannot name `Stream<A>` to
 * infer `A` (its type parameter lives under a `unique symbol` only `effect`
 * exports), so the initial value carries the type.
 */
import { signal, type ReadonlySignal } from "./signal.ts";

/** A source the runtime must start: a cell, and the subscribe that feeds it. */
export type Source = {
  cell: { set(value: unknown): void };
  subscribe: (set: (value: unknown) => void) => unknown;
};

/** Registered at module scope; started by `effects.ts::startSources` at launch. */
const sources: Source[] = [];

export function source<A>(
  subscribe: (set: (value: A) => void) => unknown,
  initial: A,
): ReadonlySignal<A> {
  const cell = signal(initial);
  sources.push({
    cell: cell as unknown as { set(value: unknown): void },
    subscribe: subscribe as (set: (value: unknown) => void) => unknown,
  });
  return cell as unknown as ReadonlySignal<A>;
}

/** Takes the sources accumulated so far, clearing the registry. Consumed once. */
export function takeSources(): Source[] {
  return sources.splice(0, sources.length);
}
