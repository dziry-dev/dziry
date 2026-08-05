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
 * Routes a keystroke into the focused editable, **at the caret**.
 *
 * Insert and delete at `caret`, which the engine reports beside the text — it owns the
 * index, this owns the string. `caret` is a character offset, not a byte one, and is
 * clamped rather than trusted: it crossed a process boundary and the value may have been
 * rewritten by app code since the engine read it.
 *
 * A `caret` of -1 means "no caret", which is what a keystroke arriving with nothing focused
 * looks like. It appends, so a host that never places a caret still behaves as this did
 * before there was one.
 *
 * Still no selection and no clipboard.
 *
 * Returns true if the key was consumed.
 */
export function typeInto(
  editables: EditableRef[],
  focused: number,
  input: { text: string | null; erase?: Erase; caret?: number },
): boolean {
  const target = editables.find((e) => e.node === focused);
  if (!target) return false;

  // Characters rather than UTF-16 units, because that is what the engine counted when it
  // resolved a click to a boundary. They differ for anything outside the BMP, and slicing
  // by the wrong unit would split a surrogate pair into two broken halves.
  const chars = [...target.signal.value];
  const caret = input.caret ?? -1;
  const at = caret < 0 ? chars.length : Math.min(caret, chars.length);
  const tail = chars.slice(at).join("");

  if (input.erase === "backward") {
    // Nothing to the left of the caret is not a failure — it is the measured behaviour of
    // Backspace at offset 0 — but the key is still consumed, so the host does not go
    // looking for another meaning for it.
    if (at === 0) return true;
    const head = chars.slice(0, at - 1).join("");
    batch(() => {
      target.signal.value = head + tail;
    });
    return true;
  }

  if (input.erase === "forward") {
    // Delete eats the character *after* the caret and leaves the caret where it is — which
    // is why the engine does not shift it for this key, and why the head is the whole
    // prefix rather than one short of it.
    if (at === chars.length) return true;
    const head = chars.slice(0, at).join("");
    batch(() => {
      target.signal.value = head + chars.slice(at + 1).join("");
    });
    return true;
  }

  if (input.text) {
    // Refuse rather than grow. The engine's arenas are monotonic — `grow` never
    // shrinks — so an input path with no ceiling is a one-way memory ratchet
    // driven by whoever is holding a key down. Dropping the keystroke at a
    // documented limit is the only place that can be decided, because by the
    // time the signal has the text the slot is already sized for it.
    if (chars.length + input.text.length > MAX_SLOT_CHARS) return false;
    const head = chars.slice(0, at).join("");
    batch(() => {
      target.signal.value = head + input.text + tail;
    });
    return true;
  }

  return false;
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
