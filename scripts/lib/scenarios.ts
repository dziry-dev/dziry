/**
 * The scenarios a rendered frame is worth taking of, and why each one exists.
 *
 * Shared because two harnesses need the same list and they ask different questions
 * of it. `golden` compares each frame against a blessed PNG in the repo — "does the
 * demo still look right". `neutrality` compares each frame against one it took
 * minutes ago — "did my change alter the output". A second copy of this list would
 * let the two drift, and the one that drifted would be the one nobody ran.
 *
 * `args` are `windows/entry.gen.ts` flags, so a scenario is a state the shipped
 * entry can be driven into rather than a harness-only mode.
 *
 * # Node ids are looked up, not written down
 *
 * A scenario that says `--click 282` is a scenario that points at whatever node inherits
 * 282 the next time anyone edits the demo, and it will still take a screenshot and still
 * look plausible. That is not hypothetical: on 2026-08-07 three lines of copy were added
 * to a page and `--open` silently pressed a plain box, producing a picture of a *closed*
 * picker for the scenario named `controls-picker`. It would have been blessed by
 * `--accept` without complaint.
 *
 * So the ids below are resolved from the compiled artifact by *role* — the third radio,
 * the first select's button — which is what the scenario actually means. Edit the demo and
 * they follow. `transform-hover` and `hover-nav` still carry literals because a hovered
 * button has no role to look up; their comments carry the warning instead.
 *
 * # What a golden cannot cover
 *
 * **The app's reaction to an input.** The screenshot path in `host/main.ts` runs its
 * gestures, ticks once and writes the PNG; the loop that drains events to the worker never
 * runs, so nothing is posted, no handler fires, and no signal a handler writes is on
 * screen. A golden proves the *engine's* answer — the box ticks, the picker opens, the
 * caret lands — and stops there.
 *
 * Worth knowing before reading one as a failure. The demo grew an `onChange` that reports
 * what it received; `controls-checked` ticks the box and the readout beside it still says
 * "nothing yet". That reads exactly like a broken handler and is a boundary of this
 * harness — the handler is covered end to end in `upload.test.ts`, which drives the engine
 * and drains the queue itself.
 */
import * as main from "../../windows/main/ui.gen.ts";
import { ControlKind } from "../../src/ir.ts";

export type Scenario = { name: string; args: string[] };

/** The nth control of a kind, in document order. Throws rather than screenshotting a lie. */
function control(kind: number, nth = 0): string {
  const found: number[] = [];
  for (let r = 0; r < main.controls.count; r++) {
    if (main.controls.kind[r] === kind) found.push(main.controls.node[r]!);
  }
  const node = found.sort((a, b) => a - b)[nth];
  if (node === undefined) {
    throw new Error(`no control of kind ${kind} at index ${nth} — the demo changed shape`);
  }
  return String(node);
}

/** The nth `bind:value` field, in document order. */
function editable(nth = 0): string {
  const node = main.editables.map((e) => e.node).sort((a, b) => a - b)[nth];
  if (node === undefined) throw new Error(`no editable at index ${nth}`);
  return String(node);
}

/**
 * The `<button>` a `<select>` shows when closed — the node a press has to land on.
 *
 * Its first child, and worth resolving rather than assuming: the select is what the
 * *control* row names, and pressing the select's own box is not the same gesture. The
 * arithmetic version of this ("the select's id plus one") is what produced the closed
 * picker described above.
 */
function selectButton(nth = 0): string {
  return String(main.nodes.firstChild[Number(control(ControlKind.SELECT, nth))]!);
}

/**
 * The nth tab stop that is reachable **only because an author wrote `tabindex`**.
 *
 * A role rather than a tag: what the scenario means is "the custom-widget case", and what
 * makes it that case is having nothing else that says it has focus.
 *
 * Both exclusions are load-bearing and the second was found by looking at the picture.
 * "Not a control" alone resolved to the first *text field* — a plain `<input type="text">`
 * has no control row either, since a press on one does nothing a control table describes —
 * so the scenario rang a field that already had an author's ring and proved nothing about
 * the rule it was added for.
 */
function focusableNonControl(nth = 0): string {
  const controls = new Set([...main.controls.node]);
  const fields = new Set(main.editables.map((e) => e.node));
  const found = [...main.tabStops].filter((n) => !controls.has(n) && !fields.has(n));
  const node = found[nth];
  if (node === undefined) throw new Error(`no tabindex-only tab stop at index ${nth}`);
  return String(node);
}

/**
 * The **words** beside a control — the text run that forwards a press to it.
 *
 * What a pointer actually hits most of the time, and the node the label-forwarding
 * scenarios exist to press. Found by asking which text run `activates` the control, which
 * is the same column the engine follows, so the scenario and the behaviour it tests read
 * the same table.
 */
function labelTextOf(controlNode: string): string {
  const target = Number(controlNode);
  for (let n = 0; n < main.nodes.count; n++) {
    if (main.nodes.activates[n] === target && main.nodes.text[n]! >= 0) return String(n);
  }
  throw new Error(`no label text forwards to node ${target}`);
}

/**
 * `--patch light,compact` flips conditional classes on by name: `light` is
 * paint-only and `compact` forces a relayout. Covering both separately and together
 * is deliberate — together is where a patch-ordering bug would show.
 *
 * The route scenarios cover what the patch ones cannot. `base` is the home route
 * with five routes resident and hidden, so it already proves the emitted `hidden`
 * column; `route-nested` and `route-param` prove the parent chain, where the
 * `products` layout stays visible because the active route renders inside it while
 * its sibling does not.
 */
export const SCENARIOS: Scenario[] = [
  { name: "base", args: [] },

  // The utility families. Real Tailwind output through the compiler, so a
  // regression in the cascade, in oklch conversion, or in one property shows up as
  // pixels rather than as a coverage number nobody re-derives.
  { name: "layout", args: ["--route", "layout"] },
  { name: "spacing", args: ["--route", "spacing"] },
  { name: "typography", args: ["--route", "typography"] },
  { name: "colors", args: ["--route", "colors"] },
  { name: "borders", args: ["--route", "borders"] },

  // The framework's own features, and the two conditional classes: `light`
  // (paint-only) and `compact` (relayout). Covering them separately and together
  // is deliberate — together is where a patch-ordering bug would show. They need
  // the route that carries them, since it is not the one the window opens on.
  { name: "features", args: ["--route", "features"] },
  { name: "features-light", args: ["--route", "features", "--patch", "light"] },
  { name: "features-compact", args: ["--route", "features", "--patch", "compact"] },
  { name: "features-light-compact", args: ["--route", "features", "--patch", "light,compact"] },

  // Nesting and parameters: the `products` layout stays visible because the active
  // route renders inside it, while its sibling does not. `route-param` drives a
  // *concrete* id, which is what the param binding and the loader's `{ id }` read.
  { name: "route-nested", args: ["--route", "products/new"] },
  { name: "route-param", args: ["--route", "products/1"] },

  // Hover, which is a predicate bit and an escaped selector — and which was
  // silently dropped for every Tailwind `hover:` utility until `@media (hover:
  // hover)` stopped being skipped.
  { name: "hover-nav", args: ["--hover", "11"] },

  /**
   * `transform` and `opacity`, which are the only styles here that change *what
   * the matrix is* rather than what gets filled — so a regression in them is
   * invisible to every other scenario.
   *
   * Tall enough for the whole page on purpose. Each block is a different way to
   * be wrong: the origin block is four identical rotations that must land in four
   * different places, and the opacity block must fade each label *with* its box
   * rather than separately, which is the difference between a layer and a
   * per-draw alpha.
   */
  { name: "transforms", args: ["--route", "transforms", "--size", "1040x1500"] },

  /**
   * A transform that lives in a variant slot, which nothing else covers.
   *
   * Node 902 is the `hover:scale-110` button. It matters because the transform is
   * only reachable through the *resolved* style — and because hit-testing has to
   * agree, or the pointer leaves the box the moment it grows.
   *
   * **The id is derived, not chosen, and it moves.** Node ids are allocated in tree
   * order, so any node added to a route that sorts before `transforms` renumbers this
   * one — it was 900 until the controls page gained a bound text field and its
   * generated text child, and the symptom was this scenario going `DIFF` while the
   * transforms page had not changed at all. That is indistinguishable from a
   * rendering regression at a glance, and `--accept` would have silently repointed
   * the scenario at whatever node inherited the number.
   *
   * If it diffs again after an unrelated demo edit, check that first: re-point it and
   * the picture should come back **byte-identical** to the committed golden, which is
   * the proof that nothing rendered differently. If the pixels still differ once the
   * right button is hovered, then it is a real regression.
   *
   * Same tall size as above, and not incidentally: that button is near the bottom
   * of the page, so at the default 700px the scenario captured only the header and
   * proved nothing.
   */
  {
    name: "transform-hover",
    args: ["--route", "transforms", "--hover", "902", "--size", "1040x1500"],
  },

  /**
   * Transitions and `@keyframes`, sampled at an exact `t`.
   *
   * **`--advance` is not optional on this route, it is what makes a golden possible.**
   * `tick()` normally reads the wall clock, so a plain screenshot of an animating page
   * is a different fraction of the way through on every run — the scenario would be
   * flaky in the one way a visual test must not be. `--advance` fixes the frame length
   * instead, so `0.25` means exactly a quarter of a second and the picture is the same
   * picture forever.
   *
   * Three samples, because each covers something the others cannot:
   *
   *   - `0` is every animation at its first keyframe and every transition at rest. It
   *     is the frame that would be *wrong* if the implicit `from` of a `@keyframes`
   *     with no `0%` were a synthesised value rather than the element's own row —
   *     `animate-spin` and `animate-ping` are both that shape.
   *   - `0.25` has all four of Tailwind's animations and both hand-written `drift`
   *     boxes mid-flight, at four different durations and on five different curves.
   *     A wrong bezier solve, a wrong segment boundary or a mask that lost a field
   *     all move a box here.
   *   - the hover one is a transition caught *halfway*: 150 ms of a 300 ms
   *     `transition-colors`, which is the frame no other scenario can produce. Node
   *     72 is the `scale-110` button in the transform block, chosen because a
   *     transform in a variant slot is only reachable through the resolved style and
   *     hit-testing has to follow it.
   */
  { name: "animations", args: ["--route", "animations", "--size", "1040x1700", "--advance", "0"] },
  {
    name: "animations-quarter",
    args: ["--route", "animations", "--size", "1040x1700", "--advance", "0.25"],
  },
  {
    name: "animation-hover",
    args: ["--route", "animations", "--size", "1040x1700", "--hover", "72", "--advance", "0.15"],
  },

  /**
   * Form controls, at rest and after a real press.
   *
   * The route had no golden at all until controls became interactive, which is worth
   * naming rather than quietly fixing: while every control was frozen in its authored
   * state there was nothing here a `--patch` scenario did not already cover. Three
   * pictures now, and each one covers something no other scenario can.
   *
   * **`--click` is not `--hover` with a different verb.** `--hover` *declares* an input
   * state; `--click` runs the press — hit-testing, the disabled swallow, a label
   * forwarding to the box beside it, and the activation behaviour itself. Every one of
   * those is a place the feature can fail while every predicate still resolves
   * correctly, and none of them is reachable by asserting the state a click would have
   * left behind.
   *
   *   - `controls` is the resting page: `:checked` and `:disabled` live from the
   *     authored attributes, which is the *seed* rather than a fixed style.
   *   - `controls-checked` presses the **text** "unchecked", not the 18px
   *     box. It is the label-forwarding case, and it is the one the pointer actually
   *     hits most of the time. It fails if `activates` stops propagating to a label's
   *     descendants, or if `buildInteractive` stops marking a node that operates a
   *     control, which would leave `hit_test` walking straight past the span.
   *   - `controls-radio` presses the first radio ("free"), which must check it *and clear*
   *     "pro". Without the group clear both would be filled and the picture would look
   *     like two checkboxes — a wrong frame that a per-control test cannot produce.
   *
   * Node ids rather than coordinates, as the hover scenarios above already do, so the
   * scenario keeps pointing at the thing it names when the layout moves. They still
   * shift if the *page* gains elements before them, which is what blessing a golden is
   * for.
   */
  { name: "controls", args: ["--route", "controls", "--size", "1040x1400"] },
  /**
   * The forms page at rest — every field wrapper quiet.
   *
   * At rest is the state worth pinning, and not for lack of ambition: the error classes are
   * driven by *validation*, which runs on the app thread, and this harness never dispatches
   * events to it — `--click` presses the engine and screenshots the result. So a shot of a
   * form in error is not reachable from here, and the error state is asserted where it can be,
   * in `src/compiler/form.test.tsx`, by submitting a real artifact and reading the patch.
   *
   * What this does catch is the half a unit test cannot: that a form of six field wrappers
   * lays out, that a `type=number` field gets a box rather than the four-pixel strip it drew
   * before `number` was typeable, and that the message spans take no room while empty.
   */
  { name: "forms", args: ["--route", "forms", "--size", "1040x900"] },
  {
    name: "controls-checked",
    args: ["--route", "controls", "--size", "1040x1400", "--click", labelTextOf(control(ControlKind.CHECKBOX, 0))],
  },
  {
    name: "controls-radio",
    args: ["--route", "controls", "--size", "1040x1400", "--click", control(ControlKind.RADIO, 0)],
  },
  /**
   * A focused text field, which is the only way to see focus at all until there is a
   * caret to show it.
   *
   * `--focus` sets the state directly rather than clicking, because a click sets
   * `pressed` too and `input[type=text]:focus` is the rule under test. Node 302 is the
   * first field on the page — the bound one.
   *
   * This scenario is newly *possible*, not newly written: `:focus` has been a live
   * predicate for as long as the engine has set `state.focused` from the hit test, and
   * an editable was in no clause of `buildInteractive`, so no field could ever be the
   * hit and the rule was unreachable. A golden of it would have been a golden of
   * nothing.
   */
  {
    name: "controls-focus",
    args: ["--route", "controls", "--size", "1040x1400", "--focus", editable(0)],
  },
  /**
   * `<select multiple>`, which is a different element wearing the `<select>` tag.
   *
   * **1040x2000 and not the 1400 every other scenario on this route uses**, because the
   * card sits below 1400 — and a golden of a card that is not in the frame is a golden of
   * nothing. That is not hypothetical here: the first render of this feature was taken at
   * 1400, showed the top edge of the card and nothing else, and would have been blessed.
   *
   * Three things only a picture can check, and each of them was wrong at some point while
   * this was being built:
   *
   *   - **The rows stack.** dziri's default display is flex, whose default direction is
   *     `row`, so the first render put six options side by side spilling out of the box.
   *     `display: block` in the UA sheet is what fixes it, and no unit test sees it.
   *   - **The box holds exactly `size` rows.** A row is an *option's* box — its font, its
   *     padding — not one line of the select's own font, and the demo's options carry both.
   *     Sized the other way, four rows held two and a half options and clipped the third
   *     mid-word.
   *   - **The selection is visible and is a set.** Two rows are filled in the first list
   *     and *none* in the second, which is the measured rule a dropdown does not share: a
   *     list box with no option marked `selected` starts with nothing selected, where a
   *     dropdown falls back to its first.
   */
  { name: "controls-listbox", args: ["--route", "controls", "--size", "1040x2000"] },
  /**
   * A real press on a list box row, which must **replace** the authored selection.
   *
   * The one assertion that separates a working list box from the radio-set path the
   * `OPTION` kind already had: clicking the third row here has to leave one row filled,
   * not three. `--click` runs the press rather than declaring the state, so it also covers
   * the release-not-press rule and the hit walking through the option's own text run.
   */
  {
    name: "controls-listbox-click",
    args: [
      "--route", "controls", "--size", "1040x2000",
      "--click", control(ControlKind.OPTION, 9),
    ],
  },
  /**
   * The UA sheet's `:focus-visible` ring, on a control that has no ring of its own.
   *
   * Node 321 is the first `<select>`. It is chosen precisely because the demo styles no
   * ring on it: the two text fields wear `focus:ring-*` classes of their own, so a
   * scenario aimed at one of those would render an *author's* ring and prove nothing
   * about the default. `controls-focus` above is that picture, and it is unchanged by
   * this feature — which is how it should be, and also why it cannot stand in for this.
   *
   * A golden rather than a unit test because the failure mode is invisible to one. The
   * predicate can be live, the variant row can be correct, the ring fields can hold the
   * right numbers, and the ring can still not be drawn. Rendering is the only assertion
   * that covers the last step.
   */
  {
    name: "controls-focus-ring",
    args: ["--route", "controls", "--size", "1040x1400", "--focus", control(ControlKind.SELECT, 0)],
  },
  /**
   * The same ring on the case that has nothing else: a `div[tabindex="0"]`.
   *
   * Distinct from the scenario above rather than redundant with it. A select with no
   * author ring still looks like a control — it has a border and an arrow — so a missing
   * ring there is a degradation. On a plain box the ring is the *only* thing that says
   * where the keyboard is, which is why the UA sheet lists `[tabindex]` beside the tags
   * and why that one line needs a picture rather than a unit test: the predicate can be
   * live and the ring fields correct and the ring still not drawn.
   */
  {
    name: "controls-focus-ring-tabindex",
    // 1800 rather than the 1400 every other controls scenario uses: the tabindex card is
    // the last on the page and sits at y≈1569, so at 1400 this shot was of a correctly
    // drawn ring that happened to be below the fold — a passing golden of nothing.
    args: ["--route", "controls", "--size", "1040x1800", "--focus", focusableNonControl(0)],
  },
  /**
   * A caret, which needs a **click** rather than `--focus`.
   *
   * The distinction is the point: `--focus` sets the state directly, and a caret is placed
   * by `mouse_down` resolving an x to a character boundary — so a scenario that only
   * focused the field would render no caret and prove nothing. `controls-focus` beside
   * this one is still worth having, because it isolates the `:focus` *style* from the
   * caret.
   *
   * Deterministic despite being a blink: the phase resets solid on placement and advances
   * on the frame `dt`, which is well under the half-second phase, so frame one always has
   * a visible caret. Same reason `--advance` makes an animation golden possible.
   *
   * The field is empty, so the caret sits at index 0 — one pixel at the text origin, in
   * `caret-color`. That is the case worth pinning: a caret at 0 is where an off-by-one in
   * the padding or the border would put it somewhere obviously wrong.
   *
   * **This frame used to show no focus ring, and that was the harness rather than the
   * engine.** `main.ts` ran every `--click` and *then* called
   * `setInputState(--hover, -1, --focus)`, so with no `--focus` flag the focus the click had
   * just acquired was reset to -1 before the shot; the caret survived only because it is not
   * keyed on focus. This comment said it was worth fixing when `--click` and `--focus` next
   * needed to compose, and `controls-picker` is that moment — a picker's highlight *is*
   * focus, and there is no value to pass instead. The declared state is now applied only
   * when a flag declares one, so this picture gained the ring a clicked field really has.
   */
  {
    name: "controls-caret",
    args: ["--route", "controls", "--size", "1040x1400", "--click", editable(0)],
  },

  /**
   * A selection, made by **dragging** — which is the only way to make one from out here.
   *
   * `--click` runs a press and a release; a range needs the motion between them, because the
   * focus follows `mouse_move` while the anchor stays where the press landed. So this exercises
   * a path `--focus` and `--click` cannot reach between them, and it is the picture that would
   * catch a band drawn at the wrong offsets, drawn over the glyphs instead of behind them, or
   * a caret still blinking inside a highlight.
   *
   * `--focus 302` as well, for the reason `controls-caret` records: `main.ts` runs the gesture
   * and *then* sets the input state, so without it the focus the press acquired is reset to -1
   * before the shot and the ring would be missing from a frame that is otherwise about a
   * focused field.
   *
   * Fractions of the field's width rather than pixels, and both well inside the *text*: the box
   * is wider than the string, so a drag past the last character clamps to the length and the
   * frame would stop being about a partial selection.
   */
  {
    name: "controls-selection",
    args: [
      "--route",
      "controls",
      "--size",
      "1040x1400",
      "--drag",
      "302:0.05:0.45",
      "--focus",
      editable(0),
    ],
  },

  /**
   * A word, from a double click — the measured boundary rule, rendered.
   *
   * Worth a frame of its own beside the drag: the *offsets* are what `caret.rs::word_at` gets
   * wrong or right, and they are invisible in a table of numbers next to a band that is one
   * character too wide. The field's centre lands inside `brown` of `quick-brown`, so a correct
   * frame highlights `brown` and its trailing space and stops short of the hyphen — which is
   * three of the four rules at once.
   */
  {
    name: "controls-word",
    args: ["--route", "controls", "--size", "1040x1400", "--double", editable(0), "--focus", editable(0)],
  },

  /**
   * The reactive rewrite, rendered.
   *
   * Every value on this page is derived from one signal through an operator that a
   * bare signal used to break — `*`, `>`, `===`, a ternary, a template literal. The
   * page reads `true` beside `tick === 3` and `odd` beside the ternary, so a
   * regression in the rewrite shows up as text rather than as a passing build. Taller
   * than the rest because the point is the whole list.
   */
  /**
   * An open `<select>` picker — the overlay layer, rendered.
   *
   * The one frame that can catch what the numbers cannot. `openSelect()` says a picker is
   * open and on which option; it says nothing about whether the box was drawn *over* the
   * cards below it or under them, whether the anchor put it against the select's bottom edge
   * or somewhere inside it, or whether the highlight landed on the committed option. All
   * three are one screenshot.
   *
   * Node 322 is the button of the first select on the page. `--open` presses it rather than
   * clicking it, because a picker opens on `mouse_down` — measured, and the opposite of a
   * checkbox — so the release is not part of the gesture under test.
   *
   * No `--focus`, deliberately, and it would break the picture: opening moves focus onto the
   * committed `<option>` and `option:focus` is what draws the highlight, so declaring a focus
   * here would overwrite the engine's own answer with the harness's.
   */
  {
    name: "controls-picker",
    args: ["--route", "controls", "--size", "1040x1400", "--open", selectButton(0)],
  },

  /**
   * An open picker **on a scrolled page, at the demo's own window size.**
   *
   * The scenario that would have caught the bug the demo found. Every frame above renders
   * into a 1400px viewport, which is taller than any route needs — so nothing in this suite
   * had ever scrolled, and a paint pass that ignored ancestor scroll looked perfect in all of
   * them. The real window is 1040x700 (`windows/main/index.tsx`), the selects sit at y≈943,
   * so reaching one *requires* scrolling, and the picker was drawn a screenful below its
   * select. Pressing a `<select>` appeared to do nothing at all.
   *
   * So the size here is not a variation for its own sake — it is the demo's size, which is
   * the one configuration nothing else in this file exercises.
   *
   * 560px of scroll puts the select card comfortably in view. Node 318 is the first select's
   * button, as in `controls-picker`; `--scroll` runs before it so the press aims at where the
   * button actually is.
   */
  {
    name: "controls-picker-scrolled",
    args: [
      "--route",
      "controls",
      "--size",
      "1040x700",
      "--scroll",
      "560",
      "--open",
      selectButton(0),
    ],
  },

  { name: "reactivity", args: ["--route", "reactivity", "--size", "1040x1400"] },
];
