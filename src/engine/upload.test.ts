/**
 * The compiled app, through the engine, asserted on.
 *
 * These replace the nine hand-computed layout tests that retired with
 * `layout.ts`. They are deliberately *not* a port: the interesting surface has
 * moved. Layout correctness is Taffy's and is covered by the engine's own Rust
 * tests; what only these can cover is the path from the compiler's IR, through
 * the field mapping, into shared memory, and back out as bounds.
 *
 * Nodes are found by what they *are* — the node with four grid tracks, the ones
 * with `position: absolute` — rather than by id, so editing `app.tsx` renumbers
 * everything without breaking a single assertion.
 */
import { expect, test } from "bun:test";
import { Align, Display, FlexWrap, Position } from "../protocol/generated.ts";
import type { CompiledUi, StyleField } from "../ir.ts";
import { Engine } from "./host.ts";
import { Uploader, capacitiesFor } from "./upload.ts";
import { applyTextBindings } from "../runtime/bindings.ts";
import { updateLists, type ListBindingRef } from "../runtime/list-runtime.ts";
import { applyStylePatches, type StylePatchRef } from "../runtime/patches.ts";
import * as generated from "../../app/ui.gen.ts";

const WIDTH = 1040;
const HEIGHT = 560;

function load(): {
  ui: CompiledUi;
  engine: Engine;
  uploader: Uploader;
  patches: StylePatchRef[];
} {
  const ui: CompiledUi = {
    strings: [...generated.strings],
    styles: generated.styles,
    nodes: generated.nodes,
    variants: generated.variants,
    interactive: generated.interactive,
    textBindings: generated.textBindings,
    handlers: generated.handlers,
    lists: generated.lists,
    root: generated.root,
  } as unknown as CompiledUi;

  const patches = generated.stylePatches as unknown as StylePatchRef[];

  applyTextBindings(ui, []);
  updateLists(ui, generated.listBindings as unknown as ListBindingRef[]);
  applyStylePatches(ui, patches);

  const engine = Engine.open({
    ...capacitiesFor(ui),
    width: WIDTH,
    height: HEIGHT,
    root: ui.root,
    windowed: false,
  });

  const uploader = new Uploader(engine, ui);
  uploader.uploadAll();
  engine.tick();

  return { ui, engine, uploader, patches };
}

/** Nodes whose style satisfies a predicate, in document order. */
function nodesWhere(ui: CompiledUi, pred: (get: (f: StyleField) => number) => boolean): number[] {
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  const out: number[] = [];
  for (let i = 0; i < ui.nodes.count; i++) {
    const slot = ui.nodes.style[i]!;
    if (pred((f) => styles[f][slot]!)) out.push(i);
  }
  return out;
}

function childrenOf(ui: CompiledUi, node: number): number[] {
  const out: number[] = [];
  for (let c = ui.nodes.firstChild[node]!; c !== -1; c = ui.nodes.nextSibling[c]!) out.push(c);
  return out;
}

// ---------------------------------------------------------------------------

test("the root receives the window rect", () => {
  const { engine, ui } = load();
  expect(engine.bounds(ui.root)).toEqual([0, 0, WIDTH, HEIGHT]);
  engine.close();
});

test("grid places explicit tracks, and a span covers two of them", () => {
  const { engine, ui } = load();

  const [grid] = nodesWhere(ui, (g) => g("display") === Display.GRID && g("gridCols") === 4);
  expect(grid).toBeDefined();

  const cells = childrenOf(ui, grid!);
  expect(cells.length).toBe(3);

  const [wide, a, b] = cells.map((c) => engine.bounds(c));

  // Four equal tracks over the grid's width. The spanning cell covers two of
  // them plus the gap that would have separated them.
  //
  // Within a pixel, because Taffy rounds final layout to whole pixels — an
  // exact quarter of 950 is not an integer, and the rounding is what stops
  // adjacent cells landing on half-pixel edges.
  const track = (engine.bounds(grid!)[2] - 3 * 10) / 4; // 3 gaps of 10px
  expect(Math.abs(wide![2] - (track * 2 + 10))).toBeLessThanOrEqual(1);
  expect(Math.abs(a![2] - track)).toBeLessThanOrEqual(1);
  expect(Math.abs(b![2] - track)).toBeLessThanOrEqual(1);

  // One row: all three share a y.
  expect(a![1]).toBe(wide![1]);
  expect(b![1]).toBe(wide![1]);
  // And they run left to right without overlapping.
  expect(a![0]).toBeGreaterThanOrEqual(wide![0] + wide![2]);
  expect(b![0]).toBeGreaterThanOrEqual(a![0] + a![2]);

  engine.close();
});

test("flex-grow gives a row's leftover width to one child", () => {
  const { engine, ui } = load();

  // A todo row: the arena's item root.
  const row = ui.lists.arenaStart[0]!;
  const kids = childrenOf(ui, row);
  expect(kids.length).toBe(3);

  const rowBox = engine.bounds(row);
  const [check, label, del] = kids.map((k) => engine.bounds(k));

  // The label grew, so the delete button sits at the far end rather than
  // butting against the checkbox. This is the bug the demo caught: without the
  // LIST node passing its container's `align-items` through, the row
  // shrink-wrapped and the label collapsed to zero width.
  expect(label![2]).toBeGreaterThan(100);
  expect(del![0] + del![2]).toBeCloseTo(rowBox[0] + rowBox[2] - 10, 0);
  expect(label![0]).toBeGreaterThanOrEqual(check![0] + check![2]);

  engine.close();
});

test("a list row stretches to its container", () => {
  const { engine, ui } = load();
  const container = ui.lists.container[0]!;
  const row = ui.lists.arenaStart[0]!;

  expect(engine.bounds(row)[2]).toBeCloseTo(engine.bounds(container)[2], 0);
  engine.close();
});

test("flex-wrap starts a second line when the first runs out", () => {
  const { engine, ui } = load();

  const [chips] = nodesWhere(ui, (g) => g("wrap") === FlexWrap.WRAP);
  expect(chips).toBeDefined();

  const boxes = childrenOf(ui, chips!).map((c) => engine.bounds(c));
  const rows = new Set(boxes.map((b) => b[1]));
  expect(rows.size).toBeGreaterThan(1);

  // Nothing escapes the container it wrapped inside.
  const box = engine.bounds(chips!);
  for (const b of boxes) expect(b[0] + b[2]).toBeLessThanOrEqual(box[0] + box[2] + 0.5);

  engine.close();
});

test("align-self overrides the parent's align-items per item", () => {
  const { engine, ui } = load();

  // The row holding the swatches, found through them rather than by guessing at
  // its own style.
  const swatches = nodesWhere(ui, (g) => g("width") === 34);
  expect(swatches.length).toBeGreaterThan(0);
  const row = ui.nodes.parent[swatches[0]!]!;

  const kids = childrenOf(ui, row);
  const boxes = kids.map((k) => engine.bounds(k));
  const container = engine.bounds(row);

  const [start, mid, end, stretch] = boxes;
  expect(start![1]).toBeCloseTo(container[1], 0);
  expect(mid![1]).toBeGreaterThan(start![1]);
  expect(end![1] + end![3]).toBeCloseTo(container[1] + container[3], 0);
  // `stretch` fills the cross axis, so it is taller than the square ones.
  expect(stretch![3]).toBeGreaterThan(start![3]);

  engine.close();
});

test("aspect-ratio squares a box from its width alone", () => {
  const { engine, ui } = load();
  const [swatch] = nodesWhere(ui, (g) => g("aspectRatio") === 1 && g("width") === 34);
  expect(swatch).toBeDefined();

  const [, , w, h] = engine.bounds(swatch!);
  expect(w).toBe(34);
  expect(h).toBe(34);
  engine.close();
});

test("absolute children are placed against their parent, out of flow", () => {
  const { engine, ui } = load();
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;

  const absolutes = nodesWhere(ui, (g) => g("position") === Position.ABSOLUTE);
  expect(absolutes.length).toBeGreaterThan(0);

  for (const node of absolutes) {
    const box = engine.bounds(ui.nodes.parent[node]!);
    const [x, y, w, h] = engine.bounds(node);
    const slot = ui.nodes.style[node]!;

    // Each inset is checked only when the author set one, so editing the CSS
    // from `top` to `bottom` changes what is asserted rather than breaking it.
    const inset = (f: StyleField) => styles[f][slot]!;

    if (!Number.isNaN(inset("insetT"))) expect(y).toBeCloseTo(box[1] + inset("insetT"), 0);
    if (!Number.isNaN(inset("insetL"))) expect(x).toBeCloseTo(box[0] + inset("insetL"), 0);
    if (!Number.isNaN(inset("insetR"))) {
      expect(x + w).toBeCloseTo(box[0] + box[2] - inset("insetR"), 0);
    }
    if (!Number.isNaN(inset("insetB"))) {
      expect(y + h).toBeCloseTo(box[1] + box[3] - inset("insetB"), 0);
    }

    // Out of flow: it sits inside its parent rather than after its siblings.
    expect(x).toBeGreaterThanOrEqual(box[0]);
    expect(y).toBeGreaterThanOrEqual(box[1]);
  }

  engine.close();
});

test("inline styles beat every selector", () => {
  const { engine, ui } = load();
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;

  // `.btn` paints #27272e. The two inline-styled buttons override it — one from
  // a string, one from an object — which is the precedence a browser gives an
  // inline declaration.
  const BTN_BG = 0xff27272e;
  const inline = nodesWhere(
    ui,
    (g) => g("bg") === 0xffb91c1c || g("bg") === 0xff15803d,
  );
  expect(inline.length).toBe(2);

  for (const node of inline) {
    expect(styles.bg[ui.nodes.style[node]!]).not.toBe(BTN_BG);
    // They still lay out as buttons: the class's padding and radius survive,
    // because inline only overrides what it actually declares.
    expect(styles.radius[ui.nodes.style[node]!]).toBe(6);
    expect(engine.bounds(node)[2]).toBeGreaterThan(0);
  }

  // The object form's `paddingLeft: 24` became 24 *pixels*, while its
  // `fontWeight: 600` stayed unitless.
  const [, objectButton] = inline;
  const slot = ui.nodes.style[objectButton!]!;
  expect(styles.padL[slot]).toBe(24);
  expect(styles.fontWeight[slot]).toBe(600);

  engine.close();
});

test("text is measured, not guessed", () => {
  const { engine, ui } = load();
  // The title, "dziri" at 22px/600.
  const [title] = nodesWhere(ui, (g) => g("fontSize") === 22 && g("fontWeight") === 600);
  expect(title).toBeDefined();

  const [, , w, h] = engine.bounds(title!);
  expect(w).toBeGreaterThan(0);
  expect(h).toBeGreaterThan(22);
  engine.close();
});

test("hit-testing finds an interactive node and ignores the rest", () => {
  const { engine, ui } = load();

  const button = ui.interactive[0]!;
  const [x, y, w, h] = engine.bounds(button);
  expect(engine.hitTest(x + w / 2, y + h / 2)).toBe(button);

  // The very bottom of the window is past the content entirely.
  expect(engine.hitTest(WIDTH - 2, HEIGHT - 2)).toBe(-1);
  engine.close();
});

test("a layout-affecting style patch reaches the engine", () => {
  const { engine, ui, uploader, patches } = load();

  const row = ui.lists.arenaStart[0]!;
  const before = engine.bounds(row)[3];

  // `.compact` rewrites padding in the style table; node pointers never change.
  const compact = patches.find((p) => p.affectsLayout);
  expect(compact).toBeDefined();
  (compact!.signal as unknown as { value: boolean }).value = true;

  applyStylePatches(ui, patches);
  uploader.uploadStyles();
  engine.tick();

  expect(engine.bounds(row)[3]).toBeLessThan(before);

  (compact!.signal as unknown as { value: boolean }).value = false;
  engine.close();
});
