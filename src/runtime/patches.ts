/**
 * Applies conditional-class patches to the style table.
 *
 * The entire runtime cost of dynamic styling: write field values for the slots a
 * class changes. No class names, no selector matching, no cascade — the compiler
 * resolved all of that and left integers.
 *
 * `affectsLayout` is the payoff. A snapshot of styles cannot say *what* differs,
 * so it would force a relayout or a diff; a patch carries the answer from the
 * compiler, so a colour-only change repaints without touching measure or arrange.
 */
import type { CompiledUi, StyleField } from "../ir.ts";
import { Dirty } from "./bindings.ts";
import type { ReadonlySignal } from "./signal.ts";

export type FieldPatchRef = {
  field: StyleField;
  slots: Uint16Array;
  on: Float64Array;
  off: Float64Array;
};

export type StylePatchRef = {
  signal: ReadonlySignal<boolean>;
  affectsLayout: boolean;
  entries: FieldPatchRef[];
  /**
   * The conditional class this patch is, for tooling that has to name one.
   *
   * The runtime never reads it — a patch is applied by index and its class name was
   * resolved away at build time. It exists because the headless flags used to take
   * an *index* into this array, and the array's order is whatever the compiler's
   * tree walk produced: adding a conditional class anywhere renumbered the rest, so
   * `--patch 1` silently began flipping a different class. A name cannot do that.
   */
  className: string;
};

/** Last applied state per patch, so only genuine changes cost writes. */
const applied = new WeakMap<StylePatchRef, boolean>();

/**
 * Drops the applied-state memo, so the next {@link applyStylePatches} writes every
 * patch regardless of whether its signal moved.
 *
 * Hot reload needs exactly this: a swap rewrites the style rows *under* an active
 * patch, the patch's signal has not changed, and without a reset the memo would
 * skip it — leaving the new base values showing where the patch should still be
 * painting. Called once per swap, not on any per-frame path.
 */
export function resetAppliedPatches(patches: StylePatchRef[]): void {
  for (const patch of patches) applied.delete(patch);
}

export function applyStylePatches(ui: CompiledUi, patches: StylePatchRef[]): Dirty {
  let dirty: Dirty = Dirty.NONE;

  for (const patch of patches) {
    const on = Boolean(patch.signal.value);
    if (applied.get(patch) === on) continue;
    applied.set(patch, on);

    for (const entry of patch.entries) {
      const column = (ui.styles as unknown as Record<StyleField, { [i: number]: number }>)[
        entry.field
      ];
      const values = on ? entry.on : entry.off;
      for (let i = 0; i < entry.slots.length; i++) column[entry.slots[i]!] = values[i]!;
    }

    dirty = patch.affectsLayout ? Dirty.LAYOUT : Math.max(dirty, Dirty.PAINT) as Dirty;
  }

  return dirty;
}

/** Subscribes `onChange` to every signal driving a patch. */
export function subscribeStylePatches(patches: StylePatchRef[], onChange: () => void): () => void {
  const seen = new Set<unknown>();
  const offs: (() => void)[] = [];

  for (const patch of patches) {
    if (seen.has(patch.signal)) continue;
    seen.add(patch.signal);
    offs.push(patch.signal.subscribe(onChange));
  }

  return () => {
    for (const off of offs) off();
  };
}

/**
 * True if any patch requires a relayout when it changes — used to decide whether
 * a style change can skip the measure and arrange passes.
 */
export function patchesAffectLayout(patches: StylePatchRef[]): boolean {
  return patches.some((p) => p.affectsLayout);
}
