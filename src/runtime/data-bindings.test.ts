import { expect, test } from "bun:test";
import { applyDataBindings, applyErrorBindings, Dirty } from "./bindings.ts";
import type { CompiledUi } from "../ir.ts";

function dataUi(parts: { literal?: string; data?: (string | number)[] }[][]): CompiledUi {
  return {
    strings: parts.map(() => ""),
    dataBindings: parts.map((p, i) => ({ node: i + 1, slot: i, parts: p })),
    textBindings: [],
  } as unknown as CompiledUi;
}

test("a {data.x} part resolves against the loader's success value", () => {
  const u = dataUi([[{ literal: "Product: " }, { data: ["title"] }]]);

  const changed: number[] = [];
  const dirty = applyDataBindings(u, { title: "Widget" }, changed);

  expect(u.strings[0]).toBe("Product: Widget");
  expect(changed).toEqual([1]);
  expect(dirty).toBe(Dirty.LAYOUT);
});

test("a nested data path reads through objects", () => {
  const u = dataUi([[{ data: ["owner", "name"] }]]);
  applyDataBindings(u, { owner: { name: "Ada" } }, []);
  expect(u.strings[0]).toBe("Ada");
});

test("an absent success value renders empty — before the loader settles", () => {
  const u = dataUi([[{ data: ["title"] }]]);
  applyDataBindings(u, undefined, []);
  expect(u.strings[0]).toBe("");
});

test("error bindings resolve against the failure value", () => {
  const u = {
    strings: [""],
    errorBindings: [{ node: 1, slot: 0, parts: [{ error: ["message"] }] }],
    textBindings: [],
  } as unknown as CompiledUi;

  applyErrorBindings(u, new Error("boom"), []);
  expect(u.strings[0]).toBe("boom");
});
