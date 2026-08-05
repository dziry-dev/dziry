/**
 * Applies state to the IR.
 *
 * This is the whole of what the runtime does about dynamic values: build each
 * bound text run from its parts, write it into the string slot the compiler
 * reserved, and report whether anything changed. No diffing, no reconciliation,
 * no dependency discovery — the compiler already decided which node reads which
 * signal.
 */
import type { CompiledUi } from "../ir.ts";
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

/** The handler bound to a node, or null. */
export function handlerFor(ui: CompiledUi, node: number): (() => void) | null {
  for (const h of ui.handlers) {
    if (h.node === node) return h.fn;
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
export function dispatch(ui: CompiledUi, node: number): boolean {
  const fn = handlerFor(ui, node);
  if (!fn) return false;
  batch(fn);
  return true;
}
