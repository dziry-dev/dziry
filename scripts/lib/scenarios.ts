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
 */
export type Scenario = { name: string; args: string[] };

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
  // route renders inside it, while its sibling does not.
  { name: "route-nested", args: ["--route", "products/new"] },
  { name: "route-param", args: ["--route", "products/$id"] },

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
   *   - `controls-checked` presses node 264 — the **text** "unchecked", not the 18px
   *     box. It is the label-forwarding case, and it is the one the pointer actually
   *     hits most of the time. It fails if `activates` stops propagating to a label's
   *     descendants, or if `buildInteractive` stops marking a node that operates a
   *     control, which would leave `hit_test` walking straight past the span.
   *   - `controls-radio` presses node 282 ("free"), which must check it *and clear*
   *     "pro". Without the group clear both would be filled and the picture would look
   *     like two checkboxes — a wrong frame that a per-control test cannot produce.
   *
   * Node ids rather than coordinates, as the hover scenarios above already do, so the
   * scenario keeps pointing at the thing it names when the layout moves. They still
   * shift if the *page* gains elements before them, which is what blessing a golden is
   * for.
   */
  { name: "controls", args: ["--route", "controls", "--size", "1040x1400"] },
  {
    name: "controls-checked",
    args: ["--route", "controls", "--size", "1040x1400", "--click", "264"],
  },
  {
    name: "controls-radio",
    args: ["--route", "controls", "--size", "1040x1400", "--click", "282"],
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
    args: ["--route", "controls", "--size", "1040x1400", "--focus", "302"],
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
   * **This frame shows no focus ring, and that is the harness rather than the engine.**
   * `main.ts` runs every `--click` and *then* calls `setInputState(--hover, -1, --focus)`,
   * so with no `--focus` flag the focus the click just acquired is reset to -1 before the
   * shot. The caret survives because it is not keyed on focus. Worth knowing before
   * reading this picture as "a clicked field does not look focused", and worth fixing when
   * `--click` and `--focus` next need to compose.
   */
  {
    name: "controls-caret",
    args: ["--route", "controls", "--size", "1040x1400", "--click", "302"],
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
      "302",
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
    args: ["--route", "controls", "--size", "1040x1400", "--double", "302", "--focus", "302"],
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
  { name: "reactivity", args: ["--route", "reactivity", "--size", "1040x1400"] },
];
