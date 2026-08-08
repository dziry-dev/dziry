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
import { local, LocalStateError } from "./reactive-runtime.ts";

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

/**
 * Component-local state, driven through the compiled artifact.
 *
 * The only reference kind that does not survive the file boundary by being imported:
 * `const locals = [signal(0)]` is *declared* in `ui.gen.ts`, and the inline handlers
 * are functions it contains rather than names it imports. So the round trip is the
 * only thing that proves it — the transform and the emitter can each look right while
 * disagreeing about which slot is which.
 */
test("a component-local signal round-trips through the artifact", async () => {
  const ui = (await import("../../windows/main/ui.gen.ts")) as unknown as {
    textBindings: { node: number; parts: { signal?: { value: number } }[] }[];
    handlers: { node: number; fn: () => void }[];
  };

  // Found by shape rather than by node id, which moves whenever the page does. An
  // inline handler is a function the artifact *contains*, so its own source names the
  // local it writes — nothing else in the module looks like that.
  //
  // **Not an exact count.** This asserted `toHaveLength(2)` and was really asserting
  // that the counter is the only component-local state in the whole demo, which stopped
  // being true the moment the controls page wired an `onChange` to a local. That is a
  // census of an unrelated page, not a fact about the round trip — so it now asks the
  // question it means: the counter's pair is present, and they are two different
  // handlers rather than one found twice.
  const inline = ui.handlers.filter((h) => /\blocal_\d+\b/.test(h.fn.toString()));
  expect(inline.length).toBeGreaterThanOrEqual(2);

  // A pair that writes **the same local**, which is the invariant this test is actually
  // about: one handler undoes the other. Anything weaker keeps drifting as the demo grows,
  // and it has now drifted three times — each fix one step behind the next page:
  //
  //   `toHaveLength(2)`      — a census of every component-local in the demo.
  //   source contains "+"/"-" — a form handler saying "the two-field form" became `minus`.
  //   the shape, independently — the demo gained a *second* counter, so `plus` came from one
  //                             signal and `minus` from the other, and the test reported
  //                             that the counter did not go back down.
  //
  // Each time the test kept passing while measuring something else, then failed for a
  // reason that had nothing to do with the round trip. Grouping by the local is the first
  // version that cannot: it asks for two handlers on one signal, which is the thing.
  const counter = /local_(\d+)\.set\(local_\1\.value ([-+]) 1\)/;
  const pairs = new Map<string, Record<string, (typeof inline)[number]>>();
  for (const handler of inline) {
    const match = counter.exec(handler.fn.toString());
    if (!match) continue;
    const arms = pairs.get(match[1]!) ?? {};
    arms[match[2]!] = handler;
    pairs.set(match[1]!, arms);
  }

  const pair = [...pairs.values()].find((arms) => arms["+"] && arms["-"]);
  expect(pair).toBeDefined();
  const plus = pair!["+"]!;
  const minus = pair!["-"]!;
  expect(plus).not.toBe(minus);

  /** Every signal any binding holds, so a change can be located rather than assumed. */
  const cells = ui.textBindings
    .flatMap((b) => b.parts)
    .map((p) => p.signal)
    .filter((s): s is { value: number } => s !== undefined);

  const snapshot = () => cells.map((c) => c.value);
  const before = snapshot();

  plus.fn();
  const after = snapshot();

  // Exactly one bound cell moved, and by one — which is the round trip: the handler
  // the artifact declared writes the signal the artifact declared, and a *binding*
  // reads it. Any of those three disagreeing shows up here as zero changes.
  const moved = before.map((v, i) => v !== after[i]).filter(Boolean);
  expect(moved).toHaveLength(1);

  const which = before.findIndex((v, i) => v !== after[i]);
  expect(after[which]).toBe(before[which]! + 1);

  minus.fn();
  expect(snapshot()[which]).toBe(before[which]);
});

test("a local whose initial value cannot be written down is refused", () => {
  // The artifact re-creates it as `signal(<initial>)`, so the initial has to survive
  // being written down. Refusing beats emitting a module that cannot express it.
  expect(() => local(new Map(), "cache")).toThrow(LocalStateError);
  expect(() => local(new Map(), "cache")).toThrow(/cannot be written down/);
  expect(() => local(() => 1, "fn")).toThrow(LocalStateError);

  // JSON-shaped initials are all fine.
  expect(() => local(0, "n")).not.toThrow();
  expect(() => local("", "s")).not.toThrow();
  expect(() => local([1, 2], "xs")).not.toThrow();
  expect(() => local({ a: 1, b: [true, null] }, "o")).not.toThrow();
});

test("a derived over an array follows a write to the array", () => {
  const before = read(langCount);
  langs.set((ls) => [...ls, { id: 99, name: "Zig", kind: "added" }]);
  expect(read(langCount)).toBe(before + 1);

  langs.set((ls) => ls.filter((l) => l.id !== 99));
  expect(read(langCount)).toBe(before);
});
