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

  // **Seven rows, and the last two are `NONE`.** This used to be five, on the argument that
  // a press does nothing to a text field so a row would say "nothing happens" — which was
  // right about presses and wrong about the table. A control row is also where a control's
  // *flags* live, and `:invalid` is a flag Bun writes after a schema runs. A text field with
  // no row has nowhere to put it, and text fields are what schemas complain about.
  //
  // The kind stays `NONE`, so nothing a press does has changed: `Controls::activate` still
  // declines these two exactly as it did when they had no row at all.
  expect(controls.count).toBe(7);
  expect([...controls.kind]).toEqual([
    ControlKind.CHECKBOX,
    ControlKind.CHECKBOX,
    ControlKind.CHECKBOX,
    ControlKind.RADIO,
    ControlKind.RADIO,
    ControlKind.NONE,
    ControlKind.NONE,
  ]);

  // Presence, not value: `<input checked>` has no value at all.
  expect([...controls.flags]).toEqual([
    0,
    ControlFlags.CHECKED,
    ControlFlags.CHECKED | ControlFlags.DISABLED,
    0,
    ControlFlags.CHECKED,
    0,
    0,
  ]);

  // Checkboxes are in no group; the two radios share one; a text field is in none.
  expect([...controls.group]).toEqual([-1, -1, -1, 0, 0, -1, -1]);

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

// ---------------------------------------------------------------------------
// List boxes: the shape `<select>` becomes when it stops being a dropdown
// ---------------------------------------------------------------------------

/**
 * The structural fork, and it is **`multiple || size > 1`** rather than `multiple`.
 *
 * Measured, `probes/select-listbox.html`: `<select size="4">` with no `multiple` is a
 * list box — in-flow options, no picker, and an empty initial selection — so keying this
 * on the attribute would have compiled a shape authors really write into a dropdown.
 * `size="1"` is the row that keeps the condition honest: it is a dropdown.
 */
test("a select becomes a LISTBOX on `multiple` or on `size` above one, and not on `size=1`", () => {
  const html = `<body>
    <select id="drop"><option>a</option></select>
    <select id="one" size="1"><option>a</option></select>
    <select id="sized" size="4"><option>a</option></select>
    <select id="multi" multiple><option>a</option></select>
    <select id="both" multiple size="7"><option>a</option></select>
  </body>`;

  const ui = toCompiledUi(compile(html, ``));
  const rowOf = (nth: number) => {
    const selects: number[] = [];
    for (let r = 0; r < ui.controls.count; r++) {
      const k = ui.controls.kind[r]!;
      if (k === ControlKind.SELECT || k === ControlKind.LISTBOX) selects.push(r);
    }
    return selects[nth]!;
  };

  const kinds = [0, 1, 2, 3, 4].map((n) => ui.controls.kind[rowOf(n)]);
  expect(kinds).toEqual([
    ControlKind.SELECT,
    ControlKind.SELECT,
    ControlKind.LISTBOX,
    ControlKind.LISTBOX,
    ControlKind.LISTBOX,
  ]);

  // `rows` is `size`, defaulting to 4 — a constant rather than the option count, which
  // the same probe pins: `size="9"` with six options gives nine rows of height.
  expect([0, 1, 2, 3, 4].map((n) => ui.controls.rows[rowOf(n)])).toEqual([0, 0, 4, 4, 7]);

  // And `MULTIPLE` says whether the selection is a *set*, which is the other question
  // and has a different answer for `size="4"`.
  const isMultiple = (n: number) =>
    (ui.controls.flags[rowOf(n)]! & ControlFlags.MULTIPLE) !== 0;
  expect([0, 1, 2, 3, 4].map(isMultiple)).toEqual([false, false, false, true, true]);
});

/**
 * A list box gets **no picker and no button**, which is the finding that decided the
 * implementation rather than a simplification of the dropdown.
 *
 * Its options are ordinary in-flow boxes — measured, they have a box, a computed style
 * and an `offsetParent`, where a dropdown's are browser chrome — so there is nothing for
 * an overlay to hold and nothing for a closed control to display.
 */
test("a list box has its options in flow, with no overlay and no selectedcontent", () => {
  const dropdown = toCompiledUi(compile(`<body><select><option>a</option></select></body>`, ``));
  expect([...dropdown.overlays]).toHaveLength(1);

  const list = toCompiledUi(
    compile(`<body><select multiple><option>a</option><option>b</option></select></body>`, ``),
  );
  expect([...list.overlays]).toHaveLength(0);

  // The options are the select's own children, in document order — not children of a
  // picker box spliced in between.
  const select = list.controls.node[
    [...list.controls.kind].findIndex((k) => k === ControlKind.LISTBOX)
  ]!;
  const kids: number[] = [];
  for (let c = list.nodes.firstChild[select]!; c !== -1; c = list.nodes.nextSibling[c]!) {
    kids.push(c);
  }
  const optionNodes = new Set(
    [...list.controls.kind]
      .map((k, r) => (k === ControlKind.OPTION ? list.controls.node[r]! : -1))
      .filter((n) => n >= 0),
  );
  expect(kids.filter((k) => optionNodes.has(k))).toHaveLength(2);
});

/**
 * What is selected at rest, which is a different rule for each shape.
 *
 * All three rows measured in `probes/select-listbox.html`, and dziry had the dropdown's
 * rule in every position until then — so a list box came up with a row highlighted that
 * the user never chose.
 */
test("a dropdown falls back to its first option, a list box selects nothing", () => {
  const checkedOptions = (html: string) => {
    const ui = toCompiledUi(compile(`<body>${html}</body>`, ``));
    let n = 0;
    for (let r = 0; r < ui.controls.count; r++) {
      if (ui.controls.kind[r] === ControlKind.OPTION) {
        if (ui.controls.flags[r]! & ControlFlags.CHECKED) n++;
      }
    }
    return n;
  };
  const opts = `<option>a</option><option>b</option><option>c</option>`;

  expect(checkedOptions(`<select>${opts}</select>`)).toBe(1);
  expect(checkedOptions(`<select multiple>${opts}</select>`)).toBe(0);
  expect(checkedOptions(`<select size="3">${opts}</select>`)).toBe(0);

  // A `multiple` keeps every marked option; anything single-selection keeps the last.
  const marked = `<option>a</option><option selected>b</option><option selected>c</option>`;
  expect(checkedOptions(`<select multiple>${marked}</select>`)).toBe(2);
  expect(checkedOptions(`<select size="3">${marked}</select>`)).toBe(1);

  // The dropdown row that found a live bug: this read `find` rather than `findLast` and
  // so showed the *first* marked option where Chromium shows the last.
  const ui = toCompiledUi(compile(`<body><select>${marked}</select></body>`, ``));
  const options: number[] = [];
  for (let r = 0; r < ui.controls.count; r++) {
    if (ui.controls.kind[r] === ControlKind.OPTION) options.push(r);
  }
  expect(ui.controls.flags[options[2]!]! & ControlFlags.CHECKED).toBeTruthy();
  expect(ui.controls.flags[options[1]!]! & ControlFlags.CHECKED).toBeFalsy();
});
