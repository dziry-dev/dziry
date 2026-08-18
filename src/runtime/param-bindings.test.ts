import { expect, test } from "bun:test";
import { applyParamBindings, Dirty } from "./bindings.ts";
import type { CompiledUi } from "../ir.ts";

function ui(parts: { literal?: string; param?: string }[][]): CompiledUi {
  return {
    strings: parts.map(() => ""),
    paramBindings: parts.map((p, i) => ({ node: i + 1, slot: i, parts: p })),
    textBindings: [],
  } as unknown as CompiledUi;
}

test("a {param} part resolves against the active route's params", () => {
  const u = ui([
    [{ literal: "#" }, { param: "id" }],
    [{ literal: "hello " }, { param: "name" }, { literal: "!" }],
  ]);

  const changed: number[] = [];
  const dirty = applyParamBindings(u, { id: "42", name: "ada" }, changed);

  expect(u.strings[0]).toBe("#42");
  expect(u.strings[1]).toBe("hello ada!");
  expect(changed).toEqual([1, 2]);
  expect(dirty).toBe(Dirty.LAYOUT);
});

test("an absent param renders empty — correct for a hidden route", () => {
  const u = ui([[{ param: "id" }]]);
  applyParamBindings(u, {}, []);
  expect(u.strings[0]).toBe("");
});

test("unchanged text is a no-op", () => {
  const u = ui([[{ literal: "fixed" }]]);
  u.strings[0] = "fixed";
  const changed: number[] = [];
  const dirty = applyParamBindings(u, {}, changed);
  expect(dirty).toBe(Dirty.NONE);
  expect(changed).toEqual([]);
});
