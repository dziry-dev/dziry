/**
 * Builds a form's payload, and runs whatever `validate={…}` was given over it.
 *
 * The compiler decided everything structural — which controls are fields, what an option
 * submits, which names collapse to arrays, which fields the markup disables. What is left
 * here is reading cells and shaping the result, which is why this file has no notion of a
 * tag, a type attribute or a selector.
 *
 * # Two halves that fail differently
 *
 * Building a payload cannot fail: every key exists at build time and every cell holds
 * something. Validating one can, and the two are kept apart so that a schema is never in a
 * position to decide what the payload's keys are.
 */
import type { CompiledUi, FormBinding, FormField } from "../ir.ts";
import { ControlFlags } from "../protocol/generated.ts";
import { isRangeControl, rangeValue } from "./numerics.ts";

/**
 * A leaf of a payload, before a schema has had a chance to narrow it.
 *
 * `unknown[]` is the repeating-row case and the one leaf the compiler does not shape: an
 * array field's value is the author's own array, so its element type is theirs — recovered by
 * the generated artifact, which types the payload from the markup, and by a schema when there
 * is one. Here it is the widest thing that is still a leaf.
 */
export type FormValue = string | number | boolean | string[] | unknown[] | undefined;

/**
 * What `onSubmit` receives when no `validate` narrowed it.
 *
 * A **tree**, because a `field` wrapper is a namespace — `{ position: { x, y } }`. Recursive
 * rather than `Record<string, FormValue>`, which is what it was until nesting existed and is
 * the sort of thing only the type checker notices: the values were still being written
 * correctly, and every runtime test passed.
 */
export type FormPayload = { [key: string]: FormValue | FormPayload };

/**
 * One reason a payload was rejected.
 *
 * The shape Standard Schema already uses, minus its variance: a path of keys and a message.
 * Every supported validator is reduced to this, so an app that switches from Zod to Effect
 * does not rewrite its error rendering.
 */
export type FormIssue = {
  /** `["address", "line1"]`. Empty for an issue about the payload as a whole. */
  path: (string | number)[];
  message: string;
};

/**
 * Whether a field contributes at all.
 *
 * Two sources, because disabledness has two: the markup, settled at build time, and a
 * `disabled={signal}`, which is the author's and therefore lives in Bun's copy of the
 * controls table. The engine owns `CHECKED` and re-reads `DISABLED` from that table on
 * every rescan, so reading it here is reading the same byte the engine obeys.
 */
function contributes(ui: CompiledUi, field: FormField): boolean {
  if (field.disabled) return false;
  if (field.row < 0) return true;
  return (ui.controls.flags[field.row]! & ControlFlags.DISABLED) === 0;
}

/**
 * The strings one field contributes — none, one, or several.
 *
 * A list even for the scalar kinds, because "contributes nothing" is a real answer for
 * four of the six and a nullable scalar would have to be unwrapped by every caller.
 */
function valuesOf(field: FormField, submitter: number): string[] {
  // The one field with no cell, because what it contributes is a property of the *gesture*:
  // a named submit button is in the payload only when it is the button that submitted.
  // Measured, and so is the position — the entry sits where the button is written, which is
  // why this is a field in the ordinary list rather than something appended at the end.
  if (field.kind === "submitter") return field.node === submitter ? [field.value] : [];

  const cell = field.signal?.value;

  switch (field.kind) {
    case "text":
    case "number":
      return [String(cell ?? "")];

    // Its own `value` when ticked, nothing when not — which is exactly how a browser
    // builds the entry, `"on"` default included. The compiler already applied that default.
    case "checkbox":
    case "radio":
      return cell ? [field.value] : [];

    case "select": {
      const chosen = field.options[Number(cell)];
      return chosen === undefined ? [] : [chosen];
    }

    case "selectMultiple": {
      const out: string[] = [];
      for (const index of (cell as number[] | undefined) ?? []) {
        const value = field.options[index];
        if (value !== undefined) out.push(value);
      }
      return out;
    }

    default:
      return [];
  }
}

/**
 * The payload for one form: an object whose keys and value shapes were fixed at build time.
 *
 * Deliberately not `FormData`. The compiler knows each field's kind, so a checkbox can be a
 * boolean and a number field a number, and the alternative — every value a string, as the
 * platform API has it — would push a `z.coerce` or a `Schema.NumberFromString` onto every
 * schema an author writes. The *inclusion* rules are still the browser's, measured:
 * nameless and disabled controls contribute nothing, an unticked box contributes nothing,
 * and two controls sharing a name contribute in document order.
 *
 * `submitter` is the node of the button that submitted, or -1 for an Enter that clicked
 * nothing. A **named** submit button contributes `name=value` when it is that button and not
 * otherwise, which is the one entry that depends on the gesture rather than on the markup.
 */
export function formPayload(
  ui: CompiledUi,
  form: FormBinding,
  submitter = -1,
): FormPayload {
  const out: FormPayload = {};

  for (const key of form.keys) {
    const values: string[] = [];
    let checked = false;

    for (const index of key.fields) {
      const field = form.fields[index]!;
      if (!contributes(ui, field)) continue;
      const contributed = valuesOf(field, submitter);
      values.push(...contributed);
      // A checkbox's *shape* is a boolean, so what matters is that it contributed rather
      // than what it contributed — `<input type=checkbox name=terms>` has the value `"on"`
      // and an author writing `data.terms` wants `true`.
      if (contributed.length > 0) checked = true;
    }

    write(
      out,
      key.path,
      key.shape === "many"
        ? values
        : key.shape === "boolean"
          ? checked
          : key.shape === "number"
            ? asNumber(values[0])
            : key.shape === "text"
              ? (values[0] ?? "")
              : values[0],
    );
  }

  // Repeating rows, which are a read rather than a walk: the rows' state *is* this array, so
  // there are no cells to gather and nothing to shape. Copied rather than handed over, because
  // a payload an author is free to keep must not be a live view of the signal they are still
  // editing — and copied one level, since the items themselves are replaced on every edit
  // rather than mutated (see `typeIntoRow`).
  for (const array of form.arrays) {
    write(out, array.path, [...(array.signal.value ?? [])]);
  }

  return out;
}

/**
 * Writes `value` at `path`, making the objects on the way.
 *
 * The whole of dziry's nesting at run time: the *paths* were resolved by the compiler from
 * the `field` wrappers, so there is no string to parse and no dialect to pick — which is the
 * one thing every server-side bracket parser has to do, and where they disagree with each
 * other. A conflicting path was already a build error, so nothing here has to decide what
 * `a` and `a.x` together should mean.
 */
function write(into: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let at = into;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    const next = at[segment];
    if (next === undefined || typeof next !== "object" || next === null) {
      at[segment] = {};
    }
    at = at[segment] as Record<string, unknown>;
  }
  at[path[path.length - 1]!] = value;
}

/**
 * A numeric field's value, or `undefined` when there is nothing usable in it.
 *
 * `undefined` rather than `NaN`, and rather than the empty string a browser reports. NaN
 * fails every schema with a message about types rather than about emptiness, and it
 * survives arithmetic silently; `undefined` is what "the user has not filled this in" means
 * to `z.number()` and to `Schema.Number` alike.
 */
function asNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * Applies a `CHANGE` from the engine to whichever field owns that node.
 *
 * The engine owns checkedness and the chosen option; Bun owns the payload. This is the one
 * line between them, and it is an event rather than a query because the alternative — ask
 * the engine at submit — would need a synchronous call from the worker thread to a handle
 * it does not have.
 *
 * Returns whether anything moved, so the caller can skip a commit.
 */
export function applyFieldChange(
  ui: CompiledUi,
  node: number,
  raw: number,
  selected: readonly number[] = [],
): boolean {
  let moved = false;

  for (const form of ui.forms) {
    for (const field of form.fields) {
      if (field.node !== node) continue;
      const cell = field.signal as { value: unknown };

      switch (field.kind) {
        case "checkbox":
          cell.value = raw === 1;
          moved = true;
          break;

        // The engine reports only the radio that *became* checked — a browser fires no
        // change on the ones it cleared, and neither does this. So the group is cleared
        // here, from the compile-time group the same table already carries.
        case "radio":
          cell.value = raw === 1;
          moved = true;
          if (raw === 1) clearGroup(ui, form, field);
          break;

        case "select":
          cell.value = raw;
          moved = true;
          break;

        // A slider. `raw` is per-mille of the track, and the conversion is the
        // numeric bridge's — the same one the `onChange` handler path uses, so a
        // form's payload and a handler can never disagree about what the thumb
        // meant. The kind on the *control* is what decides: a number *field* never
        // arrives here (it is text, and text comes through `typeInto`).
        case "number": {
          if (!isRangeControl(ui, node)) break;
          const value = rangeValue(ui, node, raw);
          if (value === null) break;
          cell.value = value;
          moved = true;
          break;
        }

        // A list box's answer is a *set*, and it cannot ride in one integer — so it arrives
        // beside the event, read on the engine thread. Copied rather than kept: the drained
        // array is reused by the next event.
        case "selectMultiple":
          cell.value = [...selected];
          moved = true;
          break;

        // A text field never arrives this way. Its value changes through `typeInto`, which
        // owns the string because Bun owns the string table.
        default:
          break;
      }
    }
  }

  return moved;
}

/**
 * Unchecks the rest of a radio group.
 *
 * By `name` within the form rather than by the engine's group id, because that is what a
 * group *is* here — the compiler interned the same `(form, name)` pair to make the engine's
 * id, so the two cannot disagree, and this side already has the names.
 */
function clearGroup(ui: CompiledUi, form: FormBinding, chosen: FormField): void {
  const key = form.keys.find((k) => k.fields.includes(form.fields.indexOf(chosen)));
  if (key === undefined) return;

  for (const index of key.fields) {
    const field = form.fields[index]!;
    if (field === chosen || field.kind !== "radio") continue;
    (field.signal as { value: unknown }).value = false;
  }
}

/**
 * Writes each `field` wrapper's error cells from a set of issues.
 *
 * A wrapper owns an issue when its path is a **prefix** of the issue's, so a
 * `field="position"` wrapper lights up for an issue at `position.x` and a nested
 * `field="x"` wrapper inside it lights up for that one alone. Both are true at once, which is
 * what makes a group *and* its members styleable from one validation.
 *
 * `showAll` is the gate the other form libraries call `touched`, done without storing
 * anything: before a submit has been attempted a wrapper may only show an error once one of
 * its own controls has moved off the value the compiler baked in, so a pristine form does not
 * turn red as the user tabs through it. After a failed submit every wrapper may speak.
 *
 * Returns whether anything moved, so a caller can skip a commit.
 */
/**
 * What joins a path into a set key.
 *
 * A NUL, because it cannot occur in an authored `field` name — so `["a.b"]` and `["a", "b"]`
 * stay different keys, which a dot would quietly merge. The same choice `fields.ts` makes for
 * the same reason.
 */
const SEGMENT = String.fromCharCode(0);

export function applyIssues(
  ui: CompiledUi,
  form: FormBinding,
  issues: readonly FormIssue[],
  showAll: boolean,
): boolean {
  let moved = false;

  // Rows first, because the section's own message depends on whether they spoke: a wrapper
  // whose rows carry their own `<span error />` must not repeat what a row is already saying.
  const spokenFor = new Set<string>();
  for (const array of form.arrays) {
    if (array.rowErrors === null) continue;
    spokenFor.add(array.path.join(SEGMENT));
    if (rowMessages(array, issues, showAll)) moved = true;
  }

  if (markInvalid(ui, form, issues, showAll)) moved = true;

  for (const group of form.groups) {
    // **The class and the messages part company here, and only here.** A wrapper is in error
    // whenever anything under it is — a broken leaf, a broken row, all of it is the group's
    // problem — and that is the prefix rule every wrapper follows.
    const found = issues.find((issue) => isUnder(issue.path, group.path));
    const show = found !== undefined && (showAll || isDirty(form, group));

    if (group.error.value !== show) {
      group.error.value = show;
      moved = true;
    }

    // The messages divide those same issues up by **specificity**: each target shows the first
    // issue under its own path that no *more specific* target would show. That is what puts
    // "city is required" beside the city box while the wrapper keeps whatever is only its own,
    // and what stops the two saying the same thing twice.
    const rowsSpeak = spokenFor.has(group.path.join(SEGMENT));
    for (const target of group.messages) {
      const mine = show
        ? issues.find(
            (issue) =>
              isUnder(issue.path, target.path) &&
              !claimedByDeeper(issue, target, group, rowsSpeak),
          )
        : undefined;

      const text = mine?.message ?? "";
      if (target.cell.value === text) continue;
      target.cell.value = text;
      moved = true;
    }
  }

  return moved;
}

/**
 * Whether something more specific than `target` is already showing this issue.
 *
 * The rule that makes several markers under one wrapper divide the work instead of echoing each
 * other, and it is deliberately about *paths* rather than about which marker was written first:
 * a `<span error="city">` claims `address.city` from the bare `<span error />` beside it, and
 * would claim it from an `error="city.line"` too if that were the deeper one.
 *
 * `rowsSpeak` folds the array case into the same rule. A row's own message element is not a
 * target here — it is a slot per row rather than a cell — so it cannot be compared by path;
 * what it claims is *any* issue with a row index in it, which is what this tests for.
 */
function claimedByDeeper(
  issue: FormIssue,
  target: FormBinding["groups"][number]["messages"][number],
  group: FormBinding["groups"][number],
  rowsSpeak: boolean,
): boolean {
  if (
    rowsSpeak &&
    target.path.length === group.path.length &&
    typeof issue.path[group.path.length] === "number"
  ) {
    return true;
  }

  for (const other of group.messages) {
    if (other.path.length <= target.path.length) continue;
    if (isUnder(issue.path, other.path)) return true;
  }
  return false;
}

/**
 * Writes `:invalid` onto the control row of every field an issue names.
 *
 * The bit the engine reads back as a predicate, so a field's own border can turn red without
 * a class and without a patch — which is what lets **one list row** differ from the next,
 * since replicas share a style row and do not share a control row.
 *
 * A field is invalid when an issue's path is its key's path or sits under it: `email` for an
 * issue at `email`, and both `position.x` and `position.y` for one at `position`, because a
 * complaint about the group is a complaint about the controls that make it up.
 *
 * Rows are **not** handled here. Which replica renders which item is runtime state the form
 * binding cannot see, so the paths are recorded per row and `applyRowValidity` — which has
 * the list — does the writing.
 */
function markInvalid(
  ui: CompiledUi,
  form: FormBinding,
  issues: readonly FormIssue[],
  showAll: boolean,
): boolean {
  let moved = false;

  const write = (row: number, invalid: boolean): void => {
    if (row < 0 || row >= ui.controls.count) return;
    const before = ui.controls.flags[row]!;
    const after = invalid
      ? before | ControlFlags.INVALID
      : before & ~ControlFlags.INVALID;
    if (before === after) return;
    ui.controls.flags[row] = after;
    moved = true;
  };

  for (const key of form.keys) {
    // The same gate the wrappers use, and it has to be the same one: a field that turns red
    // before its group would be a second, louder answer to "has the user had a go yet".
    const group = form.groups.find((g) => sameStart(key.path, g.path));
    const gated = showAll || (group !== undefined && isDirty(form, group));
    // Either direction: an issue *at* the field (`email`), and an issue about the group it
    // belongs to (`position` naming both `position.x` and `position.y`), because a complaint
    // about a group is a complaint about the controls that make it up.
    const invalid = gated && issues.some((issue) => overlaps(issue.path, key.path));

    for (const index of key.fields) write(form.fields[index]!.row, invalid);
  }

  return moved;
}

/** Whether `path` starts with `prefix`, both being authored names. */
function sameStart(path: readonly string[], prefix: readonly string[]): boolean {
  if (path.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false;
  return true;
}

/** Whether either path is a prefix of the other — segments compared as text. */
function overlaps(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) if (String(a[i]) !== String(b[i])) return false;
  return true;
}

/**
 * Fills one array field's per-row messages from the issues, and says whether anything moved.
 *
 * An issue belongs to a row when its path is the array's plus a **number** — `experience.0.title`
 * is row 0's, and `experience` alone is the section's. The first one per row wins, matching what
 * a wrapper does with several issues: one place to show a message means one message.
 *
 * `showAll` gates it exactly as it gates a wrapper. There is nothing to compare a row against —
 * the dirty test is a comparison with a compiled constant, and an array has none — so before a
 * first submit the rows stay quiet, and afterwards they update live like everything else.
 */
function rowMessages(
  array: FormBinding["arrays"][number],
  issues: readonly FormIssue[],
  showAll: boolean,
): boolean {
  const next: string[] = [];
  // Which *field* of each row is at fault, as the item path a `bind:value` recorded — so
  // `experience.0.title` becomes `title` against row 0. `applyRowValidity` turns that into a
  // control row, because only the list knows which replica is currently rendering row 0.
  const guilty: string[][] = [];

  if (showAll) {
    for (const issue of issues) {
      if (!isUnder(issue.path, array.path)) continue;
      const row = issue.path[array.path.length];
      if (typeof row !== "number") continue;
      if (next[row] === undefined) next[row] = issue.message;
      // "" means the row itself is at fault rather than one field in it — an issue at
      // `experience.0` with nothing after it.
      const field = issue.path.slice(array.path.length + 1).join(".");
      (guilty[row] ??= []).push(field);
    }
  }

  // Replaced wholesale rather than compared field by field: the guilty set is small, and a
  // stale entry here would leave a row wearing `:invalid` after its problem was fixed.
  const box = array.rowErrors!;
  let moved = box.invalid.length !== guilty.length;
  if (!moved) {
    for (let i = 0; i < guilty.length; i++) {
      if ((box.invalid[i] ?? []).join("|") === (guilty[i] ?? []).join("|")) continue;
      moved = true;
      break;
    }
  }
  box.invalid = guilty;

  const messages = box.messages;
  // Compared rather than replaced, so an unchanged validation costs no commit — and the box is
  // mutated in place because the list's text parts hold *this* object.
  const length = Math.max(messages.length, next.length);
  for (let i = 0; i < length; i++) {
    if ((messages[i] ?? "") === (next[i] ?? "")) continue;
    moved = true;
    messages.length = 0;
    for (let k = 0; k < next.length; k++) messages[k] = next[k] ?? "";
    break;
  }
  return moved;
}

/**
 * Whether an issue at `path` belongs to a wrapper at `prefix`. */
function isUnder(path: readonly (string | number)[], prefix: readonly string[]): boolean {
  if (path.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (String(path[i]) !== prefix[i]) return false;
  return true;
}

/**
 * Whether any control under this wrapper has moved off its compiled initial value.
 *
 * No stored flag, which is the point: the initial is a constant the compiler wrote into the
 * artifact, so this is a comparison. It is therefore *not* the sticky "has been modified"
 * flag TanStack calls `isDirty` — a field typed into and cleared again counts as clean here,
 * which is the behaviour that matters for "do not shout at an untouched field".
 */
function isDirty(form: FormBinding, group: FormBinding["groups"][number]): boolean {
  for (const index of group.fields) {
    const field = form.fields[index];
    if (field?.signal == null) continue;
    const current = field.signal.value;
    const initial = field.initial;
    if (Array.isArray(current) && Array.isArray(initial)) {
      if (current.length !== initial.length) return true;
      for (let i = 0; i < current.length; i++) if (current[i] !== initial[i]) return true;
      continue;
    }
    if (current !== initial) return true;
  }
  return false;
}

/** A validated payload, or the reasons it was rejected. */
export type Validated = { ok: true; value: unknown } | { ok: false; issues: FormIssue[] };

/**
 * The Standard Schema surface, restated rather than imported.
 *
 * `@standard-schema/spec` is types-only and would still be a dependency for a shape that is
 * four lines. Restating it is what keeps dziry able to validate with Zod, Valibot or
 * ArkType while depending on none of them.
 */
type StandardSchema = {
  "~standard": {
    validate: (value: unknown) => StandardResult | Promise<StandardResult>;
  };
};
type StandardResult = {
  value?: unknown;
  issues?: readonly { message: string; path?: readonly unknown[] }[];
};

/**
 * Runs `validate={…}` over a payload, whatever kind of thing it is.
 *
 * Three shapes are accepted, and **the order they are tested in is load-bearing**:
 *
 * 1. **A Standard Schema.** Anything carrying `~standard` — Zod 4, Valibot and ArkType do,
 *    natively, and so does anything an author has wrapped.
 * 2. **An Effect schema.** Recognised by its `ast`, and converted with Effect's own
 *    `Schema.standardSchemaV1` after a *lazy* import, so that `validate={Login}` works
 *    unwrapped without dziry depending on `effect`. Measured on effect 3.22: a
 *    `Schema.Struct` does **not** carry `~standard` itself, which is why this branch has to
 *    exist rather than being covered by the one above.
 * 3. **A plain function.** `(data) => issues | null`. The no-library case, and the escape
 *    hatch for a rule no schema expresses.
 *
 * The function test is **last**, and it was first until a test said otherwise: Effect's
 * schemas are *classes*, so `typeof schema === "function"` is true of one and calling it
 * throws `Cannot call a class constructor without |new|`. Ordering by specificity makes
 * that unreachable — a predicate carries neither `~standard` nor an `ast`, so neither
 * schema branch can swallow one.
 *
 * Synchronous whenever the validator is — Zod's and Effect's both are for ordinary schemas,
 * measured — so the common submit stays inside the caller's batch. A promise is returned
 * only when the validator itself returned one, or when the Effect import had to happen.
 */
export function validatePayload(
  validate: unknown,
  data: FormPayload,
): Validated | Promise<Validated> {
  const standard = (validate as StandardSchema | null)?.["~standard"];
  if (standard && typeof standard.validate === "function") {
    return settle(standard.validate(data), data);
  }

  if (isEffectSchema(validate)) return viaEffect(validate, data);

  if (typeof validate === "function") {
    return settle((validate as (d: FormPayload) => unknown)(data), data);
  }

  // Nothing recognisable. Refusing loudly beats submitting unvalidated data under a
  // `validate` prop the author believes is running.
  throw new TypeError(
    "validate={…} was given something that is neither a function, a Standard Schema " +
      "(Zod, Valibot, ArkType, or anything carrying `~standard`), nor an Effect schema.",
  );
}

/** A result of any accepted shape, reduced to [`Validated`]. */
function settle(result: unknown, data: FormPayload): Validated | Promise<Validated> {
  if (result instanceof Promise) return result.then((settled) => settle(settled, data) as Validated);

  // A predicate that returned nothing, or an empty list of complaints.
  if (result === undefined || result === null) return { ok: true, value: data };
  if (Array.isArray(result)) {
    return result.length === 0
      ? { ok: true, value: data }
      : { ok: false, issues: result.map(asIssue) };
  }

  const standard = result as StandardResult;
  if (standard.issues && standard.issues.length > 0) {
    return { ok: false, issues: standard.issues.map(asIssue) };
  }
  // `value` is the schema's *output*, which is the point of validating with one: an author
  // who wrote `Schema.NumberFromString` gets the number, not the payload's string.
  return { ok: true, value: "value" in standard ? standard.value : data };
}

/** Any of the issue shapes the three paths produce, reduced to [`FormIssue`]. */
function asIssue(raw: unknown): FormIssue {
  if (typeof raw === "string") return { path: [], message: raw };
  const issue = raw as { message?: unknown; path?: readonly unknown[] };
  return {
    message: String(issue.message ?? "invalid"),
    // Standard Schema allows a path segment to be either a key or an object carrying one,
    // and both spellings are in the wild — Zod emits keys, some emit segments.
    path: (issue.path ?? []).map((segment) =>
      segment !== null && typeof segment === "object" && "key" in segment
        ? ((segment as { key: string | number }).key)
        : (segment as string | number),
    ),
  };
}

/**
 * An Effect schema, by shape rather than by `instanceof`.
 *
 * `ast` with a `_tag` is what every `Schema` has and nothing else here does — checked
 * against Zod, which has no `ast` at all. A schema is also *callable*, so `typeof` is not
 * enough on its own.
 */
function isEffectSchema(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const ast = (value as { ast?: { _tag?: unknown } }).ast;
  return ast !== null && typeof ast === "object" && typeof ast._tag === "string";
}

/**
 * Where the Effect import's specifier is kept, and why it is not written inline.
 *
 * A dynamic `import("effect")` is still a *static* dependency to a bundler, so writing the
 * literal would make every app carry Effect — or fail to build for not having it. The
 * obvious dodge, a local `const specifier = "effect"`, does not work: **measured**, Bun's
 * bundler folds that one too and reports the same unresolved-module error the literal does.
 * It was written that way first, and the `runtime-surface` ratchet caught it — the bundle
 * went from 9,582 bytes to 1,050,133.
 *
 * A property read off this object is not folded (measured, same harness, 157 bytes), so
 * the specifier survives to run time and only an app that actually passed an Effect schema
 * ever resolves it.
 */
const EFFECT = { specifier: "effect" };

/**
 * Validates with Effect, importing it only if an Effect schema was actually passed.
 *
 * `Schema.standardSchemaV1` rather than `decodeUnknownEither` plus `ArrayFormatter`:
 * Effect's own conversion already reports *every* issue rather than the first, and reusing
 * it means there is one issue-shaping path here instead of two.
 */
async function viaEffect(schema: unknown, data: FormPayload): Promise<Validated> {
  let Schema: { standardSchemaV1: (s: unknown) => StandardSchema };
  try {
    ({ Schema } = (await import(EFFECT.specifier)) as {
      Schema: { standardSchemaV1: (s: unknown) => StandardSchema };
    });
  } catch {
    throw new TypeError(
      "validate={…} looks like an Effect schema, but `effect` could not be imported. " +
        "Install it, or pass Schema.standardSchemaV1(YourSchema) instead.",
    );
  }
  return settle(Schema.standardSchemaV1(schema)["~standard"].validate(data), data) as Validated;
}
