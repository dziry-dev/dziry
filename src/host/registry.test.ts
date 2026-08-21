/**
 * Choosing a window and a size from argv.
 *
 * These run before the engine exists, which is exactly when an unclear error is
 * most expensive: `--window tailwnd` on a project with `tailwind` should name the
 * typo and the choices, and `--size 400` should say what the flag takes — not
 * sail through and clamp silently inside SDL.
 */
import { afterEach, expect, test } from "bun:test";
import { applyMinSize, pickWindow, sizeFrom, type WindowRegistry } from "./registry.ts";
import type { WindowArtifact } from "./registry.ts";

function registry(...ids: string[]): WindowRegistry {
  const artifacts: Record<string, WindowArtifact> = {};
  for (const id of ids) artifacts[id] = { windowId: id } as WindowArtifact;
  return { artifacts, windowIds: ids };
}

test("no --window means the first window", () => {
  expect(pickWindow(registry("main", "tailwind"), []).windowId).toBe("main");
});

test("--window picks by id", () => {
  expect(pickWindow(registry("main", "tailwind"), ["--window", "tailwind"]).windowId).toBe(
    "tailwind",
  );
});

test("an empty registry says so rather than opening nothing", () => {
  expect(() => pickWindow(registry(), [])).toThrow("no windows under ./windows");
});

test("an unknown --window names what was asked and what exists", () => {
  expect(() => pickWindow(registry("main", "tailwind"), ["--window", "tailwnd"])).toThrow(
    'no window "tailwnd". Windows are main, tailwind.',
  );
});

test("--size overrides the declared size", () => {
  expect(sizeFrom(["--size", "400x600"], { width: 800, height: 600 })).toEqual([400, 600]);
});

test("without --size the declaration stands", () => {
  expect(sizeFrom([], { width: 800, height: 600 })).toEqual([800, 600]);
});

test("a malformed --size is an error naming the flag, not a silent fallback", () => {
  expect(() => sizeFrom(["--size", "400"], { width: 800, height: 600 })).toThrow(
    '--size takes WxH, got "400"',
  );
});

test("applyMinSize lifts the floor through the environment the engine reads", () => {
  delete process.env.DZIRY_MIN_WINDOW;
  applyMinSize(["--min-size", "none"]);
  // Reflect.get because TypeScript narrows a literal-key access to `undefined`
  // after the `delete` above; the point is what the process environment holds.
  expect(Reflect.get(process.env, "DZIRY_MIN_WINDOW")).toBe("none");
});

test("applyMinSize without a value is an error, not an empty override", () => {
  expect(() => applyMinSize(["--min-size"])).toThrow('--min-size takes WxH or "none"');
});

afterEach(() => {
  delete process.env.DZIRY_MIN_WINDOW;
});
