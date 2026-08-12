/**
 * Which controls a `<form>` submits, and as what.
 *
 * A browser builds its payload by walking the form for named controls and asking each one
 * for its current value. Every part of that walk except the *value* is a property of the
 * markup — which controls are named, which are disabled, what an option's value is, whether
 * two fields share a name — so all of it is decided here, at build time, and the runtime is
 * left reading cells.
 *
 * The rules are measured rather than recalled. `probes/form-data.html` builds forty-odd
 * forms and prints `new FormData(form).entries()` for each; every "measured" below cites a
 * row of that table, and BROWSER-FACTS.md holds the table itself.
 *
 * # The one thing that is not compile-time
 *
 * The payload reads **live state**, not attributes. The probe's last three rows prove it:
 * after writing `input.value`, `input.checked` and `select.selectedIndex`, the payload
 * changed and `getAttribute("value")`, `hasAttribute("checked")` and `hasAttribute
 * ("selected")` still said what the author wrote. So each field needs a cell.
 *
 * Where the cell comes from is the interesting half. A `bind:value` field already has one —
 * the author's signal. Everything else gets one the **compiler declares** in the artifact,
 * which is what makes the browser-shaped form work with no state module at all:
 *
 * ```tsx
 * <form onSubmit={save}>
 *   <input name="email" />
 *   <input name="age" type="number" />
 * </form>
 * ```
 *
 * That is the whole authoring surface, and it compiles to two `signal()` declarations in
 * `ui.gen.ts` that nothing outside the artifact can name. It passes the compile-time gate
 * the same way a list arena does: the *set* of cells, their initial values and which node
 * each belongs to are all fixed at build time, and nothing is discovered at run time.
 */
import type { FieldKind } from "../ir.ts";
import type { DynList, Element, Node } from "./html.ts";
import { listboxOf, optionsOf, uaParts } from "./ua-structure.ts";

/**
 * What one named control contributes, decided from the markup alone.
 *
 * Keyed by `Element` rather than by node id because it is resolved *before* the walk: the
 * walk needs the answer in order to give a text field its cell, and node ids do not exist
 * yet. `compile.ts` pairs it back up with node ids afterwards.
 */
export type FieldSpec = {
  el: Element;
  /** The innermost enclosing `<form>`. */
  form: Element;
  /**
   * Where this control's value sits in the payload — the chain of enclosing `field`
   * wrappers, then the control's own `name` if it has one.
   *
   * `["position", "x"]` for an `<input name="x">` inside `<div field="position">`, and
   * `["email"]` for a bare `<input>` inside `<div field="email">`. A control with neither is
   * not a field at all.
   *
   * The path *is* the leaf-or-branch answer, which is why there is no rule deciding it: a
   * wrapper whose children are unnamed produces a path ending at the wrapper, and a wrapper
   * whose children are named produces paths one level deeper. Both being true at once —
   * `["a"]` and `["a","x"]` in one form — is the contradiction `collectFields` reports.
   */
  path: string[];
  /** The last segment of [`path`], which is the key within its group. */
  name: string;
  kind: FieldKind;
  /**
   * The value this contributes when it is checked or chosen.
   *
   * `"on"` when a checkbox or radio has no `value` attribute — measured, and it is the
   * parser's invention rather than the author's, so it is applied here rather than being
   * re-invented at submit.
   */
  value: string;
  /** Each `<option>`'s submitted value in document order. `select` kinds only. */
  options: string[];
  /** The markup switches it off, so it contributes nothing. Inherited from a `<fieldset>`. */
  disabled: boolean;
  /** The compiler-declared cell's name, or `""` when the author's `bind:value` owns it. */
  cell: string;
  /** The declared cell's initial value. Absent when the author owns the cell. */
  initial?: string | boolean | number | number[];
};

/** A cell the artifact has to declare, in the order the artifact declares them. */
export type FieldCell = {
  /** `field_0`, `field_1`, … — a name nothing outside the artifact can reach. */
  name: string;
  initial: string | boolean | number | number[];
  /** The control it belongs to, for the comment the emitter writes beside it. */
  what: string;
};

/**
 * One `field` wrapper — the unit error state is kept for.
 *
 * Per wrapper the runtime stores exactly two things: whether it has an error, and the
 * message. Everything else a form library keeps per field is either derived or unnecessary
 * here — `dirty` is `cell !== initial` against a compile-time constant, so it needs no
 * storage, and `touched` existed only to gate error display, which `validateOn` does.
 */
export type FieldGroup = {
  el: Element;
  form: Element;
  /** The wrapper's own path, which every issue is prefix-matched against. */
  path: string[];
  /** Classes to wear while in error, or "" — the author's `errorClassName`. */
  errorClassName: string;
  /** The declared boolean cell driving that class. */
  errorCell: string;
  /**
   * The object `findToggles` keys this wrapper's patch on.
   *
   * A conditional class is keyed by the *signal driving it*, so every wrapper needs a
   * distinct one or twenty fields would share one patch and light up together. There is no
   * signal here — the cell is declared in the artifact — so this stands in for it, and
   * `resolve-refs` recognises the shape and emits the cell's name. The same trick the three
   * other nameless references use, each recognised by shape rather than by a flag.
   */
  errorSource: { cell: string };
  /**
   * Every element marked `error` under this wrapper, and the path each speaks for.
   *
   * A list rather than one cell, because a group can have more than one thing to say.
   * `<span error />` is the wrapper's own message; `<span error="street" />` is the message for
   * the field at `street` inside it. Both are the same mechanism — a path, a declared cell, a
   * text run — so the bare form is not a special case but the entry whose path *is* the
   * wrapper's.
   *
   * The **class stays one per wrapper**. `errorClassName` says "something under here is wrong",
   * which is a single fact however many messages describe it; only the text divides up.
   */
  messages: FieldMessage[];
};

/**
 * One `error` marker, and the path whose message it shows.
 *
 * The name is **relative to the wrapper**, exactly as a control's `name` is: inside
 * `<div field="address">`, `error="street"` means `address.street`. Dots go deeper, so
 * `error="line.one"` reaches into a nested group without needing a marker of its own there.
 */
export type FieldMessage = {
  el: Element;
  /** The wrapper's own path, or that plus the segments the marker named. */
  path: string[];
  /** The declared string cell this element's run reads. */
  cell: string;
};

/**
 * A `field` wrapper whose contents are a `map()` — the payload's one array.
 *
 * Everything else in this file resolves a *control* to a value. This resolves a wrapper to
 * the array behind the list inside it, and hands over the signal itself: the rows' state is
 * that array, so the payload entry is a read of it rather than a walk over cells.
 *
 * That is the answer to the question a repeating row asks, and it is the only answer that
 * stays compile-time. A row's controls live in an arena — `capacity` replicas of one
 * template, interchangeable by construction — so there is no per-row cell to declare and no
 * stable identity to hang one on. The array already has both: one entry per row, keyed.
 *
 * The consequence worth stating out loud is that the entry is the item **as authored**,
 * including any property no control edits. An `id` used as the list's `key` is in the
 * payload. Projecting it out would need the compiler to decide which properties are
 * "really" fields, and every rule for that is a guess about intent.
 */
export type FieldArray = {
  el: Element;
  form: Element;
  /** The wrapper chain, ending at this wrapper. */
  path: string[];
  /** The array signal the `map()` was called on. Named by the resolve pass. */
  source: unknown;
  /**
   * A `<span error />` *inside the row template*, or null.
   *
   * The row's own message, which is the one part of error display that can be per-row: every
   * replica owns its text slots, so the string can differ row by row. Colour cannot — replicas
   * share a style row — so a per-row border needs a predicate the engine owns, and that is not
   * built.
   */
  messageEl: Element | null;
  /**
   * The box those messages live in, `{ messages: string[] }` indexed by data position.
   *
   * Declared by the artifact and shared by two tables that never meet: validation writes it
   * through the form binding, and the list's slot refresh reads it through a text part. A cell
   * name rather than a signal because nothing subscribes — the refresh is driven by the same
   * commit the validation already causes.
   */
  rowErrors: { cell: string } | null;
};

/**
 * `type`, lowercased. `""` when absent, which for an `<input>` means `text`.
 *
 * A copy of `compile.ts`'s helper rather than an import, because importing it would make
 * this module depend on the 3,000-line one it is meant to keep out of.
 */
const typeOf = (el: Element): string => (el.attrs.get("type") ?? "").toLowerCase();

/**
 * The elements a form owns — HTML's "form-associated" ones, narrowed to what dziri has.
 *
 * `<button>` is in it and is not a field: it is here because *ownership* decides which
 * button Enter clicks, which is a different question from what the payload contains.
 */
const ASSOCIATED = new Set(["input", "select", "textarea", "button"]);

/**
 * Whether Enter anywhere in a form would click this element.
 *
 * Measured, `probes/implicit-submission.html`: a bare `<button>` is a submit button because
 * `type` defaults to `submit`; `type="button"` is not one and does not rescue a form that
 * would otherwise not submit; and `<input type=submit>` counts too.
 */
export function isSubmitButton(el: Element): boolean {
  if (el.tag === "button") {
    const type = typeOf(el);
    return type === "" || type === "submit";
  }
  return el.tag === "input" && typeOf(el) === "submit";
}

/**
 * Which form owns each control, and what each form owns.
 *
 * **Ownership is not ancestry**, and that is measured rather than inferred from the spec:
 * `probes/form-owner.html` puts a `form="F"` field outside F, inside a *different* form, and
 * pointing at an id that does not exist, and then asks all three of the questions a form
 * asks. Every one of them follows ownership:
 *
 * | markup | result |
 * |---|---|
 * | field after F with `form=F` | in F's payload, **at its document position** |
 * | field inside G with `form=F` | in **F**'s payload; G's is empty |
 * | field with `form=` a missing id | in **no** form's payload — it does not fall back to F |
 * | button after F with `form=F` | **is** F's default button: Enter clicks it |
 * | button inside F with `form=G` | is **not** F's default button; F fell through to its
 *   one-field rule |
 * | one field inside F, one with `form=F`, no button | Enter does **nothing** — so an
 *   associated field **counts** towards "exactly one blocking field" |
 *
 * The last two are the ones that decide the shape of the code. A subtree scan gets the first
 * of them wrong by finding a button that belongs to another form, and the second wrong by
 * counting one field when the form has two — so ownership has to be resolved once, here, and
 * everything else derived from it.
 *
 * Order is document order throughout, which the payload row above pins down: a field written
 * *before* the form it belongs to comes first in that form's payload.
 */
export type Ownership = {
  /** Every associated control each form owns, in document order. */
  byForm: Map<Element, Element[]>;
  /** The owner of each associated control. Absent means no form owns it. */
  owner: Map<Element, Element>;
};

export function formOwnership(root: Element): Ownership {
  const byId = new Map<string, Element>();
  const collectIds = (el: Element): void => {
    const id = el.attrs.get("id");
    if (el.tag === "form" && id !== undefined && !byId.has(id)) byId.set(id, el);
    for (const child of el.children) if (child.type === "element") collectIds(child);
  };
  collectIds(root);

  const byForm = new Map<Element, Element[]>();
  const owner = new Map<Element, Element>();

  const visit = (el: Element, ancestors: Element[]): void => {
    if (el.tag === "form" && !byForm.has(el)) byForm.set(el, []);

    if (ASSOCIATED.has(el.tag)) {
      const found = ownerOf(el, ancestors, byId);
      if (found !== null) {
        owner.set(el, found);
        // A form is always registered before its descendants are visited, but an *associated*
        // control can precede the form it names — the probe's "field before the form" row —
        // so the list has to be created on demand rather than only at the form.
        const list = byForm.get(found);
        if (list === undefined) byForm.set(found, [el]);
        else list.push(el);
      }
    }

    for (const child of el.children) {
      if (child.type === "element") visit(child, [...ancestors, child]);
    }
  };

  visit(root, [root]);
  return { byForm, owner };
}

/**
 * The form that owns one control.
 *
 * A `form="id"` attribute wins outright: it re-parents the control even out of another form,
 * and **a missing id orphans it** rather than falling back to the ancestor — measured, and
 * the fallback is what an implementation writes by accident.
 */
function ownerOf(
  el: Element,
  ancestors: readonly Element[],
  byId: ReadonlyMap<string, Element>,
): Element | null {
  const named = el.attrs.get("form");
  if (named !== undefined) return byId.get(named) ?? null;

  // The *innermost* enclosing form, so nested forms — invalid HTML that parses anyway —
  // resolve the way the DOM does rather than throwing.
  let found: Element | null = null;
  for (const ancestor of ancestors) if (ancestor.tag === "form") found = ancestor;
  return found;
}

/**
 * `<input>` types that submit nothing of their own.
 *
 * Measured: `type=button` and `type=reset` contribute nothing even when named, and an
 * `input[type=submit][name]` contributes only when it is the button that submitted — which
 * is the submitter rule, handled at submit rather than here.
 */
const NON_FIELD_TYPES = new Set(["button", "reset", "image"]);

/** Types whose value a payload should hand over as a number rather than a string. */
const NUMERIC_TYPES = new Set(["number", "range"]);

/**
 * How this element contributes to a payload, or null if it does not.
 *
 * Note what is *not* consulted: `name`. A control with no name is not a field — measured,
 * `text, nameless -> (empty)` — but that is a question about the form, not about the kind,
 * and keeping them apart is what lets the warning below name the two cases separately.
 */
export function fieldKindOf(el: Element): FieldKind | null {
  if (el.tag === "textarea") return "text";
  // A list box and a dropdown differ in how the *engine* reports a change — a set beside
  // the event against an index inside it — which is what this distinguishes. How many
  // values it submits is a different question, answered by `multiple` in `shapeOf`.
  if (el.tag === "select") return listboxOf(el) !== null ? "selectMultiple" : "select";
  // A named submit button, which is a field only in the sense that it can put an entry in
  // the payload. It has no cell: whether it contributes depends on which button was pressed.
  if (el.tag === "button") return isSubmitButton(el) ? "submitter" : null;
  if (el.tag !== "input") return null;
  const type = typeOf(el);
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (NUMERIC_TYPES.has(type)) return "number";
  if (type === "submit") return "submitter";
  if (NON_FIELD_TYPES.has(type)) return null;
  // `file` is a field in a browser and cannot be one here: there is no file picker, and a
  // payload entry holding a `File` would promise one. Refused by name in `collectFields`.
  if (type === "file") return null;
  return "text";
}

/**
 * The static text of a subtree — an option's label, or a `<textarea>`'s default value.
 *
 * Static only, and the consequence is worth stating: `<option>{name}</option>` submits an
 * empty value rather than a wrong one. A dynamic option label would need its own binding
 * driving the payload, and an option's *value* is not a thing that changes.
 */
function staticText(node: Node): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(staticText).join("");
  return "";
}

/**
 * What one `<option>` submits.
 *
 * Measured twice over: an option with no `value` submits its **text**, and that text is
 * **trimmed** — `<option>  two  </option>` submits `"two"`. Both are easy to get wrong in
 * the direction that looks right, since the label a user reads is the padded one.
 */
export function optionValue(option: Element): string {
  return option.attrs.get("value") ?? staticText(option).trim();
}

/** Every option value of a `<select>`, in the order the engine indexes them. */
export function optionValues(select: Element): string[] {
  return optionsOf(select.children).map(optionValue);
}

/**
 * Whether the markup switches this control off.
 *
 * **Inherited**, which is the part a per-element reading gets wrong: measured, a field
 * inside a `<fieldset disabled>` contributes nothing, and a field inside that fieldset's
 * **first `<legend>`** contributes normally. The legend exception is not decoration — it is
 * how a disabled group keeps a working "enable this section" checkbox in its own heading.
 */
export function markupDisabled(el: Element, path: readonly Element[]): boolean {
  if (el.attrs.has("disabled")) return true;

  for (let i = 0; i < path.length; i++) {
    const ancestor = path[i]!;
    if (ancestor.tag !== "fieldset" || !ancestor.attrs.has("disabled")) continue;
    const legend = ancestor.children.find((c) => c.type === "element" && c.tag === "legend");
    // `path[i + 1]` is the child of the fieldset this element descends through, so this
    // asks "did we come in through the first legend" rather than "is there a legend".
    if (legend !== undefined && path[i + 1] === legend) continue;
    return true;
  }

  return false;
}

/**
 * The cell a field starts from, before anyone has typed or clicked.
 *
 * A `submitter` never gets one — see `collectFields` — so it falls through to the string
 * branch, which is harmless and unread.
 */
function initialOf(el: Element, kind: FieldKind): string | boolean | number | number[] {
  switch (kind) {
    case "checkbox":
    case "radio":
      return el.attrs.has("checked");
    case "select": {
      // From `uaParts`, not from the attribute, and that is load-bearing: a dropdown with
      // no `selected` shows — and submits — its **first** option, and the compiler already
      // decides that once for the baked label and the engine's initial `CHECKED`. Deciding
      // it twice is how the payload and the pixels come to disagree.
      const chosen = uaParts(el).selected;
      const options = optionsOf(el.children);
      const index = options.findIndex((o) => chosen.has(o));
      return index < 0 ? 0 : index;
    }
    case "selectMultiple": {
      const chosen = uaParts(el).selected;
      return optionsOf(el.children).flatMap((o, i) => (chosen.has(o) ? [i] : []));
    }
    default:
      // A `<textarea>`'s default value is its content; an `<input>`'s is its `value`.
      return el.tag === "textarea"
        ? el.children.map(staticText).join("")
        : (el.attrs.get("value") ?? "");
  }
}

/**
 * Every named control inside a `<form>`, plus the cells the artifact must declare.
 *
 * A pure pass over the authored tree, run before the walk. Pure so it can be tested
 * directly — the payload's shape is the part of this feature most likely to be argued
 * about, and arguing about it through a rendered frame would be miserable.
 *
 * `warn` collects the cases that compile but will not do what the author meant.
 */
export function collectFields(
  root: Element,
  warn: (message: string) => void = () => {},
  ownership: Ownership = formOwnership(root),
): {
  specs: Map<Element, FieldSpec>;
  cells: FieldCell[];
  groups: FieldGroup[];
  arrays: FieldArray[];
} {
  const specs = new Map<Element, FieldSpec>();
  const cells: FieldCell[] = [];
  const groups: FieldGroup[] = [];
  const arrays: FieldArray[] = [];

  const visit = (el: Element, path: Element[], prefix: string[]): void => {
    const kind = fieldKindOf(el);
    const name = el.attrs.get("name") ?? "";
    // Ownership rather than ancestry — see [`formOwnership`]. `?? null` because a control
    // with a `form=` naming an id that does not exist is owned by nothing, measured.
    const form = ownership.owner.get(el) ?? null;

    // A `field` wrapper deepens the path for everything inside it, and is the unit error
    // state is kept for. Its own form is the one it is *inside*, since a wrapper is not a
    // control and so has no `form=` of its own to honour.
    const group = el.attrs.get("field") ?? "";
    let here = prefix;
    if (group !== "") {
      here = [...prefix, group];
      const owner = enclosingForm(path);
      if (owner === null) {
        warn(
          `<${el.tag} field="${group}"> is not inside a <form>, so nothing collects it.\n` +
            `    A field wrapper names part of a form's payload; outside one there is no\n` +
            `    payload for it to name.`,
        );
      } else {
        const errorClassName = el.errorClassName ?? "";
        const errorCell = `fieldError_${groups.length}`;
        const errorSource = { cell: errorCell };

        // The class is applied through the machinery an authored `cn("x", { on: sig })`
        // already uses, by writing the entry a `classWhen` would have had. Done here because
        // this pass runs at the top of `compileTree`, which is before both `findToggles` and
        // `compileVariants` see the document — so both observe it, and neither needs to know
        // that a form put it there.
        //
        // Idempotent, because `compileVariants` compiles the same tree a second time.
        if (errorClassName !== "" && !(el.classWhen?.[errorClassName] as unknown)) {
          el.classWhen = { ...el.classWhen, [errorClassName]: errorSource };
        }

        // A wrapper holding a `map()` is an array field, and the list's own array is its
        // value. Recorded beside the group rather than instead of it, so the wrapper still
        // has its error cells: an issue at `experience.0.title` lights it up by the same
        // prefix rule every other wrapper uses.
        const lists = enclosedLists(el);
        if (lists.length > 0) {
          // The row's own message element, found in the *template* — which `findMarked` above
          // cannot reach, because a `dynlist` is not an element child and the section's own
          // scan deliberately stops at one. So the two never claim the same span.
          const rowMessage = markedIn(lists[0]!.template);
          arrays.push({
            el,
            form: owner,
            path: here,
            source: lists[0]!.source,
            messageEl: rowMessage,
            rowErrors: rowMessage === null ? null : { cell: `rowErrors_${arrays.length}` },
          });
        }
        if (lists.length > 1) {
          warn(
            `<${el.tag} field="${group}"> holds ${lists.length} map() lists, and one key ` +
              `cannot hold two arrays.\n` +
              `    The payload's "${here.join(".")}" is the first list's array; the rest ` +
              `contribute nothing.\n` +
              `    Give each list its own <div field="…">.`,
          );
        }

        groups.push({
          el,
          form: owner,
          path: here,
          errorClassName,
          // Declared even with no `errorClassName`, because the message may still be shown
          // and both cells are written together. An unused cell costs one `signal(false)` in
          // the artifact and no writes: nothing subscribes to it.
          errorCell,
          errorSource,
          messages: markedUnder(el, here).map((found, i) => ({
            el: found.el,
            path: found.path,
            cell: `fieldMessage_${groups.length}_${i}`,
          })),
        });
      }
    }

    if (kind !== null && (name !== "" || here.length > 0) && form !== null) {
      // A `bind:value` field keeps the author's signal — two cells for one field would
      // mean the payload and the rendered text could disagree. A **submitter** gets no cell
      // at all: what it contributes depends on which button was pressed, which is not a
      // value anything can hold between submissions.
      const declared = el.bindValue === null && kind !== "submitter";
      const cell = declared ? `field_${cells.length}` : "";
      const initial = initialOf(el, kind);
      if (declared) {
        cells.push({ name: cell, initial, what: describe(el, name) });
      }

      // The wrapper chain, then this control's own name. A control with no name takes the
      // wrapper's path as its own, which is what makes a wrapper holding one bare input
      // *be* that field.
      //
      // **A radio is the exception**, and it has to be. Its `name` is not a key, it is what
      // *groups* it: the engine interns a radio group on `(form, name)`, so a set cannot share
      // one without sharing a name. Counting that name as a path segment turned the obvious
      // markup — `<div field="plan">` holding radios named `plan` — into `plan.plan`, which is
      // what the demo produced the first time it compiled. Inside a wrapper the wrapper names
      // the value, which is right for the same reason the shape is `one`: a radio set is many
      // elements and a single answer. Outside a wrapper the name is still the key, so a flat
      // form is unchanged.
      const full =
        name === "" || (kind === "radio" && here.length > 0) ? here : [...here, name];

      specs.set(el, {
        el,
        form,
        path: full,
        name: full[full.length - 1] ?? "",
        kind,
        // Measured: a checked box with no `value` submits `"on"`, and one with `value=""`
        // submits the empty string — so the fallback is on absence, not on emptiness.
        value: el.attrs.get("value") ?? (kind === "checkbox" || kind === "radio" ? "on" : ""),
        options: kind === "select" || kind === "selectMultiple" ? optionValues(el) : [],
        disabled: markupDisabled(el, path),
        cell,
        ...(declared ? { initial } : {}),
      });
    }

    // The two cases that compile and quietly do nothing, and **only** while somebody is
    // reading a payload: a nameless control is perfectly ordinary in a form nobody submits,
    // and warning about it there would be noise on markup that is not wrong.
    //
    // Two other cases deliberately say nothing. A named control *outside* a form is normal
    // — `name` is what groups a radio set, form or no form — and a `<select>` with no name
    // is the commonest control there is.
    if (form !== null && form.onSubmit) {
      // A submit button is exempt: `<button>Save</button>` is what almost every form has, and
      // telling an author to name it so it can add an entry they did not ask for would be
      // advice rather than a warning.
      // ...and a control inside a `field` wrapper is exempt too, because the wrapper named
      // it. That is the whole point of the wrapper.
      if (
        kind !== null &&
        kind !== "submitter" &&
        name === "" &&
        here.length === 0 &&
        el.tag !== "select"
      ) {
        warn(
          `<${el.tag}> inside a submitting <form> has no name, so it is not in the payload.\n` +
            `    Give it a name, or wrap it in <div field="…">. A browser leaves a nameless\n` +
            `    control out too (measured, probes/form-data.html), so this is faithful rather\n` +
            `    than a limitation — but it is also the commonest reason a field an author can\n` +
            `    see is missing from what onSubmit receives.`,
        );
      }
      if (el.tag === "input" && typeOf(el) === "file" && name !== "") {
        warn(
          `<input type="file" name="${name}"> is not in the payload.\n` +
            `    dziri has no file picker, so there is no file to submit and no File to put in\n` +
            `    the entry. The element still compiles to a box; it just contributes nothing.`,
        );
      }
    }

    for (const child of el.children) {
      if (child.type !== "element") continue;
      visit(child, [...path, child], here);
    }
  };

  visit(root, [root], []);
  reportPathConflicts(specs, warn, arrays);
  reportUnreachableMessages(specs, groups, warn);
  return { specs, cells, groups, arrays };
}

/**
 * Every `map()` inside this wrapper.
 *
 * Stops at a nested `field` wrapper, which is the containment rule the paths and the error
 * message element already follow: a list inside an inner group belongs to that group.
 *
 * Plural so that two lists under one wrapper can be *reported* — one key cannot hold two
 * arrays, and picking the first silently would drop the other one's rows from the payload.
 */
function enclosedLists(wrapper: Element): DynList[] {
  const found: DynList[] = [];
  const scan = (el: Element): void => {
    for (const child of el.children) {
      if (child.type === "dynlist") {
        found.push(child);
        continue;
      }
      if (child.type !== "element") continue;
      if (child.attrs.has("field")) continue;
      scan(child);
    }
  };
  scan(wrapper);
  return found;
}

/**
 * The one contradiction the path model can produce: a path that is both a leaf and a branch.
 *
 * `<div field="a"><input><input name="x"></div>` asks for `a` to be a string *and* an object
 * at once, which is the case a leaf-or-branch rule would have had to decide arbitrarily. The
 * path makes it visible instead — one control claims `["a"]` and another claims `["a","x"]` —
 * so it is reported rather than resolved, because either answer silently drops a field.
 */
function reportPathConflicts(
  specs: Map<Element, FieldSpec>,
  warn: (message: string) => void,
  arrays: readonly FieldArray[] = [],
): void {
  // An array wrapper claims its path as a *value* — the list's array — so a control claiming
  // the same path, or anything under it, is the contradiction below arrived at from the other
  // direction. Reported separately because the fix differs: the rows are what the wrapper
  // holds, so it is the control that has to move.
  for (const array of arrays) {
    const prefix = array.path.join(".");
    for (const spec of specs.values()) {
      const path = spec.path.join(".");
      if (path !== prefix && !path.startsWith(`${prefix}.`)) continue;
      warn(
        `"${prefix}" is both a map() list and a field.\n` +
          `    The wrapper's value is the list's array, so a control inside it claiming ` +
          `"${path}"\n` +
          `    has nowhere to go: one key cannot be an array and an object at once. Move that\n` +
          `    control out of the wrapper, or give it its own <div field="…"> beside the list.`,
      );
      break;
    }
  }

  const claimed = new Set<string>();
  for (const spec of specs.values()) claimed.add(spec.path.join("\u0000"));

  // Two *different* radio groups under one wrapper. Each takes the wrapper's path — a radio's
  // name groups it rather than keying it — so both claim one key and only one answer could
  // survive. Reported rather than resolved: the fix is a wrapper per group, and no default
  // choice here would be right.
  const radioNames = new Map<string, Set<string>>();
  for (const spec of specs.values()) {
    if (spec.kind !== "radio") continue;
    const key = spec.path.join(".");
    const names = radioNames.get(key) ?? new Set<string>();
    names.add(spec.el.attrs.get("name") ?? "");
    radioNames.set(key, names);
  }
  for (const [key, names] of radioNames) {
    if (names.size < 2) continue;
    warn(
      `two radio groups share the field "${key}".\n` +
        `    A radio's name groups it rather than naming it, so ${[...names]
          .map((n) => `"${n}"`)
          .join(" and ")} both claim that\n` +
        `    key and only one answer would survive. Give each group its own <div field="…">.`,
    );
  }

  const said = new Set<string>();
  for (const spec of specs.values()) {
    for (let cut = 1; cut < spec.path.length; cut++) {
      const ancestor = spec.path.slice(0, cut).join("\u0000");
      if (!claimed.has(ancestor) || said.has(ancestor)) continue;
      said.add(ancestor);
      const dotted = spec.path.slice(0, cut).join(".");
      warn(
        `"${dotted}" is claimed as both a value and a group.\n` +
          `    One control puts a value at "${dotted}" and another puts one at ` +
          `"${spec.path.join(".")}",\n` +
          `    so the payload would need it to be a string and an object at once. This is a\n` +
          `    wrapper holding a bare control *and* a named one: give the bare one a name, or\n` +
          `    move it out of the wrapper.`,
      );
    }
  }
}

/**
 * A `<span error="…">` that names a path no field can ever produce.
 *
 * The cost of letting a marker carry a name: `error="stret"` compiles, renders an empty span,
 * and stays empty forever — a message that never appears is indistinguishable from a field that
 * is never wrong. So the name is checked against the paths that exist, which the same pass has
 * just finished collecting.
 *
 * A path **at or above** a real field counts, because a validator may complain about a group as
 * well as a leaf: `error="address"` is legitimate beside `error="address.city"`.
 */
function reportUnreachableMessages(
  specs: Map<Element, FieldSpec>,
  groups: readonly FieldGroup[],
  warn: (message: string) => void,
): void {
  const reachable = new Set<string>();
  for (const spec of specs.values()) {
    for (let cut = 1; cut <= spec.path.length; cut++) {
      reachable.add(spec.path.slice(0, cut).join("."));
    }
  }
  // A wrapper's own path is reachable even with no control under it yet — an array field's is
  // the case, since its rows are not walked.
  for (const group of groups) reachable.add(group.path.join("."));

  for (const group of groups) {
    for (const message of group.messages) {
      const dotted = message.path.join(".");
      if (reachable.has(dotted)) continue;
      warn(
        `<${message.el.tag} error="${message.path.slice(group.path.length).join(".")}"> names ` +
          `"${dotted}", which no field produces.\n` +
          `    The name is relative to the <${group.el.tag} field="${group.path[group.path.length - 1]}">` +
          ` around it, so it should be one of\n` +
          `    that wrapper's own controls. As written the message can never appear, which looks\n` +
          `    exactly like a field that is never wrong.`,
      );
    }
  }
}

/** The innermost `<form>` among these ancestors, or null. */
function enclosingForm(ancestors: readonly Element[]): Element | null {
  let found: Element | null = null;
  for (const el of ancestors) if (el.tag === "form") found = el;
  return found;
}

/**
 * Every descendant marked `error`, with the path each one speaks for.
 *
 * The scan stops at a nested `field` wrapper, so an inner group's markers belong to the inner
 * group — the same containment rule the paths follow, which is what keeps two wrappers from
 * both claiming one span.
 *
 * A marker's value is a name **relative to this wrapper**: bare is the wrapper's own message,
 * `error="street"` is the field at `street` inside it, and dots go deeper. Relative rather than
 * absolute for the reason `name` is: a group should be movable — renaming the wrapper or nesting
 * it deeper must not require editing the markers inside it.
 */
function markedUnder(wrapper: Element, here: string[]): { el: Element; path: string[] }[] {
  const found: { el: Element; path: string[] }[] = [];

  const scan = (el: Element): void => {
    for (const child of el.children) {
      if (child.type !== "element") continue;
      const marker = child.attrs.get("error");
      if (marker !== undefined) {
        // `""` is the bare marker: JSX lowers a valueless attribute to the empty string, which
        // is also what HTML says `<span error>` means.
        const name = marker.trim();
        found.push({
          el: child,
          path: name === "" ? here : [...here, ...name.split(".").filter((s) => s !== "")],
        });
        // Not `continue`-d past: a marker is a leaf as far as this scan cares, and nesting one
        // inside another is markup nobody writes on purpose.
        continue;
      }
      if (child.attrs.has("field")) continue;
      scan(child);
    }
  };

  scan(wrapper);
  return found;
}

/**
 * The first bare `error` marker under `wrapper`, for the callers that want exactly one.
 *
 * A row template is the case: its message is per row, written into a slot rather than a cell,
 * so a *named* marker there would mean something this does not implement — see `FieldArray`.
 */
function findMarked(wrapper: Element): Element | null {
  const bare = markedUnder(wrapper, []).find((m) => m.path.length === 0);
  return bare?.el ?? null;
}

/**
 * The element marked `error` in a row template, including the template's own root.
 *
 * The root is checked as well as the descendants because a one-element row is a real template
 * — `{rows.map(r => <span error />)}` is odd but not wrong — and `findMarked` only ever looks
 * downward from a wrapper it knows is not itself the target.
 */
function markedIn(template: Node): Element | null {
  if (template.type !== "element") return null;
  if (template.attrs.has("error")) return template;
  return findMarked(template);
}

/** `input[type=email][name=…]`, for a warning that has to be findable in a page. */
function describe(el: Element, name: string): string {
  const type = el.attrs.get("type");
  return `<${el.tag}${type ? ` type="${type}"` : ""} name="${name || "…"}">`;
}

/**
 * The payload's keys and the shape of each value, from the fields that claim them.
 *
 * Decided here rather than by grouping at submit, and that is the whole point: a schema —
 * and the author reading its inferred type — needs `tags` to be an array on every submit,
 * not an array when two boxes are ticked and a string when one is. A browser has no such
 * problem because `FormData` is a multimap and never had a shape to keep stable.
 *
 * `fields` are indices into the form's field list, in document order — measured to be the
 * order a browser's entries come in, including for two controls sharing a name.
 */
export function formKeys(
  fields: readonly { path: string[]; kind: FieldKind; el: Element }[],
): {
  path: string[];
  shape: "text" | "number" | "boolean" | "one" | "many";
  fields: number[];
}[] {
  const order: string[] = [];
  const byPath = new Map<string, number[]>();

  // Grouped by the *whole* path, so `position.x` and `size.x` are two keys rather than one —
  // which is the collision a flat form has and a namespace does not.
  for (let i = 0; i < fields.length; i++) {
    const key = fields[i]!.path.join("\u0000");
    let group = byPath.get(key);
    if (group === undefined) {
      group = [];
      byPath.set(key, group);
      order.push(key);
    }
    group.push(i);
  }

  return order.map((key) => {
    const indices = byPath.get(key)!;
    const members = indices.map((i) => fields[i]!);
    const first = members[0]!;

    // A `<select multiple>` is the one control that is a list all by itself. A list box
    // *without* `multiple` is not — `size` decides how it is drawn and reports changes,
    // and `multiple` decides how many values it can hold.
    const multiSelect = members.some(
      (f) => f.kind === "selectMultiple" && f.el.attrs.has("multiple"),
    );
    // A radio set is many elements and one value; that is what a radio set *is*. Two submit
    // buttons sharing a name are the same story for a different reason: only one of them can
    // be the button that submitted, so the pair can never contribute twice.
    const allOne = members.every((f) => f.kind === "radio" || f.kind === "submitter");

    const shape = multiSelect
      ? "many"
      : members.length > 1
        ? allOne
          ? "one"
          : "many"
        : first.kind === "radio" || first.kind === "submitter"
          ? "one"
          : first.kind === "checkbox"
            // A lone valueless checkbox is the one place dziri deliberately parts company
            // with the payload a browser builds. A browser omits an unchecked box entirely,
            // which makes `terms` present-or-absent; here it is `true` or `false`, because
            // that is what a schema wants and what an author reading `data.terms` expects.
            // A checkbox carrying a `value` keeps the browser's meaning: that value, or
            // nothing.
            ? (first.el.attrs.has("value") ? "one" : "boolean")
            : first.kind === "selectMultiple"
              // A single-selection list box can genuinely have nothing selected — measured,
              // it starts with `selectedIndex` of -1 — so it is optional where a dropdown,
              // which always falls back to its first option, is not.
              ? "one"
              : first.kind === "number"
                ? "number"
                : "text";

    return { path: first.path, shape, fields: indices };
  });
}
