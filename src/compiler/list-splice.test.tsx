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
import { updateList, type ListBindingRef } from "../runtime/list-runtime.ts";
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
