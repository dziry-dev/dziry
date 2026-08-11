/**
 * Typed text is the one runtime input that grows native memory.
 *
 * Every character a user types lengthens a string slot, which raises the string
 * arena's required size, and the engine's `grow` is monotonic — it never gives
 * memory back. So the input path needs a ceiling, and the runtime is the only
 * layer that can impose one: by the time the uploader sees the string, the slot
 * is already sized for it.
 */
import { expect, test } from "bun:test";

import {
  MAX_SLOT_CHARS,
  dispatch,
  dispatchChange,
  formSubmittedByPress,
  handlerFor,
  submitForm,
  submitFrom,
  typeInto,
  type EditableRef,
} from "./bindings.ts";
import { signal, type Signal } from "./signal.ts";
import { ControlKind, type CompiledUi } from "../ir.ts";

function editable(initial: string) {
  const value = signal(initial);
  const refs: EditableRef[] = [{ node: 7, signal: value }];
  return { value, refs };
}

test("a keystroke appends to the focused editable", () => {
  const { value, refs } = editable("ab");
  expect(typeInto(refs, 7, { text: "c" })).toBe(true);
  expect(value.value).toBe("abc");
});

test("backspace removes the last character", () => {
  const { value, refs } = editable("abc");
  expect(typeInto(refs, 7, { text: null, erase: "backward" })).toBe(true);
  expect(value.value).toBe("ab");
});

test("a keystroke for an unfocused node is ignored", () => {
  const { value, refs } = editable("ab");
  expect(typeInto(refs, 99, { text: "c" })).toBe(false);
  expect(value.value).toBe("ab");
});

test("text is refused at the cap rather than growing the arena", () => {
  const { value, refs } = editable("x".repeat(MAX_SLOT_CHARS));

  expect(typeInto(refs, 7, { text: "y" })).toBe(false);
  expect(value.value.length).toBe(MAX_SLOT_CHARS);

  // And a paste that would cross the line is refused whole, not truncated —
  // silently keeping half of what someone pasted is a worse answer than keeping
  // none of it.
  const { value: v2, refs: r2 } = editable("x".repeat(MAX_SLOT_CHARS - 2));
  expect(typeInto(r2, 7, { text: "abcdef" })).toBe(false);
  expect(v2.value.length).toBe(MAX_SLOT_CHARS - 2);
});

test("backspace still works at the cap, so the field is not a trap", () => {
  const { value, refs } = editable("x".repeat(MAX_SLOT_CHARS));
  expect(typeInto(refs, 7, { text: null, erase: "backward" })).toBe(true);
  expect(value.value.length).toBe(MAX_SLOT_CHARS - 1);
});

// ---------------------------------------------------------------------------
// Editing at the caret
// ---------------------------------------------------------------------------

test("text is inserted at the caret, not appended", () => {
  const { value, refs } = editable("abcd");
  // The bug this fixes: clicking into the middle of a field and typing put the
  // characters at the end, because the host had no idea where the caret was. The engine
  // owns the index and reports it beside the text; this owns the string.
  expect(typeInto(refs, 7, { text: "X", caret: 2 })).toBe(true);
  expect(value.value).toBe("abXcd");
});

test("backspace removes the character before the caret", () => {
  const { value, refs } = editable("abcd");
  expect(typeInto(refs, 7, { text: null, erase: "backward", caret: 2 })).toBe(true);
  expect(value.value).toBe("acd");
});

test("backspace at the start consumes the key and changes nothing", () => {
  const { value, refs } = editable("abcd");
  // Consumed, not refused: Backspace at offset 0 doing nothing is the measured behaviour,
  // and returning false would send the host looking for another meaning for the key.
  expect(typeInto(refs, 7, { text: null, erase: "backward", caret: 0 })).toBe(true);
  expect(value.value).toBe("abcd");
});

test("delete removes the character after the caret", () => {
  const { value, refs } = editable("abcd");
  // The key did nothing before this: the engine forwarded it like every other unhandled
  // keycode, and the worker matched only Backspace, so it fell off the end of the switch.
  expect(typeInto(refs, 7, { text: null, erase: "forward", caret: 2 })).toBe(true);
  expect(value.value).toBe("abd");
});

test("delete at the end consumes the key and changes nothing", () => {
  const { value, refs } = editable("abcd");
  // The mirror of Backspace at 0, and consumed for the same reason.
  expect(typeInto(refs, 7, { text: null, erase: "forward", caret: 4 })).toBe(true);
  expect(value.value).toBe("abcd");

  // And with no caret at all: `at` becomes the length, which is the end.
  expect(typeInto(refs, 7, { text: null, erase: "forward" })).toBe(true);
  expect(value.value).toBe("abcd");
});

test("delete eats a whole astral character", () => {
  // The forward half of the surrogate-pair case: slicing by `.length` would leave the low
  // surrogate behind as a lone broken unit.
  const { value, refs } = editable("a😀b");
  expect(typeInto(refs, 7, { text: null, erase: "forward", caret: 1 })).toBe(true);
  expect(value.value).toBe("ab");
});

test("a caret at the end appends, and so does no caret at all", () => {
  const { value, refs } = editable("ab");
  expect(typeInto(refs, 7, { text: "c", caret: 2 })).toBe(true);
  expect(value.value).toBe("abc");

  // -1 is "nothing focused", and an absent field is a host that never places a caret.
  // Both append, so this behaves as it did before there was a caret at all.
  expect(typeInto(refs, 7, { text: "d", caret: -1 })).toBe(true);
  expect(value.value).toBe("abcd");
  expect(typeInto(refs, 7, { text: "e" })).toBe(true);
  expect(value.value).toBe("abcde");
});

test("a caret past the end is clamped rather than trusted", () => {
  const { value, refs } = editable("ab");
  // It crossed a process boundary, and app code may have rewritten the signal since the
  // engine read the length. Slicing at 99 would silently drop text.
  expect(typeInto(refs, 7, { text: "!", caret: 99 })).toBe(true);
  expect(value.value).toBe("ab!");
});

// ---------------------------------------------------------------------------
// Editing over a live selection
// ---------------------------------------------------------------------------

test("typing over a selection replaces exactly the selected range", () => {
  const { value, refs } = editable("abcdefghij");
  // Measured: `X` over `2..6` gives `abXghij`. The engine sends the two offsets it holds —
  // `caret` is the focus and `anchor` the other end — and this splices between them.
  expect(typeInto(refs, 7, { text: "X", caret: 6, anchor: 2 })).toBe(true);
  expect(value.value).toBe("abXghij");
});

test("Backspace and Delete are identical once a range is live", () => {
  // The measured surprise, and the reason both keys share one branch: over a range neither
  // takes the extra character its collapsed behaviour would. Backspace over `1..4` gives
  // `ahij`, not `hij`, and Delete over the same range gives `ahij` too.
  for (const erase of ["backward", "forward"] as const) {
    const { value, refs } = editable("abcdefghij");
    expect(typeInto(refs, 7, { text: null, erase, caret: 4, anchor: 1 })).toBe(true);
    expect(value.value, erase).toBe("aefghij");
  }
});

test("a backward selection edits the same as a forward one", () => {
  // The engine stores `(anchor, focus)` because that is what survives a Shift reversal, so
  // `caret` can be the *low* end. Measured to edit identically; splicing `caret..anchor`
  // without ordering them first would produce a negative slice and silently drop nothing.
  const forward = editable("abcdefghij");
  expect(typeInto(forward.refs, 7, { text: "Z", caret: 4, anchor: 1 })).toBe(true);

  const backward = editable("abcdefghij");
  expect(typeInto(backward.refs, 7, { text: "Z", caret: 1, anchor: 4 })).toBe(true);

  expect(backward.value.value).toBe(forward.value.value);
  expect(forward.value.value).toBe("aZefghij");
});

test("a collapsed range is a caret, not a zero-length selection", () => {
  // `anchor === caret` is what the engine sends whenever nothing is selected, which is most
  // of the time. Taking the range branch there would make every Backspace a no-op.
  const { value, refs } = editable("abcd");
  expect(typeInto(refs, 7, { text: null, erase: "backward", caret: 2, anchor: 2 })).toBe(true);
  expect(value.value).toBe("acd");

  // And an absent anchor — a host that never reports one — behaves the same way.
  const two = editable("abcd");
  expect(typeInto(two.refs, 7, { text: "X", caret: 2 })).toBe(true);
  expect(two.value.value).toBe("abXcd");
});

test("a selection past the end is clamped, not trusted", () => {
  // Both offsets crossed a process boundary, and app code may have shortened the signal
  // since the engine read it. Slicing at 99 would drop text silently.
  const { value, refs } = editable("abc");
  expect(typeInto(refs, 7, { text: "!", caret: 99, anchor: 1 })).toBe(true);
  expect(value.value).toBe("a!");
});

test("replacing a selection can free room at the cap", () => {
  // The ceiling is on the *result*, not on what was there before — so selecting the whole of
  // a full field and typing one character has to be allowed. Checking `chars.length + text`
  // as the collapsed path does would refuse it and leave the field uneditable forever.
  const full = "x".repeat(MAX_SLOT_CHARS);
  const { value, refs } = editable(full);
  expect(typeInto(refs, 7, { text: "y", caret: MAX_SLOT_CHARS, anchor: 0 })).toBe(true);
  expect(value.value).toBe("y");
});

test("the caret counts characters, not UTF-16 units", () => {
  // "😀" is one character and two UTF-16 units. The engine resolved the click by counting
  // *characters*, so slicing by `.length` here would put the insert in the middle of a
  // surrogate pair and produce two broken halves.
  const { value, refs } = editable("😀a");
  expect(typeInto(refs, 7, { text: "X", caret: 1 })).toBe(true);
  expect(value.value).toBe("😀Xa");

  // And backspace over the emoji removes the whole thing, not half of it.
  const two = editable("😀a");
  expect(typeInto(two.refs, 7, { text: null, erase: "backward", caret: 1 })).toBe(true);
  expect(two.value.value).toBe("a");
});

/**
 * `onChange` — the handler the engine has been able to fire since v13 and could not
 * reach, because nothing drained the `CHANGE` queue.
 *
 * These test the conversion rather than the plumbing, because the conversion is where
 * the decision is: the engine hands over one integer whose meaning is the control's
 * kind, and an author writing `onChange={(on) => setOn(on)}` on a checkbox should get a
 * boolean rather than a 1.
 */
function uiWith(
  handlers: Array<{
    node: number;
    kind: "click" | "change" | "focus" | "blur";
    fn: (v?: unknown) => void;
  }>,
  controls: Array<{ node: number; kind: number }>,
) {
  return {
    handlers,
    controls: {
      count: controls.length,
      node: Int32Array.from(controls.map((c) => c.node)),
      kind: Uint8Array.from(controls.map((c) => c.kind)),
    },
  } as unknown as CompiledUi;
}

test("a checkbox's onChange receives a boolean, not the wire integer", () => {
  const seen: unknown[] = [];
  const ui = uiWith(
    [{ node: 4, kind: "change", fn: (v) => seen.push(v) }],
    [{ node: 4, kind: ControlKind.CHECKBOX }],
  );

  expect(dispatchChange(ui, 4, 1)).toBe(true);
  expect(dispatchChange(ui, 4, 0)).toBe(true);
  expect(seen).toEqual([true, false]);
});

test("a select's onChange receives the chosen index", () => {
  // Not a boolean and not a node id. The index is the position in the list the author
  // wrote, which is the only one of the three they can act on without reading the IR.
  const seen: unknown[] = [];
  const ui = uiWith(
    [{ node: 9, kind: "change", fn: (v) => seen.push(v) }],
    [{ node: 9, kind: ControlKind.SELECT }],
  );

  expect(dispatchChange(ui, 9, 2)).toBe(true);
  expect(seen).toEqual([2]);
});

test("a list box's onChange receives the selected indices, not the row that moved", () => {
  // The one control whose answer is not in the wire integer at all. Measured, a list box
  // fires **one** `change` per gesture however many rows moved — so `raw` can only name
  // the row the gesture landed on, and the set arrives beside the event, read on the
  // engine thread where the handle is. See `EngineEvent.selected`.
  const seen: unknown[] = [];
  const ui = uiWith(
    [{ node: 9, kind: "change", fn: (v) => seen.push(v) }],
    [{ node: 9, kind: ControlKind.LISTBOX }],
  );

  expect(dispatchChange(ui, 9, 3, [0, 2, 3])).toBe(true);
  // Empty is a real answer — a list box can have nothing selected, which is also how it
  // starts unless an option says `selected`.
  expect(dispatchChange(ui, 9, 1, [])).toBe(true);
  expect(seen).toEqual([[0, 2, 3], []]);
});

test("a list box's handler gets a copy, not the drained event's array", () => {
  // The drained array is shared — `host.ts` hands out one frozen empty for every event
  // that is not a list box's `CHANGE`, and the filled ones come straight off an FFI read.
  // A handler that keeps what it was given must not be holding a buffer that the next
  // event rewrites.
  const kept: unknown[] = [];
  const ui = uiWith(
    [{ node: 9, kind: "change", fn: (v) => kept.push(v) }],
    [{ node: 9, kind: ControlKind.LISTBOX }],
  );

  const wire = [1, 2];
  dispatchChange(ui, 9, 2, wire);
  wire.length = 0;
  expect(kept).toEqual([[1, 2]]);
});

test("click and change handlers on one node do not answer for each other", () => {
  // The reason `handlers` grew a `kind` column rather than being looked up by node
  // alone: a checkbox inside a clickable row has an `onClick` that belongs to the row
  // and an `onChange` that belongs to the box, and dispatching by node would fire
  // whichever was emitted first.
  const fired: string[] = [];
  const ui = uiWith(
    [
      { node: 4, kind: "click", fn: () => fired.push("click") },
      { node: 4, kind: "change", fn: () => fired.push("change") },
    ],
    [{ node: 4, kind: ControlKind.CHECKBOX }],
  );

  expect(dispatchChange(ui, 4, 1)).toBe(true);
  expect(fired).toEqual(["change"]);
  expect(handlerFor(ui, 4, "click")).not.toBeNull();
});

test("a node with no change handler is not a change dispatch", () => {
  const ui = uiWith(
    [{ node: 4, kind: "click", fn: () => {} }],
    [{ node: 4, kind: ControlKind.CHECKBOX }],
  );
  expect(dispatchChange(ui, 4, 1)).toBe(false);
});

test("an unknown kind passes the integer through rather than guessing", () => {
  // A kind this function has not been taught is a kind whose value it cannot interpret.
  // Inventing a conversion would be inventing behaviour; passing the wire value through
  // at least keeps the information.
  const seen: unknown[] = [];
  const ui = uiWith(
    [{ node: 4, kind: "change", fn: (v) => seen.push(v) }],
    [{ node: 4, kind: ControlKind.BUTTON }],
  );
  expect(dispatchChange(ui, 4, 7)).toBe(true);
  expect(seen).toEqual([7]);
});

test("focus and blur route to their own handlers on the same node", () => {
  // One node can carry all four kinds, and the engine emits them at different moments —
  // so dispatching by node alone would fire whichever the compiler emitted first. The
  // kind column is what keeps a blur handler from running on a click.
  const fired: string[] = [];
  const ui = uiWith(
    [
      { node: 5, kind: "click", fn: () => fired.push("click") },
      { node: 5, kind: "focus", fn: () => fired.push("focus") },
      { node: 5, kind: "blur", fn: () => fired.push("blur") },
    ],
    [],
  );

  expect(dispatch(ui, 5, "focus")).toBe(true);
  expect(dispatch(ui, 5, "blur")).toBe(true);
  expect(dispatch(ui, 5)).toBe(true);
  expect(fired).toEqual(["focus", "blur", "click"]);
});

test("a node with only a blur handler is not focusable by dispatch", () => {
  const ui = uiWith([{ node: 5, kind: "blur", fn: () => {} }], []);
  expect(dispatch(ui, 5, "focus")).toBe(false);
  expect(dispatch(ui, 5, "blur")).toBe(true);
});

/**
 * Implicit submission, on the runtime side of the split.
 *
 * The compiler decided the outcome; these test the two questions it could not — where
 * focus is, and whether the node is a textarea — plus the ordering the browser produces.
 *
 * A hand-built `CompiledUi` rather than a compiled fixture, because `toCompiledUi`
 * returns `handlers: []` by design: handler refs are resolved only on the generated-module
 * path, and a compiled form here would have nothing to dispatch to.
 */
function formUi(opts: {
  /** `[node, parent]`, so a walk up the chain has something to walk. */
  parents: number[];
  forms: Array<{ node: number; button: number; direct: boolean; owns?: Int32Array }>;
  textAreas?: number[];
  handlers?: Array<{ node: number; kind: "click" | "submit"; fn: () => void }>;
}) {
  return {
    handlers: opts.handlers ?? [],
    // No fields, so the payload every `onSubmit` here receives is `{}`. These tests are
    // about *when* a form submits; `forms.test.ts` is about what it hands over.
    //
    // `owns` empty, which makes `formOf` fall through to the parent walk — the path these
    // tests were written for, and the one that answers for markup with no `form=` attribute.
    forms: opts.forms.map((f) => ({
      owns: new Int32Array(),
      fields: [],
      keys: [],
      arrays: [],
      validate: null,
      ...f,
    })),
    textAreas: Int32Array.from(opts.textAreas ?? []),
    nodes: { parent: Int32Array.from(opts.parents) },
  } as unknown as CompiledUi;
}

test("Enter in a field submits the form it is inside", () => {
  const seen: string[] = [];
  // 0 root, 1 form, 2 field, 3 button.
  const ui = formUi({
    parents: [-1, 0, 1, 1],
    forms: [{ node: 1, button: 3, direct: false }],
    handlers: [
      { node: 1, kind: "submit", fn: () => seen.push("submit") },
      { node: 3, kind: "click", fn: () => seen.push("click") },
    ],
  });

  expect(submitFrom(ui, 2)).toBe(true);
  // The button's own click first, then the submit. In a browser the submission *is* a
  // consequence of a synthesised click on that button, so a form whose button also
  // validates on click must behave the same under Enter as under a real press.
  expect(seen).toEqual(["click", "submit"]);
});

test("Enter outside any form submits nothing", () => {
  const ui = formUi({
    parents: [-1, 0, 0],
    forms: [{ node: 1, button: -1, direct: true }],
    handlers: [{ node: 1, kind: "submit", fn: () => {} }],
  });
  // Node 2 is a sibling of the form, not a descendant. Walking up from it reaches the
  // root without passing through node 1.
  expect(submitFrom(ui, 2)).toBe(false);
});

test("Enter in a textarea types instead of submitting", () => {
  const seen: string[] = [];
  const ui = formUi({
    parents: [-1, 0, 1],
    forms: [{ node: 1, button: -1, direct: true }],
    textAreas: [2],
    handlers: [{ node: 1, kind: "submit", fn: () => seen.push("submit") }],
  });

  // Measured. And note the form *would* submit from any other field — `direct` is true —
  // so this is the exclusion doing the work rather than the form being unsubmittable.
  expect(submitFrom(ui, 2)).toBe(false);
  expect(seen).toEqual([]);
});

test("a form the compiler marked unsubmittable does nothing on Enter", () => {
  const seen: string[] = [];
  // What a disabled submit button, or two fields and no button, compiles to.
  const ui = formUi({
    parents: [-1, 0, 1],
    forms: [{ node: 1, button: -1, direct: false }],
    handlers: [{ node: 1, kind: "submit", fn: () => seen.push("submit") }],
  });

  expect(submitFrom(ui, 2)).toBe(false);
  expect(seen).toEqual([]);
});

test("the innermost form wins", () => {
  const seen: string[] = [];
  // 0 root, 1 outer form, 2 inner form, 3 field inside the inner one.
  const ui = formUi({
    parents: [-1, 0, 1, 2],
    forms: [
      { node: 1, button: -1, direct: true },
      { node: 2, button: -1, direct: true },
    ],
    handlers: [
      { node: 1, kind: "submit", fn: () => seen.push("outer") },
      { node: 2, kind: "submit", fn: () => seen.push("inner") },
    ],
  });

  expect(submitFrom(ui, 3)).toBe(true);
  expect(seen).toEqual(["inner"]);
});

test("a press on the submit button submits, and fires its click exactly once", () => {
  const seen: string[] = [];
  const ui = formUi({
    parents: [-1, 0, 1, 1],
    forms: [{ node: 1, button: 3, direct: false }],
    handlers: [
      { node: 1, kind: "submit", fn: () => seen.push("submit") },
      { node: 3, kind: "click", fn: () => seen.push("click") },
    ],
  });

  // The worker asks this before falling back to `dispatch`, which is what stops the
  // button's `onClick` running twice — once from the ordinary click path and once from
  // inside the submission.
  expect(formSubmittedByPress(ui, 3)).toBe(1);
  expect(formSubmittedByPress(ui, 2)).toBe(-1);

  expect(submitForm(ui, 1, 3)).toBe(true);
  expect(seen).toEqual(["click", "submit"]);
});

// ---------------------------------------------------------------------------
// What a submission hands over
// ---------------------------------------------------------------------------

/**
 * A one-field form, wired the way the emitter wires one.
 *
 * `formUi` above is deliberately field-less — those tests are about *when* a form
 * submits. These are about what reaches the handler, which is the other half.
 */
function payloadUi(opts: {
  cell: Signal<string>;
  validate?: unknown;
  onSubmit?: (data?: unknown) => void;
  onInvalid?: (issues?: unknown) => void;
}) {
  return {
    handlers: [
      ...(opts.onSubmit ? [{ node: 1, kind: "submit", fn: opts.onSubmit }] : []),
      ...(opts.onInvalid ? [{ node: 1, kind: "invalid", fn: opts.onInvalid }] : []),
    ],
    forms: [
      {
        node: 1,
        button: 3,
        direct: false,
        validate: opts.validate ?? null,
        owns: Int32Array.from([2, 3]),
        validateOn: "submit",
        // No `field` wrapper, so no error cells: these tests are about what a submission
        // hands over, not about what it lights up. `forms.test.ts` covers `applyIssues`.
        groups: [],
        arrays: [],
        fields: [
          {
            node: 2,
            kind: "text",
            value: "",
            initial: "",
            options: [],
            disabled: false,
            row: -1,
            signal: opts.cell,
          },
        ],
        keys: [{ path: ["email"], shape: "text", fields: Int32Array.from([0]) }],
      },
    ],
    textAreas: Int32Array.from([]),
    controls: { count: 0, flags: new Uint8Array(4) },
    nodes: { parent: Int32Array.from([-1, 0, 1, 1]) },
  } as unknown as CompiledUi;
}

test("onSubmit receives the payload, keyed by name", () => {
  let seen: unknown = null;
  const cell = signal("a@b.co");
  const ui = payloadUi({ cell, onSubmit: (data) => (seen = data) });

  expect(submitForm(ui, 1, 3)).toBe(true);
  expect(seen).toEqual({ email: "a@b.co" });

  // Live, not authored: what the user typed since is what submits.
  cell.value = "typed@later.co";
  submitForm(ui, 1, 3);
  expect(seen).toEqual({ email: "typed@later.co" });
});

test("a valid payload reaches onSubmit as the schema's output", () => {
  let seen: unknown = null;
  const ui = payloadUi({
    cell: signal("  a@b.co  "),
    validate: (d: { email: string }) => {
      d.email = d.email.trim();
      return null;
    },
    onSubmit: (data) => (seen = data),
  });

  expect(submitForm(ui, 1, 3)).toBe(true);
  expect(seen).toEqual({ email: "a@b.co" });
});

test("an invalid payload runs onInvalid and not onSubmit", () => {
  const seen: string[] = [];
  let issues: unknown = null;
  const ui = payloadUi({
    cell: signal(""),
    validate: (d: { email: string }) =>
      d.email === "" ? [{ path: ["email"], message: "required" }] : null,
    onSubmit: () => seen.push("submit"),
    onInvalid: (raw) => {
      seen.push("invalid");
      issues = raw;
    },
  });

  // Still `true`: the form *was* submitted, and the validator is what stopped it. A
  // `false` here would tell the caller to go looking for another meaning for the press.
  expect(submitForm(ui, 1, 3)).toBe(true);
  expect(seen).toEqual(["invalid"]);
  expect(issues).toEqual([{ path: ["email"], message: "required" }]);
});

test("a form with a validate and no onInvalid simply does not submit", () => {
  const seen: string[] = [];
  const ui = payloadUi({
    cell: signal(""),
    validate: () => [{ path: [], message: "no" }],
    onSubmit: () => seen.push("submit"),
  });

  expect(submitForm(ui, 1, 3)).toBe(true);
  expect(seen).toEqual([]);
});

test("an async validator submits later, and the button's click still fires now", async () => {
  const seen: string[] = [];
  const ui = payloadUi({
    cell: signal("a@b.co"),
    validate: async () => null,
    onSubmit: () => seen.push("submit"),
  });

  expect(submitForm(ui, 1, 3)).toBe(true);
  // The click belongs to this action and is not made to wait for a validator that may
  // take a network round trip.
  expect(seen).toEqual([]);
  await Promise.resolve();
  await Promise.resolve();
  expect(seen).toEqual(["submit"]);
});

test("Enter in a form= field submits that form, though it is not inside it", () => {
  const seen: string[] = [];
  // 0 root, 1 form, 2 the form's own field, 3 its button, 4 a field written *outside* the
  // form and associated with it by `form="…"`. Node 4's parent is the root, so no walk up
  // the tree can reach node 1 — `owns` is the only thing that can.
  const ui = formUi({
    parents: [-1, 0, 1, 1, 0],
    forms: [{ node: 1, button: 3, direct: false, owns: Int32Array.from([2, 3, 4]) }],
    handlers: [{ node: 1, kind: "submit", fn: () => seen.push("submit") }],
  });

  expect(submitFrom(ui, 4)).toBe(true);
  expect(seen).toEqual(["submit"]);
});

test("a node inside a form but not owned still submits, by walking up", () => {
  const seen: string[] = [];
  // Node 4 is a `<div tabindex=0>` inside the form: not a control, so not in `owns`. The
  // parent walk is what answers for it, which is why both paths exist.
  const ui = formUi({
    parents: [-1, 0, 1, 1, 1],
    forms: [{ node: 1, button: 3, direct: false, owns: Int32Array.from([2, 3]) }],
    handlers: [{ node: 1, kind: "submit", fn: () => seen.push("submit") }],
  });

  expect(submitFrom(ui, 4)).toBe(true);
  expect(seen).toEqual(["submit"]);
});
