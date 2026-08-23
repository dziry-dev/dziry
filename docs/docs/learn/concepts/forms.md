---
title: Forms
sidebar_position: 6
---

# Forms

A form in dziry is markup, CSS and a schema. There is no form library and no
per-field state to manage: the compiler sees the whole form, so it determines
the payload's shape before the app runs.

## A minimal form

```tsx no-check
export function save(data: { email: string }) {
  console.log(data.email);
}

export const SignUp = () => (
  <form onSubmit={save}>
    <input name="email" />
    <button>Sign up</button>
  </form>
);
```

No signal and no state module. `onSubmit` receives an object keyed by each
control's `name`, and pressing Enter in the field submits the same way the
button does.

**Where the value lives:** the compiler declares a cell for every named field
that has no binding, seeded from its `value` attribute (the equivalent of a
browser's default value). That cell cannot be named from outside the generated
module, so form fields never become a second state API — the payload is how
you read them.

To hold a field's value yourself, give it `bind:value` and it uses your signal
instead. A field cannot have both a `name`-declared cell and a binding,
because two cells for one field could disagree.

## Payload types

The compiler knows a checkbox from a number field, so the payload is typed the
way you would have typed it by hand:

| Markup | Payload type |
|---|---|
| `<input name="x">`, `<textarea name="x">` | `string` |
| `<input name="x" type="number">` | `number \| undefined` — never `NaN` |
| `<input name="x" type="checkbox">` | `boolean` |
| `<input name="x" type="radio">` × n | `string \| undefined` — the checked one's `value` |
| `<select name="x">` | `string` |
| `<select name="x" multiple>`, or two controls sharing a name | `string[]` |

Which controls appear in the payload follows the browser's rules: a control
with no name is left out; so is a disabled one, including one disabled through
an enclosing `<fieldset disabled>`; an unticked checkbox contributes nothing;
and an `<option>` with no `value` submits its trimmed text.

The key set never changes shape between submits. Two controls sharing a name
always produce an array — not an array when both are filled and a string when
one is — because the shape is decided at build time, so your schema can rely
on it.

## Groups and nesting

`field` on an element that wraps controls names a **group**:

```tsx no-check
<form onSubmit={save}>
  <div field="name">
    <input />
  </div>
  <div field="position">
    <input name="x" />
    <input name="y" />
  </div>
  <div field="address">
    <div field="city"><input /></div>
  </div>
</form>;
```

produces `{ name: string, position: { x, y }, address: { city } }`.

The rule: **the wrapper chain is the path.** A wrapper holding one bare
control *is* that field. Named controls inside a wrapper become its
properties. Wrappers nest. An element without `field` is transparent, so a
layout `<div>` changes nothing.

A wrapper holding a bare control *and* a named one would need to be a string
and an object at once — that is a build error.

:::note There is no bracket syntax

`name="user[email]"` is the literal key `"user[email]"` everywhere in the web
platform — in `FormData`, in the urlencoded body, in `URLSearchParams`. The
bracket convention belongs to server-side parsers (PHP, Rack, `qs`), each with
its own dialect. dziry nests by structure instead: nothing is parsed at run
time, and a conflicting path is reported at build time.
:::

### Radio groups

A radio set shares a `name` — that is what makes it a set. Inside a wrapper,
the radio's `name` groups it and the wrapper names it:

```tsx no-check
<div field="plan">
  <input type="radio" name="plan" value="free" />
  <input type="radio" name="plan" value="pro" />
</div>;
```

produces `{ plan: "free" | "pro" | undefined }` — one key, not `plan.plan`.

Put one radio group per wrapper. Two groups under one wrapper would both claim
the wrapper's key, which is a build error.

## Repeating rows

A `field` wrapper holding a `map()` is an **array field**, and its value is
the array the rows came from:

```tsx no-check
type Job = { id: number; title: string; start: string; end: string };

export const jobs = signal<Job[]>([{ id: 1, title: "", start: "", end: "" }]);
let nextId = 2;

export const addJob = () =>
  jobs.set((rows) => [...rows, { id: nextId++, title: "", start: "", end: "" }]);
export const removeJob = (job: Job) =>
  jobs.set((rows) => rows.filter((row) => row.id !== job.id));

<div field="experience">
  {jobs.map(
    (job) => (
      <div>
        <input bind:value={job.title} />
        <input bind:value={job.start} />
        <input bind:value={job.end} />
        <button type="button" onClick={removeJob}>remove</button>
      </div>
    ),
    { key: (job) => job.id },
  )}
</div>
<button type="button" onClick={addJob}>add a row</button>;
```

produces `{ experience: Job[] }`, one entry per live row.

This is the one field whose state you own, for a structural reason: every
other field gets a compiler-declared cell, but a row's controls live in a list
arena — interchangeable replicas of one template — so there is nothing stable
to attach a per-row cell to. The array already has one entry per row and a key
for each, so the array *is* the state: `bind:value={job.title}` writes back
into it, and adding a row is an ordinary `signal.set`.

It follows that reordering rows reorders the payload, a removed row is gone
rather than blank, and the row type in the payload is the type you declared.

:::note `bind:value` on a row property

Inside a `map()`, `bind:value` takes the row's own property rather than a
signal. The callback runs once against a recording proxy, so `job.title` is a
path at build time — the same mechanism `{job.title}` uses to render. Typing
replaces the item and the array through an ordinary `signal.set`; nothing is
mutated in place.
:::

Two details:

- **The payload entry is the item as authored**, `id` included. The compiler
  does not guess which properties are "really" fields; drop the key in your
  schema if you don't want it.
- **A row's errors appear on submit**, not while typing — the pristine-field
  check compares against a compiled constant, and an array has none. After the
  first failed submit they update live like every other field.

### Per-row error messages

Put a `<span error />` inside the template and each row shows its own message:

```tsx no-check
<div field="experience" errorClassName="group/error">
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
</div>;
```

An issue at `experience.0.title` lands in row 0 and nowhere else, matched by
data position rather than by slot — a reorder cannot carry a message to the
wrong row.

The section's own `<span error />` shows only section-level issues — "add at
least one job" for an issue at `experience` itself — and stays silent when a
row already shows the message. The section's `errorClassName` still applies,
because a broken row is also the section's problem.

### Styling an invalid control

The wrapper's class styles everything around a field; the control itself uses
a pseudo-class:

```css
input:invalid { border-color: #f43f5e }
```

`:invalid` is live on any control the current `validate={…}` rejected, and
clears when the next validation passes. It is also the only way to style one
list row and not another: replicas share a style row, so a conditional class
on a row's input applies to every row, while `:invalid` is resolved per node
in the controls table.

There is no `:user-invalid` — it differs from `:invalid` only in *when* a
browser lets it match, and that timing is already covered by `validateOn` and
the pristine-field behavior.

:::warning Specificity ties

`input:invalid` and `input[type="text"]` are both specificity `(0,1,1)`, so
source order decides. An `:invalid` rule written above the field's resting
color is overwritten by it — which looks exactly like the pseudo-class never
matching. Write the `:invalid` rule after the base rule.
:::

## Validation

```tsx no-check
import * as z from "zod";

export const Login = z.object({ email: z.email(), age: z.number().min(18) });

<form validate={Login} onSubmit={save} onInvalid={showErrors}>;
```

`validate` accepts any **Standard Schema** (Zod 4, Valibot and ArkType
implement it natively), any **Effect schema**, or a plain function returning
issues. dziry depends on none of these libraries — Standard Schemas are used
through their `~standard` property, and an Effect schema is converted with
Effect's own helper behind a lazy import.

A schema also narrows what `onSubmit` receives: the payload goes in, the
schema's output comes out, so a `z.coerce.date()` field arrives as a `Date`.
When validation fails, `onSubmit` does not run and `onInvalid` receives the
issues, normalized to `{ path, message }[]` regardless of which library
produced them.

### When validation runs

```tsx no-check
<form validateOn="change" validate={Login} onSubmit={save}>;
```

`validateOn` is `"submit"` (the default), `"change"`, or `"blur"`. Two
behaviors apply in every mode:

- After a failed submit, the form re-validates as fields change, so an error
  clears the moment it is fixed.
- Before any submit, a field shows an error only once its value has moved off
  its initial one — a pristine form does not open covered in red.

There is no `touched` or `dirty` state to manage: the first is what
`validateOn` covers, and the second is derived by comparing against the
initial value the compiler recorded.

## Showing errors with CSS

Error state is one class on the wrapper:

```tsx no-check
<div field="email" errorClassName="group/error">
  <input className="error:border-red-500" />
  <span error className="hidden error:block" />
</div>;
```

```css
@custom-variant error (.group\/error &);
```

The wrapper carries `group/error` while its field has an issue — "its" meaning
any issue whose path starts with the wrapper's own, so a `position` wrapper
lights up for a problem at `position.x`. Everything inside is an ordinary
descendant selector: the input's border and the message's visibility both
follow from the class on the wrapper, with no JavaScript involved. It compiles
to a handful of style-table writes.

`<span error />` is where the message text goes. Its content becomes a binding
to a compiler-declared cell; any text you write inside it is placeholder prose
that never ships.

### One message per field in a group

A marker can name a field, so a group's messages divide up instead of
collapsing into one line:

```tsx no-check
<div field="address" errorClassName="group/error">
  <div>
    <input name="street" />
    <span error="street" />
  </div>
  <div>
    <input name="city" />
    <span error="city" />
  </div>
  <span error />
</div>;
```

Marker names are relative to their wrapper, exactly as control names are —
`error="street"` inside `field="address"` means `address.street`, and dots go
deeper. Relative, so renaming or nesting the wrapper never means editing every
marker inside it.

Each marker shows the first issue under its own path that no more specific
marker would show. With both fields empty, each leaf shows its own message and
the bare marker stays silent; with an issue at `address` itself ("street and
city cannot be the same"), the leaves are clean and the bare marker shows it.
No message appears twice.

The class stays one per wrapper — `errorClassName` means "something under here
is wrong", however many messages describe it. A marker naming a field that
does not exist is a build warning, since it could never fill.

:::warning Use the prefix form of the Tailwind variant

`@custom-variant error (.group\/error &)` emits `.group\/error .error\:block`,
a plain descendant selector. Tailwind's default form emits
`:is(:where(.group\/error) *)`, and the `*` inside `:is()` is not a selector
dziry parses.
:::

Multiple fields can share the class name and stay independent — error patches
are keyed on each field's own state, not on the string.

## Reacting to one field

A submit button that stays disabled until a box is ticked needs the app to
know about that box. This is the one place the payload-only rule costs an
extra signal:

```tsx no-check
export const termsAccepted = signal(false);
export const onTermsChange = (on: boolean) => termsAccepted.set(on === true);
export const cannotSubmit = computed(() => !termsAccepted);

<div field="terms">
  <input type="checkbox" onChange={onTermsChange} />
</div>
<button type="submit" disabled={cannotSubmit}>sign up</button>;
```

`disabled` takes a signal, and because it is a control flag rather than a
class it does three things at once: the button greys out through `:disabled`,
the engine refuses presses on it, and Enter is refused too — a form whose
submit button is disabled has no way in.

The checkbox keeps its compiler-declared cell, so `terms` remains in the
payload. The `onChange` is a second reader of the same click; the cell is
written before any handler runs, so the two cannot disagree.

:::note `bind:checked` is planned

A named field's cell is deliberately unreachable from outside the generated
module, so a field that drives something else on the page currently needs the
app to hold a copy of its value. `bind:checked` — making your signal *be* the
cell, as `bind:value` does for text — is the planned fix and is not built yet.
:::

## Showing a native dialog

```tsx no-check
import { alert } from "dziry";

export const onSignUp = (data: unknown) => {
  alert(JSON.stringify(data, null, 2), { title: "onSubmit received" });
};
```

`alert()` opens the platform's own modal dialog — see
[alert](../../reference/signals.mdx#alert). Import it explicitly: Bun defines
a global `alert()` that reads stdin, which would hang the app thread.

## File inputs

`<input type="file">` opens the platform's file dialog. The chosen path lands
in the input's bound signal and `onChange` fires. The value is the **path**,
not a `File` object — reading from disk is left to you, so the engine never
blocks a frame on I/O:

```tsx no-check
export const picked = signal("");

<input type="file" accept="image/*,.png" multiple bind:value={picked} />;
```

`accept` narrows the dialog's filter; `multiple` allows several picks, whose
paths arrive newline-joined. Three helpers read the path:

```ts no-check
import { fileInfo, readFile, readFileText } from "dziry";

const info = await fileInfo(picked);      // { path, name, size, type }
const bytes = await readFile(picked);     // Uint8Array — what <img src> needs
const text = await readFileText(picked);  // string — for .txt, .json, .csv
```

`fileInfo` reads the size from disk and derives the MIME type from the
extension; `readFile` and `readFileText` load the whole file.

## Current limitations

- **A named control inside a `map()` row is not collected.** Rows reach the
  payload as an array field through `bind:value` on row properties; a `name`
  inside a template would be the same string in every row. The build reports
  it.
- **`errorClassName` on a wrapper inside a row does nothing** — a class is a
  style row and replicas share one. Style the row's controls with `:invalid`,
  which is per node.
- **A file input contributes nothing to the payload.** The chosen path lands
  in its bound signal; there is no `File` object. Read it with
  `fileInfo`/`readFile`/`readFileText`.
- **A named submit button adds no entry of its own.** A browser includes
  `name=value` for the button that submitted; dziry does not. In a two-button
  form, use two `onClick` handlers.

`form="id"` **is** fully supported: a control it moves belongs to that form
for every purpose — payload, default button, implicit submission — even when
written outside the form or inside a different one. An id that names no form
leaves the control owned by nothing, matching browser behavior for a typo.
