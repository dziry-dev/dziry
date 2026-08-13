/**
 * The numeric bridge: what a slider's fraction means, and what a number
 * field's step does.
 *
 * The engine owns the slider's *fraction*; the value it means is this side's,
 * because min/max/step are author constants and the signal is Bun's. The bridge
 * is the `numerics` side table the compiler emits — kept out of the shared
 * protocol precisely because the engine never reads it.
 *
 * Own module rather than part of `bindings.ts` because both halves of the
 * runtime need it: `bindings.ts` (handlers and bound signals) and `forms.ts`
 * (the payload) — and `bindings` already imports `forms`, so a shared home is
 * the only acyclic one.
 */
import { findRow } from "../find-row.ts";
import type { CompiledUi } from "../ir.ts";
import { ControlKind } from "../protocol/generated.ts";

/** A node's `min`/`max`/`step`, or null when it is not a numeric control. */
export function numericFor(
  ui: CompiledUi,
  node: number,
): { min: number; max: number; step: number } | null {
  const { numerics } = ui;
  const row = findRow(numerics.node.subarray(0, numerics.count), node);
  if (row < 0) return null;
  return { min: numerics.min[row]!, max: numerics.max[row]!, step: numerics.step[row]! };
}

/** Whether `node` is the slider, rather than the typeable numeric field. */
export function isRangeControl(ui: CompiledUi, node: number): boolean {
  const row = findRow(ui.controls.node.subarray(0, ui.controls.count), node);
  return row >= 0 && ui.controls.kind[row] === ControlKind.RANGE;
}

/** The value a thumb position means, snapped to the step. */
export function rangeValue(ui: CompiledUi, node: number, perMille: number): number | null {
  const n = numericFor(ui, node);
  if (n === null || !(n.max > n.min)) return null;
  const raw = n.min + (perMille / 1000) * (n.max - n.min);
  // Snap to the step from the min, then clamp — the same rule the compiler's
  // `rangeInitialPermille` applies to the authored default, so the two ends of
  // the round trip agree.
  const snapped = n.step > 0 ? n.min + Math.round((raw - n.min) / n.step) * n.step : raw;
  const clamped = Math.min(Math.max(snapped, n.min), n.max);
  // The snap's float dust (`0.30000000000000004`) is not a value anyone wrote;
  // 10 decimal places is finer than any step that fits the wire.
  return Math.round(clamped * 1e10) / 1e10;
}

/** The thumb position a value means, per-mille — the shared table's currency. */
export function rangePermille(ui: CompiledUi, node: number, value: number): number | null {
  const n = numericFor(ui, node);
  if (n === null || !(n.max > n.min) || !Number.isFinite(value)) return null;
  return Math.round(((Math.min(Math.max(value, n.min), n.max) - n.min) / (n.max - n.min)) * 1000);
}

/**
 * ArrowUp/ArrowDown on a number field: the stepped value, clamped.
 *
 * An empty field steps from `min` — or from 0 when unbounded — which is what a
 * browser does: the first ArrowUp on an empty `min="10"` field gives 10, not 1.
 */
export function stepValue(
  current: string,
  n: { min: number; max: number; step: number },
  direction: 1 | -1,
): string {
  const parsed = Number(current);
  const base =
    Number.isFinite(parsed) && current.trim() !== ""
      ? parsed
      : Number.isFinite(n.min)
        ? n.min
        : 0;
  let next = base + direction * (n.step > 0 ? n.step : 1);
  if (Number.isFinite(n.min)) next = Math.max(next, n.min);
  if (Number.isFinite(n.max)) next = Math.min(next, n.max);
  return String(Math.round(next * 1e10) / 1e10);
}
