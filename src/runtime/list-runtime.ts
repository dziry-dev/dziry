/**
 * Reconciles a compiled list against its array.
 *
 * What makes this small: item subtrees are *interchangeable*. They were all
 * compiled from one template, so slot 3 can render any item — a reorder is a
 * permutation of the child chain plus a slot-value rewrite, never a node move.
 * Nothing is allocated, no id is invalidated, and every style id in the arena was
 * resolved at compile time.
 *
 * Keys exist for one reason: focus is a *node id*. Reassigning items to slots
 * arbitrarily would move focus to a different logical row, so a slot keeps its
 * key across updates where it can.
 */
// Split deliberately: `findRow` comes from its own module so this import stays
// value-free of `ir.ts`, whose style tables the runtime does not need. The type
// import below is erased.
import { findRow } from "../find-row.ts";
import type { CompiledUi } from "../ir.ts";
import type { ItemPath } from "../compiler/item-path.ts";
import { ControlFlags, ControlKind } from "../protocol/generated.ts";
import { Dirty, editText, type Erase } from "./bindings.ts";
import { batch, type ReadonlySignal } from "./signal.ts";

/**
 * Reads a recorded path out of a real item.
 *
 * The other half of `item-path.ts`: the compiler records `t.title` as `["title"]`,
 * and this is what turns that back into a value once one exists. It lives here
 * rather than beside the recorder because the split follows *when the code runs* —
 * recording is build-time only, reading happens every update — and the import went
 * the wrong way across that line. `../compiler/item-path.ts` is a compiler module
 * carrying build-time proxies and error classes; importing a function out of it put
 * all of that in the runtime bundle, where none of it can ever execute.
 *
 * The type still comes from there, because a type erases and the two halves have to
 * agree on the shape they exchange.
 */
export function readPath(item: unknown, path: ItemPath): unknown {
  let current: unknown = item;
  for (const step of path) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

export type ItemPart = { literal: string } | { path: ItemPath };

export type ItemBindingRef = {
  offset: number;
  slotOffset: number;
  parts: ItemPart[];
};

export type ItemHandlerRef = {
  offset: number;
  /**
   * Which event runs it. Without this an `onChange` and an `onClick` on one element are
   * indistinguishable here — both are the same offset — and a click runs whichever was
   * emitted first, with the wrong arguments.
   */
  kind: "click" | "change" | "focus" | "blur" | "submit";
  fn: (item: never, index: number, value?: unknown) => void;
};

/**
 * A `bind:value` inside a row, pointed at the row's own property.
 *
 * The only two-way binding with no signal behind it, because a row does not have one: the
 * array is the state, and `path` says which property of an item this element edits. Typing
 * therefore replaces the item — see [`typeIntoRow`].
 */
export type ItemEditableRef = {
  offset: number;
  path: ItemPath;
};

export type ListBindingRef = {
  list: number;
  signal: ReadonlySignal<unknown[]>;
  keyPath: ItemPath;
  slotStart: number;
  slotsPerItem: number;
  bindings: ItemBindingRef[];
  itemHandlers: ItemHandlerRef[];
  itemEditables: ItemEditableRef[];
  /** Which data index each slot currently renders, set by `updateList`. */
  slotData?: Int32Array;
};

/** Which key each slot currently renders, so slots can keep their identity. */
const slotKeys = new WeakMap<ListBindingRef, (unknown | undefined)[]>();

// Concrete rather than generic: inferring the constructor from `.constructor`
// loses the element type, and these arrays each have a different one.
function growI32(a: Int32Array, n: number, fill = 0): Int32Array {
  const next = new Int32Array(n);
  if (fill !== 0) next.fill(fill);
  next.set(a);
  return next;
}

function growU16(a: Uint16Array, n: number): Uint16Array {
  const next = new Uint16Array(n);
  next.set(a);
  return next;
}

function growU8(a: Uint8Array, n: number): Uint8Array {
  const next = new Uint8Array(n);
  next.set(a);
  return next;
}

function growI16(a: Int16Array, n: number, fill = 0): Int16Array {
  const next = new Int16Array(n);
  if (fill !== 0) next.fill(fill);
  next.set(a);
  return next;
}

/**
 * Grows a list's arena so it can hold `needed` items.
 *
 * A *fresh, larger* arena is appended past the end of the node arrays and the
 * list is re-pointed at it; the old region is simply left unreachable. That is
 * deliberate — it means no existing node id changes, so nothing that holds an id
 * (focus, the state table, the interactive set, cached layout) is invalidated.
 * The alternative, growing in place, would shift every later node and renumber
 * the document. Wasted slots are the price of never recycling an id, and growth
 * is rare because capacity doubles.
 */
function growArena(ui: CompiledUi, ref: ListBindingRef, needed: number): void {
  const { nodes, lists, variants } = ui;
  const oldStart = lists.arenaStart[ref.list]!;
  const stride = lists.stride[ref.list]!;
  const oldCapacity = lists.capacity[ref.list]!;
  const capacity = Math.max(needed, oldCapacity * 2);

  // Which offsets inside an item are conditionally styled, or accept input.
  const variantOffsets: { offset: number; mask: number; runStart: number }[] = [];
  const interactiveOffsets: number[] = [];
  for (let k = 0; k < stride; k++) {
    const row = findRow(variants.node, oldStart + k);
    if (row >= 0) {
      variantOffsets.push({
        offset: k,
        mask: variants.mask[row]!,
        // Every replica *shares* the template's run: the rows are compiled from
        // one template, so their conditional styles are identical by
        // construction. Growing an arena therefore adds rows to `variants` and
        // nothing at all to `slots`.
        runStart: variants.runStart[row]!,
      });
    }
    if (findRow(ui.interactive, oldStart + k) >= 0) interactiveOffsets.push(k);
  }

  const newStart = nodes.count;
  const added = capacity * stride;
  const count = newStart + added;

  nodes.kind = growU8(nodes.kind, count);
  nodes.style = growU16(nodes.style, count);
  nodes.text = growI32(nodes.text, count, -1);
  nodes.parent = growI32(nodes.parent, count, -1);
  nodes.firstChild = growI32(nodes.firstChild, count, -1);
  nodes.nextSibling = growI32(nodes.nextSibling, count, -1);
  nodes.list = growI16(nodes.list, count, -1);
  nodes.hidden = growU8(nodes.hidden, count);
  nodes.activates = growI32(nodes.activates, count, -1);
  nodes.count = count;

  // Replicate item 0 of the old arena. Its internal links are untouched by the
  // runtime — only the item root's sibling link and the chain head are rewritten —
  // so it is still a faithful template.
  const container = lists.container[ref.list]!;
  const slotStart = ui.strings.length;

  for (let item = 0; item < capacity; item++) {
    const shift = newStart + item * stride - oldStart;
    for (let k = 0; k < stride; k++) {
      const src = oldStart + k;
      const dst = newStart + item * stride + k;
      nodes.kind[dst] = nodes.kind[src]!;
      nodes.style[dst] = nodes.style[src]!;
      nodes.text[dst] = nodes.text[src]!;
      nodes.parent[dst] = k === 0 ? container : nodes.parent[src]! + shift;
      nodes.firstChild[dst] = nodes.firstChild[src]! === -1 ? -1 : nodes.firstChild[src]! + shift;
      nodes.nextSibling[dst] =
        k === 0 || nodes.nextSibling[src]! === -1 ? -1 : nodes.nextSibling[src]! + shift;
      nodes.hidden[dst] = 0;
      nodes.list[dst] = -1;
      // Shifted like every other node reference in this block. A row's `activates`
      // points inside its own item subtree — a label beside a checkbox in the same
      // row — so copying it unshifted would make every replica operate item 0's
      // control. `-1` stays `-1`.
      nodes.activates[dst] = nodes.activates[src]! === -1 ? -1 : nodes.activates[src]! + shift;
    }

    // Fresh string slots, so every row still owns its own text.
    for (const binding of ref.bindings) {
      ui.strings.push("");
      nodes.text[newStart + item * stride + binding.offset] =
        slotStart + item * ref.bindings.length + binding.slotOffset;
    }
  }

  // Extend the sparse tables. New ids are all larger than existing ones, so
  // appending keeps both arrays sorted.
  if (variantOffsets.length > 0) {
    const rows = capacity * variantOffsets.length;
    const node = new Int32Array(variants.count + rows);
    const mask = new Uint32Array(variants.count + rows);
    const runStart = new Int32Array(variants.count + rows);
    node.set(variants.node);
    mask.set(variants.mask);
    runStart.set(variants.runStart);

    let at = variants.count;
    for (let item = 0; item < capacity; item++) {
      for (const v of variantOffsets) {
        node[at] = newStart + item * stride + v.offset;
        mask[at] = v.mask;
        runStart[at] = v.runStart;
        at++;
      }
    }
    variants.node = node;
    variants.mask = mask;
    variants.runStart = runStart;
    variants.count = node.length;
    // `variants.slots` is deliberately untouched — see the comment above.
  }

  if (interactiveOffsets.length > 0) {
    const extra = new Int32Array(ui.interactive.length + capacity * interactiveOffsets.length);
    extra.set(ui.interactive);
    let at = ui.interactive.length;
    for (let item = 0; item < capacity; item++) {
      for (const k of interactiveOffsets) extra[at++] = newStart + item * stride + k;
    }
    ui.interactive = extra;
  }

  growControls(ui, oldStart, stride, newStart, capacity);
  growTabStops(ui, oldStart, stride, newStart, capacity);

  lists.arenaStart[ref.list] = newStart;
  lists.capacity[ref.list] = capacity;
  ref.slotStart = slotStart;

  // Slot identity is meaningless in a new arena; every item is reassigned below.
  slotKeys.delete(ref);
}

/**
 * Gives a regrown arena the control rows its template has.
 *
 * The compiler does this once for the compiled capacity (`replicateListControls`); this is
 * the same operation for the slots growth appends, and without it the ninth row of a
 * capacity-8 list is a box that draws, refuses focus and emits no `CHANGE` — a form row you
 * can see and cannot fill. That was the last thing standing between a list and a *form*
 * list, since an author adding rows has no way to know where the compiled capacity fell.
 *
 * **Appending keeps the table sorted**, which is the property the engine's binary search
 * needs: growth allocates past `nodes.count`, so every new node id is larger than every
 * existing one. The stale rows of the abandoned arena stay behind and stay sorted; they name
 * nodes nothing links to, so they are unreachable rather than wrong.
 *
 * `flags` deliberately keeps only `DISABLED`. A fresh slot has never been interacted with, so
 * copying `CHECKED` off the template would tick every checkbox in every new row — and
 * `DISABLED` is markup, which every replica does share.
 */
function growControls(
  ui: CompiledUi,
  oldStart: number,
  stride: number,
  newStart: number,
  capacity: number,
): void {
  const { controls } = ui;
  const template: number[] = [];
  for (let r = 0; r < controls.count; r++) {
    const node = controls.node[r]!;
    if (node >= oldStart && node < oldStart + stride) template.push(r);
  }
  if (template.length === 0) return;

  const added = capacity * template.length;
  const count = controls.count + added;

  const node = growI32(controls.node, count);
  const kind = growU8(controls.kind, count);
  const group = growI32(controls.group, count);
  const flags = growU8(controls.flags, count);
  const label = growI32(controls.label, count);
  const rows = growI32(controls.rows, count);

  let at = controls.count;
  for (let item = 0; item < capacity; item++) {
    const shift = newStart + item * stride - oldStart;
    for (const r of template) {
      node[at] = controls.node[r]! + shift;
      kind[at] = controls.kind[r]!;
      // A radio group is `(form, name)` and every row shares both, so a new replica joins
      // the group its template is in — which is what makes one row's radio clear the others'.
      group[at] = controls.group[r]!;
      flags[at] = controls.flags[r]! & ControlFlags.DISABLED;
      // Inside the item subtree, so it shifts. A label pointing outside the arena would be
      // a control in a row labelled by static text, which the compiler does not produce.
      label[at] = controls.label[r]! === -1 ? -1 : controls.label[r]! + shift;
      rows[at] = controls.rows[r]!;
      at++;
    }
  }

  controls.node = node;
  controls.kind = kind;
  controls.group = group;
  controls.flags = flags;
  controls.label = label;
  controls.rows = rows;
  controls.count = count;
}

/** The same append for Tab's reachable set, which is a sorted array rather than a table. */
function growTabStops(
  ui: CompiledUi,
  oldStart: number,
  stride: number,
  newStart: number,
  capacity: number,
): void {
  const offsets: number[] = [];
  for (const stop of ui.tabStops) {
    if (stop >= oldStart && stop < oldStart + stride) offsets.push(stop - oldStart);
  }
  if (offsets.length === 0) return;

  const next = new Int32Array(ui.tabStops.length + capacity * offsets.length);
  next.set(ui.tabStops);
  let at = ui.tabStops.length;
  for (let item = 0; item < capacity; item++) {
    for (const offset of offsets) next[at++] = newStart + item * stride + offset;
  }
  ui.tabStops = next;
}

/**
 * Assigns items to slots, rewrites the child chain, and refreshes bound strings.
 *
 * Returns LAYOUT whenever anything changed: item text and item count both affect
 * measurement.
 */
export function updateList(ui: CompiledUi, ref: ListBindingRef, array?: unknown[]): Dirty {
  const { nodes, lists } = ui;
  // The compiled list *is* a function of the array: pass one explicitly, or let it
  // read the signal it was compiled against.
  const items = array ?? ref.signal.value ?? [];

  // Capacity is an implementation detail, not something the author declares:
  // outgrowing it appends a larger arena rather than truncating.
  if (items.length > lists.capacity[ref.list]!) growArena(ui, ref, items.length);

  const arenaStart = lists.arenaStart[ref.list]!;
  const stride = lists.stride[ref.list]!;
  const capacity = lists.capacity[ref.list]!;

  let keys = slotKeys.get(ref);
  if (!keys) {
    keys = new Array<unknown>(capacity).fill(undefined);
    slotKeys.set(ref, keys);
  }

  // Keep each item in the slot that already held its key; that is the whole point
  // of keys here, and it is what preserves focus across a reorder.
  const slotOf = new Array<number>(items.length).fill(-1);
  const taken = new Uint8Array(capacity);

  for (let i = 0; i < items.length; i++) {
    const key = readPath(items[i], ref.keyPath);
    for (let s = 0; s < capacity; s++) {
      if (!taken[s] && keys[s] !== undefined && Object.is(keys[s], key)) {
        slotOf[i] = s;
        taken[s] = 1;
        break;
      }
    }
  }

  // Items without a previous slot take any free one.
  let scan = 0;
  for (let i = 0; i < items.length; i++) {
    if (slotOf[i] !== -1) continue;
    while (scan < capacity && taken[scan]) scan++;
    slotOf[i] = scan;
    taken[scan] = 1;
  }

  // Slots that no longer render anything forget their key.
  for (let s = 0; s < capacity; s++) if (!taken[s]) keys[s] = undefined;

  let changed = false;

  // Slot -> data index, so a click on a row can find the item it renders.
  if (!ref.slotData || ref.slotData.length !== capacity) {
    ref.slotData = new Int32Array(capacity);
  }
  ref.slotData.fill(-1);

  // Rewrite bound strings, and record each slot's key.
  for (let i = 0; i < items.length; i++) {
    const slot = slotOf[i]!;
    keys[slot] = readPath(items[i], ref.keyPath);
    ref.slotData[slot] = i;

    const itemBase = arenaStart + slot * stride;
    const slotBase = ref.slotStart + slot * ref.slotsPerItem;

    for (const binding of ref.bindings) {
      let next = "";
      for (const part of binding.parts) {
        next += "literal" in part ? part.literal : String(readPath(items[i], part.path) ?? "");
      }

      const stringSlot = slotBase + binding.slotOffset;
      if (ui.strings[stringSlot] !== next) {
        ui.strings[stringSlot] = next;
        changed = true;
      }
      // Keep the node pointing at its own slot; replication set this, but a
      // regrown arena or a moved slot needs it re-asserted.
      nodes.text[itemBase + binding.offset] = stringSlot;
    }
  }

  // Splice the live slots into the container's chain, in data order. Nodes do
  // not move; only links change.
  //
  // The rows are children of the container itself, between two static anchors,
  // so an empty list is `prev -> next` and a full one is
  // `prev -> row0 -> ... -> rowN -> next`. There is no wrapper node to own a
  // `firstChild`, which is what used to make a list inside a grid render every
  // row into one cell.
  const container = lists.container[ref.list]!;
  const prev = lists.anchorPrev[ref.list]!;
  const after = lists.anchorNext[ref.list]!;

  const first = items.length === 0 ? after : arenaStart + slotOf[0]! * stride;
  if (prev === -1) {
    if (nodes.firstChild[container] !== first) changed = true;
    nodes.firstChild[container] = first;
  } else {
    if (nodes.nextSibling[prev] !== first) changed = true;
    nodes.nextSibling[prev] = first;
  }

  for (let i = 0; i < items.length; i++) {
    const node = arenaStart + slotOf[i]! * stride;
    const next = i === items.length - 1 ? after : arenaStart + slotOf[i + 1]! * stride;
    if (nodes.nextSibling[node] !== next) changed = true;
    nodes.nextSibling[node] = next;
  }

  // Slots off the chain are unreachable, so they cost nothing to traverse.
  for (let s = 0; s < capacity; s++) {
    if (!taken[s]) nodes.nextSibling[arenaStart + s * stride] = -1;
  }

  lists.active[ref.list] = items.length;
  return changed ? Dirty.LAYOUT : Dirty.NONE;
}

export function updateLists(ui: CompiledUi, refs: ListBindingRef[]): Dirty {
  let dirty: Dirty = Dirty.NONE;
  for (const ref of refs) {
    if (updateList(ui, ref) === Dirty.LAYOUT) dirty = Dirty.LAYOUT;
  }
  return dirty;
}

export function subscribeLists(refs: ListBindingRef[], onChange: () => void): () => void {
  const offs = refs.map((r) => r.signal.subscribe(onChange));
  return () => {
    for (const off of offs) off();
  };
}

/**
 * Which row a node belongs to, and what that row's data is. Null if it is not in a list.
 *
 * The decomposition every per-row dispatch needs: the node is split into (slot, offset),
 * where the offset identifies which element of the *template* it is and the slot says
 * which item is currently rendered there. That indirection is why one compiled handler
 * serves every row.
 */
function rowOf(
  ui: CompiledUi,
  refs: ListBindingRef[],
  node: number,
): { ref: ListBindingRef; offset: number; item: unknown; index: number } | null {
  for (const ref of refs) {
    const start = ui.lists.arenaStart[ref.list]!;
    const stride = ui.lists.stride[ref.list]!;
    const capacity = ui.lists.capacity[ref.list]!;

    if (node < start || node >= start + capacity * stride) continue;

    const slot = Math.floor((node - start) / stride);
    const offset = node - start - slot * stride;

    // A slot off the chain renders nothing, so there is no item to hand a handler. This
    // is reachable: growth is append-and-abandon, so an arena keeps slots that used to
    // hold rows and no longer do.
    const index = ref.slotData?.[slot] ?? -1;
    if (index < 0) return null;

    return { ref, offset, item: (ref.signal.value ?? [])[index], index };
  }
  return null;
}

/**
 * Runs a per-row handler if `node` is inside a list arena.
 *
 * `kind` is not optional in spirit even though it has a default: handlers are found by
 * offset, so a row element carrying both an `onClick` and an `onChange` produces two
 * entries with the same offset, and a lookup that ignored the kind would run whichever
 * was emitted first — a click firing the change handler, with a click's arguments.
 */
export function dispatchItem(
  ui: CompiledUi,
  refs: ListBindingRef[],
  node: number,
  kind: ItemHandlerRef["kind"] = "click",
): boolean {
  const row = rowOf(ui, refs, node);
  if (!row) return false;

  const handler = row.ref.itemHandlers.find((h) => h.offset === row.offset && h.kind === kind);
  if (!handler) return false;

  batch(() => handler.fn(row.item as never, row.index));
  return true;
}

/**
 * Runs a row's `onChange`, with the control's new value as a third argument.
 *
 * The change path had no per-row equivalent at all, and the gap was not a missing feature
 * so much as a trap: a handler inside a template is *lifted* out of `ui.handlers` into the
 * list's own table, so `dispatchChange` looked for it where it no longer was and a
 * checkbox in a row reached nothing. Silently, and only in a list.
 *
 * The signature is `(item, index, value)` rather than `(value)`, because a row handler
 * already takes its item and index and a change handler in a row needs all three — which
 * row was ticked is exactly the question a list of checkboxes asks.
 *
 * `raw` is converted the same way [`dispatchChange`] converts it, and for the same
 * reason: the integer's meaning is the control's kind, and that is a protocol detail an
 * author writing `onChange={(t, i, on) => …}` should never see. The lookup is by the
 * *replica's* node, which only resolves because the compiler now gives every row its own
 * control row — see `replicateListControls`.
 */
export function dispatchItemChange(
  ui: CompiledUi,
  refs: ListBindingRef[],
  node: number,
  raw: number,
): boolean {
  const row = rowOf(ui, refs, node);
  if (!row) return false;

  const handler = row.ref.itemHandlers.find((h) => h.offset === row.offset && h.kind === "change");
  if (!handler) return false;

  let kind: number = ControlKind.NONE;
  for (let r = 0; r < ui.controls.count; r++) {
    if (ui.controls.node[r] === node) {
      kind = ui.controls.kind[r]!;
      break;
    }
  }
  const value = kind === ControlKind.CHECKBOX || kind === ControlKind.RADIO ? raw === 1 : raw;

  batch(() => handler.fn(row.item as never, row.index, value));
  return true;
}

/**
 * Routes a keystroke into a `bind:value` inside a list row.
 *
 * Tried before [`typeInto`], and it has to be: a row's element is in an arena, so it is in
 * no `editables` table at all — the compiler lifted the binding into the list the same way
 * it lifts a row's handlers. Returning false means "not a row of mine", which is what lets
 * the host fall through to the ordinary signal-backed path.
 *
 * **The write is a whole new item, not a mutation.** A signal compares with `Object.is`, so
 * editing `items[i].title` in place would leave the array identical to itself and publish
 * nothing: the row would keep the text it had, and only the caret would move. Replacing the
 * item — and the array — is what makes an ordinary `signal.set` propagate, which is also
 * what re-renders the row's slot through the path it was already bound by.
 */
export function typeIntoRow(
  ui: CompiledUi,
  refs: ListBindingRef[],
  node: number,
  input: { text: string | null; erase?: Erase; caret?: number; anchor?: number },
): boolean {
  const row = rowOf(ui, refs, node);
  if (!row) return false;

  const target = row.ref.itemEditables.find((e) => e.offset === row.offset);
  if (!target) return false;

  const current = readPath(row.item, target.path);
  const edit = editText(current === undefined || current === null ? "" : String(current), input);
  if (typeof edit !== "string") return edit;

  const signal = row.ref.signal as unknown as { value: unknown[]; set: (v: unknown[]) => void };
  const items = signal.value ?? [];
  const next = items.slice();
  next[row.index] = writeItem(items[row.index], target.path, edit);
  batch(() => {
    signal.set(next);
  });
  return true;
}

/**
 * One item with `path` set to `value`, copying only the objects along the way.
 *
 * Structural sharing rather than a deep clone: everything the path does not pass through is
 * the same reference afterwards, so a row carrying a large object is not rebuilt on every
 * keystroke. An array on the path stays an array — `items[0].tags[1]` has to keep its
 * indices, and a plain-object copy would turn it into `{0: …, 1: …}`.
 */
function writeItem(item: unknown, path: ItemPath, value: string): unknown {
  if (path.length === 0) return value;

  const [step, ...rest] = path;
  const key = step as string | number;

  if (Array.isArray(item)) {
    const copy = item.slice();
    copy[key as number] = writeItem(item[key as number], rest, value);
    return copy;
  }

  const source = (item ?? {}) as Record<string | number, unknown>;
  return { ...source, [key]: writeItem(source[key], rest, value) };
}

void findRow;
