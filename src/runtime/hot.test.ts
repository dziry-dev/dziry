/**
 * The worker half of hot reload: applyHotPayload, driven without a worker, a
 * lock or an engine — the reason the logic lives in runtime/hot.ts.
 */
import { expect, test } from "bun:test";
import type { CompiledUi } from "../ir.ts";
import type { HotPayload } from "../hot.ts";
import { applyHotPayload } from "./hot.ts";
import { signal } from "./signal.ts";
import { applyStylePatches, type StylePatchRef } from "./patches.ts";

/** The smallest ui the function touches: one style column, one row per table. */
function fakeUi() {
  const ui = {
    styles: { count: 2, bg: new Float64Array([0xff0000ff, 0xffffffff]) },
    media: {
      count: 1,
      bit: new Uint32Array([4]),
      kind: new Uint8Array([1]),
      value: new Float32Array([600]),
    },
    tweens: {
      count: 1,
      mask: new Uint32Array([1]),
      duration: new Float32Array([1000]),
      delay: new Float32Array([0]),
      iterations: new Float32Array([1]),
      firstSegment: new Int32Array([0]),
      segmentCount: new Uint16Array([1]),
      easing: new Uint8Array([0]),
      easeA: new Float32Array([0]),
      easeB: new Float32Array([0]),
      easeC: new Float32Array([1]),
      easeD: new Float32Array([1]),
    },
    keyframes: {
      count: 1,
      style: new Uint16Array([1]),
      offset: new Float32Array([1]),
      easing: new Uint8Array([0]),
      easeA: new Float32Array([0]),
      easeB: new Float32Array([0]),
      easeC: new Float32Array([1]),
      easeD: new Float32Array([1]),
    },
  };
  return ui as unknown as CompiledUi;
}

function payloadFor(ui: CompiledUi): HotPayload {
  return {
    counts: { styles: 2, media: 1, tweens: 1, keyframes: 1 },
    // One real column is enough — the payload type wants all 149; the function
    // only reads the fields the payload carries.
    styles: { bg: new Float64Array([0x00ff00ff, 0xffffffff]) } as unknown as HotPayload["styles"],
    media: { bit: new Uint32Array([4]), kind: new Uint8Array([1]), value: new Float32Array([800]) },
    tweens: {
      mask: new Uint32Array([1]),
      duration: new Float32Array([200]),
      delay: new Float32Array([0]),
      iterations: new Float32Array([1]),
      firstSegment: new Int32Array([0]),
      segmentCount: new Uint16Array([1]),
      easing: new Uint8Array([0]),
      easeA: new Float32Array([0]),
      easeB: new Float32Array([0]),
      easeC: new Float32Array([1]),
      easeD: new Float32Array([1]),
    },
    keyframes: {
      style: new Uint16Array([1]),
      offset: new Float32Array([1]),
      easing: new Uint8Array([0]),
      easeA: new Float32Array([0]),
      easeB: new Float32Array([0]),
      easeC: new Float32Array([1]),
      easeD: new Float32Array([1]),
    },
    patches: [],
  };
}

test("a payload writes the new values into the live tables", () => {
  const ui = fakeUi();
  expect(applyHotPayload(ui, [], payloadFor(ui))).toBe(true);

  const styles = ui.styles as unknown as { bg: Float64Array };
  expect(styles.bg[0]).toBe(0x00ff00ff);
  expect(ui.media.value[0]).toBe(800);
  expect(ui.tweens.duration[0]).toBe(200);
});

test("a payload whose shape disagrees is refused, not applied", () => {
  const ui = fakeUi();
  const bad = payloadFor(ui);
  bad.counts = { ...bad.counts, styles: 3 };

  expect(applyHotPayload(ui, [], bad)).toBe(false);
  const styles = ui.styles as unknown as { bg: Float64Array };
  expect(styles.bg[0]).toBe(0xff0000ff); // untouched
});

test("a patch active across the swap is re-applied over the new base values", () => {
  const ui = fakeUi();
  const on = signal(true);

  // `.light` rewrites row 0's bg when on. Applied once up front, as the worker
  // does at startup.
  const patch: StylePatchRef = {
    signal: on,
    affectsLayout: false,
    className: "light",
    entries: [
      {
        field: "bg",
        slots: new Uint16Array([0]),
        on: new Float64Array([0xffffffff]),
        off: new Float64Array([0xff0000ff]),
      },
    ],
  };
  applyStylePatches(ui, [patch]);
  const styles = ui.styles as unknown as { bg: Float64Array };
  expect(styles.bg[0]).toBe(0xffffffff);

  // The swap: base row 0 becomes green, and the class's on-value becomes black.
  // The signal never moved — only a reset + re-apply keeps the patch painting.
  const payload = payloadFor(ui);
  payload.patches = [{ on: [new Float64Array([0x000000ff])], off: [new Float64Array([0xff0000ff])] }];
  expect(applyHotPayload(ui, [patch], payload)).toBe(true);

  expect(styles.bg[0]).toBe(0x000000ff); // the patch's new on-value, not the new base
});
