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
import {
  Align,
  ControlFlags,
  ControlKind,
  Display,
  FlexWrap,
  NodeKind,
  Position,
} from "../protocol/generated.ts";
import { INITIAL_STYLE, type CompiledUi, type StyleField } from "../ir.ts";
import { Engine } from "./host.ts";
import { NUMBER_FIELDS, Uploader, capacitiesFor } from "./upload.ts";
import { applyTextBindings, typeInto } from "../runtime/bindings.ts";
import { updateLists, type ListBindingRef } from "../runtime/list-runtime.ts";
import { applyStylePatches, type StylePatchRef } from "../runtime/patches.ts";
import { buildUi, requireRoute, showRoute } from "../host/window-state.ts";
import * as generated from "../../windows/main/ui.gen.ts";

const WIDTH = 1040;
const HEIGHT = 560;

/**
 * @param route Which of the demo's routes to make visible. Defaults to `features`,
 *   which is where the grid, the list and the absolute children live.
 *
 *   Parameterised because the form controls are on a *different* route, and everything
 *   on a hidden one reads zero — a test measuring it is asserting against `display:
 *   none`, which is a correct frame and a useless test. That is not hypothetical: the
 *   placeholder test below found exactly this, having assumed the default.
 */
function load(
  route = "features",
  /**
   * Window height. Taller than the default only where a test has to *press* something.
   *
   * A node below the viewport is laid out — `bounds` reports it — but `hit_test` rejects it,
   * so a press aimed at it returns -1 and every later assertion measures a field that was
   * never touched. The Controls route's text fields sit at y≈650, past the 560 the window
   * opens at, which is exactly how the selection tests below first failed: with a null
   * selection and nothing to say the click had missed.
   */
  height = HEIGHT,
): {
  ui: CompiledUi;
  engine: Engine;
  uploader: Uploader;
  patches: StylePatchRef[];
} {
  const ui = buildUi(generated);
  const patches: StylePatchRef[] = generated.stylePatches;

  // The window opens on its overview and everything these tests assert about — the
  // grid, the list, the absolute children — lives on the `features` route, which
  // ships `hidden`. Without this every assertion measures a `display: none` subtree
  // and reads zero, which is a correct frame and a useless test.
  //
  // The host's own `showRoute`, not a copy of it, so a change to what "visible
  // together" means cannot leave the tests measuring something the application
  // never shows.
  const routes = generated.routeNodes;
  showRoute(ui, routes, requireRoute(routes, route, generated.windowId));

  applyTextBindings(ui, []);
  updateLists(ui, generated.listBindings satisfies ListBindingRef[]);
  applyStylePatches(ui, patches);

  const engine = Engine.open({
    ...capacitiesFor(ui),
    width: WIDTH,
    height,
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

/**
 * The one editable on the route `load()` shows, with the point at its centre.
 *
 * Not `editables[0]`, and the difference is a failure this file already caused once:
 * the demo gained a bound field on the *controls* route, that field sorted first by
 * node id, and two tests began measuring a `hidden` subtree — reading bounds of 0 and
 * hit-testing a point at the window's origin. Exactly the drift the header warns
 * about, committed by the tests added to fix a different silent failure.
 *
 * So the field is chosen by being laid out, and `exactly one` is asserted rather than
 * assumed: if a second visible field ever appears, this fails loudly instead of
 * quietly picking whichever came first.
 */
function shownEditable(engine: Engine): {
  node: number;
  signal: { value: string };
  centre: [number, number];
} {
  const laidOut = shownEditables(engine);
  expect(laidOut.length).toBe(1);
  return laidOut[0]!;
}

/**
 * Every editable with a laid-out box, in document order.
 *
 * The plural exists because the Controls route shows two and the default route shows one,
 * and {@link shownEditable}'s `toBe(1)` is load-bearing on the default route: it is what
 * catches an editable that stopped being laid out at all.
 */
function shownEditables(engine: Engine): {
  node: number;
  signal: { value: string };
  centre: [number, number];
}[] {
  return generated.editables
    .filter((e) => engine.bounds(e.node)[2] > 0)
    .map((found) => {
      const [x, y, w, h] = engine.bounds(found.node);
      return {
        node: found.node,
        signal: found.signal,
        centre: [x + w / 2, y + h / 2] as [number, number],
      };
    });
}

/** The one field on the Controls route that starts with text in it, so a range has substance. */
function filledEditable(engine: Engine) {
  const found = shownEditables(engine).find((e) => e.signal.value.length > 6);
  expect(found, "the Controls route needs a field with text for a selection to cover").toBeDefined();
  return found!;
}

test("clicking a text field focuses the field itself, so a keystroke has a target", () => {
  const { engine } = load();

  // The whole chain, through the real engine rather than through the compiler's
  // array: click the demo's editable, and the node the host will match a keystroke
  // against is the one the `editables` table names.
  //
  // Every link here was already correct except the first. `hit_test` returns only
  // `INTERACTIVE` nodes, and an editable was in no clause of `buildInteractive` — so
  // this returned the field's *parent* row, `typeInto` found no editable at that
  // node, and the keystroke was dropped. Asserting on `hitTest` rather than on
  // `interactive` is deliberate: the array is the compiler's claim, and this is the
  // engine agreeing with it.
  const { node, centre } = shownEditable(engine);
  expect(engine.hitTest(...centre)).toBe(node);

  engine.close();
});

test("a keystroke aimed at where the pointer landed reaches the bound signal", () => {
  const { engine } = load();

  // Focus and typing composed, which is the claim a user actually cares about and
  // neither half proves alone. The node is not passed in — it is whatever the engine
  // says is under the pointer, so a regression in `interactive`, in `bounds` or in
  // `hit_test` breaks this even though it never mentions them.
  //
  // What is still not covered, and cannot be from here: SDL. A real keystroke needs a
  // real window and real OS input, so `RawInput::Text -> TEXT_INPUT` is the one link
  // in the chain with no harness. This starts one node later, from the focus the
  // engine reports.
  const { signal, centre } = shownEditable(engine);
  const focused = engine.hitTest(...centre);

  const before = signal.value;
  expect(typeInto(generated.editables, focused, { text: "Z" })).toBe(true);
  expect(signal.value).toBe(`${before}Z`);

  // And backspace takes it off again, so the field is not write-only.
  expect(typeInto(generated.editables, focused, { text: null, erase: "backward" })).toBe(true);
  expect(signal.value).toBe(before);

  engine.close();
});

test("a placeholder is drawn exactly where the typed text will be", () => {
  // The form controls, not the default route. Written with the default first, and the
  // test failed with zero placeholders laid out — they were all on a `display: none`
  // subtree, which is exactly the trap `nodesWhere` documents.
  const { engine, ui } = load("controls");

  // The assertion is an *agreement* between two boxes rather than a number, which is
  // what makes it worth having: a placeholder that lands anywhere else than the text it
  // stands in for shifts the moment the user types a character.
  //
  // It was `left: 0` in the UA sheet, and that is short by exactly `padding-left`: an
  // absolutely positioned box is placed against its containing block's *padding* box
  // while text sits in the *content* box. The placeholder sat against the border with
  // the typed text correctly indented beside it. `walkPlaceholder` supplies the field's
  // own resolved padding as a per-state default instead, because the UA sheet cannot
  // name a length the author chooses.
  const laidOut = [...generated.placeholders].filter((n) => engine.bounds(n)[2] > 0);
  expect(laidOut.length).toBeGreaterThan(0);

  for (const box of laidOut) {
    const field = ui.nodes.parent[box]!;

    // The field's other child is the editable run — where the value is drawn.
    let run = ui.nodes.firstChild[field]!;
    while (run >= 0 && run === box) run = ui.nodes.nextSibling[run]!;
    expect(run).toBeGreaterThanOrEqual(0);

    const [px, py] = engine.bounds(box);
    const [rx, ry] = engine.bounds(run);
    expect(px).toBeCloseTo(rx, 1);
    expect(py).toBeCloseTo(ry, 1);

    // And both are inside the padding, not against the border — so the agreement above
    // cannot be satisfied by *both* being wrong in the same way.
    const [fx, fy] = engine.bounds(field);
    expect(px).toBeGreaterThan(fx);
    expect(py).toBeGreaterThan(fy);
  }

  engine.close();
});

test("an unbound <input> swallows the keystroke, because no signal owns its value", () => {
  const { engine, ui } = load();

  // The demo's Controls page has two `<input type="text">` with no binding, and this
  // is what that costs: even if one could be focused, there is no signal to write to,
  // so `typeInto` reports the key unconsumed and the field stays empty forever.
  //
  // Asserted rather than left implicit because it is the *design* question A5 has to
  // answer, and it is the same question `controls.rs` already answered for a
  // checkbox: nobody declared the value, so an engine-owned buffer is the only thing
  // that could hold it. Until that exists, a typeable field is one with `bind:value`,
  // and this test is what will start failing when that stops being true.
  const bound = new Set(generated.editables.map((e) => e.node));
  const unbound = [...ui.interactive].find((n) => !bound.has(n))!;
  expect(typeInto(generated.editables, unbound, { text: "Z" })).toBe(false);

  engine.close();
});

/**
 * A drag makes a range, and typing over it replaces exactly that range.
 *
 * The whole chain through the real engine: a press puts the anchor down, a *motion* moves
 * the focus — a press and a release at two points select nothing, because the focus follows
 * `mouse_move` — and the offsets the engine reports are what `typeInto` splices at. Nothing
 * here mentions `(anchor, focus)`; it asserts on the value, which is the only part a user
 * sees.
 */
test("dragging across a field selects a range, and typing replaces it", () => {
  const { engine } = load("controls", 900);

  const { node, signal } = filledEditable(engine);
  const before = signal.value;
  expect(before.length).toBeGreaterThan(6);

  // Fractions rather than pixels, so the test keeps pointing at the middle of the text when
  // the demo's copy changes. Both stay well inside the *text* rather than the box: the box is
  // wider than the string, and a drag past the last character clamps to the length — which is
  // correct and would make the "a proper interior range" assertions below vacuous.
  engine.dragNode(node, 0.1, 0.45);

  const range = engine.selectionOf(node);
  expect(range).not.toBeNull();
  const [start, end] = range!;
  expect(end).toBeGreaterThan(start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeLessThan(before.length);

  // Typing over it: the range goes and the character takes its place — measured, and it is
  // where a naive implementation appends instead, or deletes one character too many.
  expect(
    typeInto(generated.editables, node, { text: "Z", caret: end, anchor: start }),
  ).toBe(true);
  expect(signal.value).toBe(before.slice(0, start) + "Z" + before.slice(end));

  signal.value = before;
  engine.close();
});

/**
 * A double click selects a word; Backspace over it erases exactly the word.
 *
 * Backspace and Delete are *identical* once a range is live — both take the range and
 * neither takes the extra character its collapsed behaviour would. Measured, and it is the
 * detail that lets the two keys share one code path.
 */
test("a double click selects a word, and Backspace erases just that word", () => {
  const { engine } = load("controls", 900);

  const { node, signal } = filledEditable(engine);
  const before = signal.value;

  engine.clickNodeTimes(node, 2);
  const range = engine.selectionOf(node);
  expect(range).not.toBeNull();
  const [start, end] = range!;

  // A word, and the trailing space that comes with it — so the selected text has no
  // internal space and the whole thing is one segment plus whitespace.
  const word = before.slice(start, end);
  expect(word.trimEnd().length).toBeGreaterThan(0);
  expect(word.trimEnd()).not.toContain(" ");

  for (const erase of ["backward", "forward"] as const) {
    expect(typeInto(generated.editables, node, { text: null, erase, caret: end, anchor: start })).toBe(
      true,
    );
    expect(signal.value, erase).toBe(before.slice(0, start) + before.slice(end));
    signal.value = before;
  }

  engine.close();
});

/** A triple click takes the whole value, which is what Ctrl+A does too. */
test("a triple click selects everything in the field", () => {
  const { engine } = load("controls", 900);

  const { node, signal } = filledEditable(engine);
  engine.clickNodeTimes(node, 3);

  expect(engine.selectionOf(node)).toEqual([0, [...signal.value].length]);

  engine.close();
});

/**
 * The `<select>`s on the Controls route, found by their controls rows rather than by id.
 *
 * By structure for the reason `shownEditables` is: node ids move every time the demo's copy
 * changes, and a test that hardcodes one does not fail — it measures a different node. Each
 * select is returned with the parts a gesture needs: the button to press, the picker box the
 * options are laid out in, and the options themselves.
 *
 * `overlays` supplies the picker rather than "the last child", because that ordering is
 * deliberately not meaningful — the box is out of flow *and* out of the paint walk, so where
 * it sits among its siblings says nothing. The engine finds it by the same flag.
 */
function shownSelects(engine: Engine, ui: CompiledUi) {
  const kinds = ui.controls.kind;
  const nodes = ui.controls.node;
  const out: {
    node: number;
    button: number;
    picker: number;
    /** The `<selectedcontent>`'s text run — the node a commit repoints. */
    label: number;
    /** Each option, with the run holding its own label. */
    options: { node: number; label: number }[];
    disabled: boolean;
  }[] = [];

  /** The `controls.label` of a node, or -1 — the same column the engine reads. */
  const labelOf = (node: number) => {
    const row = [...nodes].indexOf(node);
    return row >= 0 ? ui.controls.label[row]! : -1;
  };

  for (let row = 0; row < ui.controls.count; row++) {
    if (kinds[row] !== ControlKind.SELECT) continue;
    const node = nodes[row]!;
    if (engine.bounds(node)[2] === 0) continue;

    const children: number[] = [];
    for (let c = ui.nodes.firstChild[node]!; c >= 0; c = ui.nodes.nextSibling[c]!) children.push(c);

    const picker = children.find((c) => generated.overlays.includes(c));
    expect(picker, `select ${node} has no ::picker(select) box`).toBeDefined();

    // Every option in the picker's subtree, so an `<optgroup>`'s are included — they are
    // the select's own options and a direct-child scan would miss them.
    const options: { node: number; label: number }[] = [];
    const walk = (n: number) => {
      for (let c = ui.nodes.firstChild[n]!; c >= 0; c = ui.nodes.nextSibling[c]!) {
        const at = [...nodes].indexOf(c);
        if (at >= 0 && kinds[at] === ControlKind.OPTION) {
          options.push({ node: c, label: ui.controls.label[at]! });
        }
        walk(c);
      }
    };
    walk(picker!);

    out.push({
      node,
      button: children.find((c) => ui.nodes.kind[c] === NodeKind.BUTTON) ?? -1,
      picker: picker!,
      label: labelOf(node),
      options,
      disabled: (ui.controls.flags[row]! & ControlFlags.DISABLED) !== 0,
    });
  }
  return out;
}

/** The first enabled select with more than one option, so choosing can change something. */
function pickableSelect(engine: Engine, ui: CompiledUi) {
  const found = shownSelects(engine, ui).find((s) => !s.disabled && s.options.length > 1);
  expect(found, "the Controls route needs an enabled select with two or more options").toBeDefined();
  return found!;
}

/** The centre of a node, shifted by the anchor offset the engine draws an overlay with. */
function overlayCentre(engine: Engine, select: number, picker: number, node: number) {
  const [px, py] = engine.bounds(picker);
  const [sx, sy, , sh] = engine.bounds(select);
  const [x, y, w, h] = engine.bounds(node);
  return [x + w / 2 + (sx - px), y + h / 2 + (sy + sh - py)] as [number, number];
}

/**
 * A press opens the picker — on the press, not the click.
 *
 * The trigger point is the whole assertion. Measured, `probes/select-picker.html`: the press
 * alone opened it before any release, which is the opposite of a checkbox whose bit flips
 * during the click. So this presses and asserts *before* releasing, which is the only way to
 * tell the two apart from out here — a full click would pass either way.
 */
test("pressing a select opens its picker, before any release", () => {
  const { engine, ui } = load("controls", 1400);

  const select = pickableSelect(engine, ui);
  expect(engine.openSelect()).toBeNull();

  const [x, y, w, h] = engine.bounds(select.button);
  engine.mouseDown(x + w / 2, y + h / 2);

  const open = engine.openSelect();
  expect(open).not.toBeNull();
  expect(open!.select).toBe(select.node);

  // And the picker's own options are reachable by the pointer, which they are not in the
  // main walk: `hit_test` prunes a subtree whose parent's box does not contain the point,
  // and a picker hangs below its select's box. This is the overlay walk being asked first.
  //
  // **Aimed at each option's own text run, not at the option's centre**, and that is the
  // point of this loop rather than an incidental detail. `hit_test` returns the innermost
  // *interactive* node, and a run under a control is interactive — the compiler gives it an
  // `activates` so the `<span>` beside a checkbox can reach the box. So the pointer lands on
  // the run, and a picker that only understood options declined to commit when you clicked
  // an option's label, which is most of an option. Exactly the defect the buttons had.
  //
  // Asserting the *run* is hit rather than the option is deliberate: that is what hit-testing
  // truthfully answers, and resolving it to a control is the caller's job. The commit test
  // below is what proves the resolution happens.
  for (const { node, label } of select.options) {
    const aim = label >= 0 ? label : node;
    expect(engine.hitTest(...overlayCentre(engine, select.node, select.picker, aim))).toBe(aim);
  }

  engine.close();
});

/**
 * Choosing an option commits it, closes the picker, and changes what the closed button reads.
 *
 * The label is the part that could not work by accident. The engine cannot write the string —
 * Bun owns the tables — so it redirects the `<selectedcontent>`'s run at the chosen option's,
 * and both paint *and layout* have to honour that: the assertion on the button's width is
 * what catches a version where only paint did, which would draw the new text in a box
 * measured for the old one.
 */
test("choosing an option commits it, closes the picker and relabels the button", () => {
  const { engine, ui } = load("controls", 1400);

  const select = pickableSelect(engine, ui);
  expect(select.label, "the select's <selectedcontent> needs a run to relabel").toBeGreaterThan(-1);
  const [bx, by, bw, bh] = engine.bounds(select.button);

  engine.mouseDown(bx + bw / 2, by + bh / 2);
  const committed = engine.openSelect()!.option;
  expect(committed).toBeGreaterThanOrEqual(0);

  // A different option, and one whose label is a different *width* — the assertion below is
  // that layout re-measured the run, and two equally wide strings would make it vacuous.
  // Which is the trap the button itself is: it has a fixed `width: 220px` in the demo's CSS,
  // so measuring the button would prove nothing whatever the label said.
  const before = engine.bounds(select.label)[2];
  const target = select.options.find(
    (o) => o.node !== committed && o.label >= 0 && engine.bounds(o.label)[2] !== before,
  );
  expect(target, "two options with differently-sized labels are needed").toBeDefined();
  const want = engine.bounds(target!.label)[2];

  // Released over the option's **text**, which is where a user actually clicks and where this
  // silently did nothing: the release resolved to the run, whose control kind is `NONE`, so
  // the commit was declined. Aiming at the option's centre instead would land on the same
  // run in a real tree and pass either way only by luck of layout — so aim at the run on
  // purpose and let `option_at` resolve it.
  engine.mouseUp(...overlayCentre(engine, select.node, select.picker, target!.label));
  expect(engine.openSelect(), "committing closes it").toBeNull();
  engine.tick();

  // The closed control was re-laid-out for the chosen option's string, to the same width
  // that option's own run has. This is the assertion that fails if only *paint* honours the
  // redirect: the new text would be drawn inside a box measured for the old one.
  expect(engine.bounds(select.label)[2]).toBeCloseTo(want, 1);
  expect(engine.bounds(select.label)[2]).not.toBeCloseTo(before, 1);

  // And re-opening reports the new choice, which is `:checked` having moved — the same radio
  // set a group of `<input type=radio>` does.
  engine.mouseDown(bx + bw / 2, by + bh / 2);
  expect(engine.openSelect()!.option).toBe(target!.node);

  engine.close();
});

/**
 * A press outside dismisses the picker **and still activates what it hit.**
 *
 * Two rules about two different clicks, and ROADMAP B1 warns they are easy to conflate:
 * implementing "the overlay consumes the press" and assuming it covered dismissal makes
 * every click that closes a dropdown mysteriously do nothing else. Measured 2026-08-04 —
 * clicking a `<button>` beside an open picker closed the picker *and* fired that button's own
 * `click`, leaving focus on it. So this asserts the focus moved, not merely that the picker
 * closed.
 */
test("a press outside an open picker dismisses it and still reaches what it hit", () => {
  const { engine, ui } = load("controls", 1400);

  const select = pickableSelect(engine, ui);
  const [bx, by, bw, bh] = engine.bounds(select.button);
  engine.mouseDown(bx + bw / 2, by + bh / 2);
  expect(engine.openSelect()).not.toBeNull();

  // A checkbox somewhere else on the page — a real target, so "it still reached something"
  // is checkable rather than inferred from the absence of a picker.
  const box = [...ui.controls.node].find(
    (n, row) =>
      ui.controls.kind[row] === ControlKind.CHECKBOX &&
      (ui.controls.flags[row]! & ControlFlags.DISABLED) === 0 &&
      engine.bounds(n)[2] > 0,
  );
  expect(box, "the Controls route needs an enabled checkbox").toBeDefined();

  const [cx, cy, cw, ch] = engine.bounds(box!);
  engine.mouseDown(cx + cw / 2, cy + ch / 2);
  engine.mouseUp(cx + cw / 2, cy + ch / 2);

  expect(engine.openSelect(), "the press dismissed it").toBeNull();
  expect(engine.hitTest(cx + cw / 2, cy + ch / 2)).toBe(box!);

  engine.close();
});

/** A second press on the same select closes it rather than reopening it. */
test("pressing an open select again closes it", () => {
  const { engine, ui } = load("controls", 1400);

  const select = pickableSelect(engine, ui);
  const [x, y, w, h] = engine.bounds(select.button);

  engine.mouseDown(x + w / 2, y + h / 2);
  expect(engine.openSelect()).not.toBeNull();

  // The press dismisses *and* lands on the select — which without the guard would reopen
  // the thing it just shut, and a toggle would be a stutter.
  engine.mouseUp(x + w / 2, y + h / 2);
  engine.mouseDown(x + w / 2, y + h / 2);
  expect(engine.openSelect()).toBeNull();

  engine.close();
});

/** A disabled select does not open, though its button is not itself disabled. */
test("a disabled select's picker does not open", () => {
  const { engine, ui } = load("controls", 1400);

  const off = shownSelects(engine, ui).find((s) => s.disabled);
  expect(off, "the Controls route needs a disabled select").toBeDefined();

  const [x, y, w, h] = engine.bounds(off!.button);
  engine.mouseDown(x + w / 2, y + h / 2);
  expect(engine.openSelect()).toBeNull();

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
  const ui = buildUi(generated);

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
    editableBoxes: generated.editableBoxes,
    placeholders: generated.placeholders,
    overlays: generated.overlays,
    tabStops: generated.tabStops,
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
