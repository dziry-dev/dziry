/**
 * The rewrite, end to end: a real authored module, reactive at run time.
 *
 * `reactive-transform.test.ts` checks the text the transform produces.
 * The `reactivity` golden checks the first frame. Neither covers the thing the whole
 * exercise is for — that a *write* propagates through expressions the rewrite
 * created — and a first frame is exactly what a frozen value gets right.
 *
 * So this imports `windows/main/reactivity.ts`, which the `bunfig.toml` preload
 * rewrites on the way in, and drives it. Every derived value below is an operator
 * that a bare signal used to break.
 */
import { expect, test } from "bun:test";
import { bump, doubled, drop, isBig, isThree, langCount, langs, parity, reset, shout, tick } from "../../windows/main/reactivity.ts";

/** Reads go through `.value` here — this file is framework code, not rewritten. */
const read = <T,>(cell: { value: T }): T => cell.value;

test("the module is rewritten, or every assertion below is vacuous", async () => {
  // If the preload did not run, `computed(() => tick * 2)` computed `NaN` from an
  // object and these would all be quietly wrong rather than failing. Assert the
  // premise first.
  const source = await Bun.file(new URL("../../windows/main/reactivity.ts", import.meta.url)).text();
  expect(source).toContain("computed(() => tick * 2)");
  expect(read(doubled)).toBe(6);
});

test("arithmetic on a bare signal tracks a write", () => {
  reset();
  expect(read(doubled)).toBe(6);

  bump();
  expect(read(tick)).toBe(4);
  expect(read(doubled)).toBe(8);

  drop();
  drop();
  expect(read(doubled)).toBe(4);
  reset();
});

test("`===` on a bare signal tracks, which is the one no runtime trick reached", () => {
  reset();
  expect(read(isThree)).toBe(true);

  bump();
  expect(read(isThree)).toBe(false);

  drop();
  expect(read(isThree)).toBe(true);
});

test("a comparison and a ternary both follow the signal", () => {
  reset();
  expect(read(isBig)).toBe(false);
  expect(read(parity)).toBe("odd");

  for (let i = 0; i < 3; i++) bump();
  expect(read(tick)).toBe(6);
  expect(read(isBig)).toBe(true);
  expect(read(parity)).toBe("even");

  reset();
  expect(read(isBig)).toBe(false);
});

test("a template literal recomputes, rather than freezing its first answer", () => {
  reset();
  expect(read(shout)).toBe("tick is 3, which is small");

  for (let i = 0; i < 4; i++) bump();
  expect(read(shout)).toBe("tick is 7, which is big");
  reset();
});

test("`.set` takes a value or a function of the previous one", () => {
  reset();

  tick.set(10);
  expect(read(tick)).toBe(10);

  tick.set((n) => n * 2);
  expect(read(tick)).toBe(20);
  expect(read(doubled)).toBe(40);

  reset();
  expect(read(tick)).toBe(3);
});

test("a derived over an array follows a write to the array", () => {
  const before = read(langCount);
  langs.set((ls) => [...ls, { id: 99, name: "Zig", kind: "added" }]);
  expect(read(langCount)).toBe(before + 1);

  langs.set((ls) => ls.filter((l) => l.id !== 99));
  expect(read(langCount)).toBe(before);
});
