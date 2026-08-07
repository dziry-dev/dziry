/** @jsxImportSource . */

/**
 * A dynamic list is spliced into its container's child chain, not wrapped.
 *
 * There used to be a `LIST` node between the container and the rows, copying the
 * container's `display`, tracks, gaps and alignment onto itself. That is a
 * faithful `display: contents` emulation for a flex column and wrong for
 * everything else — inside a grid the wrapper is a single item occupying a
 * single cell, with its own N tracks nested inside it, so every row rendered
 * into one cell. The sample app never showed it because its one list sits in a
 * flex column.
 *
 * These compile a real list through the JSX front end, because the HTML front
 * end cannot express one.
 */
import { expect, test } from "bun:test";

import { compileTree, toCompiledUi } from "./compile.ts";
import { toDocument } from "./jsx-runtime.ts";
import { signal, setCompiling } from "../runtime/signal.ts";
import {
  dispatchItem,
  dispatchItemChange,
  updateList,
  type ListBindingRef,
} from "../runtime/list-runtime.ts";
import { Display, type CompiledUi } from "../ir.ts";

type Item = { id: number; title: string };

const CSS = `
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); }
  .row  { height: 10px }
`;

/** Builds the document with the compiler's recording mode on, as the CLI does. */
function build(items: Item[]) {
  const data = signal(items);
  setCompiling(true);
  let doc;
  try {
    doc = toDocument(
      <div className="grid">
        <span className="before" />
        {data.value.map((t: Item) => <span className="row">{t.title}</span>, {
          key: (t: Item) => t.id,
        })}
        <span className="after" />
      </div>,
    );
  } finally {
    setCompiling(false);
  }
  return { data, result: compileTree(doc, CSS) };
}

/** The chain under `node`, as node ids in order. */
function chainOf(ui: CompiledUi, node: number): number[] {
  const out: number[] = [];
  let c = ui.nodes.firstChild[node]!;
  while (c >= 0 && out.length < 64) {
    out.push(c);
    c = ui.nodes.nextSibling[c]!;
  }
  return out;
}

test("the rows are children of the container, with no node in between", () => {
  const { result } = build([{ id: 1, title: "a" }]);
  const list = result.lists[0]!;

  // The container is the `.grid` element itself. Under the wrapper design the
  // rows' parent was a node the author never wrote, one level deeper, whose
  // `display` and tracks were copied from this one.
  expect(result.nodes[list.container]!.children.length).toBe(2);
  expect(list.container).toBe(result.nodes[list.arenaStart]!.parent);

  // And the rows are not *static* children: they enter the chain at run time.
  expect(result.nodes[list.container]!.children).not.toContain(list.arenaStart);

  for (let item = 0; item < list.capacity; item++) {
    const row = list.arenaStart + item * list.stride;
    expect(result.nodes[row]!.parent).toBe(list.container);
  }
});

test("the anchors name the static siblings the rows sit between", () => {
  const { result } = build([{ id: 1, title: "a" }]);
  const list = result.lists[0]!;
  const staticKids = result.nodes[list.container]!.children;

  // `.before` and `.after` are the only static children; the rows go between.
  expect(staticKids.length).toBe(2);
  expect(list.anchorPrev).toBe(staticKids[0]!);
  expect(list.anchorNext).toBe(staticKids[1]!);
});

test("rows are grid items of the container, not of a nested grid", () => {
  // The bug, stated structurally. The container declares three tracks; under
  // the wrapper design the container had exactly *one* item — the wrapper —
  // which auto-placed into column 1 and re-declared the same three tracks
  // inside that one cell. Taffy was never wrong; it was given the wrong tree.
  const { result } = build([{ id: 1, title: "a" }]);
  const list = result.lists[0]!;
  const grid = result.styles[result.nodes[list.container]!.style]!;

  expect(grid.display).toBe(Display.GRID);
  expect(grid.gridCols).toBe(3);

  // No descendant of the container re-declares the tracks.
  for (let item = 0; item < list.capacity; item++) {
    const row = list.arenaStart + item * list.stride;
    expect(result.styles[result.nodes[row]!.style]!.gridCols).toBe(0);
  }
});

test("an empty list links its anchors straight together", () => {
  const { data, result } = build([]);
  const ui = toCompiledUi(result);
  const list = result.lists[0]!;

  updateList(ui, {
    list: 0,
    signal: data,
    keyPath: ["id"],
    slotStart: list.slotStart,
    slotsPerItem: list.bindings.length,
    bindings: list.bindings.map((b) => ({
      offset: b.offset,
      slotOffset: b.slotOffset,
      parts: [{ path: ["title"] }],
    })),
    itemHandlers: [],
  } as ListBindingRef);

  expect(chainOf(ui, list.container)).toEqual([list.anchorPrev, list.anchorNext]);
});

test("rows splice between the anchors and reorder without disturbing them", () => {
  const items: Item[] = [
    { id: 1, title: "a" },
    { id: 2, title: "b" },
    { id: 3, title: "c" },
  ];
  const { data, result } = build(items);
  const ui = toCompiledUi(result);
  const list = result.lists[0]!;

  const ref = {
    list: 0,
    signal: data,
    keyPath: ["id"],
    slotStart: list.slotStart,
    slotsPerItem: list.bindings.length,
    bindings: list.bindings.map((b) => ({
      offset: b.offset,
      slotOffset: b.slotOffset,
      parts: [{ path: ["title"] }],
    })),
    itemHandlers: [],
  } as ListBindingRef;

  updateList(ui, ref);

  const chain = chainOf(ui, list.container);
  expect(chain[0]).toBe(list.anchorPrev);
  expect(chain[chain.length - 1]).toBe(list.anchorNext);
  expect(chain.length).toBe(5);

  // Each row is an arena item root, and they are distinct nodes.
  const rows = chain.slice(1, -1);
  for (const row of rows) {
    expect((row - list.arenaStart) % list.stride).toBe(0);
  }
  expect(new Set(rows).size).toBe(3);

  // A reorder permutes the middle and leaves the anchors exactly where they are.
  data.value = [items[2]!, items[0]!, items[1]!];
  updateList(ui, ref);

  const after = chainOf(ui, list.container);
  expect(after[0]).toBe(list.anchorPrev);
  expect(after[after.length - 1]).toBe(list.anchorNext);
  expect(new Set(after.slice(1, -1))).toEqual(new Set(rows));
  expect(after.slice(1, -1)).not.toEqual(rows);
});

/**
 * `:last-child` beside a dynamic list, which is the one place a structural
 * pseudo-class has no compile-time answer.
 *
 * A list's length is a runtime value, so "is this the last child" is too — for the
 * rows themselves and for any static sibling the list could come after. The guess
 * is documented in `matchStructural`: unknown resolves to *not matching*, so
 * `:not(:last-child)` holds and every row keeps its margin. One margin too many
 * after the final row is a much smaller wrong answer than no spacing at all, which
 * is what resolving it the other way would produce.
 *
 * The test is the guess, not the ideal. If per-row structural styles ever become
 * runtime-resolvable, this is the test that should change.
 */
test("a structural pseudo-class beside a dynamic list resolves to not-matching", () => {
  const data = signal<Item[]>([{ id: 1, title: "a" }, { id: 2, title: "b" }]);
  setCompiling(true);
  let doc;
  try {
    doc = toDocument(
      <div className="sp">
        <span className="before" />
        {data.value.map((t: Item) => <span className="row">{t.title}</span>, {
          key: (t: Item) => t.id,
        })}
      </div>,
    );
  } finally {
    setCompiling(false);
  }

  const result = compileTree(doc, `.sp > :not(:last-child) { margin-block-end: 16px }`);
  const ui = toCompiledUi(result);
  const marginOf = (node: number) => result.styles[result.nodes[node]!.style]!.marB;

  // `.before` could be followed by zero rows, in which case it *is* the last child
  // and a browser would give it no margin. Unknown, so it keeps one.
  const staticKids = result.nodes[result.lists[0]!.container]!.children;
  expect(marginOf(staticKids[0]!)).toBe(16);

  // Every row keeps its margin too, including whichever one is last at run time.
  const list = result.lists[0]!;
  for (let item = 0; item < list.capacity; item++) {
    expect(marginOf(list.arenaStart + item * list.stride)).toBe(16);
  }

  // The container is not a child of `.sp` and must not have been given one.
  expect(marginOf(ui.root)).toBe(0);
});

/**
 * Controls inside a row, which were structurally replicated and semantically not.
 *
 * A list arena is `capacity` copies of one template. The copy took nodes, styles and text
 * slots; anything held in a *side table* keyed by node id stayed behind. So a checkbox in
 * a row compiled to exactly one control row — for row 0 — and rows 1..7 were painted
 * boxes that swallowed presses, were skipped by Tab, and emitted no `CHANGE`.
 *
 * It needed two items to show. Every existing test and the demo's one list used a single
 * item, which only ever renders row 0.
 */
function buildControls() {
  const data = signal([
    { id: 1, title: "a" },
    { id: 2, title: "b" },
  ]);
  setCompiling(true);
  let doc;
  try {
    doc = toDocument(
      <div>
        {data.value.map(
          (t: Item) => (
            <label className="row">
              <input type="checkbox" onChange={() => {}} />
              <span>{t.title}</span>
            </label>
          ),
          { key: (t: Item) => t.id },
        )}
      </div>,
    );
  } finally {
    setCompiling(false);
  }
  return { data, result: compileTree(doc, CSS) };
}

test("every row of a list gets its template's control rows", () => {
  const { result } = buildControls();
  const ui = toCompiledUi(result);
  const list = result.lists[0]!;

  // One per row, not one in total.
  expect(ui.controls.count).toBe(list.capacity);

  // At the same offset within each row, which is what makes them the same control.
  const offsets = new Set<number>();
  for (let r = 0; r < ui.controls.count; r++) {
    const node = ui.controls.node[r]!;
    offsets.add((node - list.arenaStart) % list.stride);
  }
  expect(offsets.size).toBe(1);

  // Ascending, because the engine binary-searches this column and the replicas are
  // appended after every node the walk produced. Unsorted, every lookup past the first
  // arena silently misses — and misses by returning *some other control*.
  const nodes = [...ui.controls.node].slice(0, ui.controls.count);
  expect(nodes).toEqual([...nodes].sort((a, b) => a - b));
});

test("every row is a tab stop, not just the first", () => {
  const { result } = buildControls();
  const ui = toCompiledUi(result);
  const list = result.lists[0]!;

  // `tabStop` is a per-node boolean the replication loop was not copying, so Tab walked
  // into row 0's checkbox and then straight past the other seven.
  expect([...ui.tabStops].length).toBe(list.capacity);
});

test("a row's label activates that row's control, not row zero's", () => {
  const { result } = buildControls();
  const list = result.lists[0]!;

  // The template is a `<label>` wrapping the box, so the label's press is redirected to
  // the control — `activates`, a node id, which has to be shifted per row. Unshifted,
  // clicking any row's text would tick the *first* row's box.
  for (let item = 0; item < list.capacity; item++) {
    const row = list.arenaStart + item * list.stride;
    const activates = result.nodes[row]!.activates;
    expect(activates).toBeGreaterThanOrEqual(row);
    expect(activates).toBeLessThan(row + list.stride);
  }
});

test("a row's onChange runs, with its item, its index and a converted value", () => {
  const { data, result } = buildControls();
  const ui = toCompiledUi(result);
  const list = result.lists[0]!;

  const seen: Array<[string, number, unknown]> = [];
  const ref = {
    list: 0,
    signal: data,
    keyPath: ["id"],
    slotStart: list.slotStart,
    slotsPerItem: list.bindings.length,
    bindings: list.bindings.map((b) => ({
      offset: b.offset,
      slotOffset: b.slotOffset,
      parts: [{ path: ["title"] }],
    })),
    itemHandlers: [
      {
        offset: list.itemHandlers[0]!.offset,
        kind: "change" as const,
        fn: (t: Item, i: number, v?: unknown) => seen.push([t.title, i, v]),
      },
    ],
  } as unknown as ListBindingRef;

  // `slotData` is what maps a node back to an item, and only `updateList` fills it.
  updateList(ui, ref);

  const box = (row: number) => list.arenaStart + row * list.stride + list.itemHandlers[0]!.offset;

  expect(dispatchItemChange(ui, [ref], box(1), 1)).toBe(true);
  // The **second** row's item, not the first. This is the whole indirection: one compiled
  // handler, and the slot says which item it is running for.
  expect(seen).toEqual([["b", 1, true]]);

  // A checkbox hands over a boolean rather than the wire integer, exactly as
  // `dispatchChange` does off a list — and that lookup only resolves because the replica
  // now has a control row of its own.
  seen.length = 0;
  expect(dispatchItemChange(ui, [ref], box(0), 0)).toBe(true);
  expect(seen).toEqual([["a", 0, false]]);
});

test("a click does not run the row's change handler", () => {
  const { data, result } = buildControls();
  const ui = toCompiledUi(result);
  const list = result.lists[0]!;

  const seen: string[] = [];
  const offset = list.itemHandlers[0]!.offset;
  const ref = {
    list: 0,
    signal: data,
    keyPath: ["id"],
    slotStart: list.slotStart,
    slotsPerItem: list.bindings.length,
    bindings: list.bindings.map((b) => ({
      offset: b.offset,
      slotOffset: b.slotOffset,
      parts: [{ path: ["title"] }],
    })),
    // Two handlers at the *same offset*, which is the case a kind-less lookup cannot tell
    // apart: it finds by offset, so it would return whichever was emitted first and run a
    // change handler on a click, with a click's arguments.
    itemHandlers: [
      { offset, kind: "change" as const, fn: () => seen.push("change") },
      { offset, kind: "click" as const, fn: () => seen.push("click") },
    ],
  } as unknown as ListBindingRef;

  updateList(ui, ref);
  const box = list.arenaStart + offset;

  expect(dispatchItem(ui, [ref], box, "click")).toBe(true);
  expect(seen).toEqual(["click"]);
});

test("a prop given a signal is refused out loud, not dropped in silence", () => {
  // `disabled={isBusy}` compiles cleanly and produces a control that is never disabled:
  // the attribute map holds text, because a selector compares against text, so a signal
  // has nowhere to go. Everything about that is correct except the silence.
  const busy = signal(true);
  setCompiling(true);
  let doc;
  try {
    doc = toDocument(
      <div>
        <input type="checkbox" disabled={busy as never} />
      </div>,
    );
  } finally {
    setCompiling(false);
  }
  const result = compileTree(doc, "");
  const ui = toCompiledUi(result);

  expect(result.warnings.join("\n")).toMatch(/disabled=\{…\} was given a signal, which is ignored/);
  // And the behaviour it warns about is real: the control is not disabled.
  expect(ui.controls.flags[0]).toBe(0);
});
