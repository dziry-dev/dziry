/** @jsxImportSource . */

/**
 * `bind:value` — the compile-time half of a text field.
 *
 * There is one fact here and it is a link between two files that never mention
 * each other. `hit_test` returns the innermost **`INTERACTIVE`** node
 * (`native-src/dziry-engine/src/paint.rs:1896`), focus is whatever that returned
 * (`engine.rs:1164`), and the host routes a keystroke by matching the focused node
 * against the `editables` table (`src/runtime/bindings.ts:96`). So an editable that
 * is not in `interactive` cannot be focused, and every keystroke aimed at it is
 * dropped.
 *
 * That is not hypothetical. `buildInteractive` took handlers, lists and variants and
 * never editables, so a `<div bind:value>` with no `hover:` class and no `onClick` —
 * which is what both demo pages authored — qualified under no clause, and typing into
 * it had never once worked. The failure is silent in the worst way: the compiled
 * artifact is *correct*, the text binding renders, the signal is real, and nothing
 * reports that the node it addresses can never hold focus.
 *
 * These compile through the JSX front end because HTML cannot express a binding —
 * `parseHtml` sets `bindValue: null` at every one of its construction sites.
 *
 * The assertions read from two different places on purpose. `interactive` is on the
 * in-memory `CompiledUi`; the editables *table* is not, because bindings are resolved
 * only on the generated-module path (`compile.ts:1393`). So the table is read from the
 * `CompileResult` and the flag from the `CompiledUi`, which is also the pairing the
 * bug lived between.
 */
import { expect, test } from "bun:test";

import { compileTree, toCompiledUi, type CompileResult } from "./compile.ts";
import { jsx, toDocument } from "./jsx-runtime.ts";
import type { Element } from "./html.ts";
import { signal, setCompiling } from "../runtime/signal.ts";
import { findRow } from "../find-row.ts";
import { Position } from "../ir.ts";

/** Builds a document with the compiler's recording mode on, as the CLI does. */
function build(tree: () => unknown, css = ``): CompileResult {
  setCompiling(true);
  try {
    return compileTree(toDocument(tree() as never), css);
  } finally {
    setCompiling(false);
  }
}

test("an editable is interactive, so a click can focus it", () => {
  const draft = signal("");
  // Deliberately bare: no `hover:` class, no handler, no control kind. Every other
  // route into `interactive` is closed, which is the case that was broken and the
  // only case worth asserting — an editable that also had `onClick` was always fine,
  // and testing that one would have agreed with itself while typing stayed dead.
  const result = build(() => <div bind:value={draft} />);

  expect(result.editables.length).toBe(1);
  const node = result.editables[0]!.node;

  const ui = toCompiledUi(result);
  expect(findRow(ui.interactive, node)).toBeGreaterThanOrEqual(0);
});

test("a real <input> binds the same way a <div> does", () => {
  const draft = signal("hi");
  // The form an author actually writes, and the demo does not: both demo fields are
  // a `<div bind:value>`, so nothing here covered the tag whose whole purpose this
  // is. `<input>` is void in the HTML parser, and the generated `dyntext` child is a
  // child of a void tag — legal on the JSX path, which has no void check, and worth
  // pinning because the two front ends disagree about it.
  const result = build(() => <input type="text" bind:value={draft} />);

  expect(result.editables.length).toBe(1);
  expect(result.textBindings.length).toBe(1);

  const ui = toCompiledUi(result);
  expect(findRow(ui.interactive, result.editables[0]!.node)).toBeGreaterThanOrEqual(0);
});

test("the bound signal reaches the editables table by identity", () => {
  const draft = signal("hello");
  const result = build(() => <div bind:value={draft} />);

  // `resolve-refs` matches this ref against the module's exported signals by object
  // identity, which is what lets the emitted artifact hold the real signal instead of
  // a name to look up. The namespaced prop spelling must not change that.
  expect(result.editables[0]!.ref).toBe(draft);
});

test("an editable with no children displays its own value", () => {
  const draft = signal("typed");
  const result = build(() => <div bind:value={draft} />);

  // `bind:value` alone both shows and edits, via one generated `dyntext` child. An
  // editable that displayed nothing would be indistinguishable from a broken one in
  // a screenshot, which is how this stayed plausible for so long.
  expect(result.textBindings.length).toBe(1);
  const part = result.textBindings[0]!.parts[0]!;
  // A `{ source }` part, not a `{ literal }` one — the generated child holds the
  // signal itself, which is what makes the field update when the user types rather
  // than freezing whatever the value was at build time.
  expect(part).toHaveProperty("source");
  expect((part as { source: unknown }).source).toBe(draft);
});

test("children win over the bound value, so a placeholder can be authored", () => {
  const draft = signal("");
  const result = build(() => <div bind:value={draft}>empty</div>);

  // No `dyntext` was generated: the element already had children, so the binding
  // edits without displaying. Asserted because the condition is `children.length
  // === 0` and inverting it would be invisible to every other test here.
  expect(result.editables.length).toBe(1);
  expect(result.textBindings.length).toBe(0);
});

test("a text field with no binding warns, and a disabled one does not", () => {
  // Covered here rather than by the demo, which used to carry an unbound field purely
  // to show the warning. A field that silently ignores typing reads as broken rather
  // than as a lesson, so the demo binds both of its fields now — and the warning has to
  // stay tested somewhere, or the next person to touch `isTextEntry` finds out from a
  // user instead.
  const bare = build(() => <input type="text" />);
  expect(bare.warnings.some((w) => w.includes("no bind:value"))).toBe(true);

  // Disabled and readonly are exempt: a browser refuses typing into those too, so
  // there is nothing to warn about. This is the pair `isTextEntryTag` was split out
  // for — they still get a full-height box, they just get no warning.
  const off = build(() => <input type="text" disabled />);
  expect(off.warnings.some((w) => w.includes("no bind:value"))).toBe(false);

  // A checkbox is not a text field. It has a `type` too, and the naive test is a tag
  // check that would warn about every input on a form.
  const box = build(() => <input type="checkbox" />);
  expect(box.warnings.some((w) => w.includes("no bind:value"))).toBe(false);

  // And a bound one is silent, which is the whole point of the warning.
  const draft = signal("");
  const bound = build(() => <input type="text" bind:value={draft} />);
  expect(bound.warnings.some((w) => w.includes("no bind:value"))).toBe(false);
});

test("every text-entry box is one line high, bound or not", () => {
  // The compile-time half of the strut. Both shapes have to be flagged, because a
  // bound field's height comes from its generated run and an unbound one has no run at
  // all — a browser gives both the same box, and a `disabled` field is full height too.
  const draft = signal("");
  const result = build(() => (
    <div>
      <input type="text" bind:value={draft} />
      <input type="text" />
      <input type="text" disabled />
      <input type="checkbox" />
      <div />
    </div>
  ));

  const ui = toCompiledUi(result);
  const flagged = new Set(ui.editableBoxes);

  // Three fields, each with a run: six. **Not four**, which is what this asserted when
  // it was written, and the change is the point rather than a number that drifted. An
  // unbound field used to carry the strut on the element itself, justified by "a node
  // with a child is never measured" — then `::placeholder` gave it a child and the field
  // collapsed to padding height. Every field owns a run now, bound or not, so the two
  // shapes are one thing and the strut has a single home.
  //
  // Still not the checkbox and not the plain div: neither is a text-entry box, and
  // flagging the div would give every empty box in the tree a line of height.
  expect(flagged.size).toBe(6);
  expect(flagged.has(result.editables[0]!.node)).toBe(true);
});

test("a placeholder is a generated box whose text comes from the attribute", () => {
  const draft = signal("");
  const result = build(() => <input type="text" placeholder="type here" bind:value={draft} />);
  const ui = toCompiledUi(result);

  // One placeholder box, and its text is the attribute — not a `content` declaration,
  // which is the one way it differs from `::before`. Asserted through the string table
  // because that is where a painted string has to end up for anyone to see it.
  expect(ui.placeholders.length).toBe(1);
  const box = ui.placeholders[0]!;
  expect(ui.strings[ui.nodes.text[box]!]).toBe("type here");

  // `generated` too, so its predicates resolve against the field: that is what makes
  // `input:focus::placeholder` mean "the placeholder of a focused input" rather than
  // "a focused placeholder", which nothing could ever satisfy.
  expect(findRow(ui.generated, box)).toBeGreaterThanOrEqual(0);

  // Out of flow, so a field with a placeholder is exactly as tall as one without. If
  // this regressed to a static box the field would be two lines high and the strut
  // would be pointless.
  expect(ui.styles.position[ui.nodes.style[box]!]).toBe(Position.ABSOLUTE);
});

test("no placeholder attribute, no box — and never on a non-field", () => {
  const draft = signal("");
  // The attribute decides whether the box exists, which is the inversion of `::before`,
  // where a `content` declaration does. An empty attribute is treated as absent: a box
  // holding no text is a node, a style row and a paint visit for nothing.
  expect(toCompiledUi(build(() => <input type="text" bind:value={draft} />)).placeholders.length)
    .toBe(0);
  expect(toCompiledUi(build(() => <input type="text" placeholder="" />)).placeholders.length)
    .toBe(0);

  // A `placeholder` attribute on something that is not a text field is inert, as in a
  // browser. Without the tag test this would emit a floating grey box over a checkbox.
  expect(toCompiledUi(build(() => <input type="checkbox" placeholder="no" />)).placeholders.length)
    .toBe(0);
  expect(toCompiledUi(build(() => <div placeholder="no" />)).placeholders.length).toBe(0);
});

test("the bind: namespace never becomes an attribute a selector can match", () => {
  const draft = signal("");
  // Read off the element rather than the compiled tree, because `attrsOf` is what is
  // under test. Skipping by prefix means `bind:checked` and `bind:group` need no
  // second edit there — and without the skip the map would hold a signal object
  // under a key `[bind\:value]` could start matching against.
  // `jsx` is typed as returning a `Node`, since a component may return anything a
  // child position accepts; an intrinsic tag is always an `Element`.
  const el = jsx("div", { "bind:value": draft }) as Element;

  expect(el.bindValue).toBe(draft);
  expect([...el.attrs.keys()].some((k) => k.includes("bind"))).toBe(false);
});
