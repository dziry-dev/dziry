/** @jsxImportSource . */

/**
 * A `<form>`, end to end: authored JSX → emitted artifact → a payload in a handler.
 *
 * The unit tests either side of this one each assert half. `fields.test.ts` asserts the
 * table the compiler builds, and `runtime/forms.test.ts` asserts the payload built from a
 * hand-written table of the same shape — which is exactly the pair that can both pass while
 * the emitted module in between says something else. Two tables agreeing about a shape
 * neither of them writes to disk is the failure this file exists to catch.
 *
 * So this one **writes the artifact and imports it**, then submits it the way the worker
 * does. What that covers and nothing else does: the emitter's field syntax parses, the
 * declared cells are in scope where the forms table names them, `signal` is imported when
 * a cell needs it, and the whole chain from `name="email"` to `data.email` holds.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileTree, emit, type CompileResult } from "./compile.ts";
import { jsx, toDocument } from "./jsx-runtime.ts";
import { buildRefIndex, resolveRefs } from "./resolve-refs.ts";
import { compileVariants, findToggles, type VariantCompiled } from "./variant-compile.ts";
import { setCompiling, signal } from "../runtime/signal.ts";
import { submitForm } from "../runtime/bindings.ts";
import { applyFieldChange } from "../runtime/forms.ts";
import { typeInto } from "../runtime/bindings.ts";
import {
  applyRowValidity,
  typeIntoRow,
  updateList,
  type ListBindingRef,
} from "../runtime/list-runtime.ts";
import { ControlFlags, type CompiledUi } from "../ir.ts";
import type { EditableRef } from "../runtime/bindings.ts";
import type { StylePatchRef } from "../runtime/patches.ts";

/**
 * The artifact's shape, which is `CompiledUi` plus the tables the *host* wires up.
 *
 * `editables` is one of those: the worker reads it from the module and hands it to
 * `typeInto`, so it is an export of the artifact rather than a field of the IR.
 */
type Artifact = CompiledUi & {
  editables: EditableRef[];
  stylePatches: StylePatchRef[];
  listBindings: ListBindingRef[];
};

/**
 * Compiles a tree, resolves its references, emits the module, and imports it.
 *
 * `exports` is what the app's state module would export — the handlers and schemas the
 * artifact imports by name. It is written to disk beside the artifact for the same reason
 * the artifact is: an import specifier has to resolve.
 */
async function artifact(
  tree: () => unknown,
  exports: Record<string, unknown> = {},
  css = ``,
): Promise<{ ui: Artifact; dir: string }> {
  setCompiling(true);
  let result: CompileResult;
  let variants: VariantCompiled | undefined;
  try {
    const doc = toDocument(tree() as never);
    result = compileTree(doc, css);
    // The variant pass, because a `field` wrapper's `errorClassName` *is* a conditional
    // class — so without this the error patches would not exist and the styling half of the
    // feature would be untested.
    const toggles = findToggles(doc);
    if (toggles.length > 0) variants = await compileVariants(doc, css, result, toggles);
  } finally {
    setCompiling(false);
  }

  const dir = await mkdtemp(join(tmpdir(), "dziri-form-"));
  const specifier = `./state.ts`;
  const { imports } = resolveRefs(result, buildRefIndex([{ specifier, exports }]), variants);

  // The state module has to be *the same objects*, so it re-exports a global the test
  // filled — a fresh module evaluated by `import()` would give the artifact a different
  // handler than the one this test is holding.
  (globalThis as Record<string, unknown>).__formTestExports = exports;
  await writeFile(
    join(dir, "state.ts"),
    Object.keys(exports)
      .map((name) => `export const ${name} = (globalThis as any).__formTestExports[${JSON.stringify(name)}];`)
      .join("\n") || "export {};",
  );

  const source = emit(result, { html: "test", css: "none", typesFrom: PACKAGE_ROOT }, imports, variants).source;
  await writeFile(join(dir, "ui.gen.ts"), source);

  const module = (await import(join(dir, "ui.gen.ts"))) as unknown as Artifact;
  // A shallow copy, because a module namespace object's exports are **readonly** and the
  // runtime reassigns some of the tables — `ui.interactive`, `ui.tabStops` — when a list
  // arena grows. The host does the same thing for the same reason (`buildUi`), so copying
  // here is fidelity rather than a test convenience: asserting against the namespace would
  // pass for everything except growth and then throw where the real host does not.
  return { ui: { ...module }, dir };
}

/**
 * Where the emitted module finds `ir.ts` and the runtime from a temp directory.
 *
 * An absolute path rather than the bare `dziri` specifier the real build uses, because the
 * artifact is written outside the project and a bare specifier would resolve against the
 * temp directory's (absent) `node_modules`.
 */
const PACKAGE_ROOT = join(import.meta.dir, "..").replaceAll("\\", "/");

test("a browser-shaped form submits a payload with no state module at all", async () => {
  let seen: unknown = null;
  const save = (data: unknown) => (seen = data);

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save}>
        <input name="email" value="a@b.co" />
        <input name="age" type="number" value="31" />
        <input name="terms" type="checkbox" checked />
        <input name="plan" type="radio" value="pro" />
        <input name="plan" type="radio" value="ent" checked />
        <select name="colour">
          <option value="red">red</option>
          <option value="green" selected>
            green
          </option>
        </select>
        <textarea name="bio">hello</textarea>
        <button type="submit">Save</button>
      </form>
    ),
    { save },
  );

  const form = ui.forms[0]!;
  expect(form.keys.map((k) => [k.path.join("."), k.shape])).toEqual([
    ["email", "text"],
    ["age", "number"],
    ["terms", "boolean"],
    ["plan", "one"],
    ["colour", "text"],
    ["bio", "text"],
  ]);

  // Submitted through the same call the worker makes for a press on the button.
  expect(submitForm(ui, form.node, form.button)).toBe(true);
  expect(seen).toEqual({
    email: "a@b.co",
    age: 31,
    terms: true,
    plan: "ent",
    colour: "green",
    bio: "hello",
  });

  await rm(dir, { recursive: true, force: true });
});

test("typing into a named field changes what it submits and what it draws", async () => {
  let seen: unknown = null;
  const save = (data: unknown) => (seen = data);

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save}>
        <input name="email" />
        <button type="submit">Save</button>
      </form>
    ),
    { save },
  );

  // The field is in `editables` under the cell the compiler declared, which is what makes
  // a keystroke reach it — the same table a `bind:value` field lands in.
  const editable = ui.editables[0]!;
  expect(typeInto(ui.editables, editable.node, { text: "hi@there.co" })).toBe(true);

  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  expect(seen).toEqual({ email: "hi@there.co" });

  // And it draws: the run bound to that cell holds the typed string, so the field shows
  // what was typed rather than staying visibly empty.
  const { textBindings, strings } = ui;
  const run = textBindings.find((b) => b.parts.length === 1)!;
  const part = run.parts[0]!;
  if (!("signal" in part)) throw new Error("the field's run is a literal, not a binding");
  expect(String(part.signal.value)).toBe("hi@there.co");
  expect(strings.length).toBeGreaterThan(run.slot);

  await rm(dir, { recursive: true, force: true });
});

test("a checkbox the user ticks is in the next payload", async () => {
  let seen: unknown = null;
  const save = (data: unknown) => (seen = data);

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save}>
        <input name="terms" type="checkbox" />
        <button type="submit">Save</button>
      </form>
    ),
    { save },
  );

  const form = ui.forms[0]!;
  submitForm(ui, form.node, form.button);
  expect(seen).toEqual({ terms: false });

  // What the engine sends when a press ticks the box, routed exactly as `worker.ts` routes
  // it. Checkedness is the engine's, so this event is the only way Bun learns it.
  applyFieldChange(ui, form.fields[0]!.node, 1);
  submitForm(ui, form.node, form.button);
  expect(seen).toEqual({ terms: true });

  await rm(dir, { recursive: true, force: true });
});

test("a bind:value field keeps the author's signal, and the payload reads it", async () => {
  let seen: unknown = null;
  const save = (data: unknown) => (seen = data);
  const draft = signal("typed by the author");

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save}>
        <input name="email" bind:value={draft} />
        <button type="submit">Save</button>
      </form>
    ),
    { save, draft },
  );

  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  expect(seen).toEqual({ email: "typed by the author" });

  // The *same* signal, not a copy — which is the whole reason a bound field does not also
  // get a cell: two cells for one field could disagree.
  draft.value = "changed";
  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  expect(seen).toEqual({ email: "changed" });

  await rm(dir, { recursive: true, force: true });
});

test("validate runs against the payload, and onSubmit sees the schema's output", async () => {
  const seen: unknown[] = [];
  const save = (data: unknown) => seen.push({ ok: data });
  const oops = (issues: unknown) => seen.push({ no: issues });
  const Login = (data: { email: string }) =>
    data.email.includes("@") ? null : [{ path: ["email"], message: "not an email" }];

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save} onInvalid={oops} validate={Login}>
        <input name="email" value="nope" />
        <button type="submit">Save</button>
      </form>
    ),
    { save, oops, Login },
  );

  const form = ui.forms[0]!;
  // The schema reached the artifact as an import, which is the half a hand-built table
  // cannot check: `validate` is a reference like any other and has to resolve to a name.
  expect(form.validate).toBe(Login);

  submitForm(ui, form.node, form.button);
  expect(seen).toEqual([{ no: [{ path: ["email"], message: "not an email" }] }]);

  typeInto(ui.editables, form.fields[0]!.node, { text: "@x.co" });
  submitForm(ui, form.node, form.button);
  expect(seen[1]).toEqual({ ok: { email: "nope@x.co" } });

  await rm(dir, { recursive: true, force: true });
});

test("a named submit button reaches the payload, and only when it is the one pressed", async () => {
  let seen: unknown = null;
  const save = (data: unknown) => (seen = data);

  // This is also the case that first *emitted* a submitter, and it caught a crash the unit
  // tests could not: a submitter has no cell, so the emitter had no name to resolve and
  // `identifier("")` refused it — the build would have failed from inside the emitter,
  // pointing at generated code. Every earlier test used an unnamed button, which is not one.
  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save}>
        <input name="email" value="a@b.co" />
        <button type="submit" name="action" value="draft">
          Save draft
        </button>
        <button type="submit" name="action" value="publish">
          Publish
        </button>
      </form>
    ),
    { save },
  );

  const form = ui.forms[0]!;
  // Two buttons sharing a name are one value, because only one can be pressed.
  expect(form.keys.map((k) => [k.path.join("."), k.shape])).toEqual([
    ["email", "text"],
    ["action", "one"],
  ]);

  const [draft, publish] = form.fields.filter((f) => f.kind === "submitter");
  submitForm(ui, form.node, draft!.node);
  expect(seen).toEqual({ email: "a@b.co", action: "draft" });

  submitForm(ui, form.node, publish!.node);
  expect(seen).toEqual({ email: "a@b.co", action: "publish" });

  // The default button is the first in document order, so that is what Enter presses.
  expect(form.button).toBe(draft!.node);

  await rm(dir, { recursive: true, force: true });
});

test("a form= field outside the form is compiled into it, end to end", async () => {
  let seen: unknown = null;
  const save = (data: unknown) => (seen = data);

  const { ui, dir } = await artifact(
    () => (
      <div>
        <form id="login" onSubmit={save}>
          <input name="email" value="a@b.co" />
          <button type="submit">Sign in</button>
        </form>
        <input name="remember" type="checkbox" checked form="login" />
      </div>
    ),
    { save },
  );

  const form = ui.forms[0]!;
  submitForm(ui, form.node, form.button);
  // The checkbox is a sibling of the form, not a descendant — ownership put it in.
  expect(seen).toEqual({ email: "a@b.co", remember: true });

  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `field` wrappers: nesting, error state, and the message
// ---------------------------------------------------------------------------

test("a field wrapper namespaces the payload, and nests structurally", async () => {
  let seen: unknown = null;
  const save = (data: unknown) => (seen = data);

  // The shape from the design discussion, verbatim: a wrapper holding one bare control *is*
  // that field, and a wrapper holding named controls makes them its properties.
  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save}>
        <div field="name">
          <input type="text" value="Med" />
        </div>
        <div field="position">
          <input type="text" name="x" value="1" />
          <input type="text" name="y" value="2" />
        </div>
        <div field="address">
          <div field="city">
            <input type="text" value="Alger" />
          </div>
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save },
  );

  const form = ui.forms[0]!;
  expect(form.keys.map((k) => k.path)).toEqual([
    ["name"],
    ["position", "x"],
    ["position", "y"],
    ["address", "city"],
  ]);

  submitForm(ui, form.node, form.button);
  expect(seen).toEqual({
    name: "Med",
    position: { x: "1", y: "2" },
    address: { city: "Alger" },
  });

  await rm(dir, { recursive: true, force: true });
});

test("an issue lights up its wrapper and every wrapper above it", async () => {
  const save = () => {};
  // Fails on `position.x`, so the `position` wrapper is in error *and* so is the nested `x`
  // one — a prefix match, which is what lets a group and its members both be styled.
  const check = (d: { position: { x: string } }) =>
    d.position.x === "" ? [{ path: ["position", "x"], message: "x is required" }] : null;

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save} validate={check}>
        <div field="name" errorClassName="group/error">
          <input type="text" value="Med" />
          <span error />
        </div>
        <div field="position" errorClassName="group/error">
          <div field="x" errorClassName="group/error">
            <input type="text" />
            <span error />
          </div>
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save, check },
  );

  const form = ui.forms[0]!;
  const byPath = new Map(form.groups.map((g) => [g.path.join("."), g]));
  expect([...byPath.keys()]).toEqual(["name", "position", "position.x"]);

  // Nothing is in error before a submit.
  expect(byPath.get("position")!.error.value).toBe(false);

  submitForm(ui, form.node, form.button);

  expect(byPath.get("position")!.error.value).toBe(true);
  expect(byPath.get("position.x")!.error.value).toBe(true);
  // The unrelated wrapper stays quiet, which is the whole point of the prefix rule.
  expect(byPath.get("name")!.error.value).toBe(false);

  // The message reaches the cell the `<span error />` run is bound to. `messages[0]` because a
  // wrapper can carry several markers now — a bare one plus a named one per leaf — and a bare
  // marker is simply the entry whose path is the wrapper''s own.
  expect(byPath.get("position.x")!.messages[0]!.cell.value).toBe("x is required");
  expect(byPath.get("name")!.messages[0]!.cell.value).toBe("");

  await rm(dir, { recursive: true, force: true });
});

test("the error class becomes a style patch, so the wrapper's subtree restyles", async () => {
  const save = () => {};
  const check = () => [{ path: ["email"], message: "no" }];

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save} validate={check}>
        <div field="email" errorClassName="invalid">
          <input className="fld" />
          <span error className="note" />
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save, check },
    // The wrapper's class reaches the input and the message, which is what makes the whole
    // error story CSS rather than JS.
    `.invalid .fld { border-top-color: #ff0000 } .note { display: none } .invalid .note { display: block }`,
  );

  expect(ui.stylePatches.length).toBe(1);
  const patch = ui.stylePatches[0]!;
  expect(patch.entries.map((e) => e.field).sort()).toEqual(["borderTopColor", "display"]);
  // The signal driving it is the wrapper's own error cell, so two wrappers cannot share it.
  expect(patch.signal.value).toBe(false);

  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  expect(patch.signal.value).toBe(true);

  await rm(dir, { recursive: true, force: true });
});

/**
 * Several `error` markers under one wrapper, dividing that wrapper's complaints by name.
 *
 * The end-to-end half of the feature, and worth having here rather than only in `fields.test.ts`:
 * a marker's cell is declared by the emitted module and its run is created bound to it, so a
 * name that resolved correctly at compile time can still reach the wrong span on disk.
 */
test("named error markers divide a group's messages, and nothing is said twice", async () => {
  const save = () => {};
  type Address = { street: string; city: string };
  const check = (data: { address: Address }) => {
    const issues: { path: (string | number)[]; message: string }[] = [];
    if (data.address.street === "") issues.push({ path: ["address", "street"], message: "street?" });
    if (data.address.city === "") issues.push({ path: ["address", "city"], message: "city?" });
    if (data.address.street !== "" && data.address.street === data.address.city) {
      issues.push({ path: ["address"], message: "not the same" });
    }
    return issues.length === 0 ? null : issues;
  };

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save} validate={check}>
        <div field="address">
          <input name="street" />
          <span error="street" />
          <input name="city" />
          <span error="city" />
          <span error />
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save, check },
  );

  const group = ui.forms[0]!.groups[0]!;
  const said = () =>
    Object.fromEntries(group.messages.map((m) => [m.path.join("."), m.cell.value]));

  // Relative to the wrapper, so the markers name `street` and the paths come out absolute.
  expect(group.messages.map((m) => m.path.join("."))).toEqual([
    "address.street",
    "address.city",
    "address",
  ]);

  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  // Each leaf's complaint beside that leaf — and the bare marker silent, because both issues
  // belong to something more specific than the wrapper.
  expect(said()).toEqual({
    "address.street": "street?",
    "address.city": "city?",
    address: "",
  });

  const cellOf = (path: string) =>
    ui.forms[0]!.fields[ui.forms[0]!.keys.find((k) => k.path.join(".") === path)!.fields[0]!]!
      .signal as { value: string };
  cellOf("address.street").value = "Same";
  cellOf("address.city").value = "Same";
  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);

  // Now the leaves are clean and the group has something only it can say.
  expect(said()).toEqual({
    "address.street": "",
    "address.city": "",
    address: "not the same",
  });

  await rm(dir, { recursive: true, force: true });
});

/** A tree compiled with recording on, for the cases that are about *diagnostics*. */
function build(tree: () => unknown, css = ``): CompileResult {
  setCompiling(true);
  try {
    return compileTree(toDocument(tree() as never), css);
  } finally {
    setCompiling(false);
  }
}

test("the ways a repeating section can be written wrong are all reported", () => {
  const save = () => {};
  // Annotated at every `map` below, and that is the API rather than these tests: `map`'s
  // `Item` is a free generic, so it is inferred from the callback rather than from the
  // signal's element type. Every list in `windows/` annotates for the same reason.
  type Titled = { id: number; title: string };
  type Named = { id: number; name: string };
  const jobs = signal<Titled[]>([{ id: 1, title: "" }]);
  const other = signal<Named[]>([{ id: 1, name: "" }]);

  // Two lists under one wrapper: one key, two arrays. Reported rather than resolved, because
  // taking the first silently drops every row of the second.
  const twoLists = build(() => (
    <form onSubmit={save}>
      <div field="experience">
        {jobs.map((job: Titled) => <div>{job.title}</div>, { key: (job: Titled) => job.id })}
        {other.map((row: Named) => <div>{row.name}</div>, { key: (row: Named) => row.id })}
      </div>
    </form>
  ));
  expect(twoLists.warnings.some((w) => w.includes("cannot hold two arrays"))).toBe(true);

  // A named control beside the list, which asks the same key to be an array and an object.
  const alsoAField = build(() => (
    <form onSubmit={save}>
      <div field="experience">
        {jobs.map((job: Titled) => <div>{job.title}</div>, { key: (job: Titled) => job.id })}
        <input name="note" />
      </div>
    </form>
  ));
  expect(
    alsoAField.warnings.some((w) => w.includes("both a map() list and a field")),
  ).toBe(true);

  // A `bind:value` given something that is neither a signal nor a row's property. The prop's
  // type admits a bare string so that `bind:value={job.title}` can compile, and this is the
  // refusal that pays for the widening.
  const literal = build(() => <input bind:value="hello" />);
  expect(literal.warnings.some((w) => w.includes("not a signal"))).toBe(true);
  expect(literal.editables.length).toBe(0);

  // And the wrapper on its own is fine — one list, nothing beside it.
  const clean = build(() => (
    <form onSubmit={save}>
      <div field="experience">
        {jobs.map((job: Titled) => <div><input bind:value={job.title} /></div>, {
          key: (job: Titled) => job.id,
        })}
      </div>
    </form>
  ));
  expect(clean.warnings.filter((w) => w.includes("map()"))).toEqual([]);
});

/**
 * Repeating rows, which is the one field whose value the compiler does not own.
 *
 * Worth an end-to-end test more than any other kind is: the three halves are in three files
 * — `fields.ts` finds the list, `compile.ts` lifts the per-row bindings out of the template,
 * and `list-runtime.ts` writes back into the array — and each of them can be right about a
 * shape the other two spell differently. Only the emitted module says whether they agree.
 */
test("a map() inside a field wrapper submits its rows as an array", async () => {
  let seen: unknown = null;
  const save = (data: unknown) => (seen = data);
  type Job = { id: number; title: string; start: string; end: string };
  const jobs = signal<Job[]>([
    { id: 1, title: "cook", start: "2019", end: "2021" },
    { id: 2, title: "clerk", start: "2021", end: "" },
  ]);

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save}>
        <div field="experience">
          {jobs.map(
            (job) => (
              <div>
                <input bind:value={job.title} />
                <input bind:value={job.start} />
              </div>
            ),
            { key: (job: Job) => job.id },
          )}
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save, jobs },
  );

  const form = ui.forms[0]!;
  // No `keys` entry and no `fields`: a row's controls are in an arena, so there is no cell
  // for the payload to read. The array is the entry.
  expect(form.keys.length).toBe(0);
  expect(form.arrays.map((a) => a.path.join("."))).toEqual(["experience"]);

  submitForm(ui, form.node, form.button);
  expect(seen).toEqual({
    experience: [
      { id: 1, title: "cook", start: "2019", end: "2021" },
      { id: 2, title: "clerk", start: "2021", end: "" },
    ],
  });

  // Adding a row is a plain `signal.set` — no form API, and nothing recompiled.
  jobs.set((rows) => [...rows, { id: 3, title: "cabbie", start: "2024", end: "" }]);
  submitForm(ui, form.node, form.button);
  expect((seen as { experience: unknown[] }).experience.length).toBe(3);

  // The payload is a copy, so a handler that kept it does not watch it change underneath.
  const kept = (seen as { experience: unknown[] }).experience;
  jobs.set((rows) => rows.slice(0, 1));
  expect(kept.length).toBe(3);

  await rm(dir, { recursive: true, force: true });
});

test("typing in a row writes into that row, and the others are untouched", async () => {
  let seen: unknown = null;
  const save = (data: unknown) => (seen = data);
  type Job = { id: number; title: string };
  const jobs = signal<Job[]>([
    { id: 1, title: "cook" },
    { id: 2, title: "clerk" },
  ]);

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save}>
        <div field="experience">
          {jobs.map((job) => <div><input bind:value={job.title} /></div>, {
            key: (job: Job) => job.id,
          })}
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save, jobs },
  );

  const list = ui.listBindings[0]!;
  // Slots have to be assigned before a row can be typed into: which item a slot renders is
  // what turns a node back into an index, and that is `updateList`'s answer.
  updateList(ui, list);

  const { arenaStart, stride } = { arenaStart: ui.lists.arenaStart[0]!, stride: ui.lists.stride[0]! };
  const editable = list.itemEditables[0]!;
  const rowOne = arenaStart + stride + editable.offset;

  // A row's input is in *no* `editables` table — that is the whole reason `typeIntoRow`
  // exists, and asserting it here is what stops a future refactor from quietly making the
  // ordinary path answer for rows with row 0's target.
  expect(ui.editables.some((e) => e.node === rowOne)).toBe(false);
  expect(typeInto(ui.editables, rowOne, { text: "!" })).toBe(false);

  expect(typeIntoRow(ui, ui.listBindings, rowOne, { text: "!", caret: 5 })).toBe(true);
  expect(jobs.value.map((j) => j.title)).toEqual(["cook", "clerk!"]);
  // The item was replaced rather than mutated, which is what makes the signal publish.
  expect(jobs.value[0]!.id).toBe(1);

  // And it renders: the row's bound slot is refreshed from the same path it was bound by.
  updateList(ui, list);
  const slot = list.slotStart + 1 * list.slotsPerItem + list.bindings[0]!.slotOffset;
  expect(ui.strings[slot]).toBe("clerk!");

  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  expect(seen).toEqual({ experience: [{ id: 1, title: "cook" }, { id: 2, title: "clerk!" }] });

  await rm(dir, { recursive: true, force: true });
});

/**
 * The row past the compiled capacity, which is where a form list would have quietly broken.
 *
 * An arena is `capacity` replicas and growth appends a *larger* one, copying the nodes. Every
 * side table keyed by node id had to be extended alongside — variants and the interactive set
 * already were; the controls table and the tab-stop set were not, so a row past the capacity
 * drew perfectly, refused focus, and emitted no `CHANGE`. Invisible in a list, fatal in a
 * form: the author adding a ninth job has no way to know where the eighth boundary fell.
 */
test("a row added past the compiled capacity is still a real control", async () => {
  const save = () => {};
  type Job = { id: number; title: string; done: boolean };
  const jobs = signal<Job[]>([{ id: 1, title: "cook", done: false }]);

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save}>
        <div field="experience">
          {jobs.map(
            (job) => (
              <div>
                <input bind:value={job.title} />
                <input type="checkbox" />
              </div>
            ),
            // One slot, so the second row has to grow the arena. The default is
            // `max(8, items * 2)`, which would hide this behind eight passing rows.
            { key: (job: Job) => job.id, capacity: 1 },
          )}
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save, jobs },
  );

  const list = ui.listBindings[0]!;
  updateList(ui, list);

  const before = {
    controls: ui.controls.count,
    tabStops: ui.tabStops.length,
    capacity: ui.lists.capacity[0]!,
  };
  expect(before.capacity).toBe(1);

  jobs.set((rows) => [...rows, { id: 2, title: "clerk", done: false }]);
  updateList(ui, list);
  expect(ui.lists.capacity[0]!).toBeGreaterThan(1);

  // The second row's own nodes, in the arena the growth allocated.
  const arenaStart = ui.lists.arenaStart[0]!;
  const stride = ui.lists.stride[0]!;
  const rowOne = arenaStart + stride;

  expect(ui.controls.count).toBeGreaterThan(before.controls);
  expect(ui.tabStops.length).toBeGreaterThan(before.tabStops);

  // Sorted, which the engine's binary search over both tables requires. Appending keeps it
  // that way only because a grown arena starts past every existing node id.
  const controlNodes = [...ui.controls.node.subarray(0, ui.controls.count)];
  expect([...controlNodes].sort((a, b) => a - b)).toEqual(controlNodes);
  expect([...ui.tabStops].sort((a, b) => a - b)).toEqual([...ui.tabStops]);

  // Every live slot has the control rows and the tab stop its template has — the second row's
  // checkbox is its own row rather than a second reference to the first row's, which is what
  // makes it toggle independently.
  const inSlot = (all: readonly number[], slot: number): number[] =>
    all
      .filter((n) => n >= arenaStart + slot * stride && n < arenaStart + (slot + 1) * stride)
      .map((n) => n - arenaStart - slot * stride);

  expect(inSlot(controlNodes, 1)).toEqual(inSlot(controlNodes, 0));
  expect(inSlot(controlNodes, 0).length).toBeGreaterThan(0);
  expect(inSlot([...ui.tabStops], 1)).toEqual(inSlot([...ui.tabStops], 0));

  // And it can be typed into: the per-row binding is found by offset, so it serves a replica
  // the compiler never saw.
  const editable = list.itemEditables[0]!;
  expect(typeIntoRow(ui, ui.listBindings, rowOne + editable.offset, { text: "!" })).toBe(true);
  expect(jobs.value.map((j) => j.title)).toEqual(["cook", "clerk!"]);

  await rm(dir, { recursive: true, force: true });
});

/**
 * Every replica gets the *flags* its template has, not just its nodes.
 *
 * `::placeholder` was the one still missing. A replica's placeholder box was copied as a
 * generated box but not marked a placeholder, so the engine never applied the "paint it only
 * while the field is empty" test and drew the hint straight over the row's value.
 *
 * It could only ever show up here. Row 0 *is* the template and was always right, so the bug
 * needed a second row that had both text and a placeholder — which is a repeating form row and
 * nothing else, since before per-row binding a row's input could not hold text at all.
 */
test("a row's placeholder is a placeholder in every replica, not just the first", () => {
  type Job = { id: number; title: string };
  const jobs = signal<Job[]>([{ id: 1, title: "cook" }, { id: 2, title: "clerk" }]);
  const result = build(() => (
    <div>
      {jobs.map((job) => <div><input placeholder="title" bind:value={job.title} /></div>, {
        key: (job: Job) => job.id,
      })}
    </div>
  ));

  const list = result.lists[0]!;
  const offsets = (slot: number) =>
    result.nodes
      .map((node, i) => ({ node, i }))
      .filter(
        ({ node, i }) =>
          node.placeholder &&
          i >= list.arenaStart + slot * list.stride &&
          i < list.arenaStart + (slot + 1) * list.stride,
      )
      .map(({ i }) => i - list.arenaStart - slot * list.stride);

  expect(offsets(0).length).toBe(1);
  // Every replica, not just the second — a capacity-8 arena has eight rows to get right.
  for (let slot = 1; slot < list.capacity; slot++) expect(offsets(slot)).toEqual(offsets(0));
});

/**
 * The complaint belongs beside the row that caused it.
 *
 * A `<span error />` in a template is `capacity` spans on screen, so binding it to the
 * section's cell would print one row's problem on every row — which is what a shared cell
 * means. Every replica owns its text slots, so the message is per row; they share a style
 * row, so the *colour* cannot be, and that asymmetry is the whole shape of this feature.
 */
test("a row's message goes in that row, and the section does not repeat it", async () => {
  const save = () => {};
  type Job = { id: number; title: string; start: string };
  const jobs = signal<Job[]>([
    { id: 1, title: "cook", start: "2019" },
    { id: 2, title: "clerk", start: "" },
  ]);
  const check = (data: { experience: Job[] }) => {
    const issues = data.experience.flatMap((row, i) =>
      row.start === "" ? [{ path: ["experience", i, "start"], message: "needs a start" }] : [],
    );
    return data.experience.length === 0
      ? [{ path: ["experience"], message: "add at least one job" }]
      : issues;
  };

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save} validate={check}>
        <div field="experience" errorClassName="bad">
          {jobs.map(
            (job: Job) => (
              <div>
                <input bind:value={job.title} />
                <span error />
              </div>
            ),
            { key: (job: Job) => job.id },
          )}
          <span error />
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save, jobs, check },
    `.bad input { color: red }`,
  );

  const list = ui.listBindings[0]!;
  const array = ui.forms[0]!.arrays[0]!;
  const section = ui.forms[0]!.groups[0]!;
  updateList(ui, list);

  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  updateList(ui, list);

  // Row 1 is the broken one, and row 0 says nothing — the message is indexed by *data*
  // position, not by slot, so a reorder cannot carry it to the wrong row.
  expect(array.rowErrors?.messages).toEqual(["", "needs a start"]);

  const rowText = (slot: number) =>
    list.bindings
      .map((b) => ui.strings[list.slotStart + slot * list.slotsPerItem + b.slotOffset])
      .join("|");
  expect(rowText(0)).toBe("cook|");
  expect(rowText(1)).toBe("clerk|needs a start");

  // The section wears its class — a broken row is still the section's problem — while its own
  // message stays empty, so the complaint is not printed twice.
  expect(section.error.value).toBe(true);
  expect(section.messages[0]!.cell.value).toBe("");

  // An issue at the section's *own* path is the section's to say, and the rows fall silent.
  jobs.set([]);
  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  expect(section.messages[0]!.cell.value).toBe("add at least one job");
  expect(array.rowErrors?.messages).toEqual([]);

  await rm(dir, { recursive: true, force: true });
});

/**
 * `:invalid` on one row's field and not its neighbour's — the thing a class cannot do.
 *
 * Replicas share a **style row**, so a conditional class on a row's input is the same style
 * row every other row reads; they do not share a **control row**, and a predicate is resolved
 * per node against that table. So this is the one mechanism in the engine that can tell two
 * rows apart, which is why validity is a control flag rather than a patch.
 */
test("a row's own field wears :invalid, and its neighbours do not", async () => {
  const save = () => {};
  type Job = { id: number; title: string; start: string };
  const jobs = signal<Job[]>([
    { id: 1, title: "cook", start: "2019" },
    { id: 2, title: "clerk", start: "" },
  ]);
  const check = (data: { experience: Job[] }) =>
    data.experience.flatMap((row, i) =>
      row.start === "" ? [{ path: ["experience", i, "start"], message: "needs a start" }] : [],
    );

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save} validate={check}>
        <div field="experience">
          {jobs.map(
            (job: Job) => (
              <div>
                <input bind:value={job.title} />
                <input bind:value={job.start} />
                <span error />
              </div>
            ),
            { key: (job: Job) => job.id },
          )}
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save, jobs, check },
  );

  const list = ui.listBindings[0]!;
  updateList(ui, list);
  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  applyRowValidity(ui, ui.listBindings, ui.forms[0]!.arrays);

  const start = ui.lists.arenaStart[list.list]!;
  const stride = ui.lists.stride[list.list]!;
  const flagged = (slot: number, path: string) => {
    const editable = list.itemEditables.find((e) => e.path.join(".") === path)!;
    const node = start + slot * stride + editable.offset;
    const row = [...ui.controls.node.subarray(0, ui.controls.count)].indexOf(node);
    // Every text input has a control row now — without one there is nowhere for the bit.
    expect(row).toBeGreaterThanOrEqual(0);
    return (ui.controls.flags[row]! & ControlFlags.INVALID) !== 0;
  };

  expect(flagged(1, "start")).toBe(true);
  expect(flagged(0, "start")).toBe(false);
  // The *field*, not the row: the title beside the offending start is fine.
  expect(flagged(1, "title")).toBe(false);

  // Fixed, and the bit comes back off — a field that could not recover would be a form
  // nobody can satisfy.
  jobs.set(jobs.value.map((j) => (j.id === 2 ? { ...j, start: "2020" } : j)));
  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  applyRowValidity(ui, ui.listBindings, ui.forms[0]!.arrays);
  expect(flagged(1, "start")).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("a row's validation issue lights up the wrapper it is under", async () => {
  const save = () => {};
  let rejected: { path: (string | number)[]; message: string }[] = [];
  const onInvalid = (issues: { path: (string | number)[]; message: string }[]) => {
    rejected = issues;
  };
  type Job = { id: number; title: string };
  const jobs = signal<Job[]>([{ id: 1, title: "" }]);
  // An issue *inside* a row — the wrapper's path is a prefix of it, which is the whole rule.
  const check = (data: { experience: { title: string }[] }) =>
    data.experience[0]!.title === ""
      ? [{ path: ["experience", 0, "title"], message: "what was the job?" }]
      : null;

  const { ui, dir } = await artifact(
    () => (
      <form onSubmit={save} validate={check} onInvalid={onInvalid}>
        <div field="experience" errorClassName="bad">
          {jobs.map((job) => <div><input bind:value={job.title} /></div>, {
            key: (job: Job) => job.id,
          })}
          <span error />
        </div>
        <button type="submit">Save</button>
      </form>
    ),
    { save, jobs, check, onInvalid },
    `.bad input { color: red }`,
  );

  const group = ui.forms[0]!.groups[0]!;
  expect(group.path).toEqual(["experience"]);

  submitForm(ui, ui.forms[0]!.node, ui.forms[0]!.button);
  expect(rejected.map((i) => i.path.join("."))).toEqual(["experience.0.title"]);
  // The wrapper wears its class for an issue three segments deep, because ownership is a
  // prefix test and a numeric segment is just a segment.
  expect(group.error.value).toBe(true);
  expect(group.messages[0]!.cell.value).toBe("what was the job?");

  await rm(dir, { recursive: true, force: true });
});
