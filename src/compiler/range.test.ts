// range/number/color/file/date input compiler tests
import { expect, test } from "bun:test";
import { compile, toCompiledUi } from "./compile.ts";
import { ControlKind } from "../ir.ts";

test("range emits ControlKind.RANGE and a numerics row", () => {
  const ui = toCompiledUi(compile('<body><input type="range" min="0" max="100" step="1"></body>', ''));
  const { controls, numerics } = ui;
  const kinds = [...controls.kind.subarray(0, controls.count)];
  expect(kinds).toContain(ControlKind.RANGE);
  expect(numerics.count).toBe(1);
  expect(numerics.min[0]).toBe(0);
  expect(numerics.max[0]).toBe(100);
  expect(numerics.step[0]).toBe(1);
});

test("range defaults to min=0 max=100 step=1 when attrs absent", () => {
  const { numerics } = toCompiledUi(compile('<body><input type="range"></body>', ''));
  expect(numerics.count).toBe(1);
  expect(numerics.min[0]).toBe(0);
  expect(numerics.max[0]).toBe(100);
  expect(numerics.step[0]).toBe(1);
});

test("range value=25 sets initial per-mille to 250", () => {
  const ui = toCompiledUi(compile('<body><input type="range" min="0" max="100" step="1" value="25"></body>', ''));
  const { controls } = ui;
  const row = [...controls.kind.subarray(0, controls.count)].findIndex(k => k === ControlKind.RANGE);
  expect(row).toBeGreaterThanOrEqual(0);
  expect(controls.value[row]).toBe(250); // 25/100 = 250 per-mille
});

test("range with no value uses 0xffff sentinel (engine reads as mid-track)", () => {
  const ui = toCompiledUi(compile('<body><input type="range" min="0" max="100"></body>', ''));
  const { controls } = ui;
  const row = [...controls.kind.subarray(0, controls.count)].findIndex(k => k === ControlKind.RANGE);
  expect(controls.value[row]).toBe(0xffff);
});

test("range value clamped to min when below range", () => {
  const ui = toCompiledUi(compile('<body><input type="range" min="0" max="100" value="-50"></body>', ''));
  const { controls } = ui;
  const row = [...controls.kind.subarray(0, controls.count)].findIndex(k => k === ControlKind.RANGE);
  expect(controls.value[row]).toBe(0); // clamped to min -> 0 per-mille
});

test("number emits a numerics row with min/max/step", () => {
  const ui = toCompiledUi(compile('<body><input type="number" min="0" max="100" step="5"></body>', ''));
  const { numerics } = ui;
  expect(numerics.count).toBe(1);
  expect(numerics.min[0]).toBe(0);
  expect(numerics.max[0]).toBe(100);
  expect(numerics.step[0]).toBe(5);
});

test("number without min/max gets NaN bounds but step=1", () => {
  const { numerics } = toCompiledUi(compile('<body><input type="number"></body>', ''));
  expect(numerics.count).toBe(1);
  expect(Number.isNaN(numerics.min[0]!)).toBe(true);
  expect(Number.isNaN(numerics.max[0]!)).toBe(true);
  expect(numerics.step[0]).toBe(1);
});

test("file emits ControlKind.FILE", () => {
  const ui = toCompiledUi(compile('<body><input type="file"></body>', ''));
  expect([...ui.controls.kind.subarray(0, ui.controls.count)]).toContain(ControlKind.FILE);
});

test("file UA sheet puts 'Choose file' in the string table via ::before", () => {
  const ui = toCompiledUi(compile('<body><input type="file"></body>', ''));
  expect(ui.strings.some(s => s.includes('Choose file'))).toBe(true);
});

test("controls.node is sorted ascending for range and file", () => {
  const ui = toCompiledUi(compile('<body><input type="range"><input type="file"></body>', ''));
  const nodes = [...ui.controls.node.subarray(0, ui.controls.count)];
  expect(nodes).toEqual([...nodes].sort((a, b) => a - b));
});
