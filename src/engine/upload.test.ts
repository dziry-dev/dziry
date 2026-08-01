/**
 * The compiled window, through the engine, asserted on.
 *
 * These replace the nine hand-computed layout tests that retired with
 * `layout.ts`. They are deliberately *not* a port: the interesting surface has
 * moved. Layout correctness is Taffy's and is covered by the engine's own Rust
 * tests; what only these can cover is the path from the compiler's IR, through
 * the field mapping, into shared memory, and back out as bounds.
 *
 * Nodes are found by what they *are* — the node with four grid tracks, the ones
 * with `position: absolute` — rather than by id, so editing the page renumbers
 * everything without breaking a single assertion. That held when the demo became
 * a route inside a window and every node id shifted.
 *
 * The window's other five routes are in this tree too, resident and `hidden`, so
 * they are excluded from layout exactly as they are at run time.
 */
import { expect, test } from "bun:test";
import { Align, Display, FlexWrap, Position } from "../protocol/generated.ts";
import { INITIAL_STYLE, type CompiledUi, type StyleField } from "../ir.ts";
import { Engine } from "./host.ts";
import { NUMBER_FIELDS, Uploader, capacitiesFor } from "./upload.ts";
import { applyTextBindings } from "../runtime/bindings.ts";
import { updateLists, type ListBindingRef } from "../runtime/list-runtime.ts";
import { applyStylePatches, type StylePatchRef } from "../runtime/patches.ts";
import * as generated from "../../windows/main/ui.gen.ts";

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
    media: generated.media,
    root: generated.root,
  };

  const patches: StylePatchRef[] = generated.stylePatches;

  applyTextBindings(ui, []);
  updateLists(ui, generated.listBindings satisfies ListBindingRef[]);
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
  const styles: Record<StyleField, ArrayLike<number>> = ui.styles;
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
  // butting against the checkbox. This is what the demo caught when rows still
  // hung off a wrapper node: the container's `align-items` applied to the
  // wrapper instead of the rows, so the row shrink-wrapped and the label
  // collapsed to zero width. Rows are the container's own children now, so the
  // property holds by construction rather than by copying fields onto a
  // stand-in.
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
  const styles: Record<StyleField, ArrayLike<number>> = ui.styles;

  const absolutes = nodesWhere(ui, (g) => g("position") === Position.ABSOLUTE);
  expect(absolutes.length).toBeGreaterThan(0);

  for (const node of absolutes) {
    const parent = ui.nodes.parent[node]!;
    const box = engine.bounds(parent);
    const [x, y, w, h] = engine.bounds(node);
    const slot = ui.nodes.style[node]!;

    // An inset is measured from the containing block's *padding* box, so a
    // bordered parent moves its absolute children in by the border width. The
    // bounds the engine publishes are border boxes, hence this term. It was
    // absent while `borderWidth` was excluded from layout, which is why this
    // assertion is what caught that fix reaching Taffy.
    const border = styles.borderWidth[ui.nodes.style[parent]!]!;
    const inner = [box[0] + border, box[1] + border, box[2] - border * 2, box[3] - border * 2];

    // Each inset is checked only when the author set one, so editing the CSS
    // from `top` to `bottom` changes what is asserted rather than breaking it.
    const inset = (f: StyleField) => styles[f][slot]!;

    if (!Number.isNaN(inset("insetT"))) expect(y).toBeCloseTo(inner[1]! + inset("insetT"), 0);
    if (!Number.isNaN(inset("insetL"))) expect(x).toBeCloseTo(inner[0]! + inset("insetL"), 0);
    if (!Number.isNaN(inset("insetR"))) {
      expect(x + w).toBeCloseTo(inner[0]! + inner[2]! - inset("insetR"), 0);
    }
    if (!Number.isNaN(inset("insetB"))) {
      expect(y + h).toBeCloseTo(inner[1]! + inner[3]! - inset("insetB"), 0);
    }

    // Out of flow: it sits inside its parent rather than after its siblings.
    expect(x).toBeGreaterThanOrEqual(box[0]);
    expect(y).toBeGreaterThanOrEqual(box[1]);
  }

  engine.close();
});

test("inline styles beat every selector", () => {
  const { engine, ui } = load();
  const styles: Record<StyleField, ArrayLike<number>> = ui.styles;

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

test("typing does not resize the arena on every keystroke", () => {
  // Growth is not free: `grow` reallocates all three arenas, invalidates every
  // view, forces a full re-upload and marks the engine `fresh`, which rebuilds
  // the whole Taffy tree. An exact capacity request moves by 12 bytes per
  // character, so holding a key down did all of that once per character — and
  // since `grow` never shrinks, deleting the text did not give it back.
  const ui: CompiledUi = {
    strings: [...generated.strings],
    styles: generated.styles,
    nodes: generated.nodes,
    variants: generated.variants,
    interactive: generated.interactive,
    textBindings: generated.textBindings,
    handlers: generated.handlers,
    lists: generated.lists,
    media: generated.media,
    root: generated.root,
  };

  const slot = ui.strings.findIndex((s) => s === "");
  expect(slot).toBeGreaterThanOrEqual(0);

  let last = capacitiesFor(ui).stringBytes;
  let growths = 0;
  for (let i = 1; i <= 2000; i++) {
    ui.strings[slot] = "x".repeat(i);
    const want = capacitiesFor(ui).stringBytes;
    if (want > last) {
      growths++;
      last = want;
    }
  }

  // Doubling, so the count is logarithmic in the text length rather than equal
  // to it. The exact figure depends on where the sample starts; what must hold
  // is that it is a handful and not two thousand.
  expect(growths).toBeLessThan(6);
});

/**
 * Zero is a real value in a style table, so a slot nobody wrote must still say
 * `auto` rather than `0`.
 *
 * Asserted through the mapping table rather than on a chosen field, because the
 * bug this replaces was a hand-written list: it covered `width`, `height` and
 * `alignSelf` and left `maxWidth: 0`, `flexBasis: 0`, `flexShrink: 0` and
 * `fontSize: 0` in every spare slot. A per-field list in the test would have had
 * exactly the same blind spot as the one in the code.
 */
test("spare style slots hold the initial style, every field of it", () => {
  const { ui } = load();
  const count = ui.styles.count;

  // `capacitiesFor` sizes the style table exactly — styles are interned at build
  // time, so there is nothing to grow into — which is why this asks for headroom
  // rather than using the shared harness. A grown table is where spare slots
  // actually appear.
  const engine = Engine.open({
    ...capacitiesFor(ui),
    styles: count + 4,
    width: WIDTH,
    height: HEIGHT,
    root: ui.root,
    windowed: false,
  });
  new Uploader(engine, ui).uploadAll();

  const styles = engine.tables.styles as unknown as Record<string, ArrayLike<number>>;
  expect(engine.tables.styles.bg.length).toBeGreaterThan(count);

  const wrong: string[] = [];
  for (const [schemaField, irField] of NUMBER_FIELDS) {
    const initial = INITIAL_STYLE[irField];
    const got = styles[schemaField]![count]!;
    const same = Number.isNaN(initial) ? Number.isNaN(got) : got === initial;
    if (!same) wrong.push(`${schemaField}: got ${got}, want ${initial}`);
  }

  expect(wrong).toEqual([]);
  engine.close();
});

test("a capacity request is a power of two", () => {
  const ui: CompiledUi = {
    strings: ["x".repeat(5000)],
    styles: generated.styles,
    nodes: generated.nodes,
    variants: generated.variants,
    interactive: generated.interactive,
    textBindings: [],
    handlers: [],
    lists: generated.lists,
    media: generated.media,
    root: 0,
  };
  const bytes = capacitiesFor(ui).stringBytes;
  expect(Number.isInteger(Math.log2(bytes))).toBe(true);
  expect(bytes).toBeGreaterThanOrEqual(5000 * 3);
});

/**
 * A short viewport must not compress the content.
 *
 * CSS's initial `min-height` is `auto`, which for a flex item resolves to its
 * content size — the rule that stops a column from squeezing its children when the
 * container runs out of room. `INITIAL_STYLE` had `minH: 0`, so the sample's list
 * rows silently got shorter as the window got shorter, and text started colliding
 * with its own box. What should happen instead is that the content keeps its size
 * and overflows, which is what a scroll container is then for.
 *
 * Asserted on the real app at two viewport heights, because that is how it was
 * noticed: resize the window and watch the rows shrink.
 */
test("a short viewport overflows rather than squeezing the rows", () => {
  const { ui } = load();
  const row = ui.lists.arenaStart[0]!;

  const measure = (height: number): number => {
    const engine = Engine.open({
      ...capacitiesFor(ui),
      width: WIDTH,
      height,
      root: ui.root,
      windowed: false,
    });
    new Uploader(engine, ui).uploadAll();
    engine.tick();
    const rowHeight = engine.bounds(row)[3];
    engine.close();
    return rowHeight;
  };

  const roomy = measure(HEIGHT);
  const cramped = measure(220);

  expect(roomy).toBeGreaterThan(0);
  expect(cramped).toBeCloseTo(roomy, 0);
});
