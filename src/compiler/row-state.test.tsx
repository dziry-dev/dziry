/**
 * Per-row state from data — `cn({ done: t.done })` and `checked={t.done}`.
 *
 * The mechanism under test is v45's: the compiler resolves the class both ways
 * into the node's variant run behind `Predicate.ROW`, gives the element a
 * control row to carry the bit, and the list update writes `ControlFlags.ROW`
 * (or `CHECKED`, under the `DATA_CHECKED` marker) per replica from the row's
 * own data. The tests run the compiler and the list runtime together, because
 * the contract is the pair: what one emits is exactly what the other writes.
 */
import { expect, test } from "bun:test";
import { compileTree, toCompiledUi, type CompileResult } from "./compile.ts";
import { cn, toDocument } from "./jsx-runtime.ts";
import { setCompiling, signal, type Signal } from "../runtime/signal.ts";
import { updateList, takeListControlsTouched, type ListBindingRef } from "../runtime/list-runtime.ts";
import { findRow } from "../find-row.ts";
import { ControlFlags, ControlKind, Predicate } from "../protocol/generated.ts";

type Todo = { id: number; title: string; done: boolean };

const CSS = `
  .row  { color: #e4e4e7 }
  .done { color: #10b981 }
`;

function build(
  row: (t: Todo) => unknown,
  items: Todo[] = [
    { id: 1, title: "open", done: false },
    { id: 2, title: "shut", done: true },
  ],
  css = CSS,
): { data: Signal<Todo[]>; result: CompileResult } {
  const data = signal(items);
  setCompiling(true);
  let doc;
  try {
    doc = toDocument(
      <div>
        {data.value.map(row as never, { key: (t: Todo) => t.id }) as never}
      </div>,
    );
  } finally {
    setCompiling(false);
  }
  return { data, result: compileTree(doc, css) };
}

const refFor = (data: Signal<Todo[]>, result: CompileResult): ListBindingRef => {
  const list = result.lists[0]!;
  return {
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
    itemEditables: [],
    itemFlags: list.itemFlags,
    itemChecked: list.itemChecked,
  } as ListBindingRef;
};

test("cn({ done: t.done }) compiles both answers and puts the pick behind Predicate.ROW", () => {
  const { result } = build((t) => <div className={cn("row", { done: t.done })}>{t.title}</div>);
  const list = result.lists[0]!;

  expect(list.itemFlags).toEqual([{ offset: expect.any(Number) as never, path: ["done"] }]);

  const node = list.arenaStart + list.itemFlags[0]!.offset;
  const built = result.nodes[node]!;
  expect(built.mask & Predicate.ROW).toBe(Predicate.ROW);

  // Both cascades are compiled: the class-off row keeps .row's color, the
  // class-on row wears .done's. One bit picks — nothing cascades at run time.
  const off = result.styles[built.run[0]!]!;
  const on = result.styles[built.run[built.run.length - 1]!]!;
  expect(off.fg).not.toBe(on.fg);

  // The bit needs somewhere to live: a control row, NONE-kind, like v39 gave
  // text inputs for :invalid.
  const row = result.controls.find((c) => c.node === node);
  expect(row).toBeDefined();
  expect(row!.kind).toBe(ControlKind.NONE);
});

test("a second data-driven class on one element is refused by name", () => {
  expect(() =>
    build((t) => <div className={cn({ done: t.done, busy: t.done })}>{t.title}</div>),
  ).toThrow(/"done", "busy"|"busy", "done"/);
});

test("the list update writes ROW from the data, both directions, and says so once", () => {
  const { data, result } = build((t) => <div className={cn("row", { done: t.done })}>{t.title}</div>);
  const ui = toCompiledUi(result);
  const ref = refFor(data, result);
  const list = result.lists[0]!;
  const nodeOf = (slot: number) => list.arenaStart + slot * list.stride + list.itemFlags[0]!.offset;
  const flagsAt = (slot: number) =>
    ui.controls.flags[findRow(ui.controls.node.subarray(0, ui.controls.count), nodeOf(slot))]!;

  takeListControlsTouched(); // drain whatever earlier tests left
  updateList(ui, ref);
  expect(flagsAt(0) & ControlFlags.ROW).toBe(0); // "open"
  expect(flagsAt(1) & ControlFlags.ROW).toBe(ControlFlags.ROW); // "shut"
  expect(takeListControlsTouched()).toBe(true);
  expect(takeListControlsTouched()).toBe(false); // taken means taken

  // The row flips in the data; the bit follows, including *off*.
  updateList(ui, ref, [
    { id: 1, title: "open", done: true },
    { id: 2, title: "shut", done: false },
  ]);
  expect(flagsAt(0) & ControlFlags.ROW).toBe(ControlFlags.ROW);
  expect(flagsAt(1) & ControlFlags.ROW).toBe(0);
  expect(takeListControlsTouched()).toBe(true);
});

test("checked={t.done} marks the row DATA_CHECKED and the update writes the tick", () => {
  const { data, result } = build((t) => (
    <label>
      <input type="checkbox" checked={t.done} />
      {t.title}
    </label>
  ));
  const list = result.lists[0]!;
  expect(list.itemChecked).toEqual([{ offset: expect.any(Number) as never, path: ["done"] }]);

  const templateNode = list.arenaStart + list.itemChecked[0]!.offset;
  const authored = result.controls.find((c) => c.node === templateNode)!;
  expect(authored.flags & ControlFlags.DATA_CHECKED).toBe(ControlFlags.DATA_CHECKED);

  const ui = toCompiledUi(result);
  const ref = refFor(data, result);
  const nodeOf = (slot: number) => list.arenaStart + slot * list.stride + list.itemChecked[0]!.offset;
  const flagsAt = (slot: number) =>
    ui.controls.flags[findRow(ui.controls.node.subarray(0, ui.controls.count), nodeOf(slot))]!;

  updateList(ui, ref);
  expect(flagsAt(0) & ControlFlags.CHECKED).toBe(0);
  expect(flagsAt(1) & ControlFlags.CHECKED).toBe(ControlFlags.CHECKED);
  // The marker survives beside the data-written bit — rescan re-reads under it.
  expect(flagsAt(1) & ControlFlags.DATA_CHECKED).toBe(ControlFlags.DATA_CHECKED);
});

test("a signal-driven cn is still a toggle: recorders are the exception, not the rule", () => {
  const theme = signal(false);
  const { result } = build((t) => <div className={cn("row", { lit: theme })}>{t.title}</div>);
  // No ROW machinery for it — it stays on the conditional-class path.
  expect(result.lists[0]!.itemFlags).toEqual([]);
});
