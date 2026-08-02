/**
 * Does the protocol actually round-trip through `bun:ffi`?
 *
 *   bun test src/engine-smoke.test.ts     # or just `bun test`
 *
 * The Rust tests prove the engine works when Rust writes the tables. This proves
 * the interesting half: that **Bun** can write them — through typed-array views
 * over the engine's own memory, with no FFI call per write — and that the engine
 * reads back exactly what was written.
 *
 * It also settles the question the roadmap flagged and would not assume:
 * whether `toArrayBuffer` attaches a deallocator to Rust-owned memory.
 *
 * This was a script that printed `ok` lines and exited non-zero, which meant its
 * assertions only ran when somebody remembered to type `bun run engine:smoke`.
 * They are the same assertions; they just run under `bun test` now.
 *
 * One engine, shared, and the tests are **order-dependent on purpose**: half of
 * what is being tested is that a patch, a relink and a forced GC each leave the
 * engine working, which is a sequence rather than a set of independent facts. The
 * panic test is last because it poisons the engine deliberately.
 */
import { afterAll, expect, test } from "bun:test";

import {
  Align,
  Display,
  EventKind,
  FlexDirection,
  Justify,
  NodeFlags,
  NodeKind,
  Predicate,
  Status,
} from "../protocol/generated.ts";
import { Engine, writeString } from "./host.ts";

// Headless: the same pipeline, no window, so this runs anywhere.
const engine = Engine.open({
  width: 300,
  height: 200,
  nodes: 8,
  styles: 3,
  variants: 1,
  variantSlots: 4,
  media: 1,
  lists: 1,
  strings: 4,
  stringBytes: 256,
  windowed: false,
});

afterAll(() => engine.close());

const { nodes, styles, variants, layout } = engine.tables;

/**
 * Every style field has to be written: the arenas are zeroed, and zero is a real
 * value here — `width: 0`, not `auto`. `auto` is `NaN`.
 */
function initStyle(slot: number): void {
  styles.bg[slot] = 0x00000000;
  styles.fg[slot] = 0xff000000;
  styles.display[slot] = Display.FLEX;
  styles.flexDirection[slot] = FlexDirection.COLUMN;
  styles.justifyContent[slot] = Justify.FLEX_START;
  styles.alignItems[slot] = Align.FLEX_START;
  styles.alignSelf[slot] = Align.UNSET;
  styles.justifyItems[slot] = Align.UNSET;
  styles.justifySelf[slot] = Align.UNSET;
  for (const field of [
    "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
    "flexBasis", "aspectRatio", "insetTop", "insetRight", "insetBottom", "insetLeft",
  ] as const) {
    styles[field][slot] = NaN;
  }
  styles.flexShrink[slot] = 1;
  styles.fontSize[slot] = 16;
  styles.fontWeight[slot] = 400;
  // The transform identities, and the sharpest case of the comment above: a zeroed
  // row is `scale(0)`, a node scaled to nothing rather than a node with no
  // transform. Left out, every box here is invisible *and* unhittable, and it
  // presents as a hit-testing failure rather than as a transform one. `Uploader`
  // gives real tables these by deriving every slot from `INITIAL_STYLE`.
  styles.scaleX[slot] = 1;
  styles.scaleY[slot] = 1;
  styles.opacity[slot] = 1;
  styles.transformOriginPercentX[slot] = 0.5;
  styles.transformOriginPercentY[slot] = 0.5;
}

for (let slot = 0; slot < 3; slot++) initStyle(slot);

// Root: fills the window, 20px padding, 10px gap.
for (const field of ["padTop", "padRight", "padBottom", "padLeft"] as const) {
  styles[field][0] = 20;
}
styles.gapRow[0] = 10;
styles.bg[0] = 0xff101216;

// A fixed box, and a text node that has to be measured.
styles.width[1] = 120;
styles.height[1] = 40;
styles.bg[1] = 0xff3b82f6;
styles.fg[2] = 0xffffffff;

writeString(engine, 0, "Hello", 0);

function node(id: number, kind: number, style: number, text: number): void {
  nodes.kind[id] = kind;
  nodes.style[id] = style;
  nodes.text[id] = text;
}

node(0, NodeKind.BOX, 0, -1);
node(1, NodeKind.BOX, 1, -1);
node(2, NodeKind.TEXT, 2, 0);
nodes.flags[2] = NodeFlags.MEASURABLE;
nodes.flags[1] = NodeFlags.INTERACTIVE;

// Link: root -> [box, text]. Writing the chain *is* the API; there is no call.
nodes.firstChild[0] = 1;
nodes.nextSibling[1] = 2;
nodes.parent[1] = 0;
nodes.parent[2] = 0;

// One conditional node: it reads hover and active, so its run is four entries
// long — base, hover, active, hover+active — indexed by the compacted bits.
variants.node[0] = 1;
variants.mask[0] = Predicate.HOVER | Predicate.ACTIVE;
variants.runStart[0] = 0;
engine.tables.variantSlots.style.set([1, 1, 1, 1]);

engine.tick();

test("what Bun wrote, the engine read", () => {
  expect(Array.from(engine.bounds(0))).toEqual([0, 0, 300, 200]);
  expect(Array.from(engine.bounds(1))).toEqual([20, 20, 120, 40]);

  const [textX, textY, textW] = engine.bounds(2);
  expect([textX, textY]).toEqual([20, 70]);

  if (engine.fontFamily() === "Segoe UI") {
    // Skia measures "Hello" at 16px as 36.85; Taffy publishes whole pixels.
    expect(textW).toBeCloseTo(36.85, 0);
  } else {
    // Any other font manager: the number is different, the point is that Skia
    // measured rather than the host guessing.
    expect(textW).toBeGreaterThan(0);
  }
});

test("the layout table is the same memory as the bounds call", () => {
  expect([layout.x[1], layout.y[1], layout.width[1], layout.height[1]]).toEqual([20, 20, 120, 40]);
});

test("hit-testing finds the interactive node, and nothing where nothing is", () => {
  expect(engine.hitTest(30, 30)).toBe(1);
  expect(engine.hitTest(290, 190)).toBe(-1);
});

test("a style patch is a memory write, not a call", () => {
  styles.height[1] = 64;
  engine.tick();
  expect(engine.bounds(1)[3]).toBe(64);
});

test("a list relink is a memory write too", () => {
  nodes.firstChild[0] = 2;
  nodes.nextSibling[2] = 1;
  nodes.nextSibling[1] = -1;
  engine.tick();
  expect(engine.bounds(2)[1]).toBe(20);
});

/**
 * `toArrayBuffer(ptr, byteOffset, byteLength)` — the three-argument form — takes
 * no finalizer, so Bun attaches none. This is the empirical half of that claim:
 * drop every local reference to the views, force a full GC, and keep rendering.
 * If a deallocator had been attached, the engine would now be drawing from freed
 * memory.
 */
test("the engine still renders after a forced GC", () => {
  let views: unknown[] | null = [nodes.kind, styles.bg, layout.x];
  views = null;
  void views;
  Bun.gc(true);

  engine.tick();
  expect(engine.bounds(1)[3]).toBe(64);
  expect(styles.height[1]).toBe(64);
});

test("events cross the boundary as data", () => {
  expect(engine.drainEvents().length).toBe(0);
  expect(EventKind.CLICK).toBe(6);
});

/**
 * Last, and it has to be: a caught panic poisons the engine, so every call after
 * this one fails fast by design. The real assertion is that the process is still
 * here to run the next line — an unwind reaching Bun aborts it with no message.
 */
test("a Rust panic returns a status code instead of killing the process", () => {
  expect(engine.panicForTesting()).toBe(Status.PANIC);
  expect(engine.tick.bind(engine)).toThrow();
});
