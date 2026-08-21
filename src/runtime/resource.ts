/**
 * `resource` — pull-based async data, and the thing a `<Suspense>` boundary watches.
 *
 * The one-line split API.md draws: **`source` = push, from outside the process;
 * `resource` = pull, async, drives a boundary.** A source is fed by a subscribe
 * callback; a resource runs a fetcher and knows whether it has answered yet, which
 * is exactly the bit a boundary needs and a source deliberately has no concept of.
 *
 * The shape is `source`'s deliberately: created at module level, **registered
 * rather than run** — the compiler imports app modules at build time, and a
 * fetcher that ran at import would fetch during the build (the same rule
 * `source.ts` states for its subscribes). The worker starts every registered
 * resource once at launch via {@link takeResources}.
 *
 * What comes back *is the data signal* — `{stats}` in a template binds it like any
 * signal, `stats.map(...)` compiles a list from it — with three members riding on
 * it: `status`, `error` (signals), and `refetch()`. They sit on the signal object
 * itself (signals are plain objects) so the resource survives the compiler/runtime
 * boundary as **one** module export the artifact can import by name; a wrapper
 * object would make `{stats.data}` a property read on an export, which the
 * reference resolver has no name for.
 *
 * Status walks `"pending" → "ready" | "error"`, and a `refetch()` sets **`"stale"`,
 * never `"pending"`** — the design doc's rule, so revalidation does not flash a
 * boundary's fallback: stale means "showing data, fetching newer", and a boundary
 * only falls back on `"pending"`, which a resource is exactly once.
 */
import { batch, signal, type ReadonlySignal, type Signal } from "./signal.ts";

export type ResourceStatus = "pending" | "ready" | "stale" | "error";

export type Resource<T> = ReadonlySignal<T> & {
  /** `"pending"` until the first settle; `"stale"` while a refetch is in flight. */
  readonly status: ReadonlySignal<ResourceStatus>;
  /** What the fetcher last threw or rejected with, or null. Cleared by a settle. */
  readonly error: ReadonlySignal<unknown>;
  /** Runs the fetcher again. Status goes stale, the shown data stays. */
  refetch(): void;
};

/** The brand `compile.ts` tests to collect a boundary's resources from bindings. */
const RESOURCE = Symbol.for("dziri.resource");

export function isResource(value: unknown): value is Resource<unknown> {
  return typeof value === "object" && value !== null && RESOURCE in value;
}

const registry: (() => void)[] = [];

export function resource<T>(fetcher: () => Promise<T> | T, initial: T): Resource<T> {
  // Un-widened: the cell holds exactly `T`, and `Widen` would turn a union like
  // `"a" | "b"` into `string` on the way through.
  const data = signal(initial) as unknown as Signal<T>;
  const status = signal<ResourceStatus>("pending");
  const error = signal<unknown>(null);

  /**
   * Monotonic supersession, the router's `navToken` in miniature: a refetch
   * issued while a run is in flight must win, and the slower answer must land
   * nowhere — not even in `error`.
   */
  let token = 0;

  const run = (as: ResourceStatus): void => {
    const mine = ++token;
    status.value = as;
    const succeed = (value: T): void => {
      if (mine !== token) return;
      batch(() => {
        data.value = value;
        error.value = null;
        status.value = "ready";
      });
    };
    const fail = (thrown: unknown): void => {
      if (mine !== token) return;
      batch(() => {
        error.value = thrown;
        status.value = "error";
      });
    };
    try {
      const answer = fetcher();
      if (answer instanceof Promise) answer.then(succeed, fail);
      else succeed(answer);
    } catch (e) {
      fail(e);
    }
  };

  const self = data as unknown as Record<string | symbol, unknown>;
  self[RESOURCE] = true;
  self["status"] = status;
  self["error"] = error;
  self["refetch"] = () => run("stale");

  registry.push(() => run("pending"));
  return data as unknown as Resource<T>;
}

/**
 * Starts everything registered since the last take, once each.
 *
 * Consumed, exactly like `takeSources`: the worker calls this at launch, and a
 * second window (or a test creating resources of its own) only starts what it
 * registered itself. In the compiler's process nothing ever calls this, which is
 * the whole "registered rather than run" rule made mechanical.
 */
export function takeResources(): (() => void)[] {
  return registry.splice(0);
}
