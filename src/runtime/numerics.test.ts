// numerics.ts unit tests: per-mille conversion and number stepping
import { expect, test } from "bun:test";
import { rangeValue, rangePermille, stepValue } from "./numerics.ts";
import { compile, toCompiledUi } from "../compiler/compile.ts";

function rangeUi(min: number, max: number, step: number) {
  return toCompiledUi(compile(
    '<body><input type="range" min="' + min + '" max="' + max + '" step="' + step + '"></body>',
    ''
  ));
}

test("rangeValue: mid-track per-mille gives mid-range value", () => {
  const ui = rangeUi(0, 100, 1);
  // The input is the first node in the tree, index 1 (body is 0)
  const node = ui.controls.node[0]!;
  expect(rangeValue(ui, node, 500)).toBe(50);
});

test("rangeValue: 0 per-mille gives min", () => {
  const ui = rangeUi(10, 20, 1);
  const node = ui.controls.node[0]!;
  expect(rangeValue(ui, node, 0)).toBe(10);
});

test("rangeValue: 1000 per-mille gives max", () => {
  const ui = rangeUi(10, 20, 1);
  const node = ui.controls.node[0]!;
  expect(rangeValue(ui, node, 1000)).toBe(20);
});

test("rangePermille: value to per-mille round-trip", () => {
  const ui = rangeUi(0, 100, 1);
  const node = ui.controls.node[0]!;
  expect(rangePermille(ui, node, 75)).toBe(750);
  expect(rangePermille(ui, node, 0)).toBe(0);
  expect(rangePermille(ui, node, 100)).toBe(1000);
});

test("rangeValue snaps to step", () => {
  const ui = rangeUi(0, 100, 10);
  const node = ui.controls.node[0]!;
  // 553 per-mille = 55.3 raw -> snapped to 50 (nearest 10-step from 0)
  expect(rangeValue(ui, node, 553)).toBe(60); // Math.round(55.3/10)*10 = 60
});

test("stepValue: arrow up increments by step", () => {
  const n = { min: 0, max: 100, step: 5 };
  expect(stepValue("10", n, 1)).toBe("15");
  expect(stepValue("95", n, 1)).toBe("100");
  expect(stepValue("100", n, 1)).toBe("100"); // clamped at max
});

test("stepValue: arrow down decrements by step", () => {
  const n = { min: 0, max: 100, step: 5 };
  expect(stepValue("10", n, -1)).toBe("5");
  expect(stepValue("5", n, -1)).toBe("0");
  expect(stepValue("0", n, -1)).toBe("0"); // clamped at min
});

test("stepValue: empty field steps from min", () => {
  const n = { min: 10, max: 100, step: 5 };
  expect(stepValue("", n, 1)).toBe("15"); // from min=10, +5 = 15
});

test("stepValue: unbounded number field steps from 0 when empty", () => {
  const n = { min: NaN, max: NaN, step: 1 };
  expect(stepValue("", n, 1)).toBe("1"); // from 0 + 1
  expect(stepValue("", n, -1)).toBe("-1"); // from 0 - 1
});
