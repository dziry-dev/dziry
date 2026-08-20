/**
 * `<Window>` and `<Outlet/>` themselves — the components.
 *
 * window-tree.test.tsx drives the splice through compiled windows; these cover
 * what that pipeline cannot reach: the props validation that runs before any
 * tree exists, and the side tables (`configOf`, `routeSignalOf`, `layerOf`)
 * keyed by the element, including that a consumed `route` signal is cleared
 * from droppedSignals so the build does not warn about a prop that went exactly
 * where it was meant to.
 */
import { expect, test } from "bun:test";
import {
  Outlet,
  Window,
  WindowError,
  configOf,
  isOutlet,
  layerOf,
  routeSignalOf,
} from "./window.ts";
import { parseHtml, type Element } from "./html.ts";
import { signal } from "../runtime/signal.ts";

test("<Window> produces a body element with its config in the side table", () => {
  const root = Window({ title: "dziri", width: 800, height: 600, children: [] });
  expect(root.tag).toBe("body");
  expect(configOf(root)).toEqual({
    title: "dziri",
    width: 800,
    height: 600,
    minWidth: undefined,
    minHeight: undefined,
  });
});

test("<Window> without a title refuses — there is no sensible default", () => {
  expect(() => Window({ children: [] } as never)).toThrow(WindowError);
  expect(() => Window({ title: "", children: [] })).toThrow("<Window> needs a title");
});

test("a non-integer or non-positive size is refused by name", () => {
  expect(() => Window({ title: "t", width: 800.5, children: [] })).toThrow("width");
  expect(() => Window({ title: "t", height: -1, children: [] })).toThrow("height");
  expect(() => Window({ title: "t", minWidth: 0, children: [] })).toThrow("minWidth");
});

test("route and layer reach the side tables, not the element's attributes", () => {
  const route = signal("/");
  const layer = { tag: "TestLayer" };
  const root = Window({ title: "t", route, layer, children: [] });
  expect(routeSignalOf(root)).toBe(route);
  expect(layerOf(root)).toBe(layer);
  // The route signal was consumed by the side table, so the dropped-prop warning
  // must not fire for it.
  expect(root.droppedSignals ?? []).not.toContain("route");
});

test("an element that is not a window root has no config, route or layer", () => {
  const plain = parseHtml("<div/>").children[0] as Element;
  expect(configOf(plain)).toBeUndefined();
  expect(routeSignalOf(plain)).toBeUndefined();
  expect(layerOf(plain)).toBeUndefined();
});

test("<Outlet/> is the marker tag, and isOutlet knows it", () => {
  const outlet = Outlet();
  expect(outlet.tag).toBe("#outlet");
  expect(isOutlet(outlet)).toBe(true);
  expect(isOutlet(parseHtml("<div/>").children[0] as Element)).toBe(false);
});
