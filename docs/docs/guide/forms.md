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

:::warning Use the prefix form of the Tailwind variant

`@custom-variant error (.group\/error &)` emits `.group\/error .error\:block`, a plain
descendant selector. Tailwind's default form emits `:is(:where(.group\/error) *)`, and the `*`
inside `:is()` is not a selector dziri parses.
:::

Many fields can share the class name and stay independent — patches are keyed on the field's own
state, not on the string.

## Telling the user

```tsx no-check
import { alert } from "dziri";

export const onSignUp = (data: unknown) => {
  alert(JSON.stringify(data, null, 2), { title: "onSubmit received" });
};
```

`alert()` opens the platform's own modal — see [alert](../api/signals.mdx#alert). Import it: Bun
has a global `alert()` that reads stdin.

## What is not built

- **Fields inside a `map()` list are not collected.** A list template is compiled once into an
  arena, so a `value` inside it is the same string in every row and per-row entries would be
  indistinguishable. The control still renders; the build says it is not in the payload.
- **No `<input type="file">`.** There is no file picker, so there would be nothing to submit.
- **A named submit button adds no entry of its own** — a browser includes `name=value` for the
  button that submitted, and dziri does not. In a two-button form, use two `onClick`s.

`form="id"` **is** supported, and fully: a control it moves is that form's for every purpose —
its payload, its default button, and its implicit-submission rules — even when written outside
the form or inside a different one. An id that names no form leaves the control owned by
nothing, which is what a browser does with a typo too.
