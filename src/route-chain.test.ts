/**
 * The visible set, which three things compute and all three must agree on.
 *
 * The emitter decides which routes start `hidden`, the driver reports how many that
 * was, and the host switches route. When they were three walks of the same links,
 * a disagreement would have shown as a window that is correct until the first
 * navigation — so the walk is one function and this is its test.
 */
import { expect, test } from "bun:test";
import { routeChain, type RouteNodes } from "./ir.ts";

/** The demo window's shape: two top-level routes and a layout with two children. */
const ROUTES: RouteNodes[] = [
  { path: "/", roots: [13], loading: [], error: [], parent: -1 },
  { path: "about", roots: [18], loading: [], error: [], parent: -1 },
  { path: "products", roots: [23], loading: [], error: [], parent: -1 },
  { path: "products/new", roots: [31], loading: [], error: [], parent: 2 },
  { path: "products/$id", roots: [34], loading: [], error: [], parent: 2 },
];

const chain = (index: number) => [...routeChain(ROUTES, index)].sort((a, b) => a - b);

test("a top-level route is visible alone", () => {
  expect(chain(0)).toEqual([0]);
  expect(chain(1)).toEqual([1]);
});

test("a nested route keeps its layout visible, because it renders inside it", () => {
  expect(chain(3)).toEqual([2, 3]);
  expect(chain(4)).toEqual([2, 4]);
});

test("a layout on its own does not pull its children in", () => {
  // Showing "products" shows the layout and neither child — which is why a layout
  // with an outlet and nothing in it is a build error rather than a blank frame.
  expect(chain(2)).toEqual([2]);
});

test("siblings are never visible together", () => {
  const withNew = routeChain(ROUTES, 3);
  expect(withNew.has(4)).toBe(false);
  expect(routeChain(ROUTES, 4).has(3)).toBe(false);
});

test("depth is not a limit — a chain is as long as the nesting", () => {
  const deep: RouteNodes[] = [
    { path: "a", roots: [1], loading: [], error: [], parent: -1 },
    { path: "a/b", roots: [2], loading: [], error: [], parent: 0 },
    { path: "a/b/c", roots: [3], loading: [], error: [], parent: 1 },
    { path: "a/b/c/d", roots: [4], loading: [], error: [], parent: 2 },
  ];
  expect([...routeChain(deep, 3)].sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
});

test("a cycle terminates rather than hanging the build", () => {
  // `parent` is compiler output, so a cycle is a compiler bug — but a `while` loop
  // here would answer it with a build that never finishes and never says why.
  const cyclic: RouteNodes[] = [
    { path: "a", roots: [1], loading: [], error: [], parent: 1 },
    { path: "b", roots: [2], loading: [], error: [], parent: 0 },
  ];
  expect(routeChain(cyclic, 0).size).toBe(2);
});

test("an out-of-range index yields just itself, not a crash", () => {
  expect([...routeChain(ROUTES, 99)]).toEqual([99]);
  expect([...routeChain([], 0)]).toEqual([0]);
});
