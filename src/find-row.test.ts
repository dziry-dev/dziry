/**
 * findRow — the binary search the runtime's state and interactive tables are
 * consulted through.
 *
 * Boundary-heavy on purpose: every off-by-one in a hand-rolled binary search
 * lives at an end or in the empty case, and the callers (`list-runtime.ts`)
 * have no fallback — a wrong index is a wrong row written.
 */
import { expect, test } from "bun:test";
import { findRow } from "./find-row.ts";

test("finds every element of a sorted array, ends included", () => {
  const sorted = new Int32Array([1, 3, 5, 7, 9]);
  for (let i = 0; i < sorted.length; i++) expect(findRow(sorted, sorted[i]!)).toBe(i);
});

test("a missing value is -1, between, below and above", () => {
  const sorted = new Int32Array([10, 20, 30]);
  expect(findRow(sorted, 15)).toBe(-1);
  expect(findRow(sorted, 5)).toBe(-1);
  expect(findRow(sorted, 35)).toBe(-1);
});

test("empty and singleton arrays", () => {
  expect(findRow(new Int32Array(0), 1)).toBe(-1);
  expect(findRow(new Int32Array([4]), 4)).toBe(0);
  expect(findRow(new Int32Array([4]), 5)).toBe(-1);
});

test("an even-length array still converges", () => {
  const sorted = new Int32Array([2, 4, 6, 8]);
  expect(findRow(sorted, 2)).toBe(0);
  expect(findRow(sorted, 8)).toBe(3);
  expect(findRow(sorted, 7)).toBe(-1);
});
