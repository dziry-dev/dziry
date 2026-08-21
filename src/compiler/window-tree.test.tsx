/** @jsxImportSource . */

/**
 * The splice, through the real `<Window>` and `<Outlet>`.
 *
 * Written as JSX rather than as hand-built element literals because the thing
 * being tested is what an author's tree turns into, and a hand-built tree would
 * let a mistake in `Window` or `Outlet` pass unnoticed here and fail in the driver.
 *
 * The errors matter as much as the splicing. Nesting is by path prefix and a
 * layout is a page that renders an outlet — two independent facts that have to
 * agree, and every way they can disagree renders nothing while looking fine.
 */
import { expect, test } from "bun:test";

import type { Element, Node } from "./html.ts";
import { spliceWindow, WindowTreeError, type PageTree } from "./window-tree.ts";
import { layerOf, Outlet, Window } from "./window.ts";

/** The tags of an element's children, one level deep. */
const tags = (el: Element): string[] =>
  el.children.filter((c): c is Element => c.type === "element").map((c) => c.tag);

/** Every class in the subtree, depth-first — enough to see what got spliced where. */
function classes(node: Node, out: string[] = []): string[] {
  if (node.type !== "element") return out;
  for (const c of node.classes) out.push(c);
  for (const child of node.children) classes(child, out);
  return out;
}

const page = (path: string, parent: number, nodes: Node | Node[]): PageTree => ({
  path,
  file: `windows/main/pages/${path === "/" ? "index" : path}.tsx`,
  parent,
  nodes: Array.isArray(nodes) ? nodes : [nodes],
  loadingNodes: [],
  errorNodes: [],
});

test("a route's page replaces the shell's outlet, wherever the outlet is nested", () => {
  const shell = Window({
    title: "dziry",
    children: (
      <div className="chrome">
        <div className="header" />
        <Outlet />
      </div>
    ),
  });

  const { root, roots } = spliceWindow(shell, [page("/", -1, <div className="home" />)]);

  const chrome = root.children[0] as Element;
  expect(tags(chrome)).toEqual(["div", "div"]);
  expect(classes(root)).toEqual(["chrome", "header", "home"]);

  // The outlet marker is gone, not merely emptied.
  expect(classes(root)).not.toContain("#outlet");
  expect(roots[0]!.map((e) => e.classes[0])).toEqual(["home"]);
});

test("sibling routes are spliced in table order, all resident", () => {
  const shell = Window({ title: "dziry", children: <Outlet /> });

  const { root } = spliceWindow(shell, [
    page("/", -1, <div className="home" />),
    page("about", -1, <div className="about" />),
    page("products", -1, <div className="products" />),
  ]);

  // All three at once: residency is the design, and `hidden` is what makes only
  // one of them visible.
  expect(classes(root)).toEqual(["home", "about", "products"]);
});

test("a page that renders an outlet is a layout, and its children nest inside it", () => {
  const shell = Window({ title: "dziry", children: <Outlet /> });

  const { root, roots } = spliceWindow(shell, [
    page("/", -1, <div className="home" />),
    page(
      "products",
      -1,
      <div className="products">
        <div className="toolbar" />
        <Outlet />
      </div>,
    ),
    page("products/new", 1, <div className="new" />),
    page("products/$id", 1, <div className="detail" />),
  ]);

  expect(classes(root)).toEqual(["home", "products", "toolbar", "new", "detail"]);

  // Each route owns what it contributed, not what nests inside it.
  expect(roots.map((r) => r.map((e) => e.classes[0]))).toEqual([
    ["home"],
    ["products"],
    ["new"],
    ["detail"],
  ]);
});

test("nesting recurses, so a layout inside a layout works with no extra rule", () => {
  const layout = (name: string) => (
    <div className={name}>
      <Outlet />
    </div>
  );

  const shell = Window({ title: "dziry", children: <Outlet /> });

  const { root } = spliceWindow(shell, [
    page("a", -1, layout("a")),
    page("a/b", 0, layout("a-b")),
    page("a/b/c", 1, <div className="leaf" />),
  ]);

  expect(classes(root)).toEqual(["a", "a-b", "leaf"]);
});

test("a layout that is only an outlet owns no nodes, so hiding it hides nothing", () => {
  const shell = Window({ title: "dziry", children: <Outlet /> });

  const { root, roots } = spliceWindow(shell, [
    page("products", -1, <Outlet />),
    page("products/$id", 0, <div className="detail" />),
  ]);

  expect(classes(root)).toEqual(["detail"]);
  // It contributed nothing, so it owns nothing — and the child is hidden on its
  // own account rather than through a layout that is not there.
  expect(roots[0]).toEqual([]);
  expect(roots[1]!.map((e) => e.classes[0])).toEqual(["detail"]);
});

test("a page returning a fragment owns each of its top-level nodes", () => {
  const shell = Window({ title: "dziry", children: <Outlet /> });

  const { roots } = spliceWindow(shell, [
    page("/", -1, [<div className="one" />, <div className="two" />]),
  ]);

  expect(roots[0]!.map((e) => e.classes[0])).toEqual(["one", "two"]);
});

// ---------------------------------------------------------------------------
// The two facts that have to agree
// ---------------------------------------------------------------------------

test("routes nesting inside a page with no outlet is an error naming them", () => {
  const shell = Window({ title: "dziry", children: <Outlet /> });

  const run = () =>
    spliceWindow(shell, [
      page("products", -1, <div className="products" />),
      page("products/$id", 0, <div className="detail" />),
    ]);

  expect(run).toThrow(WindowTreeError);
  expect(run).toThrow(/renders no <Outlet\/>/);
  expect(run).toThrow(/"products\/\$id"/);
});

test("an outlet with no route to fill it is an error, not empty markup", () => {
  const shell = Window({ title: "dziry", children: <Outlet /> });

  const run = () => spliceWindow(shell, [page("about", -1, layoutOf("about"))]);
  expect(run).toThrow(/no route extends "about"/);
});

test("a window with no outlet cannot show any of its routes", () => {
  const shell = Window({ title: "dziry", children: <div className="chrome" /> });

  const run = () => spliceWindow(shell, [page("/", -1, <div className="home" />)]);
  expect(run).toThrow(/window renders no <Outlet\/>/);
});

test("two outlets in one page have no non-arbitrary answer, so they are an error", () => {
  const shell = Window({ title: "dziry", children: <Outlet /> });

  const run = () =>
    spliceWindow(shell, [
      page(
        "products",
        -1,
        <div className="products">
          <Outlet />
          <Outlet />
        </div>,
      ),
      page("products/$id", 0, <div className="detail" />),
    ]);

  expect(run).toThrow(/more than one <Outlet\/>/);
});

test("two outlets in the window shell are the same error", () => {
  const shell = Window({
    title: "dziry",
    children: (
      <div className="chrome">
        <Outlet />
        <div className="sidebar">
          <Outlet />
        </div>
      </div>
    ),
  });

  expect(() => spliceWindow(shell, [page("/", -1, <div className="home" />)])).toThrow(
    /more than one <Outlet\/>/,
  );
});

function layoutOf(name: string): Element {
  return (
    <div className={name}>
      <Outlet />
    </div>
  ) as Element;
}

test("<Window layer={…}> is captured beside the tree and never becomes an attribute", () => {
  const layer = { pipe: () => {} }; // any object export-shaped value
  const shell = Window({
    title: "dziry",
    layer,
    children: <Outlet />,
  });

  expect(layerOf(shell)).toBe(layer);
  // The cascade must never see it — attrsOf ignores object props, and this is
  // the test that keeps `[layer=…]` from ever being a selector someone can write.
  expect(shell.attrs.has("layer")).toBe(false);
});

test("a window without a layer records none", () => {
  const shell = Window({ title: "dziry", children: <Outlet /> });
  expect(layerOf(shell)).toBeUndefined();
});

test("every window carries the failure overlay: last child, hidden shape, own dyntext slots", () => {
  const shell = Window({ title: "dziry", children: <Outlet /> });

  const { root, redbox } = spliceWindow(shell, [page("/", -1, <div className="home" />)]);

  // Last child of the shell — document order is paint order, so nothing the app
  // renders can paint over it.
  expect(root.children[root.children.length - 1]).toBe(redbox.root);
  expect(redbox.root.children).toEqual([redbox.title, redbox.detail]);

  // The message children are dyntext, which is what buys each a *reserved* string
  // slot — an interned "" would be shared with any app text that happens to be "".
  for (const el of [redbox.title, redbox.detail]) {
    expect(el.children).toHaveLength(1);
    expect(el.children[0]!.type).toBe("dyntext");
  }

  // No classes: an app stylesheet must have nothing to select the box by, and its
  // look rides inline style, which beats every selector.
  expect(redbox.root.classes).toEqual([]);
  expect(redbox.root.style).toContain("position:absolute");
});
