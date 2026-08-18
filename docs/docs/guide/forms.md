---
title: Forms
sidebar_position: 7
---

# Forms

A form in dziri is markup, CSS and a schema. There is no form library, no per-field state, and
nothing to wire up: the compiler can see the whole form, so it works out what the payload looks
like before the app runs.

## The smallest form that works

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

That is the whole thing. No `signal`, no state module. `onSubmit` receives an object keyed by
each control's `name`, and Enter in the field submits it as surely as pressing the button does.

**Where does the value live?** The compiler declares a cell for every named field that has no
binding, seeded from its `value` attribute — a browser's "default value". Nothing outside the
generated artifact can name that cell, so a form's fields never become a second, undocumented
state API. The payload is how you read them.

If you *do* want the value elsewhere, give the field a `bind:value` and it uses your signal
instead. It cannot have both, because two cells for one field could disagree.

## The payload is typed by what each control is

The compiler knows a checkbox from a number field, so you get the type you would have written
by hand:

| markup | what you get |
|---|---|
| `<input name="x">`, `<textarea name="x">` | `string` |
| `<input name="x" type="number">` | `number \| undefined` — never `NaN` |
| `<input name="x" type="checkbox">` | `boolean` |
| `<input name="x" type="radio">` × n | `string \| undefined` — the checked one's `value` |
| `<select name="x">` | `string` |
| `<select name="x" multiple>`, or two controls sharing a name | `string[]` |

Which controls are *in* the payload follows the browser's rules, measured rather than recalled:
a control with no name is left out, so is a disabled one — including one disabled by an
enclosing `<fieldset disabled>`, because disabledness is inherited — an unticked checkbox
contributes nothing, and an `<option>` with no `value` submits its trimmed text.

The key set never changes shape. Two controls sharing a name give an array on every submit, not
an array when both are filled and a string when one is. That is decided at build time so your
schema can rely on it.

## Groups, and nesting

`field` on anything that wraps a control names a **group**:

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

gives `{ name: string, position: { x, y }, address: { city } }`.

The rule is one sentence: **the wrapper chain is the path.** A wrapper holding one bare control
*is* that field. Named controls inside a wrapper become its properties. Wrappers nest. An
element without `field` is transparent, so a layout div nests nothing.

There is nothing to remember about leaves versus branches, because the path is the answer. A
wrapper holding a bare control *and* a named one asks for `a` to be a string and an object at
once — that is a build error, not a coin toss.

:::note No brackets, and no browser does this either

`name="user[email]"` is the literal key `"user[email]"` everywhere in the platform — in
`FormData`, in the urlencoded body, in `URLSearchParams`. The bracket convention belongs to
server-side parsers (PHP, Rack, `qs`), each with its own dialect, each guessing at structure
after the fact.

dziri nests by structure instead, because a compiler can see structure. Nothing is parsed at run
time, there is no dialect to pick, and a conflicting path is reported instead of resolved.
:::

### One thing that will surprise you: radios

A radio set has to share a `name` — that is what makes it a set. So inside a wrapper, a radio's
`name` **groups** it and the wrapper **names** it:

```tsx no-check
<div field="plan">
  <input type="radio" name="plan" value="free" />
  <input type="radio" name="plan" value="pro" />
</div>;
```

gives `{ plan: "free" | "pro" | undefined }` — one key, not `plan.plan`. That is the same reason
a radio set's shape is a single value: many elements, one answer.

Put **one radio group per wrapper**. Two groups under one wrapper would both claim the wrapper's
key, and the build says so rather than letting one overwrite the other.

## Repeating rows

A `field` wrapper holding a `map()` is an **array field**, and its value is the array the rows
came from:

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

gives `{ experience: Job[] }`, one entry per live row.

**This is the one field whose state you own**, and the reason is worth a sentence. Every other
field gets a cell the compiler declares — but a row's controls live in a list arena, which is
`capacity` interchangeable replicas of one template, so there is nothing stable to hang a
per-row cell on. The array already has one entry per row and a key for each. So the array *is*
the state, `bind:value={job.title}` writes back into it, and adding a row is an ordinary
`signal.set` rather than a call into a form API.

Everything else follows from that: reordering rows reorders the payload, a removed row is gone
rather than blank, and the row type in your payload is the type you declared.

:::note `bind:value` on a row's property

Inside a `map()`, `bind:value` takes the row's own property rather than a signal. The callback
runs once against a recording proxy, so `job.title` is a *path* at build time — which is the
same mechanism `{job.title}` already uses to render. Typing replaces the item and the array, so
an ordinary `signal.set` publishes it; nothing is mutated in place.
:::

Two things to know:

- **The entry is the item as authored**, `id` and all. Dropping the key from the payload would
  mean the compiler deciding which properties are "really" fields, and every rule for that is a
  guess. Drop it in your schema if you mind.
- **A row's errors appear on submit**, not while typing. The pristine-field gate is a comparison
  against a compiled constant, and an array has none. After the first failed submit they update
  live like everything else.

### The message goes in the row

Put a `<span error />` **inside the template** and each row shows its own complaint:

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

An issue at `experience.0.title` lands in row 0 and nowhere else, matched by **data position**
rather than by slot — so a reorder cannot carry a message to the wrong row.

The section's own `<span error />` then shows only what is the *section's*: "add at least one
job" for an issue at `experience` itself, and nothing when a row is already saying it. Its
`errorClassName` still goes on, because a broken row is the section's problem too — the class
and the message part company only here.

### Styling the field itself: `:invalid`

The wrapper's class dresses everything *around* a field. The field itself uses a pseudo-class:

```css
input:invalid { border-color: #f43f5e }
```

`:invalid` is live on any control a `validate={…}` rejected, and it clears the moment the next
validation passes. **It is the only way to style one list row and not another**, and the
reason is worth knowing: replicas share a style row, so a conditional class on a row's input
is the same class on every row's, while each replica has its own row in the controls table —
which is where this bit lives and what the engine resolves it against.

There is no `:user-invalid`. It differs from `:invalid` only in *when* a browser lets it
match, and that timing is already decided by `validateOn` plus the pristine-field gate.

:::warning Watch the specificity

`input:invalid` and `input[type="text"]` are both `(0,1,1)`, so they tie and source order
decides. A rule written above the field's resting colour compiles into the variant slot and is
then overwritten by it — which looks exactly like the predicate never going live.
:::

## Validation

```tsx no-check
import * as z from "zod";

export const Login = z.object({ email: z.email(), age: z.number().min(18) });

<form validate={Login} onSubmit={save} onInvalid={showErrors}>;
```

`validate` accepts any **Standard Schema** — Zod 4, Valibot and ArkType implement it natively —
any **Effect** schema, or a plain function returning issues. dziri depends on none of them: the
first kind is used through its `~standard` property, and an Effect schema is converted with
Effect's own helper behind an import that only happens if you pass one.

A schema also **narrows what `onSubmit` receives**: the payload goes in and the schema's output
comes out, so a `z.coerce.date()` field arrives as a `Date` rather than the string that was
typed. When validation fails, `onSubmit` does not run and `onInvalid` receives the issues,
normalised to `{ path, message }[]` whichever library produced them.

### When it checks

```tsx no-check
<form validateOn="change" validate={Login} onSubmit={save}>;
```

`"submit"` (the default), `"change"`, or `"blur"`. Two behaviours are not options, because
neither is a preference:

- after a failed submit the form re-validates as its fields change, so an error clears the
  moment you fix it;
- before any submit, a field shows an error only once its value has *moved* off the one it was
  compiled with — so a pristine form does not greet the user in red.

There is no `touched` or `dirty` for you to manage. The first is what `validateOn` is for, and
the second costs nothing to derive: the initial value is a constant the compiler wrote down.

## Showing errors, in CSS

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

The wrapper wears `group/error` while its field has an issue — where "its" means any issue whose
path starts with the wrapper's own, so a `position` wrapper lights up for a problem at
`position.x`. Everything below it is an ordinary descendant selector, which is why the input's
border and the message's visibility both come from a class on the div and **none of the styling
is JavaScript**. It compiles to a handful of style-table writes.

`<span error />` is where the message goes. Its text becomes a binding to a cell the compiler
declares; anything you write inside it is placeholder prose for your own benefit and never
ships.

### One message per field, in a group

A marker can **name** a field, and then a group's complaints divide up instead of collapsing
into one line:

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

The name is **relative to the wrapper**, exactly as a control's `name` is — `error="street"`
inside `field="address"` means `address.street`, and dots go deeper. Relative rather than
absolute for the same reason: renaming the wrapper, or nesting it, must not mean editing every
marker inside it.

Each marker shows the first issue under **its own** path that no more specific marker would
show. So with both fields empty, each leaf says its own thing and the bare marker stays silent;
with an issue at `address` itself — "street and city cannot be the same" — the leaves are clean
and the bare marker speaks. Nothing is ever said twice.

**The class stays one per wrapper.** `errorClassName` means "something under here is wrong",
which is a single fact however many messages describe it; only the text divides. A name that
matches no field is a build warning, because a marker that can never fill is indistinguishable
from a field that is never wrong.

:::warning Use the prefix form of the Tailwind variant

`@custom-variant error (.group\/error &)` emits `.group\/error .error\:block`, a plain
descendant selector. Tailwind's default form emits `:is(:where(.group\/error) *)`, and the `*`
inside `:is()` is not a selector dziri parses.
:::

Many fields can share the class name and stay independent — patches are keyed on the field's own
state, not on the string.

## Reacting to one field

A submit button that is off until a box is ticked needs the *app* to know about that box, and
this is the one place the payload-only rule costs you something:

```tsx no-check
export const termsAccepted = signal(false);
export const onTermsChange = (on: boolean) => termsAccepted.set(on === true);
export const cannotSubmit = computed(() => !termsAccepted);

<div field="terms">
  <input type="checkbox" onChange={onTermsChange} />
</div>
<button type="submit" disabled={cannotSubmit}>sign up</button>;
```

`disabled` takes a signal, and it buys three things at once because it is a *control flag*
rather than a class: the button greys out through `:disabled`, presses on it are refused by the
engine, and **Enter is refused too** — a form whose submit button is off has no route in.

The checkbox keeps its compiler-declared cell, so `terms` is still in the payload. The
`onChange` is a second reader, and both see the same click: the cell is written before any
handler runs, so the two cannot disagree.

:::note This is a duplicate, and it is the API's fault

A named field's cell is deliberately unnameable from outside the artifact — the payload is how
you read it — so a field that has to drive something *else* on the page needs the app to hold
its value as well. `bind:checked` is what removes the copy, making the author's signal *be* the
cell the way `bind:value` already does for text. It is not built.
:::

## Telling the user

```tsx no-check
import { alert } from "dziri";

export const onSignUp = (data: unknown) => {
  alert(JSON.stringify(data, null, 2), { title: "onSubmit received" });
};
```

`alert()` opens the platform's own modal — see [alert](../api/signals.mdx#alert). Import it: Bun
has a global `alert()` that reads stdin.

## Reading a picked file

`<input type="file">` opens the platform's open-file dialog (SDL's). The chosen path lands
in the input's bound signal and `onChange` fires — the value is the **path**, not the file,
because no engine thread should block a frame on disk.

```tsx no-check
export const picked = signal("");

<input type="file" accept="image/*,.png" multiple bind:value={picked} />;
```

`accept` narrows the dialog's filter and `multiple` allows several picks, whose paths are
newline-joined. Three helpers turn the path into something useful:

```ts no-check
import { fileInfo, readFile, readFileText } from "dziri";

const info = await fileInfo(picked);      // { path, name, size, type }
const bytes = await readFile(picked);     // Uint8Array — what <img src> needs
const text = await readFileText(picked);  // string — for .txt, .json, .csv
```

`fileInfo` reads the size from disk and guesses the MIME type from the extension;
`readFile` and `readFileText` load the whole file.

## What is not built

- **A *named* control inside a `map()` row is still not collected.** Rows reach the payload as
  an array field, through `bind:value` on the row's own properties — a `name` inside a template
  would be the same string in every row, so it stays out. The build says so.
- **`errorClassName` on a wrapper *inside* a row does nothing.** A class is a style row, and
  replicas share one. Style the row's controls with `:invalid` instead, which is per node.
- **A file input contributes nothing to the payload.** `<input type="file">` opens the
  picker and the chosen *path* lands in its bound signal, but there is no `File` object here,
  so it is not a form field. Read it with `fileInfo`/`readFile`/`readFileText` (above).
- **A named submit button adds no entry of its own** — a browser includes `name=value` for the
  button that submitted, and dziri does not. In a two-button form, use two `onClick`s.

`form="id"` **is** supported, and fully: a control it moves is that form's for every purpose —
its payload, its default button, and its implicit-submission rules — even when written outside
the form or inside a different one. An id that names no form leaves the control owned by
nothing, which is what a browser does with a typo too.
