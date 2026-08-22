/**
 * What a `<form>` submits, compile side.
 *
 * The runtime's `forms.test.ts` asserts what a payload *is*; this asserts the table it is
 * built from — which controls are fields, of what kind, carrying which value, and how their
 * names collapse into keys. That split matters because the key shapes are the part an
 * author's schema is written against, and they are decided here, once, rather than by
 * whatever happened to be ticked at submit.
 *
 * Every expectation traceable to a browser is cited to the row of `guards/probes/form-data.html`
 * it came from. Where dziry deliberately parts company — a lone checkbox is a boolean
 * rather than present-or-absent — the test says so rather than reading as a browser claim.
 */
import { expect, test } from "bun:test";
import { signal } from "../runtime/signal.ts";
import { jsx, toDocument } from "./jsx-runtime.ts";
import type { Node } from "./html.ts";
import { compileTree } from "./compile.ts";
import { collectFields, fieldKindOf, formKeys, markupDisabled, optionValue } from "./fields.ts";
import { parseHtml, type Element } from "./html.ts";

/** The document element, which is what both `collectFields` and the walk start from. */
const doc = (html: string): Element => parseHtml(html);

/** The one form in `html`, compiled — fields, keys and all. */
const form = (html: string) => {
  const built = compileTree(doc(html), "");
  const [only] = built.forms;
  if (!only) throw new Error("no form compiled");
  return only;
};

/** `{ name: shape }`, which is what a schema is written against. */
const shapes = (html: string): Record<string, string> =>
  Object.fromEntries(form(html).keys.map((k) => [k.path.join("."), k.shape]));

// ---------------------------------------------------------------------------
// Which controls are fields
// ---------------------------------------------------------------------------

test("a named control in a form becomes a field; a nameless one does not", () => {
  // Measured: `text, named -> a="x"` and `text, nameless -> (empty)`.
  const built = form(`<body><form>
    <input name="a" value="x">
    <input value="x">
  </form></body>`);

  expect(built.fields.length).toBe(1);
  expect(built.keys.map((k) => k.path.join("."))).toEqual(["a"]);
});

test("a button contributes nothing unless it is a named submit button", () => {
  // Measured: `input[type=button][name]` and `input[type=reset][name]` contribute nothing
  // ever, while a named **submit** button contributes when it is the one that submitted —
  // which is why the two spellings of a submit button are a kind and the others are not.
  expect(fieldKindOf(el(`<input type="button" name="b">`))).toBe(null);
  expect(fieldKindOf(el(`<input type="reset" name="b">`))).toBe(null);
  expect(fieldKindOf(el(`<input type="file" name="b">`))).toBe(null);
  expect(fieldKindOf(el(`<button type="button">x</button>`))).toBe(null);

  expect(fieldKindOf(el(`<input type="submit" name="b">`))).toBe("submitter");
  expect(fieldKindOf(el(`<button name="b">x</button>`))).toBe("submitter");
  expect(fieldKindOf(el(`<button type="submit" name="b">x</button>`))).toBe("submitter");
});

test("each control kind is recognised from its tag and type", () => {
  expect(fieldKindOf(el(`<input name="a">`))).toBe("text");
  expect(fieldKindOf(el(`<input type="email" name="a">`))).toBe("text");
  expect(fieldKindOf(el(`<input type="number" name="a">`))).toBe("number");
  expect(fieldKindOf(el(`<input type="range" name="a">`))).toBe("number");
  expect(fieldKindOf(el(`<input type="checkbox" name="a">`))).toBe("checkbox");
  expect(fieldKindOf(el(`<input type="radio" name="a">`))).toBe("radio");
  expect(fieldKindOf(el(`<textarea name="a"></textarea>`))).toBe("text");
  expect(fieldKindOf(el(`<select name="a"></select>`))).toBe("select");
  // A list box reports a *set* rather than an index, which is what this kind names. How
  // many values it submits is `multiple`'s business, not `size`'s — see the shapes below.
  expect(fieldKindOf(el(`<select name="a" size="4"></select>`))).toBe("selectMultiple");
  expect(fieldKindOf(el(`<select name="a" multiple></select>`))).toBe("selectMultiple");
});

// ---------------------------------------------------------------------------
// The values a field contributes
// ---------------------------------------------------------------------------

test("a checkbox with no value contributes \"on\"", () => {
  // Measured: `checkbox, checked, no value -> a="on"`, and `value=""` submits the empty
  // string — so the default is on *absence*, not on emptiness.
  const built = form(`<body><form>
    <input type="checkbox" name="a" checked>
    <input type="checkbox" name="b" value="" checked>
    <input type="checkbox" name="c" value="1" checked>
  </form></body>`);

  expect(built.fields.map((f) => f.value)).toEqual(["on", "", "1"]);
});

test("an option with no value submits its text, trimmed", () => {
  // Measured: `select, option without value -> a="one"`, and `select, padded option text`
  // — `<option>  two  </option>` — submits `"two"`. The label a user reads is the padded
  // one, which is what makes the trim easy to get wrong in the direction that looks right.
  expect(optionValue(el(`<option value="1">one</option>`))).toBe("1");
  expect(optionValue(el(`<option>one</option>`))).toBe("one");
  expect(optionValue(el(`<option>  two  </option>`))).toBe("two");
});

test("a select's options are collected in document order, through optgroups", () => {
  // The order is not cosmetic: it is the index space the engine reports a commit in, and
  // `select::options_of` descends into `<optgroup>` rather than scanning past it.
  const built = form(`<body><form><select name="a">
    <option value="1">one</option>
    <optgroup label="g"><option value="2">two</option></optgroup>
    <option value="3">three</option>
  </select></form></body>`);

  expect(built.fields[0]!.options).toEqual(["1", "2", "3"]);
});

// ---------------------------------------------------------------------------
// Disabled, which is inherited
// ---------------------------------------------------------------------------

test("a field inside a disabled fieldset is disabled, unless it is in the legend", () => {
  // Both measured, and the legend exception is the surprising half: `<fieldset disabled>
  // + legend field -> leg="x"` — the field in the heading survives while its siblings do
  // not, which is how a disabled section keeps a working "enable this" control.
  const built = form(`<body><form>
    <input name="plain" value="x">
    <fieldset disabled>
      <legend><input name="leg" value="x"></legend>
      <input name="inner" value="x">
    </fieldset>
    <input name="own" value="x" disabled>
  </form></body>`);

  expect(built.fields.map((f) => [f.node >= 0, f.disabled])).toEqual([
    [true, false],
    [true, false],
    [true, true],
    [true, true],
  ]);
});

test("markupDisabled reads the ancestor chain rather than the element", () => {
  const tree = doc(`<body><fieldset disabled><div><input name="a"></div></fieldset></body>`);
  const fieldset = find(tree, "fieldset")!;
  const div = find(tree, "div")!;
  const input = find(tree, "input")!;

  expect(markupDisabled(input, [tree, fieldset, div, input])).toBe(true);
  // The same element with no such ancestor is not disabled — so this is inheritance, not
  // a property of the input.
  expect(markupDisabled(input, [tree, div, input])).toBe(false);
});

// ---------------------------------------------------------------------------
// Key shapes — the part a schema is written against
// ---------------------------------------------------------------------------

test("each control kind gives its key the shape an author would write a schema for", () => {
  expect(
    shapes(`<body><form>
      <input name="email">
      <input name="age" type="number">
      <input name="terms" type="checkbox">
      <input name="plan" type="radio" value="pro">
      <input name="plan" type="radio" value="ent">
      <select name="colour"><option>red</option></select>
      <select name="tags" multiple><option>a</option></select>
      <textarea name="bio"></textarea>
    </form></body>`),
  ).toEqual({
    email: "text",
    age: "number",
    // The deliberate divergence: a browser omits an unticked box, making `terms`
    // present-or-absent. A boolean is what `z.boolean()` wants and what an author reading
    // `data.terms` expects.
    terms: "boolean",
    // A radio set is many elements and one value — that is what a radio set is.
    plan: "one",
    colour: "text",
    tags: "many",
    bio: "text",
  });
});

test("two controls sharing a name give an array, in document order", () => {
  // Measured: `same name twice -> a="1" a="2"`, in source order — and `two names, source
  // order b then a -> b="1" a="2"`, so the *keys* keep source order too.
  const built = form(`<body><form>
    <input name="b" value="1">
    <input name="a" value="2">
    <input name="a" value="3">
  </form></body>`);

  expect(built.keys.map((k) => [k.path.join("."), k.shape, [...k.fields]])).toEqual([
    ["b", "text", [0]],
    ["a", "many", [1, 2]],
  ]);
});

test("a lone checkbox carrying a value keeps the browser's present-or-absent meaning", () => {
  // The boolean divergence is for the valueless case only. A `value` says "this string,
  // when ticked", and turning that into `true` would throw the string away.
  expect(shapes(`<body><form><input type="checkbox" name="a" value="1"></form></body>`)).toEqual({
    a: "one",
  });
  // Two of them sharing a name is the multi-value checkbox group — measured,
  // `checkbox pair, both checked -> a="1" a="2"`.
  expect(
    shapes(`<body><form>
      <input type="checkbox" name="a" value="1">
      <input type="checkbox" name="a" value="2">
    </form></body>`),
  ).toEqual({ a: "many" });
});

test("a single-selection list box is optional where a dropdown is not", () => {
  // Measured on both sides: a dropdown with nothing marked `selected` submits its **first**
  // option, so it always has a value; a list box starts with nothing selected at all.
  expect(shapes(`<body><form><select name="a"><option>x</option></select></form></body>`)).toEqual({
    a: "text",
  });
  expect(
    shapes(`<body><form><select name="a" size="4"><option>x</option></select></form></body>`),
  ).toEqual({ a: "one" });
});

test("formKeys keeps every key even when two shapes disagree", () => {
  // A text input and a checkbox sharing a name is legal and meaningless, and the answer
  // has to be *a* shape rather than a crash: the pair is a list, like any other pair.
  const keys = formKeys([
    { path: ["a"], kind: "text", el: el(`<input name="a">`) },
    { path: ["a"], kind: "checkbox", el: el(`<input type="checkbox" name="a">`) },
  ]);
  expect(keys).toEqual([{ path: ["a"], shape: "many", fields: [0, 1] }]);
});

// ---------------------------------------------------------------------------
// Cells: the state the compiler declares
// ---------------------------------------------------------------------------

test("a named field with no bind:value gets a cell the compiler declares", () => {
  const { specs, cells } = collectFields(
    doc(`<body><form>
      <input name="email" value="a@b.c">
      <input name="terms" type="checkbox" checked>
      <select name="plan"><option>free</option><option selected>pro</option></select>
      <textarea name="bio">hello</textarea>
    </form></body>`),
  );

  // One per field, named so nothing outside the artifact can reach it, and seeded from the
  // markup — a browser's "default value", which is exactly what the attributes are.
  expect(cells.map((c) => [c.name, c.initial])).toEqual([
    ["field_0", "a@b.c"],
    ["field_1", true],
    // The chosen option's *index*: a dropdown's cell holds what the engine reports.
    ["field_2", 1],
    // A textarea's default value is its content, not an attribute.
    ["field_3", "hello"],
  ]);
  expect([...specs.values()].map((s) => s.cell)).toEqual([
    "field_0",
    "field_1",
    "field_2",
    "field_3",
  ]);
});

test("a dropdown with nothing selected starts on its first option", () => {
  const { cells } = collectFields(
    doc(`<body><form><select name="a"><option>x</option><option>y</option></select></form></body>`),
  );
  expect(cells[0]!.initial).toBe(0);
});

test("a list box starts with exactly the options marked selected", () => {
  const { cells } = collectFields(
    doc(`<body><form><select name="a" multiple>
      <option>x</option><option selected>y</option><option selected>z</option>
    </select></form></body>`),
  );
  expect(cells[0]!.initial).toEqual([1, 2]);
});

test("a bind:value field keeps the author's signal instead of getting a cell", () => {
  // Two cells for one field would let the payload and the rendered text disagree.
  const tree = doc(`<body><form><input name="email"></form></body>`);
  const input = find(tree, "input")!;
  (input as { bindValue: unknown }).bindValue = { value: "typed" };

  const { specs, cells } = collectFields(tree);
  expect(cells).toEqual([]);
  expect(specs.get(input)!.cell).toBe("");
});

test("a bind:value field is two-way: the signal is its editable AND its display", () => {
  // The display half is what makes seeding work — a loader writing the signal
  // puts the text *in* the field. It regressed invisibly once (the write landed,
  // the run never repainted, and only a screenshot caught it), so both halves
  // are pinned: the editables ref carries the signal, and the field's run is a
  // text binding over the same signal.
  const sig = signal("seeded");
  // Through the real authoring path: jsx() is what inserts the signal as the
  // field's display child — a parser-built tree with bindValue attached by
  // hand would prove nothing about what an app compiles to.
  const tree = toDocument(
    jsx("body", { children: jsx("input", { type: "text", "bind:value": sig }) }) as Node,
  );

  const built = compileTree(tree, "");
  const editable = built.editables.find((e) => e.ref === sig);
  expect(editable).toBeDefined();

  const binding = built.textBindings.find((b) =>
    b.parts.some((p) => "source" in p && p.source === sig),
  );
  expect(binding).toBeDefined();
  // The bound run is the field's child, so what the signal holds is what paints.
  expect(built.nodes[binding!.node]!.parent).toBe(editable!.node);
});

test("the innermost form owns a field, and a nested form's fields are its own", () => {
  // Nested forms are invalid HTML that parses anyway. Resolving them the way the DOM does
  // is a quiet right answer where hoisting would be a quiet wrong one.
  const built = compileTree(
    doc(`<body>
      <form id="outer"><input name="a"><form id="inner"><input name="b"></form></form>
    </body>`),
    "",
  );

  const [outer, inner] = built.forms;
  expect(outer!.keys.map((k) => k.path.join("."))).toEqual(["a"]);
  expect(inner!.keys.map((k) => k.path.join("."))).toEqual(["b"]);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The first element of a fragment, for the per-element helpers. */
function el(html: string): Element {
  const root = parseHtml(html);
  const first = root.children.find((c) => c.type === "element");
  if (first === undefined || first.type !== "element") throw new Error(`no element in ${html}`);
  return first;
}

/** The first element with this tag, in document order. */
function find(node: Element, tag: string): Element | null {
  if (node.tag === tag) return node;
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const found = find(child, tag);
    if (found !== null) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ownership: a `form="id"` attribute, which is not ancestry
// ---------------------------------------------------------------------------

test("a form= field outside the form is in its payload, at its document position", () => {
  // Measured, `guards/probes/form-owner.html`: written *after* the form it gives `inner outer`, and
  // written *before* it gives `outer inner`. So the order is document order over the whole
  // document — which a subtree scan could not produce, since the field is not in the subtree.
  expect(
    form(`<body><form id="F"><input name="inner" value="1"></form>
      <input name="outer" value="2" form="F"></body>`).keys.map((k) => k.path.join(".")),
  ).toEqual(["inner", "outer"]);

  expect(
    form(`<body><input name="outer" value="2" form="F">
      <form id="F"><input name="inner" value="1"></form></body>`).keys.map((k) => k.path.join(".")),
  ).toEqual(["outer", "inner"]);
});

test("a field inside one form pointing at another belongs only to the other", () => {
  // Measured: F gets `inner moved`, G gets nothing at all.
  const built = compileTree(
    doc(`<body>
      <form id="F"><input name="inner" value="1"></form>
      <form id="G"><input name="moved" value="2" form="F"></form>
    </body>`),
    "",
  );

  const [f, g] = built.forms;
  expect(f!.keys.map((k) => k.path.join("."))).toEqual(["inner", "moved"]);
  expect(g!.keys.map((k) => k.path.join("."))).toEqual([]);
});

test("a form= naming an id that does not exist orphans the field", () => {
  // The measured surprise, and the one an implementation gets wrong by writing the obvious
  // fallback: F's payload is **empty**. The field does not revert to its ancestor.
  expect(
    form(`<body><form id="F"><input name="inner" value="1" form="ZZZ"></form></body>`).keys,
  ).toEqual([]);
});

test("ownership decides the default button, not descent", () => {
  // Three measured rows in one test, because they are the same rule seen from three sides.
  //
  // A button outside the form but associated with it *is* the default button: Enter clicked
  // it. So `button` has to be resolvable to a node that is not a descendant.
  const outside = form(`<body><form id="F"><input name="a"></form>
    <button type="submit" form="F">go</button></body>`);
  expect(outside.button).toBeGreaterThanOrEqual(0);

  // An unassociated one is not found — otherwise the rule would be "any button on the page".
  // The form falls through to its one-field rule instead, which is what Enter did.
  const stray = form(`<body><form id="F"><input name="a"></form>
    <button type="submit">go</button></body>`);
  expect(stray.button).toBe(-1);
  expect(stray.direct).toBe(true);

  // And a descendant whose `form=` points elsewhere is *not* this form's button: measured,
  // F fired `submit` with no click at all, i.e. it fell through to the one-field rule.
  const defected = compileTree(
    doc(`<body><form id="F"><input name="a"><button type="submit" form="G">go</button></form>
      <form id="G"></form></body>`),
    "",
  );
  expect(defected.forms[0]!.button).toBe(-1);
  expect(defected.forms[0]!.direct).toBe(true);
});

test("an associated field counts towards the one-blocking-field rule", () => {
  // The row that decides the shape of the code: one field inside and one associated from
  // outside, no button — Enter did **nothing**, so both count. A subtree scan would see one
  // field and wrongly mark the form directly submittable.
  const built = form(`<body><form id="F"><input name="a"></form>
    <input name="b" form="F"></body>`);
  expect(built.direct).toBe(false);

  // The control: drop the associated field and the same form submits directly.
  expect(form(`<body><form id="F"><input name="a"></form></body>`).direct).toBe(true);
});

test("owns holds every control the form owns, sorted, named or not", () => {
  const built = form(`<body><form id="F">
    <input name="a">
    <input>
    <button type="submit">go</button>
  </form><input name="b" form="F"></body>`);

  // Four controls owned; two of them — the nameless input and the nameless button — are in
  // `owns` and not in `fields`, which is the distinction this table exists for: ownership
  // answers "which form does Enter here submit", the field list answers "what is in the
  // payload". Sorted, because the runtime binary-searches it.
  expect(built.owns.length).toBe(4);
  expect([...built.owns]).toEqual([...built.owns].sort((x, y) => x - y));
  expect(built.fields.length).toBe(2);
});

// ---------------------------------------------------------------------------
// The submitter's own entry
// ---------------------------------------------------------------------------

test("a named submit button is a field, keyed where it is written", () => {
  // Measured: with the button *before* the field, the payload is `btn="first" a="x"`; with it
  // after, `a="x" btn="second"`. So the entry sits at the button's document position, which
  // is why a submitter is an ordinary member of the field list rather than an append.
  expect(
    form(`<body><form>
      <button type="submit" name="btn" value="first">one</button>
      <input name="a" value="x">
    </form></body>`).keys.map((k) => [k.path.join("."), k.shape]),
  ).toEqual([
    ["btn", "one"],
    ["a", "text"],
  ]);
});

test("two submit buttons sharing a name stay one value", () => {
  // Only one of them can be the button that submitted, so the pair can never contribute
  // twice — the same argument a radio set makes, reached from a different direction.
  expect(
    shapes(`<body><form>
      <button type="submit" name="btn" value="first">one</button>
      <button type="submit" name="btn" value="second">two</button>
    </form></body>`),
  ).toEqual({ btn: "one" });
});

test("a named submit button gets no cell", () => {
  // There is nothing for a cell to hold: what it contributes is a property of the gesture,
  // not a value that persists between submissions.
  const { cells } = collectFields(
    doc(`<body><form><input name="a"><button type="submit" name="btn" value="go">x</button></form></body>`),
  );
  expect(cells.map((c) => c.name)).toEqual(["field_0"]);
});

// ---------------------------------------------------------------------------
// `field` wrappers
// ---------------------------------------------------------------------------

test("a wrapper holding one bare control is that field; named children are its properties", () => {
  const built = form(`<body><form>
    <div field="name"><input type="text"></div>
    <div field="position"><input type="text" name="x"><input type="text" name="y"></div>
  </form></body>`);

  expect(built.keys.map((k) => k.path)).toEqual([["name"], ["position", "x"], ["position", "y"]]);
});

test("wrappers nest, and a wrapper without field is transparent", () => {
  const built = form(`<body><form>
    <div field="address">
      <div class="layout-only">
        <div field="city"><input type="text"></div>
      </div>
    </div>
  </form></body>`);

  expect(built.keys.map((k) => k.path)).toEqual([["address", "city"]]);
});

test("a path claimed as both a value and a group is reported", () => {
  // The one contradiction the model can produce, and the reason there is no leaf-or-branch
  // rule: `a` would have to be a string and an object at once. Either answer drops a field.
  const built = compileTree(
    doc(`<body><form><div field="a"><input type="text"><input type="text" name="x"></div></form></body>`),
    "",
  );
  expect(built.warnings.some((w) => w.includes("claimed as both a value and a group"))).toBe(true);
});

test("a wrapper gets an error cell, and a marker gets a message cell", () => {
  const { groups } = collectFields(
    doc(`<body><form>
      <div field="email"><span error></span><input type="text"></div>
      <div field="age"><input type="text"></div>
    </form></body>`),
  );

  // Every wrapper declares the error cell, marker or not — `errorClassName` may
  // still key on it. A *message* cell exists only where a marker does: with no
  // `<span error />` there is nowhere to show one.
  expect(groups.map((g) => [g.path, g.errorCell, g.messages[0]?.cell])).toEqual([
    [["email"], "fieldError_0", "fieldMessage_0_0"],
    [["age"], "fieldError_1", undefined],
  ]);
});

test("errorClassName becomes a conditional class keyed on the wrapper's own cell", () => {
  // Keyed per wrapper, because the patch machinery groups by the *signal* driving it — two
  // wrappers sharing the class string must not share the patch, or twenty fields would light
  // up together.
  const tree = doc(`<body><form>
    <div field="a"><input type="text"></div>
    <div field="b"><input type="text"></div>
  </form></body>`);
  const a = find(tree, "div")!;
  (a as { errorClassName?: string }).errorClassName = "group/error";

  const { groups } = collectFields(tree);
  expect(a.classWhen).toEqual({ "group/error": groups[0]!.errorSource });
  expect(groups[0]!.errorSource).not.toBe(groups[1]!.errorSource);
});

test("the element marked error belongs to the innermost wrapper", () => {
  const { groups } = collectFields(
    doc(`<body><form>
      <div field="outer">
        <span error id="for-outer"></span>
        <div field="inner"><span error id="for-inner"></span></div>
      </div>
    </form></body>`),
  );

  expect(groups.map((g) => [g.path.join("."), g.messages.map((m) => m.el.id)])).toEqual([
    ["outer", ["for-outer"]],
    ["outer.inner", ["for-inner"]],
  ]);
});

test("a named error marker speaks for a leaf, relative to its wrapper", () => {
  const { groups } = collectFields(
    doc(`<body><form>
      <div field="address">
        <input type="text" name="street">
        <input type="text" name="city">
        <span error="street" id="s"></span>
        <span error="city" id="c"></span>
        <span error id="whole"></span>
      </div>
    </form></body>`),
  );

  // Relative, like a control's `name`: the wrapper's chain plus what the marker said. So the
  // group is movable — renaming the wrapper does not touch the markers inside it.
  expect(groups[0]!.messages.map((m) => [m.el.id, m.path.join(".")])).toEqual([
    ["s", "address.street"],
    ["c", "address.city"],
    ["whole", "address"],
  ]);

  // A cell each, because they show different text at the same time.
  expect(new Set(groups[0]!.messages.map((m) => m.cell)).size).toBe(3);
});

test("a named error marker that names nothing is reported", () => {
  const warnings: string[] = [];
  collectFields(
    doc(`<body><form>
      <div field="address">
        <input type="text" name="city">
        <span error="cty"></span>
      </div>
    </form></body>`),
    (m) => warnings.push(m),
  );

  // The cost of a name: a typo compiles, renders an empty span, and stays empty forever —
  // which is indistinguishable from a field that is never wrong.
  expect(warnings.some((w) => w.includes(`names "address.cty"`))).toBe(true);
});

test("a name at or above a real field is reachable, because a validator may complain there", () => {
  const warnings: string[] = [];
  collectFields(
    doc(`<body><form>
      <div field="address">
        <div field="line"><input type="text" name="one"></div>
        <span error="line"></span>
        <span error="line.one"></span>
      </div>
    </form></body>`),
    (m) => warnings.push(m),
  );

  expect(warnings.filter((w) => w.includes("which no field produces"))).toEqual([]);
});

test("validateOn is read from the kebab-cased attribute a JSX prop becomes", () => {
  // It was read as `validateon` first, so every form compiled as "submit" while the markup
  // said otherwise — no error, no warning, a feature that silently did nothing.
  expect(form(`<body><form validate-on="change"><input name="a"></form></body>`).validateOn).toBe(
    "change",
  );
  expect(form(`<body><form validate-on="blur"><input name="a"></form></body>`).validateOn).toBe(
    "blur",
  );
  expect(form(`<body><form><input name="a"></form></body>`).validateOn).toBe("submit");
});

test("a validateOn nobody supports is a warning, not a silent submit", () => {
  const built = compileTree(
    doc(`<body><form validate-on="onChange"><input name="a"></form></body>`),
    "",
  );
  expect(built.forms[0]!.validateOn).toBe("submit");
  expect(built.warnings.some((w) => w.includes(`validateOn="onChange"`))).toBe(true);
});

test("a radio's name groups it rather than naming it", () => {
  // The wart the demo produced the first time it compiled: `<div field="plan">` holding radios
  // named `plan` gave the key `plan.plan`. A radio set *must* share a name — the engine
  // interns a group on `(form, name)` — so inside a wrapper the wrapper names the value, which
  // is the same reason its shape is `one`.
  expect(
    form(`<body><form><div field="plan">
      <input type="radio" name="plan" value="free">
      <input type="radio" name="plan" value="pro">
    </div></form></body>`).keys.map((k) => [k.path, k.shape]),
  ).toEqual([[["plan"], "one"]]);

  // Outside a wrapper the name is still the key, so a flat form is unchanged.
  expect(
    form(`<body><form>
      <input type="radio" name="plan" value="free">
      <input type="radio" name="plan" value="pro">
    </form></body>`).keys.map((k) => k.path),
  ).toEqual([["plan"]]);
});

test("two radio groups under one wrapper are reported", () => {
  // Both would claim the wrapper's key and only one answer could survive, so this is said out
  // loud rather than resolved — the fix is a wrapper per group.
  const built = compileTree(
    doc(`<body><form><div field="prefs">
      <input type="radio" name="plan" value="free">
      <input type="radio" name="colour" value="red">
    </div></form></body>`),
    "",
  );
  expect(built.warnings.some((w) => w.includes(`two radio groups share the field "prefs"`))).toBe(
    true,
  );
});
