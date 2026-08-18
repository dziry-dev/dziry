/**
 * The worker half of hot reload: writing a recompile's style values into the
 * tables a running window is already painting from.
 *
 * Kept out of `host/worker.ts` so a test can drive it without a worker, a lock
 * or an engine — the same argument `window-state.ts` makes for the apply pass.
 * The caller (the worker's `hot` message) owns the lock, the upload and the
 * publish; this owns the *data* moving and nothing else.
 *
 * What is preserved is the point: signals are module state and are never
 * touched, focus and scroll live in the engine against node ids the fingerprint
 * proved unchanged, and text/list state lives in tables this does not write.
 */
import type { CompiledUi, StyleField } from "../ir.ts";
import type { HotPayload } from "../hot.ts";
import { applyStylePatches, resetAppliedPatches, type StylePatchRef } from "./patches.ts";

/**
 * Writes `payload` over `ui`'s style-ish tables, then re-applies the conditional
 * classes so a patch that was active across the swap still paints.
 *
 * The fingerprint upstream guarantees shape: every count and every patch's
 * wiring is identical, so the checks below are assertions of that contract, not
 * negotiation. A violation returns false and the worker ignores the message —
 * a stale payload (two saves landing out of order) must not corrupt a table.
 */
export function applyHotPayload(
  ui: CompiledUi,
  stylePatches: StylePatchRef[],
  payload: HotPayload,
): boolean {
  if (
    payload.counts.styles !== ui.styles.count ||
    payload.counts.media !== ui.media.count ||
    payload.counts.tweens !== ui.tweens.count ||
    payload.counts.keyframes !== ui.keyframes.count ||
    payload.patches.length !== stylePatches.length
  ) {
    return false;
  }

  const columns = ui.styles as unknown as Record<StyleField, { set(values: ArrayLike<number>): void }>;
  for (const [field, values] of Object.entries(payload.styles)) {
    const column = columns[field as StyleField];
    if (!column || values.length !== ui.styles.count) return false;
    column.set(values);
  }

  ui.media.bit.set(payload.media.bit);
  ui.media.kind.set(payload.media.kind);
  ui.media.value.set(payload.media.value);

  const t = ui.tweens;
  t.mask.set(payload.tweens.mask);
  t.duration.set(payload.tweens.duration);
  t.delay.set(payload.tweens.delay);
  t.iterations.set(payload.tweens.iterations);
  t.firstSegment.set(payload.tweens.firstSegment);
  t.segmentCount.set(payload.tweens.segmentCount);
  t.easing.set(payload.tweens.easing);
  t.easeA.set(payload.tweens.easeA);
  t.easeB.set(payload.tweens.easeB);
  t.easeC.set(payload.tweens.easeC);
  t.easeD.set(payload.tweens.easeD);

  const k = ui.keyframes;
  k.style.set(payload.keyframes.style);
  k.offset.set(payload.keyframes.offset);
  k.easing.set(payload.keyframes.easing);
  k.easeA.set(payload.keyframes.easeA);
  k.easeB.set(payload.keyframes.easeB);
  k.easeC.set(payload.keyframes.easeC);
  k.easeD.set(payload.keyframes.easeD);

  for (const [i, patch] of stylePatches.entries()) {
    const next = payload.patches[i]!;
    if (next.on.length !== patch.entries.length || next.off.length !== patch.entries.length) {
      return false;
    }
    for (const [j, entry] of patch.entries.entries()) {
      entry.on.set(next.on[j]!);
      entry.off.set(next.off[j]!);
    }
  }

  // Base rows moved under any active patch; the memoised "already applied" answer
  // is about the old rows. Reset and re-apply so the current state paints over the
  // new values.
  resetAppliedPatches(stylePatches);
  applyStylePatches(ui, stylePatches);

  return true;
}
