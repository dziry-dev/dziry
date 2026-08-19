/**
 * The invalidation closure, as pure data. The plugin side — that a versioned
 * specifier loads a fresh module, that a redirect of a relative import sticks —
 * is probed by hand against Bun (`.link-probe` notes in the commit), because it
 * is Bun's behaviour, not ours.
 */
import { expect, test } from "bun:test";
import { bustSet } from "./module-cache.ts";

// state.ts <- pages/index.tsx <- index.tsx; theme.ts <- state.ts (nobody imports it back)
const dependents = new Map<string, ReadonlySet<string>>([
  ["state.ts", new Set(["pages/index.tsx"])],
  ["pages/index.tsx", new Set(["index.tsx"])],
]);

test("a changed file busts itself and its transitive importers", () => {
  expect([...bustSet(["state.ts"], dependents)].sort()).toEqual([
    "index.tsx",
    "pages/index.tsx",
    "state.ts",
  ]);
});

test("a leaf change reaches nobody else", () => {
  expect([...bustSet(["index.tsx"], dependents)]).toEqual(["index.tsx"]);
});

test("an unobserved module busts only itself — it was never cached", () => {
  expect([...bustSet(["new-file.ts"], dependents)]).toEqual(["new-file.ts"]);
});

test("a diamond busts the shared import once", () => {
  const diamond = new Map<string, ReadonlySet<string>>([
    ["shared.ts", new Set(["a.ts", "b.ts"])],
    ["a.ts", new Set(["entry.ts"])],
    ["b.ts", new Set(["entry.ts"])],
  ]);
  const bust = bustSet(["shared.ts"], diamond);
  expect(bust.size).toBe(4);
  expect(bust.has("entry.ts")).toBe(true);
});
