/**
 * readPath — the read half of the compiler's recorded paths.
 *
 * Two callers with opposite tolerances rely on the same walk: list rows (a
 * missing key is a blank cell, not a crash) and route loader exits (a loader
 * that returned null must read as empty, not throw). The short-circuit is the
 * contract.
 */
import { expect, test } from "bun:test";
import { readPath } from "./read-path.ts";

test("an empty path is the item itself", () => {
  const item = { title: "x" };
  expect(readPath(item, [])).toBe(item);
});

test("a key path reads through objects", () => {
  expect(readPath({ a: { b: { c: 7 } } }, ["a", "b", "c"])).toBe(7);
});

test("numeric steps index arrays — a recorded [0] arrives as a number, not a string", () => {
  expect(readPath({ rows: [{ title: "first" }] }, ["rows", 0, "title"])).toBe("first");
});

test("a null or undefined on the path reads as undefined, not a throw", () => {
  expect(readPath(null, ["a", "b"])).toBeUndefined();
  expect(readPath({ a: null }, ["a", "b"])).toBeUndefined();
  expect(readPath({}, ["missing", "deeper"])).toBeUndefined();
});

test("a present but falsy leaf is returned as itself", () => {
  expect(readPath({ done: false }, ["done"])).toBe(false);
  expect(readPath({ count: 0 }, ["count"])).toBe(0);
});
