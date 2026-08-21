/**
 * The Effect seam — where dziri meets `effect` without depending on it.
 *
 * Three things live here, and the rule they share is the `validate={}` ruling
 * (`forms.ts`): dziri recognises Effect values *structurally* and imports the
 * package *lazily*, so an app that never hands one over never loads a byte of it.
 * That is why this module imports nothing from `effect` — not even types. A
 * type-only import would be erased at run time but would still fail `tsc` in any
 * app that has dziri installed and `effect` not, because this file is reachable
 * from `dziri`'s public exports. Structural types below, deliberately.
 *
 * The gate (compile-time-gate): question 1 answered "no" — a handler's returned
 * value and a layer's live services exist only at event/launch time; the user and
 * the OS supply them. Everything decidable at build is decided at build: *which*
 * export the layer is (`<Window layer={…}>` is reverse-mapped and emitted by
 * name), whether one exists at all (absent → `provideWindowLayer` is never
 * called and every branch here is dead), and which handlers exist. The runtime
 * learns one bit per dispatch — "was that an Effect" — plus holds one disposable
 * handle per window. Ledger entry: NOTES.md, "live service instances".
 */

import { reportFailure } from "./redbox.ts";
import { takeSources } from "./source.ts";

/**
 * Navigation as control flow — the two tags the router interprets.
 *
 * Plain classes, not `Data.TaggedError`, so a loader that is an ordinary
 * function can `throw new Redirect("login")` in a project that has never
 * installed `effect`. An Effect loader fails with the same objects:
 * `Effect.fail(new Redirect("login"))`. Matching is by `_tag`, which is the
 * one convention shared by both worlds.
 *
 * Designed in data-layer-design.md §4 ("Exits drive navigation"); the router
 * that interprets them rides M7/M8. They are exported now because handlers can
 * already fail with them and the tags' identity should not move later.
 */
export class Redirect {
  readonly _tag = "Redirect";
  constructor(readonly to: string) {}
}

export class Cancel {
  readonly _tag = "Cancel";
}

/**
 * Every Effect value carries `Symbol.for("effect/Effect")` — a *registered*
 * symbol, so the test needs no import. Measured against effect 3.22
 * (data-layer-design.md §4, "The loader's three shapes").
 */
const EFFECT_TYPE_ID: unique symbol = Symbol.for("effect/Effect") as never;

export function isEffect(value: unknown): value is object {
  return typeof value === "object" && value !== null && EFFECT_TYPE_ID in value;
}

/** Every Effect `Stream` carries `Symbol.for("effect/Stream")`, like `isEffect`. */
const STREAM_TYPE_ID: unique symbol = Symbol.for("effect/Stream") as never;

export function isStream(value: unknown): value is object {
  return typeof value === "object" && value !== null && STREAM_TYPE_ID in value;
}

/** Unsubscribes returned by callback-shaped `source()`s, run on window close. */
const unsubscribes: (() => void)[] = [];

/**
 * Why the specifier is a property read and not a literal: a dynamic
 * `import("effect")` is still a static dependency to a bundler, and so is a
 * folded local const — both measured in `forms.ts`, where the `runtime-surface`
 * ratchet caught the bundle growing from 9,582 bytes to 1,050,133. A property
 * read is not folded (measured there, 157 bytes).
 */
const EFFECT = { specifier: "effect" };

/** The slice of `effect`'s module surface this file touches, structurally. */
type EffectModule = {
  Effect: {
    runPromiseExit(effect: unknown): Promise<ExitLike>;
    runFork(effect: unknown): unknown;
    sync(thunk: () => void): unknown;
    catchAllCause(effect: unknown, handler: (cause: unknown) => unknown): unknown;
  };
  Stream: { runForEach(stream: unknown, f: (a: unknown) => unknown): unknown };
  ManagedRuntime: { make(layer: unknown): ManagedRuntimeLike };
  Cause: {
    isInterruptedOnly(cause: unknown): boolean;
    pretty(cause: unknown): string;
    failureOption(cause: unknown): { _tag: "Some"; value: unknown } | { _tag: "None" };
  };
};

type ExitLike = { _tag: "Success" | "Failure"; value?: unknown; cause?: unknown };

type ManagedRuntimeLike = {
  /** Forces the memoized layer build — `ManagedRuntime.make` alone acquires nothing. */
  runtime(): Promise<unknown>;
  runPromiseExit(effect: unknown): Promise<ExitLike>;
  runFork(effect: unknown): unknown;
  dispose(): Promise<void>;
};

/** The window's layer, and the runtime being built from it. One window per process. */
let windowLayer: unknown = null;
let building: Promise<ManagedRuntimeLike | null> | null = null;

async function windowRuntime(): Promise<ManagedRuntimeLike | null> {
  building ??= (async () => {
    if (windowLayer === null) return null;
    const mod = (await import(EFFECT.specifier)) as EffectModule;
    const rt = mod.ManagedRuntime.make(windowLayer);
    // `make` alone acquires nothing — services open on first use. Forcing the
    // memoized build here is what makes "built at launch" true: the store is
    // opening while the first frame paints, and a layer that cannot build says
    // so now rather than on the first click. Measured: without this line the
    // smoke fixture's acquire never ran under --screenshot.
    await rt.runtime();
    return rt;
  })();
  return building;
}

/**
 * Called by the host at startup when the artifact carries a layer. Acquisition
 * starts immediately rather than on the first effect — the design doc's "built
 * at launch" — so a store that takes a moment to open is opening while the
 * first frame paints, and a layer that cannot build says so at launch rather
 * than on the first click.
 */
export function provideWindowLayer(layer: unknown): void {
  windowLayer = layer;
  // Drop any runtime already built without the layer. The worker provides before
  // the first dispatch, so this is only reachable in tests and misuse — but a
  // cached no-layer runtime silently swallowing the layer would be a debugging
  // trap worth a line to prevent.
  building = null;
  void windowRuntime().catch((e) => {
    console.error(`  the window layer failed to build:\n  ${e instanceof Error ? e.message : String(e)}`);
  });
}

/**
 * Runs a value a handler returned, if it is an Effect. The one bit dispatch learns.
 *
 * Fire-and-forget by design — a handler's job is to *start* work; the UI it
 * affects is signals the effect writes. Failures are printed with the full
 * cause rather than swallowed (an unobserved rejected promise is the exact
 * failure mode this exists to prevent), and interruption is silent because a
 * superseded fiber is an outcome, not an error.
 */
export function runDispatched(value: unknown, label: string): boolean {
  if (!isEffect(value)) return false;

  void (async () => {
    let mod: EffectModule;
    try {
      mod = (await import(EFFECT.specifier)) as EffectModule;
    } catch {
      console.error(
        `  ${label} returned an Effect, but "effect" is not installed.\n` +
          `  A handler may return an Effect only in a project that depends on effect —\n` +
          `  dziri recognises the value structurally and never bundles the library.`,
      );
      return;
    }

    const rt = await windowRuntime().catch(() => null);
    const exit = await (rt ? rt.runPromiseExit(value) : mod.Effect.runPromiseExit(value));
    if (exit._tag === "Failure" && !mod.Cause.isInterruptedOnly(exit.cause)) {
      const pretty = mod.Cause.pretty(exit.cause);
      console.error(`  ${label} failed:\n${pretty}`);
      // The paint channel, beside the log — a window's worker turns this into the
      // red box; anything else registered no sink and this line is a no-op.
      reportFailure(`${label} failed`, pretty);
    }
  })();

  return true;
}

/** What a route loader's exit means to navigation. */
export type LoaderExit =
  | { kind: "success"; value: unknown }
  | { kind: "redirect"; to: string }
  | { kind: "cancel" }
  | { kind: "failure"; value: unknown };

/**
 * Runs a route loader and interprets its exit for the router.
 *
 * Three shapes, detected in a load-bearing order — Effect first (it must not be
 * awaited), then thenable, then a plain value. A thrown or failed `Redirect` /
 * `Cancel` is navigation control flow, not an error; interruption is silence; a
 * real failure is printed (the same contract `runDispatched` keeps) and reported
 * as `failure` so the router can do more than print later.
 */
export async function runLoader(
  loader: (args: Record<string, string>) => unknown,
  args: Record<string, string>,
): Promise<LoaderExit> {
  let result: unknown;
  try {
    result = loader(args);
  } catch (e) {
    return exitFromThrown(e);
  }

  if (isEffect(result)) {
    const mod = (await import(EFFECT.specifier)) as EffectModule;
    const rt = await windowRuntime().catch(() => null);
    const exit = await (rt ? rt.runPromiseExit(result) : mod.Effect.runPromiseExit(result));
    if (exit._tag === "Failure") {
      const result = exitFromCause(mod, exit.cause);
      if (result.kind === "failure") {
        console.error(`  a route loader failed:\n${mod.Cause.pretty(exit.cause)}`);
      }
      return result;
    }
    return { kind: "success", value: (exit as ExitLike).value };
  }

  if (result instanceof Promise) {
    try {
      return { kind: "success", value: await result };
    } catch (e) {
      return exitFromThrown(e);
    }
  }

  return { kind: "success", value: result };
}

function exitFromThrown(e: unknown): LoaderExit {
  if (e instanceof Redirect) return { kind: "redirect", to: e.to };
  if (e instanceof Cancel) return { kind: "cancel" };
  console.error(`  a route loader failed:\n  ${e instanceof Error ? e.message : String(e)}`);
  return { kind: "failure", value: e };
}

function exitFromCause(mod: EffectModule, cause: unknown): LoaderExit {
  if (mod.Cause.isInterruptedOnly(cause)) return { kind: "cancel" };
  const option = mod.Cause.failureOption(cause);
  const value = option._tag === "Some" ? option.value : null;
  if (value instanceof Redirect) return { kind: "redirect", to: value.to };
  if (value instanceof Cancel) return { kind: "cancel" };
  return { kind: "failure", value };
}

/**
 * Disposes the window's runtime — layer finalizers run, the store shuts down.
 * Called on quit; best-effort, because the process is about to exit and a
 * finalizer that hangs should not hold the window open.
 */
export async function disposeWindowRuntime(): Promise<void> {
  // Callback-source unsubscribes first, in reverse order, then the runtime — the
  // same "undo in reverse, exactly once" the layer itself follows.
  const cleanups = unsubscribes.splice(0, unsubscribes.length);
  for (const u of cleanups.reverse()) {
    try {
      u();
    } catch {
      // Best-effort: the process is exiting, and one hung unsubscribe must not
      // hold the window open.
    }
  }

  const pending = building;
  building = null;
  windowLayer = null;
  if (!pending) return;
  const rt = await pending.catch(() => null);
  if (rt) await rt.dispose().catch(() => undefined);
}

/**
 * Starts every `source()` the artifact declared, once the runtime is ready.
 *
 * `source()` registers its subscribe at module scope, but the subscription
 * must not run until the window is live — and a stream may need services that
 * exist only after the layer is built. This is the other half, called by the
 * host at startup. Each subscribe is handed `set`; the result decides the
 * shape: an unsubscribe function is kept for window close, and an Effect
 * `Stream` is forked with `Stream.runForEach(stream, x => cell.set(x))`.
 *
 * Streams run through the window runtime when a layer exists (so `R` is
 * satisfied), and through Effect's default runtime otherwise — correct, not a
 * fallback: a stream that needs no services is its own complete program, and a
 * stream that needs a service with no layer fails loudly, as it should.
 *
 * A no-op when nothing called `source()`. Callback-only sources never import
 * `effect`; the package loads only when a subscribe returns a Stream.
 */
export async function startSources(): Promise<void> {
  const pending = takeSources();
  if (pending.length === 0) return;

  // Callback sources subscribe now, no effect needed: the subscribe is handed
  // `set` and returns an unsubscribe, kept for window close. A subscribe whose
  // return value is a Stream is the Effect shape, collected for the lazy import
  // below. Calling with `set` is safe for both — a stream factory takes no
  // argument and ignores it.
  const streams: { cell: { set(value: unknown): void }; stream: unknown }[] = [];
  for (const { cell, subscribe } of pending) {
    const result = subscribe(cell.set);
    if (isStream(result)) {
      streams.push({ cell, stream: result });
    } else if (typeof result === "function") {
      unsubscribes.push(result as () => void);
    }
  }

  if (streams.length === 0) return; // callback-only sources never import effect

  let mod: EffectModule;
  try {
    mod = (await import(EFFECT.specifier)) as EffectModule;
  } catch {
    console.error(
      `  source() returned a Stream, but "effect" is not installed.\n` +
        `  A stream source needs effect — add it to the project's dependencies.\n` +
        `  dziri recognises the stream structurally and never bundles the library.`,
    );
    return;
  }

  const rt = await windowRuntime().catch(() => null);
  for (const { cell, stream } of streams) {
    const run = mod.Stream.runForEach(stream, (a: unknown) =>
      mod.Effect.sync(() => cell.set(a)),
    );
    const guarded = mod.Effect.catchAllCause(run, (cause: unknown) =>
      mod.Effect.sync(() => {
        if (!mod.Cause.isInterruptedOnly(cause)) {
          console.error(`  a stream source failed:\n${mod.Cause.pretty(cause)}`);
        }
      }),
    );
    if (rt) rt.runFork(guarded);
    else mod.Effect.runFork(guarded);
  }
}
