/**
 * The compiled window, through the engine, asserted on.
 *
 * These replace the nine hand-computed layout tests that retired with `layout.ts`.
 * They are deliberately *not* a port: the interesting surface has moved. Layout
 * correctness is Taffy's and is covered by the engine's own Rust tests; what only
 * these can cover is the path from the compiler's IR, through the field mapping, into
 * shared memory, and back out as bounds.
 *
 * # What belongs here, and what does not
 *
 * The demo is the fixture on purpose. The claim is about *real emitter output* making
 * the round trip, and a synthetic tree cannot exercise that — the same reason a
 * compiler is tested on real programs.
 *
 * What does **not** belong here is a claim about what CSS means. Five tests had drifted
 * into exactly that — that `align-self` beats `align-items`, that `aspect-ratio` squares
 * a box, that a grid places four tracks — and they lived here only because the demo
 * happened to contain an example of each. They are now in
 * `native-src/dziri-engine/tests/bounds.rs`, against fixtures those tests own, which is
 * what the paragraph above always said should happen.
 *
 * The move was not tidying. Nodes here are found by what they *are* rather than by id,
 * which survives renumbering but not the page *growing*: `wrap === WRAP` matched two
 * nodes when it was written and four once the demo's navigation gained `flex-wrap`, and
 * the test took the first — so it silently began measuring the navigation bar and kept
 * passing, because a wrapped nav also wraps onto two lines. `exactly` exists to make
 * that class of drift loud, and it caught a second instance the moment it was added.
 *
 * The window's other routes are in this tree too, resident and `hidden`, so they are
 * excluded from layout exactly as they are at run time.
 */
import { expect, test } from "bun:test";
import { Align, Display, FlexWrap, Position } from "../protocol/generated.ts";
import { INITIAL_STYLE, routeChain, type CompiledUi, type StyleField } from "../ir.ts";
import { Engine } from "./host.ts";
import { NUMBER_FIELDS, Uploader, capacitiesFor } from "./upload.ts";
import { applyTextBindings } from "../runtime/bindings.ts";
import { updateLists, type ListBindingRef } from "../runtime/list-runtime.ts";
import { applyStylePatches, type StylePatchRef } from "../runtime/patches.ts";
import * as generated from "../../windows/main/ui.gen.ts";

const WIDTH = 1040;
const HEIGHT = 560;

/**
 * Shows one route, the way the host does.
 *
 * The window opens on its overview and everything these tests assert about — the
 * grid, the list, the absolute children — lives on the `features` route, which
 * ships `hidden`. Without this every assertion measures a `display: none` subtree
 * and reads zero, which is a correct frame and a useless test.
 *
 * Deliberately the same `routeChain` the emitter and the host use, so a change to
 * what "visible together" means cannot leave the tests measuring something the
 * application never shows.
 */
function showRoute(path: string): void {
  const routes = generated.routeNodes;
  const target = routes.findIndex((r) => r.path === path);
  if (target === -1) throw new Error(`no route "${path}" — routes are ${routes.map((r) => r.path).join(", ")}`);

  const chain = routeChain(routes, target);
  for (const [i, route] of routes.entries()) {
    for (const node of route.roots) generated.nodes.hidden[node] = chain.has(i) ? 0 : 1;
  }
}

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
    generated: generated.generated,
    textBindings: generated.textBindings,
    handlers: generated.handlers,
    lists: generated.lists,
    media: generated.media,
    tweens: generated.tweens,
    keyframes: generated.keyframes,
    controls: generated.controls,
    root: generated.root,
  };

  const patches: StylePatchRef[] = generated.stylePatches;

  showRoute("features");

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

/**
 * Nodes whose style satisfies a predicate, in document order, **on the visible
 * route only**.
 *
 * Finding a node by what it *is* rather than by id is what let every assertion here
 * survive the page being renumbered. Residency broke the uniqueness that depended
 * on: nine other routes are in this table too, and the `borders` route also has a
 * four-track grid — so "the node with four grid tracks" silently started matching a
 * subtree the frame does not show, and the assertions measured zeros.
 *
 * Skipping hidden subtrees restores the property and is what the tests meant all
 * along: they assert about what is on screen.
 *
 * **Use {@link exactly} whenever the count is known.** A predicate is a query against a
 * page that keeps growing, and the failure mode of taking `[0]` from an ambiguous one
 * is not a broken test — it is a test that quietly measures something else. That is
 * not hypothetical: `wrap === WRAP` matched two nodes when it was written and four
 * after the demo's navigation gained `flex-wrap`, and the assertion — "wraps onto more
 * than one line, and nothing escapes its container" — was true of the navigation bar
 * as well, so it went on passing while measuring the wrong element.
 */
function nodesWhere(ui: CompiledUi, pred: (get: (f: StyleField) => number) => boolean): number[] {
  const styles: Record<StyleField, ArrayLike<number>> = ui.styles;

  const excluded = new Set<number>();
  const bury = (node: number): void => {
    excluded.add(node);
    for (let c = ui.nodes.firstChild[node]!; c !== -1; c = ui.nodes.nextSibling[c]!) bury(c);
  };
  for (let i = 0; i < ui.nodes.count; i++) {
    if (ui.nodes.hidden[i] !== 0) bury(i);
  }

  const out: number[] = [];
  for (let i = 0; i < ui.nodes.count; i++) {
    if (excluded.has(i)) continue;
    const slot = ui.nodes.style[i]!;
    if (pred((f) => styles[f][slot]!)) out.push(i);
  }
  return out;
}

/**
 * Exactly `count` nodes matching `pred`, or a failure naming what was found.
 *
 * The count *is* an assertion, and it is the one that was missing. `what` is quoted
 * back because the useful diagnostic is "the thing you meant is no longer the only one
 * of its kind" — which a bare length comparison does not convey, and which is what
 * distinguishes a test that should narrow its query from one that should own a fixture.
 *
 * It has already earned itself twice. Converting `text is measured` to use it reported
 * *four* matches for a query whose comment named one element, so that test had been
 * measuring the demo's page title rather than the heading it claimed.
 */
function exactly(
  ui: CompiledUi,
  what: string,
  count: number,
  pred: (get: (f: StyleField) => number) => boolean,
): number[] {
  const found = nodesWhere(ui, pred);
  if (found.length !== count) {
    throw new Error(
      `expected exactly ${count} node(s) for "${what}" on the visible route, ` +
        `found ${found.length}${found.length > 0 ? ` (${found.join(", ")})` : ""}.\n` +
        `  Either the page gained one, or this test should be asserting on a fixture it ` +
        `owns rather than on the demo — see the note on nodesWhere.`,
    );
  }
  return found;
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
  expect(del![0] + del![2]).toBeCloseTo(rowBox[0] + rowBox[2] - 12, 0);
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

test("inline styles beat every selector", () => {
  const { engine, ui } = load();
  const styles: Record<StyleField, ArrayLike<number>> = ui.styles;

  // `.btn`/BTN paints zinc-800. The two inline-styled buttons override it — one from
  // a string, one from an object — which is the precedence a browser gives an
  // inline declaration.
  const BTN_BG = 0xff27272a; // bg-zinc-800
  const inline = exactly(
    ui,
    "the two inline-styled buttons",
    2,
    (g) => g("bg") === 0xffb91c1c || g("bg") === 0xff15803d,
  );

  for (const node of inline) {
    expect(styles.bg[ui.nodes.style[node]!]).not.toBe(BTN_BG);
    // They still lay out as buttons: the class's padding and radius survive,
    // because inline only overrides what it actually declares.
    expect(styles.radTL[ui.nodes.style[node]!]).toBe(8); // rounded-lg
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

  // Every 18px/600 heading on the route, not the first one.
  //
  // This test named "the features heading" and took `[0]`, and `only` reported the
  // query matching four nodes — so it had in fact been measuring the demo's page
  // title all along. The fix is not a narrower query: the claim here is that *any*
  // text run gets a real advance width from Skia rather than a guess, which is true
  // of all four, and asserting it over the whole set is both stronger and immune to
  // the page gaining a fifth.
  //
  // It stays on the demo rather than moving to a fixture because a measured advance
  // needs a real string in a real font, which is exactly what a synthetic tree lacks.
  const titles = nodesWhere(ui, (g) => g("fontSize") === 18 && g("fontWeight") === 600);
  expect(titles.length).toBeGreaterThan(0);

  for (const title of titles) {
    const [, , w, h] = engine.bounds(title);
    expect(w).toBeGreaterThan(0);
    // Taller than the font size, because a line box is not a glyph box.
    expect(h).toBeGreaterThan(18);
  }
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
    generated: generated.generated,
    textBindings: generated.textBindings,
    handlers: generated.handlers,
    lists: generated.lists,
    media: generated.media,
    tweens: generated.tweens,
    keyframes: generated.keyframes,
    controls: generated.controls,
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
    generated: generated.generated,
    textBindings: [],
    handlers: [],
    lists: generated.lists,
    media: generated.media,
    tweens: generated.tweens,
    keyframes: generated.keyframes,
    controls: generated.controls,
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
