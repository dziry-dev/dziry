import { expect, test } from "bun:test";
import { matchRoute, requireRouteMatch, showRoute } from "./window-state.ts";
import type { CompiledUi, RouteNodes } from "../ir.ts";

const routes: RouteNodes[] = [
  { path: "/", roots: [0], loading: [], error: [], parent: -1 },
  { path: "about", roots: [1], loading: [], error: [], parent: -1 },
  { path: "products", roots: [2], loading: [], error: [], parent: -1 },
  { path: "products/$id", roots: [3], loading: [], error: [], parent: 2 },
  { path: "products/$id/reviews", roots: [4], loading: [], error: [], parent: 3 },
];

test("an exact path matches with no params", () => {
  expect(matchRoute(routes, "about")).toEqual({ index: 1, params: {} });
  expect(matchRoute(routes, "/")).toEqual({ index: 0, params: {} });
});

test("a pattern binds parameters", () => {
  expect(matchRoute(routes, "products/1")).toEqual({ index: 3, params: { id: "1" } });
  expect(matchRoute(routes, "products/1/reviews")).toEqual({
    index: 4,
    params: { id: "1" },
  });
});

test("segment count must match, so no prefix/suffix bleeding", () => {
  expect(matchRoute(routes, "products")).toEqual({ index: 2, params: {} });
  expect(matchRoute(routes, "products/1/x")).toBeNull();
});

test("an unknown path is null, not a crash", () => {
  expect(matchRoute(routes, "nope")).toBeNull();
  expect(matchRoute(routes, "products/1/reviews/extra")).toBeNull();
});

test("parameters are URL-decoded", () => {
  expect(matchRoute(routes, "products/a%20b")).toEqual({ index: 3, params: { id: "a b" } });
});

// ---------------------------------------------------------------------------
// requireRouteMatch — `--route` at startup, where a concrete path must bind
// ---------------------------------------------------------------------------

test("a concrete --route binds its parameters, not just the pattern", () => {
  // The startup path used to exact-match only, so `--route products/1` — the
  // one spelling a user would actually try — was rejected with a list of
  // patterns. Found by the route-param golden pointing at a concrete id.
  expect(requireRouteMatch(routes, "products/1", "main")).toEqual({
    index: 3,
    params: { id: "1" },
  });
  expect(requireRouteMatch(routes, "about", "main")).toEqual({ index: 1, params: {} });
});

test("a --route matching nothing throws, naming the window and the routes", () => {
  expect(() => requireRouteMatch(routes, "nope", "main")).toThrow(
    'no route "nope" in window main',
  );
  expect(() => requireRouteMatch(routes, "products/1/extra/deep", "main")).toThrow(
    "products/$id",
  );
});

// ---------------------------------------------------------------------------
// showRoute — the three views a route object swaps between
// ---------------------------------------------------------------------------

const viewRoutes: RouteNodes[] = [
  { path: "/", roots: [0], loading: [], error: [], parent: -1 },
  { path: "products", roots: [1], loading: [], error: [], parent: -1 },
  { path: "products/$id", roots: [2], loading: [3], error: [4], parent: 1 },
];

const ui = (): CompiledUi =>
  ({ nodes: { hidden: new Uint8Array(10) } }) as unknown as CompiledUi;

test("showRoute success shows the chain and hides loading/error", () => {
  const u = ui();
  showRoute(u, viewRoutes, 2, "success");
  expect(u.nodes.hidden[0]).toBe(1); // the index route, off-chain
  expect(u.nodes.hidden[1]).toBe(0); // the layout stays visible
  expect(u.nodes.hidden[2]).toBe(0); // the leaf's success view
  expect(u.nodes.hidden[3]).toBe(1); // loading hidden
  expect(u.nodes.hidden[4]).toBe(1); // error hidden
});

test("showRoute loading swaps the leaf for its skeleton", () => {
  const u = ui();
  showRoute(u, viewRoutes, 2, "loading");
  expect(u.nodes.hidden[1]).toBe(0); // layout still visible
  expect(u.nodes.hidden[2]).toBe(1); // success hidden
  expect(u.nodes.hidden[3]).toBe(0); // skeleton shown
});

test("showRoute error swaps the leaf for its error view", () => {
  const u = ui();
  showRoute(u, viewRoutes, 2, "error");
  expect(u.nodes.hidden[1]).toBe(0); // layout still visible
  expect(u.nodes.hidden[2]).toBe(1); // success hidden
  expect(u.nodes.hidden[4]).toBe(0); // error shown
});

test("an error bubbles to the nearest ancestor with an error view", () => {
  const bubbling: RouteNodes[] = [
    { path: "products", roots: [0], loading: [], error: [5], parent: -1 },
    { path: "products/$id", roots: [1], loading: [], error: [], parent: 0 },
  ];
  const u = ui();
  showRoute(u, bubbling, 1, "error");
  expect(u.nodes.hidden[5]).toBe(0); // the parent's error shown
  expect(u.nodes.hidden[0]).toBe(1); // the parent's layout hidden
  expect(u.nodes.hidden[1]).toBe(1); // the leaf hidden
});

// --- hot reload state transfer -------------------------------------------------

test("dumpState carries writable signals by export name and skips the rest", async () => {
  const { dumpState } = await import("./window-state.ts");
  const { signal, computed } = await import("../runtime/signal.ts");

  const count = signal(41);
  const rows = signal([{ id: "a" }]);
  const doubled = computed(() => 0); // read-only: no set, never dumped
  class Model { x = 1; m() { return this.x; } }
  const model = signal(new Model()); // class instance: would declass, so skipped

  const artifact = {
    __state: [{ count, rows, doubled, model, helper: () => 1, plain: 7 }],
  } as never;

  const dump = dumpState(artifact, "products/1");
  expect(dump.route).toBe("products/1");
  expect(Object.keys(dump.values).sort()).toEqual(["count", "rows"]);
  expect(dump.values.count).toBe(41);
  expect(dump.values.rows).toEqual([{ id: "a" }]);
  // A dump is a copy: mutating the live signal's rows must not move it.
  rows.value.push({ id: "b" });
  expect(dump.values.rows).toEqual([{ id: "a" }]);
});

test("restoreState writes same-named signals and ignores what changed names", async () => {
  const { restoreState } = await import("./window-state.ts");
  const { signal } = await import("../runtime/signal.ts");

  const count = signal(0);
  const added = signal("fresh"); // no dumped value: keeps its initial
  const artifact = { __state: [{ count, added }] } as never;

  restoreState(artifact, { count: 41, renamed: "gone" });
  expect(count.value).toBe(41);
  expect(added.value).toBe("fresh");
});
