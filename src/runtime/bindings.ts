/**
 * Applies state to the IR.
 *
 * This is the whole of what the runtime does about dynamic values: build each
 * bound text run from its parts, write it into the string slot the compiler
 * reserved, and report whether anything changed. No diffing, no reconciliation,
 * no dependency discovery — the compiler already decided which node reads which
 * signal.
 */
import { findRow } from "../find-row.ts";
import type { CompiledUi, FormBinding } from "../ir.ts";
import { ControlFlags, ControlKind } from "../protocol/generated.ts";
import {
  isRangeControl,
  numericFor,
  rangePermille,
  rangeValue,
  stepValue,
} from "./numerics.ts";
import { applyIssues, formPayload, validatePayload, type Validated } from "./forms.ts";
import { runDispatched } from "./effects.ts";
import { batch, type Signal } from "./signal.ts";

/**
 * The longest string a single slot may hold, in characters.
 *
 * Every sink that writes typed text into a slot stops here. It lives in the
 * runtime rather than beside the arena it protects, because this is the only
 * layer that can refuse: by the time the uploader sees the string, the slot is
 * already sized for it. Generous for a text field, and finite, which is the
 * property that matters — the engine's arenas only ever grow.
 */
export const MAX_SLOT_CHARS = 64 * 1024;

export const Dirty = { NONE: 0, PAINT: 1, LAYOUT: 2 } as const;
export type Dirty = (typeof Dirty)[keyof typeof Dirty];

/**
 * Recomputes every bound text run, appending the nodes whose text changed to
 * `changed`.
 *
 * A changed string means a changed advance width, so those nodes need measuring
 * again — but only those, and their ancestors. Reporting *which* nodes changed is
 * what lets the caller avoid re-measuring the whole tree.
 *
 * `changed` is caller-owned so the steady state allocates nothing.
 */
export function applyTextBindings(ui: CompiledUi, changed?: number[]): Dirty {
  let dirty: Dirty = Dirty.NONE;

  for (const binding of ui.textBindings) {
    let next = "";
    for (const part of binding.parts) {
      next += "literal" in part ? part.literal : String(part.signal.value);
    }

    if (ui.strings[binding.slot] !== next) {
      ui.strings[binding.slot] = next;
      changed?.push(binding.node);
      dirty = Dirty.LAYOUT;
    }
  }

  return dirty;
}

/**
 * Applies dynamic image sources: rewrites the string slot each `bind:src`
 * points at when its signal has moved.
 *
 * Same incremental-string mechanism as `applyTextBindings` — a changed string
 * means the loader picks the new path up on the next frame, so this is a
 * `Dirty.LAYOUT` (the image's box may need re-measuring).
 */
export function applyImageBindings(ui: CompiledUi): Dirty {
  let dirty: Dirty = Dirty.NONE;

  for (const binding of ui.imageBindings) {
    const next = String(binding.signal.value);
    if (ui.strings[binding.slot] !== next) {
      ui.strings[binding.slot] = next;
      dirty = Dirty.LAYOUT;
    }
  }

  return dirty;
}

/**
 * Subscribes `onChange` to every signal any image binding reads.
 */
export function subscribeImageBindings(ui: CompiledUi, onChange: () => void): () => void {
  const unsubscribes = ui.imageBindings.map((b) => b.signal.subscribe(onChange));
  return () => {
    for (const off of unsubscribes) off();
  };
}

/**
 * Subscribes `onChange` to every signal any binding reads.
 *
 * Deliberately coarse: one callback for the whole document rather than per-node
 * effects. Recomputing all bindings is a handful of string builds, while the
 * bookkeeping to track which binding to revisit would cost more than it saves at
 * this scale. Per-binding effects become worthwhile only if binding counts grow
 * by orders of magnitude.
 */
export function subscribeBindings(ui: CompiledUi, onChange: () => void): () => void {
  const seen = new Set<unknown>();
  const unsubscribes: (() => void)[] = [];

  for (const binding of ui.textBindings) {
    for (const part of binding.parts) {
      if ("literal" in part || seen.has(part.signal)) continue;
      seen.add(part.signal);
      unsubscribes.push(part.signal.subscribe(onChange));
    }
  }

  return () => {
    for (const off of unsubscribes) off();
  };
}

export type EditableRef = { node: number; signal: Signal<string> };

/**
 * A dynamic `src` on an `<img>`, from `bind:src={sig}`.
 *
 * The slot is the string the image table points into; when the signal moves the
 * worker rewrites `strings[slot]` and the loader picks the new path up on the
 * next frame.
 */
export type ImageBinding = { node: number; slot: number; signal: Signal<string> };

// The numeric bridge's pure half lives in `numerics.ts` (shared with
// `forms.ts`, which this module already imports — a shared home is the only
// acyclic one). Re-exported so the worker and tests import one place.
export { numericFor, rangePermille, rangeValue } from "./numerics.ts";

/**
 * The engine's slider CHANGE, written to the bound signal if there is one.
 *
 * A slider with `bind:value` is two-way like any field: the drag writes the
 * signal here, and `writeRangeValue` carries a signal write back to the thumb.
 * The number is stringified because a field's signal holds text — the same
 * shape `bind:value` has everywhere else, so one signal type serves both.
 */
export function applyRangeChange(
  ui: CompiledUi,
  editables: EditableRef[],
  node: number,
  perMille: number,
): boolean {
  const target = editables.find((e) => e.node === node);
  if (!target) return false;
  const value = rangeValue(ui, node, perMille);
  if (value === null) return false;
  const next = String(value);
  if (target.signal.value === next) return true;
  batch(() => {
    target.signal.value = next;
  });
  return true;
}

/**
 * A bound slider's signal, written back into the controls table as per-mille.
 *
 * The other direction of `applyRangeChange`: a reset button sets the signal,
 * and the thumb has to follow. The engine applies the table value on rescan
 * only when it *changed*, so writing here cannot fight a drag in progress —
 * a drag reports through `applyRangeChange`, which writes this same signal,
 * and the round trip lands on the value the engine already has.
 *
 * Returns the dirty level: the controls table is uploaded on
 * `controlsDirty`, and a thumb that moved is a paint, not a layout.
 */
export function writeRangeValue(ui: CompiledUi, node: number, value: number): Dirty {
  const perMille = rangePermille(ui, node, value);
  if (perMille === null) return Dirty.NONE;
  let dirty: Dirty = Dirty.NONE;
  for (let r = 0; r < ui.controls.count; r++) {
    // Every row naming this node: a slider in a list template is one row per
    // replica, and the replica showing this value is not knowable here — so all
    // of them, which is right only because replicas share the template's value.
    if (ui.controls.node[r] !== node) continue;
    if (ui.controls.value[r] !== perMille) {
      ui.controls.value[r] = perMille;
      dirty = Dirty.PAINT;
    }
  }
  return dirty;
}

/**
 * ArrowUp/ArrowDown on a number field: step the value, clamped.
 *
 * Here and not in the engine for the reason the whole numeric bridge is: the
 * value is a signal, and signals are Bun's. The engine forwards the two keys
 * (they are not caret moves on a single-line field) and this answers them.
 *
 * An empty field steps from `min` — or from 0 when unbounded — which is what a
 * browser does: the first ArrowUp on an empty `min="10"` field gives 10, not 1.
 */
export function stepNumber(
  ui: CompiledUi,
  editables: EditableRef[],
  node: number,
  direction: 1 | -1,
): boolean {
  if (isRangeControl(ui, node)) return false; // the engine already answered it
  const n = numericFor(ui, node);
  if (n === null) return false;
  const target = editables.find((e) => e.node === node);
  if (!target) return false;

  batch(() => {
    target.signal.value = stepValue(target.signal.value, n, direction);
  });
  return true;
}


/**
 * Which way an erasing key eats: Backspace behind the caret, Delete in front of it.
 *
 * A union rather than two booleans, because "backspace and forward-delete at once" is not
 * a state any keyboard can produce and a shape that can express it invites a caller to
 * try.
 */
export type Erase = "backward" | "forward";

/**
 * Routes a keystroke into the focused editable, **at the caret or over the selection**.
 *
 * Insert and delete at `caret`, which the engine reports beside the text — it owns the
 * index, this owns the string. `caret` is a character offset, not a byte one, and is
 * clamped rather than trusted: it crossed a process boundary and the value may have been
 * rewritten by app code since the engine read it.
 *
 * `anchor` is the selection's other end. When it differs from `caret` there is a live range,
 * and **every** editing key replaces exactly that range — measured, and the surprise is that
 * Backspace and Delete become identical there: both erase the range and neither takes the
 * extra character its collapsed behaviour would. So the erase direction is consulted only on
 * a collapsed caret.
 *
 * A `caret` of -1 means "no caret", which is what a keystroke arriving with nothing focused
 * looks like. It appends, so a host that never places a caret still behaves as this did
 * before there was one.
 *
 * Still no clipboard.
 *
 * Returns true if the key was consumed.
 */
export function typeInto(
  editables: EditableRef[],
  focused: number,
  input: { text: string | null; erase?: Erase; caret?: number; anchor?: number },
): boolean {
  const target = editables.find((e) => e.node === focused);
  if (!target) return false;

  const edit = editText(target.signal.value, input);
  if (typeof edit !== "string") return edit;

  batch(() => {
    target.signal.value = edit;
  });
  return true;
}

/** What one keystroke does to one string: the new text, or whether it was consumed. */
export type Edit = string | boolean;

/**
 * The splice a keystroke makes, with nowhere to put the result.
 *
 * Separated from [`typeInto`] when a second kind of target appeared — a `bind:value` inside
 * a `map()` row, whose text lives in an item of an array rather than in a signal. Both paths
 * have to agree on *every* rule below (character counting, range ordering, what counts as
 * consumed, the slot ceiling), and the way to guarantee that is to have one of them.
 *
 * `false` means "not a key this owns", `true` means consumed with nothing changed, and a
 * string is the new value.
 */
export function editText(
  current: string,
  input: { text: string | null; erase?: Erase; caret?: number; anchor?: number },
): Edit {
  // Characters rather than UTF-16 units, because that is what the engine counted when it
  // resolved a click to a boundary. They differ for anything outside the BMP, and slicing
  // by the wrong unit would split a surrogate pair into two broken halves.
  const chars = [...current];
  const caret = input.caret ?? -1;
  const at = caret < 0 ? chars.length : Math.min(caret, chars.length);

  // The range, in document order. The engine stores `(anchor, focus)` because that is what
  // survives a Shift reversal; ordering it is this side's job, and doing it here rather than
  // per branch is what stops a backward drag splicing the wrong way round — measured to edit
  // identically to a forward one.
  const anchor = input.anchor ?? -1;
  const other = anchor < 0 ? at : Math.min(anchor, chars.length);
  let from = Math.min(at, other);
  let to = Math.max(at, other);

  // **Every editing key is one splice**: replace `[from, to)` with `inserted`. Insert,
  // Backspace, Delete, and each of those over a range, all of it.
  //
  // That is the measurement rather than a tidy-up. Over a live range Backspace and Delete are
  // *identical* — both take exactly the range, neither takes the extra character its collapsed
  // behaviour would — so the erase direction only widens a **collapsed** caret, by one, in the
  // key's own direction. Three separate branches said the same thing three times and were
  // bigger; this is also what the byte ratchet noticed.
  if (from === to) {
    if (input.erase === "backward") from = Math.max(0, at - 1);
    if (input.erase === "forward") to = Math.min(chars.length, at + 1);
  }

  const inserted = input.erase === undefined ? (input.text ?? "") : "";
  // Neither an erase nor any text: not a key this owns.
  if (input.erase === undefined && inserted === "") return false;
  // An erase with nothing on that side of the caret — Backspace at 0, Delete at the end.
  // Measured to change nothing and still be *consumed*, so the host does not go looking for
  // another meaning for the key.
  if (from === to && inserted === "") return true;

  // Refuse rather than grow. The engine's arenas are monotonic — `grow` never shrinks — so an
  // input path with no ceiling is a one-way memory ratchet driven by whoever is holding a key
  // down. Dropping the keystroke at a documented limit is the only place that can be decided,
  // because by the time the signal has the text the slot is already sized for it.
  //
  // Counted before the string is built, and in *characters*: `.length` on the result would
  // over-count anything outside the BMP, and building it first would allocate the very string
  // this refuses.
  if (from + [...inserted].length + (chars.length - to) > MAX_SLOT_CHARS) return false;

  return chars.slice(0, from).join("") + inserted + chars.slice(to).join("");
}

/**
 * Wraps a handler so a returned Effect is run rather than dropped.
 *
 * The form path calls its handlers in five places across three branches; wrapping
 * once at lookup is what keeps "a submit handler may return an Effect" true in
 * all of them without five call-site edits.
 */
function effectful(
  fn: ((value?: unknown) => unknown) | null,
  label: string,
): ((value?: unknown) => void) | null {
  return fn && ((value?: unknown) => void runDispatched(fn(value), label));
}

/**
 * The handler of a kind bound to a node, or null.
 *
 * Declared as returning `unknown` rather than `void`: a handler may return an
 * Effect, and the dispatchers hand whatever came back to `runDispatched` — one
 * structural check, and a non-Effect return is ignored exactly as before.
 */
export function handlerFor(
  ui: CompiledUi,
  node: number,
  kind: "click" | "change" | "focus" | "blur" | "submit" | "invalid" = "click",
): ((value?: unknown) => unknown) | null {
  for (const h of ui.handlers) {
    if (h.node === node && h.kind === kind) return h.fn;
  }
  return null;
}

/**
 * Runs a node's handler, if it has one, as a single batch.
 *
 * Batching belongs here rather than in each handler: one user action should cost
 * one repaint, however many signals the handler happens to write. Without it, a
 * handler touching two signals asks for three repaints (the second write plus the
 * computed's invalidation).
 */
export function dispatch(
  ui: CompiledUi,
  node: number,
  kind: "click" | "focus" | "blur" = "click",
): boolean {
  const fn = handlerFor(ui, node, kind);
  if (!fn) return false;
  runDispatched(batch(fn), `${kind} handler at node ${node}`);
  return true;
}

/**
 * Runs a node's `onChange`, with the control's new value.
 *
 * Separate from [`dispatch`] rather than a flag on it, because the *argument* is what
 * differs and it differs in kind: a click handler takes the list item and index, a change
 * handler takes a value. One function taking both would have to decide which to pass by
 * inspecting the handler it is about to call.
 *
 * The value arrives from the engine as one integer whose meaning is the control's kind —
 * see `EventKind.CHANGE`. Converting it here rather than in the app is deliberate: the
 * integer encoding is a protocol detail, and an author writing
 * `onChange={(on) => setOn(on)}` on a checkbox should get a boolean, not a 1. The lookup
 * is the same `controls` table the engine reads, so the two cannot disagree about which
 * kind a node is.
 */
export function dispatchChange(
  ui: CompiledUi,
  node: number,
  raw: number,
  selected: readonly number[] = [],
): boolean {
  const fn = handlerFor(ui, node, "change");
  if (!fn) return false;

  let kind: number = ControlKind.NONE;
  for (let r = 0; r < ui.controls.count; r++) {
    if (ui.controls.node[r] === node) {
      kind = ui.controls.kind[r]!;
      break;
    }
  }

  // A checkbox and a radio carry checkedness; a select carries the chosen index, which is
  // already the number an author wants. Anything else passes the integer through rather
  // than guessing — an unknown kind is a kind this function has not been taught, and
  // inventing a conversion for it would be inventing behaviour.
  //
  // A **slider** carries per-mille of the track, and the conversion is this side's
  // whole job in the numeric bridge: the engine knows fractions, the author wrote
  // min/max/step. The handler gets the *value*, because nobody's `onChange` wants
  // per-mille.
  //
  // A **list box** is the one whose answer is not in `raw` at all. Its selection is a set,
  // measured to fire one `change` per gesture however many rows moved, so `raw` is only
  // the row the gesture landed on and the set arrives beside the event — see
  // `EngineEvent.selected`. A fresh array per dispatch, because the drained one is shared
  // and a handler that keeps it would be holding a buffer the next event overwrites.
  const value =
    kind === ControlKind.CHECKBOX || kind === ControlKind.RADIO
      ? raw === 1
      : kind === ControlKind.LISTBOX
        ? [...selected]
        : kind === ControlKind.RANGE
          ? (rangeValue(ui, node, raw) ?? raw)
          : raw;

  runDispatched(
    batch(() => fn(value)),
    `change handler at node ${node}`,
  );
  return true;
}

/**
 * The `<form>` that owns `node`, or -1.
 *
 * Two questions in one, asked in the order that makes the second a fallback rather than a
 * competitor:
 *
 * 1. **Does a form claim this node?** `owns` is the compiled ownership set, and it is the
 *    only way to answer for a control a `form="F"` attribute moved: measured, such a control
 *    is F's for every purpose including implicit submission, and it need not be inside F at
 *    all — so no walk up the tree can find it.
 * 2. **Otherwise, walk up.** For everything else in a form — a `<div tabindex=0>`, a
 *    generated box — ancestry is the answer, and the innermost form wins because the first
 *    match going up is the nearest one. Nested forms are invalid HTML that parses anyway,
 *    and this resolves them the way the DOM would.
 *
 * The walk stays because the ownership set holds *controls*, not every focusable node, and
 * making it hold every node would cost a row per node to answer a question a handful of
 * parent reads already answers.
 */
function formOf(ui: CompiledUi, node: number): number {
  for (const form of ui.forms) if (findRow(form.owns, node) >= 0) return form.node;

  for (let n = node; n >= 0; n = ui.nodes.parent[n] ?? -1) {
    for (const form of ui.forms) if (form.node === n) return n;
  }
  return -1;
}

/**
 * Whether `node`'s control is disabled *right now*.
 *
 * Reads the same byte the engine obeys. Author-owned disabledness is the one control flag Bun
 * writes rather than the engine, so this is a lookup rather than a question for the far side —
 * and `ui.controls.node` is sorted, which is what `findRow` needs.
 */
function isDisabledNow(ui: CompiledUi, node: number): boolean {
  const row = findRow(ui.controls.node.subarray(0, ui.controls.count), node);
  return row >= 0 && (ui.controls.flags[row]! & ControlFlags.DISABLED) !== 0;
}

/**
 * Runs implicit submission for an Enter pressed with `node` focused. Returns whether it
 * submitted.
 *
 * The measured algorithm, with three of its four questions already answered by the
 * compiler — see `BROWSER-FACTS.md`, "Implicit submission: the conditions, not just the
 * headline". What is left here is the pair that depends on where focus happens to be.
 *
 * **The button's own `onClick` runs too, before the submit**, because in a browser the
 * submission is a *consequence* of a synthesised click on that button rather than a
 * separate mechanism. A form whose button both validates on click and submits would
 * otherwise behave differently under Enter than under a real press, which is the kind of
 * divergence that is only ever found by an author debugging their own form.
 */
export function submitFrom(ui: CompiledUi, node: number): boolean {
  // A textarea takes Enter for itself. Measured, and it is the reason `textAreas` exists
  // as a set: by the time the IR is built, a textarea and a text input are the same kind
  // of editable box.
  //
  // From `find-row.ts` and **not** from `ir.ts`, which re-exports it. `ir.ts` is a value
  // import that drags `STYLE_FIELDS` and its 80 rows into the runtime bundle — 8049 bytes
  // to 13186, caught by the `runtime-surface` ratchet. That split module exists for
  // exactly this, as its own comment in `list-runtime.ts` says.
  if (findRow(ui.textAreas, node) >= 0) return false;

  const form = formOf(ui, node);
  if (form < 0) return false;
  const binding = ui.forms.find((f) => f.node === form);
  if (!binding) return false;

  // Neither a usable button nor the one-field rule. A disabled submit button lands here,
  // and lands here rather than falling through to `direct` — measured, it blocks outright.
  if (binding.button < 0 && !binding.direct) return false;

  return submitForm(ui, binding.node, binding.button);
}

/**
 * Runs a form's submission: the button's click handler, then validation, then `onSubmit`.
 *
 * Shared by Enter and by a real press on the submit button, so that the two paths cannot
 * drift — a click on the button has to submit as surely as Enter does, and that is one
 * call rather than a second copy of the ordering.
 *
 * **`onSubmit` receives the payload**, built from the form's fields by the table the
 * compiler emitted — see `runtime/forms.ts`. When a `validate={…}` is present it runs
 * first, and decides which of the two handlers is called:
 *
 * - valid → `onSubmit(parsed)`, where `parsed` is the *schema's* output rather than the
 *   raw payload, so a schema that turns a string into a `Date` hands over the `Date`.
 * - invalid → `onInvalid(issues)`, and `onSubmit` does not run at all. A form with a
 *   `validate` and no `onInvalid` simply does nothing on a bad payload, which is the same
 *   shape as a browser refusing to submit an invalid form.
 *
 * Synchronous whenever the validator is, which is every ordinary Zod and Effect schema
 * (measured) — so the usual submit stays inside one batch and costs one repaint.
 */
export function submitForm(ui: CompiledUi, form: number, button: number): boolean {
  // **A submit button disabled by a *signal* blocks submission**, and this is the one path
  // that has to say so out loud. A press on a disabled control never arrives — the engine
  // swallows it before recording anything, measured — so this only ever fires for Enter,
  // which reaches `submitFrom` and finds a `button` the compiler resolved from the markup.
  //
  // The compile-time half already worked: a literal `disabled` attribute makes the compiler
  // emit `button: -1`, and measured, that blocks outright rather than falling through to the
  // one-field rule. A `disabled={signal}` cannot be seen at build time, so without this a
  // form whose button was visibly greyed out still submitted on Enter.
  if (button >= 0 && isDisabledNow(ui, button)) return false;

  const binding = ui.forms.find((f) => f.node === form);
  const submit = effectful(handlerFor(ui, form, "submit"), `submit handler at node ${form}`);
  const invalid = effectful(handlerFor(ui, form, "invalid"), `invalid handler at node ${form}`);
  const click =
    button >= 0 ? effectful(handlerFor(ui, button, "click"), `click handler at node ${button}`) : null;
  if (!submit && !click) return false;

  // The button's own handler runs whether or not the payload validates, and before the
  // validation, because in a browser the submission is a *consequence* of that click.
  if (!submit || !binding) {
    batch(() => {
      click?.();
      submit?.();
    });
    return true;
  }

  // The button is the *submitter*, which is what puts its own `name=value` in the payload
  // when it has a name. -1 for an Enter that clicked nothing, which is the `direct` case.
  const data = formPayload(ui, binding, button);
  if (binding.validate === null || binding.validate === undefined) {
    batch(() => {
      click?.();
      submit(data);
    });
    return true;
  }
  attempted.add(binding);

  const verdict = validatePayload(binding.validate, data);
  const finish = (settled: Validated): void => {
    batch(() => {
      // Every wrapper may speak from here on: the user has tried, so withholding an error
      // would be withholding the reason nothing happened. This is also what turns
      // `validateOn="submit"` into "and re-validate on change afterwards" without a second
      // attribute — `attempted` is what the change path reads.
      attempted.add(binding);
      applyIssues(ui, binding, settled.ok ? [] : settled.issues, true);
      if (settled.ok) submit(settled.value);
      else invalid?.(settled.issues);
    });
  };

  if (verdict instanceof Promise) {
    // The click still belongs to *this* action, so it is not made to wait for a validator
    // that may take a network round trip.
    batch(() => click?.());
    void verdict.then(finish);
    return true;
  }

  batch(() => {
    click?.();
    applyIssues(ui, binding, verdict.ok ? [] : verdict.issues, true);
    if (verdict.ok) submit(verdict.value);
    else invalid?.(verdict.issues);
  });
  return true;
}

/**
 * Forms whose submit has been attempted, so every wrapper may now show an error.
 *
 * A set rather than a field on the binding, because the binding is the *compiled* table and
 * this is the one thing about a form that is neither compiled nor per-field. It is also the
 * whole of "re-validate on change after a failed submit" — the behaviour React Hook Form
 * spells `reValidateMode: onChange` — which is why that is not a second attribute.
 */
const attempted = new WeakSet<FormBinding>();

/**
 * Re-checks a form because one of its fields changed, or lost focus.
 *
 * Runs when the form asked for it — `validateOn="change"` or `"blur"` — and always after a
 * submit has been attempted, because an error the user has already seen must clear itself as
 * soon as they fix it.
 *
 * Nothing is submitted and no handler runs: this only moves the error cells, which move the
 * style-table entries the wrapper's `errorClassName` compiled to. An async validator is
 * awaited and applied when it settles.
 *
 * Returns whether anything moved.
 */
export function revalidate(ui: CompiledUi, node: number, on: "change" | "blur"): boolean {
  const form = ui.forms.find((f) => f.node === formOf(ui, node));
  if (!form || form.validate === null || form.validate === undefined) return false;
  if (form.groups.length === 0) return false;

  const attemptedYet = attempted.has(form);
  if (!attemptedYet && form.validateOn !== on) return false;

  const verdict = validatePayload(form.validate, formPayload(ui, form));
  if (verdict instanceof Promise) {
    void verdict.then((settled) => {
      batch(() => applyIssues(ui, form, settled.ok ? [] : settled.issues, attemptedYet));
    });
    return false;
  }

  let moved = false;
  batch(() => {
    moved = applyIssues(ui, form, verdict.ok ? [] : verdict.issues, attemptedYet);
  });
  return moved;
}

/**
 * The form a press on `node` submits, or -1.
 *
 * Clicking a submit button submits its form — the ordinary way a form is submitted, and
 * the same table answers it. Kept separate from [`submitFrom`] because the question is
 * different: that one asks "what would Enter do from here", this one asks "is this node
 * the button", and only the second is true of a press on a node outside any form.
 */
export function formSubmittedByPress(ui: CompiledUi, node: number): number {
  for (const form of ui.forms) if (form.button === node) return form.node;
  return -1;
}
