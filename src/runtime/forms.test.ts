/**
 * What a form hands to `onSubmit`, and what `validate={…}` does to it.
 *
 * The compiler's `fields.test.ts` asserts the table; this asserts the payload built from
 * it, plus the three validator shapes — a plain function, a Standard Schema, and a raw
 * Effect schema. The last two are checked against the real libraries rather than a stub,
 * because the whole claim is interoperability: a stub would only prove that dziri agrees
 * with dziri's idea of Zod.
 *
 * `zod` and `effect` are devDependencies for exactly this. Neither is a dependency of the
 * framework, and `forms.ts` imports neither.
 */
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { z } from "zod";

import { applyFieldChange, applyIssues, formPayload, validatePayload } from "./forms.ts";
import { signal } from "./signal.ts";
import { ControlFlags, type CompiledUi, type FormBinding, type FormField } from "../ir.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * One field, spelled the way the emitter spells it.
 *
 * Hand-built rather than compiled: `toCompiledUi` returns forms with no fields by design
 * — a cell is either an export or an artifact declaration, and there is no artifact on the
 * in-memory path. So the compiler's half is tested there and the runtime's half here, on a
 * table with the same shape the emitter writes.
 */
function field(over: Partial<FormField> & Pick<FormField, "kind">): FormField {
  return {
    node: 0,
    value: "",
    options: [],
    disabled: false,
    row: -1,
    initial: "",
    // Defaulted rather than required, because a `submitter` genuinely has none — it is the
    // one kind whose contribution comes from the gesture instead of from a cell.
    signal: null,
    ...over,
  } as FormField;
}

function ui(form: Partial<FormBinding> & Pick<FormBinding, "fields" | "keys">): {
  ui: CompiledUi;
  form: FormBinding;
} {
  const binding = {
    node: 1,
    button: -1,
    direct: false,
    validate: null,
    owns: new Int32Array(),
    groups: [],
    arrays: [],
    arrays: [],
    validateOn: "submit",
    ...form,
  } as FormBinding;
  return {
    ui: {
      forms: [binding],
      controls: { count: 0, flags: new Uint8Array(8) },
    } as unknown as CompiledUi,
    form: binding,
  };
}

/** A one-key form, which is most of the cases below. */
function single(shape: string, ...fields: FormField[]) {
  return ui({
    fields,
    keys: [{ path: ["a"], shape, fields: Int32Array.from(fields.map((_, i) => i)) }],
  } as unknown as FormBinding);
}

// ---------------------------------------------------------------------------
// The payload: one key per name, shaped at build time
// ---------------------------------------------------------------------------

test("a text field contributes its cell's string", () => {
  const { ui: u, form } = single("text", field({ kind: "text", signal: signal("typed") }));
  expect(formPayload(u, form)).toEqual({ a: "typed" });
});

test("a number field parses, and an empty one is undefined rather than NaN", () => {
  const cell = signal("31");
  const { ui: u, form } = single("number", field({ kind: "number", signal: cell }));
  expect(formPayload(u, form)).toEqual({ a: 31 });

  // `undefined` is what "not filled in" means to `z.number()` and to `Schema.Number`
  // alike. NaN fails with a message about types and survives arithmetic silently.
  cell.value = "";
  expect(formPayload(u, form)).toEqual({ a: undefined });
  cell.value = "12abc";
  expect(formPayload(u, form)).toEqual({ a: undefined });
});

test("a lone valueless checkbox is a boolean, ticked or not", () => {
  const cell = signal(false);
  const { ui: u, form } = single(
    "boolean",
    field({ kind: "checkbox", value: "on", signal: cell }),
  );

  // The deliberate divergence from `FormData`, which omits an unticked box entirely.
  expect(formPayload(u, form)).toEqual({ a: false });
  cell.value = true;
  expect(formPayload(u, form)).toEqual({ a: true });
});

test("a checkbox carrying a value contributes that value, or nothing", () => {
  const cell = signal(false);
  const { ui: u, form } = single("one", field({ kind: "checkbox", value: "1", signal: cell }));

  expect(formPayload(u, form)).toEqual({ a: undefined });
  cell.value = true;
  expect(formPayload(u, form)).toEqual({ a: "1" });
});

test("a radio group contributes the checked member's value", () => {
  const pro = signal(false);
  const ent = signal(true);
  const { ui: u, form } = single(
    "one",
    field({ kind: "radio", value: "pro", signal: pro }),
    field({ kind: "radio", value: "ent", signal: ent }),
  );

  expect(formPayload(u, form)).toEqual({ a: "ent" });
  // Measured: `radio, none checked -> (empty)`. Nothing checked is a real state and the
  // key still exists, because the key set is fixed at build time.
  ent.value = false;
  expect(formPayload(u, form)).toEqual({ a: undefined });
});

test("a select contributes the chosen option's value, by index", () => {
  const cell = signal(0);
  const { ui: u, form } = single(
    "text",
    field({ kind: "select", options: ["red", "green"], signal: cell }),
  );

  expect(formPayload(u, form)).toEqual({ a: "red" });
  cell.value = 1;
  expect(formPayload(u, form)).toEqual({ a: "green" });
  // An index with no option behind it contributes nothing rather than `undefined`
  // stringified into the payload.
  cell.value = 7;
  expect(formPayload(u, form)).toEqual({ a: "" });
});

test("a multiple select contributes every selected value, in document order", () => {
  const cell = signal<number[]>([2, 0]);
  const { ui: u, form } = single(
    "many",
    field({ kind: "selectMultiple", options: ["a", "b", "c"], signal: cell }),
  );

  // The engine reports indices; the order of the *values* is the order of the indices it
  // gave, which it builds by walking the options in document order.
  expect(formPayload(u, form)).toEqual({ a: ["c", "a"] });
  cell.value = [];
  // Empty rather than missing — the key set does not depend on what is selected.
  expect(formPayload(u, form)).toEqual({ a: [] });
});

test("two fields sharing a name give an array", () => {
  const { ui: u, form } = single(
    "many",
    field({ kind: "text", signal: signal("1") }),
    field({ kind: "text", signal: signal("2") }),
  );
  expect(formPayload(u, form)).toEqual({ a: ["1", "2"] });
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

test("a field the markup disabled contributes nothing", () => {
  const { ui: u, form } = single(
    "text",
    field({ kind: "text", signal: signal("secret"), disabled: true }),
  );
  // Measured: `text, name but disabled -> (empty)`. The key survives, its value does not.
  expect(formPayload(u, form)).toEqual({ a: "" });
});

test("a field a signal disabled contributes nothing either", () => {
  // `disabled={isSaving}` is the author's, so it lives in Bun's copy of the controls
  // table — the same byte the engine obeys, read at submit rather than at build.
  const { ui: u, form } = single("text", field({ kind: "text", signal: signal("x"), row: 3 }));

  expect(formPayload(u, form)).toEqual({ a: "x" });
  u.controls.flags[3] = ControlFlags.DISABLED;
  expect(formPayload(u, form)).toEqual({ a: "" });
});

// ---------------------------------------------------------------------------
// Live state, which arrives as a CHANGE
// ---------------------------------------------------------------------------

test("a checkbox's CHANGE writes its cell", () => {
  const cell = signal(false);
  const { ui: u } = single("boolean", field({ kind: "checkbox", node: 5, signal: cell }));

  expect(applyFieldChange(u, 5, 1)).toBe(true);
  expect(cell.value).toBe(true);
  expect(applyFieldChange(u, 5, 0)).toBe(true);
  expect(cell.value).toBe(false);
  // A node that is not a field is not an error, it is simply not ours.
  expect(applyFieldChange(u, 99, 1)).toBe(false);
});

test("checking a radio clears the rest of its group", () => {
  // The engine reports only the radio that *became* checked — a browser fires no change
  // on the ones it cleared — so the clearing has to happen here or the payload would
  // report two checked radios in one group.
  const pro = signal(true);
  const ent = signal(false);
  const { ui: u, form } = single(
    "one",
    field({ kind: "radio", node: 5, value: "pro", signal: pro }),
    field({ kind: "radio", node: 6, value: "ent", signal: ent }),
  );

  applyFieldChange(u, 6, 1);
  expect([pro.value, ent.value]).toEqual([false, true]);
  expect(formPayload(u, form)).toEqual({ a: "ent" });
});

test("a select's CHANGE carries the index, a list box's the set", () => {
  const dropdown = signal(0);
  const listbox = signal<number[]>([]);
  const { ui: u } = ui({
    fields: [
      field({ kind: "select", node: 5, options: ["a", "b"], signal: dropdown }),
      field({ kind: "selectMultiple", node: 6, options: ["a", "b", "c"], signal: listbox }),
    ],
    keys: [],
  } as unknown as FormBinding);

  applyFieldChange(u, 5, 1);
  expect(dropdown.value).toBe(1);

  // A set cannot ride in one integer, so it arrives beside the event — and is copied,
  // because the drained array is reused by the next event.
  const drained = [0, 2];
  applyFieldChange(u, 6, 0, drained);
  drained[0] = 99;
  expect(listbox.value).toEqual([0, 2]);
});

// ---------------------------------------------------------------------------
// validate — three shapes, one issue type
// ---------------------------------------------------------------------------

test("a plain function validates, and its issues come through", () => {
  const ok = validatePayload((d: { age: number }) => (d.age < 18 ? [{ path: ["age"], message: "too young" }] : null), {
    age: 31,
  });
  expect(ok).toEqual({ ok: true, value: { age: 31 } });

  const bad = validatePayload(
    (d: { age: number }) => (d.age < 18 ? [{ path: ["age"], message: "too young" }] : null),
    { age: 3 },
  );
  expect(bad).toEqual({ ok: false, issues: [{ path: ["age"], message: "too young" }] });
});

test("an empty issue list is a pass, not a failure", () => {
  expect(validatePayload(() => [], { a: "x" })).toEqual({ ok: true, value: { a: "x" } });
});

test("a Zod schema validates through ~standard, with no import of zod here", () => {
  // Zod 4 carries `~standard` natively (measured), so this is the interop spec doing the
  // work rather than a Zod-shaped branch in `forms.ts` — which has no mention of zod.
  const Login = z.object({ email: z.string().min(3), age: z.number().min(18) });

  expect(validatePayload(Login, { email: "a@b.co", age: 31 })).toEqual({
    ok: true,
    value: { email: "a@b.co", age: 31 },
  });

  const bad = validatePayload(Login, { email: "x", age: 3 });
  expect(bad).toMatchObject({ ok: false });
  if (bad instanceof Promise || bad.ok) throw new Error("expected a synchronous failure");
  expect(bad.issues.map((i) => i.path)).toEqual([["email"], ["age"]]);
  expect(bad.issues.every((i) => typeof i.message === "string")).toBe(true);
});

test("a schema narrows what onSubmit receives, rather than passing the payload through", () => {
  // The point of validating with a schema: the payload's string goes in, the schema's
  // output comes out. Everything a form collects is a string or a boolean, so a schema is
  // the only place a `Date` or a branded id can come from.
  const When = z.object({ at: z.coerce.date() });
  const out = validatePayload(When, { at: "2026-08-11" });
  if (out instanceof Promise || !out.ok) throw new Error("expected a synchronous pass");
  expect((out.value as { at: Date }).at instanceof Date).toBe(true);
});

test("a raw Effect schema validates, unwrapped", async () => {
  // Measured on effect 3.22: a `Schema.Struct` does **not** carry `~standard`, so this is
  // the branch that exists for it — recognised by its `ast`, converted with Effect's own
  // `standardSchemaV1` after a lazy import. Asynchronous only because of that import.
  const Login = Schema.Struct({ email: Schema.String, age: Schema.Number });

  expect(await validatePayload(Login, { email: "a@b.co", age: 31 })).toEqual({
    ok: true,
    value: { email: "a@b.co", age: 31 },
  });

  const bad = await validatePayload(Login, { email: 1, age: "x" });
  expect(bad.ok).toBe(false);
  if (bad.ok) throw new Error("unreachable");
  // Every issue, not just the first — which is what `standardSchemaV1` gives and what an
  // error summary needs.
  expect(bad.issues.map((i) => i.path)).toEqual([["email"], ["age"]]);
});

test("an Effect schema wrapped by hand takes the synchronous path", async () => {
  // The wrap is the documented way to keep a submit synchronous with Effect, and it has
  // to reach the same verdict as the unwrapped schema above.
  const Login = Schema.standardSchemaV1(Schema.Struct({ email: Schema.String }));
  const out = validatePayload(Login, { email: "a@b.co" });
  expect(out).not.toBeInstanceOf(Promise);
  expect(out).toEqual({ ok: true, value: { email: "a@b.co" } });
});

test("an async validator is awaited rather than mistaken for a pass", async () => {
  const slow = async (d: { a: string }) =>
    d.a === "" ? [{ path: ["a"], message: "required" }] : null;
  const out = validatePayload(slow, { a: "" });
  expect(out).toBeInstanceOf(Promise);
  expect(await out).toEqual({ ok: false, issues: [{ path: ["a"], message: "required" }] });
});

test("something that is not a validator is refused rather than skipped", () => {
  // Silently submitting unvalidated data under a `validate` prop the author believes is
  // running is the one failure mode worth being loud about.
  expect(() => validatePayload({ nope: true }, {})).toThrow(/neither a function/);
});

// ---------------------------------------------------------------------------
// The submitter, which is the one entry the markup does not decide
// ---------------------------------------------------------------------------

test("a named submit button contributes only when it is the button that submitted", () => {
  const { ui: u, form } = ui({
    fields: [
      field({ kind: "text", node: 2, signal: signal("x") }),
      field({ kind: "submitter", node: 3, value: "first" }),
      field({ kind: "submitter", node: 4, value: "second" }),
    ],
    keys: [
      { path: ["a"], shape: "text", fields: Int32Array.from([0]) },
      { path: ["btn"], shape: "one", fields: Int32Array.from([1, 2]) },
    ],
  } as unknown as FormBinding);

  // Measured: `submitter = the first button -> btn="first" a="x"`, and the last one gives
  // `btn="second"`. Two buttons sharing a name never both contribute, because only one of
  // them can be the one that was pressed.
  expect(formPayload(u, form, 3)).toEqual({ a: "x", btn: "first" });
  expect(formPayload(u, form, 4)).toEqual({ a: "x", btn: "second" });

  // Enter with no button to click — the `direct` case — submits with no entry for either.
  expect(formPayload(u, form, -1)).toEqual({ a: "x", btn: undefined });
});

test("a submitter with a name and no value contributes the empty string", () => {
  // Measured: `submitter: name, no value -> a="x" c=""`. Not `"on"` — that default belongs
  // to a checkbox, and giving it to a button would invent a value the markup never had.
  const { ui: u, form } = single("one", field({ kind: "submitter", node: 3, value: "" }));
  expect(formPayload(u, form, 3)).toEqual({ a: "" });
});

// ---------------------------------------------------------------------------
// Error state per wrapper, and the dirty gate that decides who may speak
// ---------------------------------------------------------------------------

/** A form with one wrapper over one text field, spelled the way the emitter spells it. */
function wrapped(path: string[], initial = "") {
  const cell = signal(initial);
  const error = signal(false);
  const message = signal("");
  const binding = {
    node: 1,
    button: -1,
    direct: false,
    validate: null,
    owns: new Int32Array(),
    validateOn: "submit",
    fields: [field({ kind: "text", node: 2, signal: cell, initial })],
    keys: [{ path, shape: "text", fields: Int32Array.from([0]) }],
    groups: [{ node: 3, path, error, message, fields: Int32Array.from([0]) }],
    arrays: [],
  } as unknown as FormBinding;
  return { form: binding, cell, error, message };
}

test("an issue lights up the wrapper whose path is a prefix of it", () => {
  const { form, error, message } = wrapped(["position"]);
  applyIssues(form, [{ path: ["position", "x"], message: "x is required" }], true);
  expect(error.value).toBe(true);
  expect(message.value).toBe("x is required");
});

test("an issue elsewhere leaves a wrapper alone", () => {
  const { form, error } = wrapped(["position"]);
  applyIssues(form, [{ path: ["email"], message: "nope" }], true);
  expect(error.value).toBe(false);
});

test("a valid payload clears the wrapper", () => {
  const { form, error, message } = wrapped(["email"]);
  applyIssues(form, [{ path: ["email"], message: "bad" }], true);
  expect(error.value).toBe(true);
  applyIssues(form, [], true);
  expect(error.value).toBe(false);
  expect(message.value).toBe("");
});

test("before a submit, only a field that has moved may show its error", () => {
  // The gate other libraries store as `touched`, done with no state at all: the initial is a
  // constant the compiler baked in, so this is a comparison.
  const { form, cell, error } = wrapped(["email"], "start");
  const issues = [{ path: ["email"], message: "bad" }];

  applyIssues(form, issues, false);
  expect(error.value).toBe(false);

  cell.value = "typed";
  applyIssues(form, issues, false);
  expect(error.value).toBe(true);

  // Back to the value it was compiled with, so it is clean again — this is deliberately
  // *not* the sticky "has been modified" flag TanStack calls `isDirty`.
  cell.value = "start";
  applyIssues(form, issues, false);
  expect(error.value).toBe(false);

  // And after a submit has been attempted, the gate is gone: the user has asked.
  applyIssues(form, issues, true);
  expect(error.value).toBe(true);
});

test("applyIssues reports whether anything moved", () => {
  const { form } = wrapped(["email"]);
  const issues = [{ path: ["email"], message: "bad" }];
  expect(applyIssues(form, issues, true)).toBe(true);
  // Same issues again: nothing to write, so nothing to commit.
  expect(applyIssues(form, issues, true)).toBe(false);
});

// ---------------------------------------------------------------------------
// The nested payload
// ---------------------------------------------------------------------------

test("a payload nests by path, and two groups do not collide", () => {
  const x = signal("1");
  const y = signal("2");
  const name = signal("Med");
  const binding = {
    node: 1,
    button: -1,
    direct: false,
    validate: null,
    owns: new Int32Array(),
    validateOn: "submit",
    groups: [],
    arrays: [],
    fields: [
      field({ kind: "text", node: 2, signal: name }),
      field({ kind: "text", node: 3, signal: x }),
      field({ kind: "text", node: 4, signal: y }),
    ],
    keys: [
      { path: ["name"], shape: "text", fields: Int32Array.from([0]) },
      { path: ["position", "x"], shape: "text", fields: Int32Array.from([1]) },
      { path: ["position", "y"], shape: "text", fields: Int32Array.from([2]) },
    ],
  } as unknown as FormBinding;

  const u = { forms: [binding], controls: { count: 0, flags: new Uint8Array(8) } } as unknown as CompiledUi;
  expect(formPayload(u, binding)).toEqual({ name: "Med", position: { x: "1", y: "2" } });
});

test("the same leaf name under two groups stays two values", () => {
  // The collision a flat form has and a namespace does not.
  const a = signal("1");
  const b = signal("2");
  const binding = {
    node: 1, button: -1, direct: false, validate: null, owns: new Int32Array(),
    validateOn: "submit", groups: [], arrays: [],
    fields: [field({ kind: "text", node: 2, signal: a }), field({ kind: "text", node: 3, signal: b })],
    keys: [
      { path: ["position", "x"], shape: "text", fields: Int32Array.from([0]) },
      { path: ["size", "x"], shape: "text", fields: Int32Array.from([1]) },
    ],
  } as unknown as FormBinding;

  const u = { forms: [binding], controls: { count: 0, flags: new Uint8Array(8) } } as unknown as CompiledUi;
  expect(formPayload(u, binding)).toEqual({ position: { x: "1" }, size: { x: "2" } });
});
