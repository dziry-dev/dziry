/**
 * What a compiled window looks like from outside, and how one is chosen.
 *
 * Shared by both threads and by the single-threaded path, because all three have
 * to agree on the same shape — the app thread reads the signals and handlers, the
 * engine thread reads nothing but needs the type to exist, and `--window` has to
 * mean the same thing wherever it is parsed.
 */
import type { CompiledUi, RouteNodes, WindowConfig } from "../ir.ts";
import type { EditableRef, ImageBinding } from "../runtime/bindings.ts";
import type { ListBindingRef } from "../runtime/list-runtime.ts";
import type { StylePatchRef } from "../runtime/patches.ts";
import type { ReadonlySignal } from "../runtime/signal.ts";

/**
 * One window's compiled artifact — the shape `ui.gen.ts` declares it satisfies.
 *
 * Naming it rather than inferring it at the call site is what keeps the compiler
 * and the host honest about the same interface: the artifact says
 * `satisfies StyleTable` on the way out, and this says what the host needs on the
 * way in. A field the emitter renames breaks at `tsc`, not at the first frame that
 * happens to touch it.
 */
export type WindowArtifact = CompiledUi & {
  stylePatches: StylePatchRef[];
  listBindings: ListBindingRef[];
  editables: EditableRef[];
  imageBindings: ImageBinding[];
  routeNodes: RouteNodes[];
  initialRoute: number;
  windowConfig: WindowConfig;
  windowId: string;
  routeSignal: ReadonlySignal<string> | null;
  /**
   * The window's Effect layer — `<Window layer={…}>` — or null. The worker
   * builds a ManagedRuntime from it at launch and disposes it on quit.
   * `windowLayer` rather than `layer` so it cannot shadow the app's own export.
   */
  windowLayer: unknown;
};

/** Every window in the project, as `windows.gen.ts` exports them. */
export type WindowRegistry = {
  artifacts: Record<string, WindowArtifact>;
  windowIds: readonly string[];
};

/**
 * Which window to open. `--window tailwind`, defaulting to the first.
 *
 * One at a time, not one per process by choice: `Window::new` creates an
 * `EventPump` per engine and SDL's queue is process-global, so two windows would
 * fight over events. Opening either from one host is what this needs; opening
 * both at once is an engine refactor.
 */
export function pickWindow(
  registry: WindowRegistry,
  argv: readonly string[],
): WindowArtifact {
  const i = argv.indexOf("--window");
  const wanted = i !== -1 ? argv[i + 1] : null;
  const ids = registry.windowIds;

  if (ids.length === 0) throw new Error("this project has no windows under ./windows");
  if (!wanted) return registry.artifacts[ids[0]!]!;

  const found = registry.artifacts[wanted];
  if (!found) throw new Error(`no window "${wanted}". Windows are ${ids.join(", ")}.`);
  return found;
}

/** The window size a run should use — `--size WxH` overriding what `<Window>` declared. */
export function sizeFrom(
  argv: readonly string[],
  fallback: { width: number; height: number },
): [number, number] {
  const i = argv.indexOf("--size");
  const raw = i !== -1 ? argv[i + 1] : null;
  const match = raw?.match(/^(\d+)x(\d+)$/);
  if (raw && !match) throw new Error(`--size takes WxH, got "${raw}"`);
  if (match) return [Number(match[1]), Number(match[2])];
  return [fallback.width, fallback.height];
}

/**
 * `--min-size none` (or `WxH`) lifts the engine's 564x320 floor for this run.
 *
 * An environment variable rather than a config field because the engine reads it
 * at window creation — see `MIN_WINDOW_ENV` in `window.rs`. Must be set before the
 * engine is created, which is the only reason this is a separate call.
 *
 * Without it, `--size 400x600` silently gives a 564-wide window: SDL clamps up to
 * the minimum, so the flag that exists to *reach* small sizes cannot reach them.
 */
export function applyMinSize(argv: readonly string[]): void {
  const i = argv.indexOf("--min-size");
  const raw = i !== -1 ? argv[i + 1] : null;
  if (i !== -1 && !raw) throw new Error(`--min-size takes WxH or "none"`);
  if (raw) process.env.DZIRI_MIN_WINDOW = raw;
}
