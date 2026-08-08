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
import type { CompiledUi } from "../ir.ts";
import { ControlKind } from "../protocol/generated.ts";
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

  // Characters rather than UTF-16 units, because that is what the engine counted when it
  // resolved a click to a boundary. They differ for anything outside the BMP, and slicing
  // by the wrong unit would split a surrogate pair into two broken halves.
  const chars = [...target.signal.value];
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

  const next = chars.slice(0, from).join("") + inserted + chars.slice(to).join("");
  batch(() => {
    target.signal.value = next;
  });
  return true;
}

/** The handler of a kind bound to a node, or null. */
export function handlerFor(
  ui: CompiledUi,
  node: number,
  kind: "click" | "change" | "focus" | "blur" | "submit" = "click",
): ((value?: unknown) => void) | null {
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
  batch(fn);
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
        : raw;

  batch(() => fn(value));
  return true;
}

/**
 * The innermost `<form>` containing `node`, or -1.
 *
 * A walk up `nodes.parent` rather than a compiled field-to-form table, and the reason is
 * that a table would have to have one row per focusable node while this needs no storage
 * at all. The chain is a handful of steps and this runs once per Enter keypress.
 *
 * Innermost, because `forms` is scanned as the walk climbs: the first match encountered
 * going up is the nearest ancestor. Nested forms are invalid HTML that parses anyway, and
 * this resolves them the way the DOM would.
 */
function formOf(ui: CompiledUi, node: number): number {
  for (let n = node; n >= 0; n = ui.nodes.parent[n] ?? -1) {
    for (const form of ui.forms) if (form.node === n) return n;
  }
  return -1;
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
 * Runs a form's submission: the button's click handler, then the form's `onSubmit`.
 *
 * Shared by Enter and by a real press on the submit button, so that the two paths cannot
 * drift — a click on the button has to submit as surely as Enter does, and that is one
 * call rather than a second copy of the ordering.
 */
export function submitForm(ui: CompiledUi, form: number, button: number): boolean {
  const submit = handlerFor(ui, form, "submit");
  const click = button >= 0 ? handlerFor(ui, button, "click") : null;
  if (!submit && !click) return false;

  // One batch across both, for the same reason `dispatch` batches: submitting is one user
  // action however many signals the two handlers write between them.
  batch(() => {
    click?.();
    submit?.();
  });
  return true;
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
