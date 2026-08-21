/**
 * The failure overlay's runtime half — ROADMAP's red box.
 *
 * The box itself is compiled: `window-tree.ts` appends a hidden subtree to every
 * shell, and the artifact names its three nodes (`RedboxNodes`). Showing it is
 * therefore the same operation navigation is — one `hidden` byte — plus two string
 * writes into slots that were *reserved* at compile time, so nothing here mints a
 * node, a style, or a slot. That is the compile-time gate holding under failure,
 * which is exactly when it is easiest to drop.
 *
 * Two producers feed it, both dev-only surfaces:
 * - the worker's message pump, catching what a handler or an effect threw;
 * - the watcher, forwarding a failed recompile's formatted error.
 *
 * The **sink** indirection exists for the first one: `effects.ts` reports failures
 * from inside the runtime, where there is no `ui` and no uploader — it calls
 * {@link reportFailure}, and the worker, which has both, registers what that does.
 * A process with no sink (tests, the compiler importing app modules) loses nothing:
 * the console line every reporter already writes still happens at the call site.
 */
import type { CompiledUi, RedboxNodes } from "../ir.ts";

/**
 * Writes the message and unhides the box. Returns the nodes whose text changed,
 * for the caller's `changedNodes` — they need re-measuring, like any binding write.
 *
 * The message lands via `nodes.text[…]`: the artifact names the TEXT nodes and the
 * node table already knows their slots, so the ref carries no slot numbers to drift.
 */
export function showRedbox(
  ui: CompiledUi,
  redbox: RedboxNodes,
  title: string,
  detail: string,
): number[] {
  ui.strings[ui.nodes.text[redbox.title]!] = title;
  ui.strings[ui.nodes.text[redbox.detail]!] = detail;
  ui.nodes.hidden[redbox.root] = 0;
  return [redbox.title, redbox.detail];
}

/** Hides the box — a successful recompile clearing a build error. One byte. */
export function hideRedbox(ui: CompiledUi, redbox: RedboxNodes): void {
  ui.nodes.hidden[redbox.root] = 1;
}

type FailureSink = (title: string, detail: string) => void;

let sink: FailureSink | null = null;

/** The worker registers how a reported failure becomes a painted box. */
export function setFailureSink(fn: FailureSink | null): void {
  sink = fn;
}

/**
 * Reports a runtime failure to whoever registered — the worker, in a window.
 *
 * Callers keep their own `console.error`: this is the *paint* channel, not the
 * logging one, and a headless run must still say what happened.
 */
export function reportFailure(title: string, detail: string): void {
  sink?.(title, detail);
}

/** One readable string for an arbitrary thrown value, stack included when real. */
export function describeThrown(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
  return String(e);
}
