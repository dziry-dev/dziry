/**
 * Form controls, compile side: the controls table and the activation column.
 *
 * The engine's `tests/controls.rs` asserts what a press *paints*. This asserts what
 * the compiler hands it, which is the half the engine cannot work out for itself:
 * which node is a control, of what kind, in which radio group, in what state it was
 * authored, and — the part with no browser equivalent as data — which nodes a press
 * forwards from.
 *
 * That last one is `nodes.activates`, and it is what stands in for the second,
 * synthetic click a browser dispatches at a control when a label was clicked. The
 * behaviour it reproduces is measured in `probes/control-activation.html`; these
 * tests are about the table, not about the rule.
 */
import { expect, test } from "bun:test";
import { compile, compileTree, toCompiledUi } from "./compile.ts";
import { parseHtml, type Element } from "./html.ts";
import { ControlFlags, ControlKind } from "../ir.ts";

// ---------------------------------------------------------------------------
// Form controls: the controls table, and what a press reaches
// ---------------------------------------------------------------------------

test("a checkbox and a radio become controls table rows, seeded from their attributes", () => {
  // The compile-time half of an interactive control. What the compiler knows and
  // the engine cannot work out for itself: which node is a control, of what kind,
  // in which group, and the state it was authored in.
  const html = `<body>
    <input type="checkbox">
    <input type="checkbox" checked>
    <input type="checkbox" checked disabled>
    <input type="radio" name="plan">
    <input type="radio" name="plan" checked>
    <input type="text">
    <input>
  </body>`;

  const ui = toCompiledUi(compile(html, ``));
  const { controls } = ui;

  // Five rows, not seven: `type=text` and a bare `<input>` are real elements with
  // real UA styling and nothing a press does to them, so a row would say "nothing
  // happens".
  expect(controls.count).toBe(5);
  expect([...controls.kind]).toEqual([
    ControlKind.CHECKBOX,
    ControlKind.CHECKBOX,
    ControlKind.CHECKBOX,
    ControlKind.RADIO,
    ControlKind.RADIO,
  ]);

  // Presence, not value: `<input checked>` has no value at all.
  expect([...controls.flags]).toEqual([
    0,
    ControlFlags.CHECKED,
    ControlFlags.CHECKED | ControlFlags.DISABLED,
    0,
    ControlFlags.CHECKED,
  ]);

  // Checkboxes are in no group; the two radios share one.
  expect([...controls.group]).toEqual([-1, -1, -1, 0, 0]);

  // Ascending, because the engine binary-searches this column.
  const nodes = [...controls.node];
  expect(nodes).toEqual([...nodes].sort((a, b) => a - b));
});

test("a radio group is keyed on the form, not on the name alone", () => {
  // Measured, and the one that would have been silently wrong: three radios named
  // `plan` were checked at once in Chromium when two of them sat in their own
  // `<form>`. See BROWSER-FACTS.md, "A radio cannot be unchecked by pointer, and
  // its group is the form". Keying on the name would have merged two independent
  // groups, which only shows up in a form busy enough that nobody is watching.
  const html = `<body>
    <input type="radio" name="plan">
    <input type="radio" name="plan">
    <form><input type="radio" name="plan"></form>
    <form><input type="radio" name="plan"></form>
    <input type="radio">
  </body>`;

  const { group } = toCompiledUi(compile(html, ``)).controls;

  // The first pair share a group; each form makes another; the nameless one is in
  // none at all, which is what lets it be checked and never cleared.
  expect([...group]).toEqual([0, 0, 1, 2, -1]);
});

test("a label's press reaches its control, through `for` and through containment", () => {
  // `activates` is what replaces the second, synthetic click a browser dispatches
  // at the control — measured, `probes/control-activation.html`.
  const html = `<body>
    <label id="wrap"><input type="checkbox" id="cb"><span id="text">tick me</span></label>
    <input type="checkbox" id="far">
    <label for="far" id="named">or me</label>
    <label for="nothing" id="broken">typo</label>
  </body>`;

  const nodeOf = new Map<Element, number>();
  const result = compileTree(parseHtml(html), ``, { nodeOf });
  const ui = toCompiledUi(result);
  const { activates } = ui.nodes;

  const find = (id: string) => {
    for (const [el, node] of nodeOf) if (el.id === id) return node;
    throw new Error(`no element #${id}`);
  };

  const cb = find("cb");
  const far = find("far");

  // A control points at itself, which is what makes a press on the box itself work
  // through the same one lookup.
  expect(activates[cb]).toBe(cb);
  // The wrapping label, and — the case that matters — the span *inside* it. That is
  // what the pointer actually hits when someone clicks the words beside a checkbox.
  expect(activates[find("wrap")]).toBe(cb);
  expect(activates[find("text")]).toBe(cb);
  // `for=`, resolved by id, and the target is later in the document than the label
  // in the DOM sense — which is why this cannot be done while walking.
  expect(activates[find("named")]).toBe(far);

  // A `for=` naming nothing is a warning, not a build failure: the markup renders
  // perfectly and the label simply stops forwarding.
  expect(activates[find("broken")]).toBe(-1);
  expect(result.warnings.join("\n")).toMatch(/label for="nothing".*does not name a form control/);
});

test("a node that operates a control is interactive, and a button inside a label is not", () => {
  // Two halves of the same fact. `hit_test` only ever returns an `INTERACTIVE`
  // node, so a span with no styling of its own has to be marked or a correct
  // `activates` is unreachable — the same silent shape as a variant no predicate
  // can select.
  //
  // And the other direction: HTML excludes "interactive content" from a label's
  // activation behaviour, so a button inside a label must not tick the box beside
  // it.
  const html = `<body>
    <label id="l"><input type="checkbox" id="c"><span id="s">words</span><button id="b">go</button></label>
  </body>`;

  const nodeOf = new Map<Element, number>();
  const ui = toCompiledUi(compileTree(parseHtml(html), ``, { nodeOf }));
  const find = (id: string) => {
    for (const [el, node] of nodeOf) if (el.id === id) return node;
    throw new Error(`no element #${id}`);
  };

  const span = find("s");
  expect(ui.nodes.activates[span]).toBeGreaterThanOrEqual(0);
  expect([...ui.interactive]).toContain(span);

  // The button owns its own press, and what that means got sharper rather than
  // changing: it used to be `-1`, "operates nothing", because a `<button>` had no
  // control row at all. It has one now — `ControlKind.BUTTON`, so Enter and Space can be
  // dispatched on kind like every other activation — so the button operates *itself*.
  //
  // The claim being tested is the same one and is now stated directly: whatever the
  // button operates, it is not the checkbox beside it.
  const button = find("b");
  expect(ui.nodes.activates[button]).toBe(button);
  expect(ui.nodes.activates[button]).not.toBe(find("c"));
});

test("a page with no controls emits no rows and no activation", () => {
  const ui = toCompiledUi(compile(`<body><div>plain</div></body>`, ``));
  expect(ui.controls.count).toBe(0);
  expect([...ui.nodes.activates].every((a) => a === -1)).toBe(true);
});
