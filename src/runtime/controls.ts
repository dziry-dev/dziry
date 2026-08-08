/**
 * Applies signals to the controls table — today, `disabled`.
 *
 * The whole runtime cost of a control switching off at run time: write one byte per
 * control row. No new protocol, no engine change, and nothing about the node tree moves.
 *
 * It works because of an asymmetry the engine already had. `Controls::rescan` clears every
 * live flag except `CHECKED` and re-reads `DISABLED` from the table each time, on the
 * grounds that checkedness is the user's and disabledness is the author's — so the author
 * changing their mind is exactly the case that path was built for, before anything could
 * express it.
 *
 * Separate from `patches.ts` even though the shape is identical — signal, write, dirty —
 * because the *table* differs, and a patch carries `affectsLayout` while this never can:
 * a control's flags are read by hit-testing and by the predicate machinery, never by
 * measure or arrange.
 */
import type { CompiledUi, DisabledBinding } from "../ir.ts";
import { ControlFlags } from "../protocol/generated.ts";
import { Dirty } from "./bindings.ts";

/** Last applied state per binding, so a signal that did not move costs no writes. */
const applied = new WeakMap<DisabledBinding, boolean>();

/**
 * Writes each binding's flag, returning whether anything changed.
 *
 * The return value is load-bearing rather than informational: `flush` in `worker.ts`
 * uploads styles, variants, lists, nodes and strings, and **not** controls — so a write
 * here reaches the engine only if the caller is told to upload that table. Returning
 * `Dirty.PAINT` unconditionally would either cost a controls upload on every keystroke or,
 * worse, invite the caller to skip it.
 */
export function applyDisabled(ui: CompiledUi, bindings: DisabledBinding[]): Dirty {
  let dirty: Dirty = Dirty.NONE;

  for (const binding of bindings) {
    const on = Boolean(binding.signal.value);
    if (applied.get(binding) === on) continue;
    applied.set(binding, on);

    for (const row of binding.rows) {
      const flags = ui.controls.flags[row]!;
      ui.controls.flags[row] = on
        ? flags | ControlFlags.DISABLED
        : flags & ~ControlFlags.DISABLED;
    }

    // Never `Dirty.LAYOUT`. A greyed control is the same size as a live one, and the two
    // things this actually changes — whether a press lands and whether `:disabled` matches
    // — are both resolved after arrange.
    dirty = Dirty.PAINT;
  }

  return dirty;
}

/** Subscribes `onChange` to every signal driving a disabled binding. */
export function subscribeDisabled(bindings: DisabledBinding[], onChange: () => void): () => void {
  const seen = new Set<unknown>();
  const offs: (() => void)[] = [];

  for (const binding of bindings) {
    if (seen.has(binding.signal)) continue;
    seen.add(binding.signal);
    offs.push(binding.signal.subscribe(onChange));
  }

  return () => {
    for (const off of offs) off();
  };
}
