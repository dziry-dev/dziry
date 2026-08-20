/**
 * Style patches, through their own interface.
 *
 * `upload.test.ts` reaches `applyStylePatches` on the way to the tables; these
 * pin the semantics the hot swap relies on — above all `resetAppliedPatches`,
 * which exists for exactly one caller (the `{t:"hot"}` path) and would silently
 * revert to "unchanged signal means no write" the day it broke, leaving base
 * values showing where a patch should be painting.
 */
import { expect, test } from "bun:test";
import type { CompiledUi } from "../ir.ts";
import { Dirty } from "./bindings.ts";
import {
  applyStylePatches,
  patchesAffectLayout,
  resetAppliedPatches,
  subscribeStylePatches,
  type StylePatchRef,
} from "./patches.ts";
import { signal } from "./signal.ts";

function uiWith(fields: Record<string, number[]>): CompiledUi {
  const styles: Record<string, Float64Array> = {};
  for (const [name, values] of Object.entries(fields)) styles[name] = new Float64Array(values);
  return { styles } as unknown as CompiledUi;
}

function patch(over: Partial<StylePatchRef> & { on: number[]; off: number[] }): {
  ref: StylePatchRef;
  ui: CompiledUi;
} {
  const ui = uiWith({ fg: over.off });
  const ref: StylePatchRef = {
    signal: signal(false),
    affectsLayout: false,
    entries: [
      {
        field: "fg" as never,
        slots: new Uint16Array(over.on.map((_, i) => i)),
        on: new Float64Array(over.on),
        off: new Float64Array(over.off),
      },
    ],
    className: "x-test",
    ...over,
  };
  return { ref, ui };
}

const fg = (ui: CompiledUi) => ui.styles.fg as Float64Array;

test("first application writes the signal's current side", () => {
  const { ref, ui } = patch({ on: [9], off: [3] });
  applyStylePatches(ui, [ref]);
  expect([...fg(ui)]).toEqual([3]); // signal false: the off values
});

test("flipping the signal writes the other side, and back", () => {
  const { ref, ui } = patch({ on: [9], off: [3] });
  applyStylePatches(ui, [ref]);
  (ref.signal as { value: boolean }).value = true;
  applyStylePatches(ui, [ref]);
  expect([...fg(ui)]).toEqual([9]);
  (ref.signal as { value: boolean }).value = false;
  applyStylePatches(ui, [ref]);
  expect([...fg(ui)]).toEqual([3]);
});

test("an unchanged signal costs no writes and reports NONE", () => {
  const { ref, ui } = patch({ on: [9], off: [3] });
  applyStylePatches(ui, [ref]);
  fg(ui)[0] = 42; // evidence: a rewrite would clobber this
  expect(applyStylePatches(ui, [ref])).toBe(Dirty.NONE);
  expect(fg(ui)[0]).toBe(42);
});

test("resetAppliedPatches forces a rewrite under an unmoved signal", () => {
  // The hot swap: rows were replaced underneath the patch, the signal never
  // moved, and without the reset the memo would skip the re-application.
  const { ref, ui } = patch({ on: [9], off: [3] });
  applyStylePatches(ui, [ref]);
  fg(ui)[0] = -1; // what the swap left: new base values, patch not re-applied
  resetAppliedPatches([ref]);
  expect(applyStylePatches(ui, [ref])).not.toBe(Dirty.NONE);
  expect(fg(ui)[0]).toBe(3);
});

test("a paint-only patch reports PAINT, a layout one LAYOUT", () => {
  const paint = patch({ on: [9], off: [3] });
  expect(applyStylePatches(paint.ui, [paint.ref])).toBe(Dirty.PAINT);

  const layout = patch({ on: [9], off: [3], affectsLayout: true });
  expect(applyStylePatches(layout.ui, [layout.ref])).toBe(Dirty.LAYOUT);
});

test("subscribeStylePatches dedupes a signal shared by two patches", () => {
  const shared = signal(false);
  const a = patch({ on: [9], off: [3] });
  const b = patch({ on: [7], off: [1] });
  a.ref.signal = shared;
  b.ref.signal = shared;

  let calls = 0;
  const off = subscribeStylePatches([a.ref, b.ref], () => calls++);
  (shared as { value: boolean }).value = true;
  expect(calls).toBe(1); // one signal, one notification — not one per patch

  off();
  (shared as { value: boolean }).value = false;
  expect(calls).toBe(1);
});

test("patchesAffectLayout is any-of", () => {
  const paint = patch({ on: [9], off: [3] });
  const layout = patch({ on: [9], off: [3], affectsLayout: true });
  expect(patchesAffectLayout([paint.ref])).toBe(false);
  expect(patchesAffectLayout([paint.ref, layout.ref])).toBe(true);
});
