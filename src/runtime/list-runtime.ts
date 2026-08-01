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
import { findRow, type CompiledUi } from "../ir.ts";
import type { ItemPath } from "../compiler/item-path.ts";
import { Dirty } from "./bindings.ts";
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
  fn: (item: never, index: number) => void;
};

export type ListBindingRef = {
  list: number;
  signal: ReadonlySignal<unknown[]>;
  keyPath: ItemPath;
  slotStart: number;
  slotsPerItem: number;
  bindings: ItemBindingRef[];
  itemHandlers: ItemHandlerRef[];
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

  lists.arenaStart[ref.list] = newStart;
  lists.capacity[ref.list] = capacity;
  ref.slotStart = slotStart;

  // Slot identity is meaningless in a new arena; every item is reassigned below.
  slotKeys.delete(ref);
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
 * Runs a per-row handler if `node` is inside a list arena.
 *
 * The clicked node is decomposed into (slot, offset): the offset identifies which
 * handler in the template was hit, and the slot says which item is currently
 * rendered there. That indirection is why one compiled handler serves every row.
 */
export function dispatchItem(ui: CompiledUi, refs: ListBindingRef[], node: number): boolean {
  for (const ref of refs) {
    const start = ui.lists.arenaStart[ref.list]!;
    const stride = ui.lists.stride[ref.list]!;
    const capacity = ui.lists.capacity[ref.list]!;

    if (node < start || node >= start + capacity * stride) continue;

    const slot = Math.floor((node - start) / stride);
    const offset = node - start - slot * stride;

    const handler = ref.itemHandlers.find((h) => h.offset === offset);
    if (!handler) return false;

    const index = ref.slotData?.[slot] ?? -1;
    if (index < 0) return false;

    const items = ref.signal.value ?? [];
    batch(() => handler.fn(items[index] as never, index));
    return true;
  }
  return false;
}

void findRow;
