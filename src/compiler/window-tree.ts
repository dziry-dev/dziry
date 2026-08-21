/**
 * One window, one tree, every route in it.
 *
 * The shell's `<Outlet/>` is replaced by the top-level routes' pages, and a page
 * that renders an `<Outlet/>` of its own has its child routes spliced in the same
 * way, recursively — which is what makes nesting a matter of path prefix and
 * nothing else. Every route ends up in one tree, compiled once, so styles intern
 * globally and a route costs nodes and nothing per frame: `hidden` already
 * excludes a subtree from layout, paint and hit-testing.
 *
 * The alternative was compiling each route separately and merging the tables
 * afterwards, which means rebasing every node index, every list arena, every
 * binding and the variant table — against a saving of, measured, two style rows
 * out of nine. This file is the cheap half of that trade.
 *
 * Deliberately pure: trees in, tree out. The driver does the importing, so the
 * splice can be tested without a filesystem and without evaluating anything.
 */
import type { Element, Node } from "./html.ts";
import { isOutlet } from "./window.ts";

export class WindowTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowTreeError";
  }
}

/** A route and the tree its page module produced. */
export type PageTree = {
  /** Route path, as the scan derived it — `"/"`, `"products/$id"`. */
  path: string;
  /** Source file, for diagnostics. */
  file: string;
  /** Index in the window's route list of the nearest prefix route, or -1. */
  parent: number;
  /**
   * What the page's default export returned, as nodes.
   *
   * A page may return a fragment, so this is a list. Each entry becomes a node the
   * router can hide, which is why no wrapper is added: an extra box per route
   * would be observable in the layout — there is no `display: contents` — and
   * hiding N roots is N byte writes, which is not a cost worth a node for.
   */
  nodes: Node[];
  /** The loadingComponent's tree, or [] when the route declares none. */
  loadingNodes: Node[];
  /** The errorComponent's tree, or [] when the route declares none. */
  errorNodes: Node[];
};

export type SplicedWindow = {
  /** The window root, with every route spliced in. Ready for `compileTree`. */
  root: Element;
  /**
   * Per route, in the order given: the top-level elements that route owns.
   *
   * These are the nodes navigation hides. Text and other non-element nodes are
   * excluded because `hidden` is a column of the node table and only elements
   * become nodes with children to exclude — a bare text child of a route is a node
   * too, so it is kept, but anything the walk drops is not.
   */
  roots: Element[][];
  /** Per route: the loadingComponent's top-level elements, or []. */
  loadingRoots: Element[][];
  /** Per route: the errorComponent's top-level elements, or []. */
  errorRoots: Element[][];
  /** The synthesized failure overlay — see [`redboxTree`]. */
  redbox: { root: Element; title: Element; detail: Element };
};

/**
 * Splices each route's page into the window tree.
 *
 * @param shell the element `<Window>` produced.
 * @param pages one entry per route, in the window's route order.
 */
export function spliceWindow(shell: Element, pages: readonly PageTree[]): SplicedWindow {
  const childrenOf = new Map<number, number[]>();
  const topLevel: number[] = [];

  for (const [i, page] of pages.entries()) {
    if (page.parent === -1) {
      topLevel.push(i);
      continue;
    }
    const siblings = childrenOf.get(page.parent);
    if (siblings) siblings.push(i);
    else childrenOf.set(page.parent, [i]);
  }

  const roots: Element[][] = pages.map(() => []);
  const loadingRoots: Element[][] = pages.map(() => []);
  const errorRoots: Element[][] = pages.map(() => []);

  /**
   * The nodes for a route, with its own child routes already spliced into it.
   *
   * Recursive, and the recursion is over the route tree rather than the element
   * tree, so a layout three deep costs three passes over its own nodes and not one
   * over everything.
   */
  const resolve = (index: number): Node[] => {
    const page = pages[index]!;
    const children = childrenOf.get(index) ?? [];

    // Before splicing, and excluding the outlet itself: what this route owns is
    // what it contributed, and its children's nodes belong to *them*.
    //
    // A layout whose page is nothing but `<Outlet/>` therefore owns nothing, which
    // is right — it adds no nodes, so there is nothing for navigation to hide, and
    // its children are hidden individually. Taking this after the splice would have
    // given that layout its children's roots and made hiding one of them look like
    // hiding the layout.
    roots[index] = page.nodes.filter((n): n is Element => n.type === "element" && !isOutlet(n));
    loadingRoots[index] = page.loadingNodes.filter((n): n is Element => n.type === "element");
    errorRoots[index] = page.errorNodes.filter((n): n is Element => n.type === "element");

    const nested = children.flatMap(resolve);

    const outlets = replaceOutlets(page.nodes, nested, () => {
      throw new WindowTreeError(
        `${page.file} renders more than one <Outlet/>.\n` +
          `  A route's children have one place to go. Two outlets would need a rule for\n` +
          `  which one wins, and the honest version of that rule is "the first", which is\n` +
          `  not something to make anyone remember.`,
      );
    });

    if (children.length > 0 && outlets === 0) {
      const names = children.map((c) => `"${pages[c]!.path}"`).join(", ");
      throw new WindowTreeError(
        `${page.file} is the route "${page.path}", and ${names} nest inside it by path —\n` +
          `  but it renders no <Outlet/>, so they can never appear. Nesting is by path\n` +
          `  prefix and a layout is a page that renders an outlet; this is one without the\n` +
          `  other. Either add <Outlet/>, or move those routes so they do not extend this\n` +
          `  path.`,
      );
    }

    if (children.length === 0 && outlets > 0) {
      throw new WindowTreeError(
        `${page.file} renders an <Outlet/>, but no route extends "${page.path}".\n` +
          `  An outlet with nothing to put in it renders nothing and reads as a bug at the\n` +
          `  first glance and as dead markup at the second. A page that is not a layout has\n` +
          `  no outlet.`,
      );
    }

    // Success, then loading, then error — three alternatives at this route's own
    // position. The parent splices all of them into its outlet, and navigation
    // shows exactly one by writing `hidden`. Order is irrelevant while hidden, since
    // a hidden node is excluded from layout.
    return [...page.nodes, ...page.loadingNodes, ...page.errorNodes];
  };

  const spliced = topLevel.flatMap(resolve);

  const shellOutlets = replaceOutlets(shell.children, spliced, () => {
    throw new WindowTreeError(
      `the window renders more than one <Outlet/>.\n` +
        `  A window has one route showing at a time and one place to show it.`,
    );
  });

  if (shellOutlets === 0) {
    throw new WindowTreeError(
      `the window renders no <Outlet/>, so none of its ${pages.length} route(s) can appear.\n` +
        `  windows/<name>/index.tsx is the shell — the chrome that stays put across\n` +
        `  navigation — and <Outlet/> is where the route goes.`,
    );
  }

  const redbox = redboxTree();
  shell.children.push(redbox.root);

  return { root: shell, roots, loadingRoots, errorRoots, redbox };
}

/** An element with no attributes, handlers or classes — the shape `ua-structure.ts` mints. */
function synthesized(tag: string, style: string, children: Node[]): Element {
  return {
    type: "element",
    tag,
    id: null,
    classes: [],
    children,
    onClick: null, onChange: null, onFocus: null, onBlur: null,
    onSubmit: null,
    classWhen: null,
    bindValue: null,
    bindSrc: null,
    style,
    attrs: new Map(),
  };
}

/**
 * The runtime failure overlay — ROADMAP's red box — compiled into every window.
 *
 * Synthesized like a control's internals (`ua-structure.ts`): ordinary elements the
 * cascade never has to know are special. The compile-time gate's answer is question 3
 * — the overlay's two states are enumerable, so it is a hidden subtree and the runtime
 * writes one `hidden` byte and two string slots, exactly the mechanism a route's
 * `errorComponent` already rides. It starts hidden, and a hidden node is excluded from
 * layout, paint and hit-testing, so an app that never fails carries three idle nodes
 * and nothing else.
 *
 * The message slots are **dyntext** children, which is what gives each its own
 * reserved string slot — an interned literal would be shared with whatever app text
 * happens to be equal, and the runtime overwrites these.
 *
 * Styling is inline because inline beats every selector: an app stylesheet cannot
 * restyle the box that reports the app's own failure. Painted last in document order
 * — it is the shell's last child — and stacked over everything by `position:absolute`.
 * Deliberately not `INTERACTIVE`: clicks pass through to the app underneath, which is
 * a known v1 rough edge, not a design position.
 */
function redboxTree(): { root: Element; title: Element; detail: Element } {
  const dyn = (): Node => ({ type: "dyntext", parts: [{ literal: "" }] });
  const title = synthesized(
    "div",
    "color:#fecaca;font-size:15px;font-weight:700",
    [dyn()],
  );
  const detail = synthesized(
    "div",
    "color:#ffffff;font-size:13px",
    [dyn()],
  );
  const root = synthesized(
    "div",
    "position:absolute;top:0;right:0;bottom:0;left:0;" +
      "background:rgba(69,10,10,0.97);padding:24px;gap:12px;overflow-y:auto",
    [title, detail],
  );
  return { root, title, detail };
}

/**
 * Replaces the single `<Outlet/>` in `nodes` with `replacement`, in place.
 *
 * Returns how many outlets were found, so the caller can tell "no outlet" from
 * "one" without a second traversal. Recurses into elements, because an outlet is
 * normally nested inside the shell's layout rather than being a direct child.
 */
function replaceOutlets(nodes: Node[], replacement: Node[], onSecond: () => never): number {
  let found = 0;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.type !== "element") continue;

    if (isOutlet(node)) {
      if (found > 0) onSecond();
      found++;
      nodes.splice(i, 1, ...replacement);
      // Skip what was just inserted: a spliced page may contain outlets of its
      // own, and those belong to *it* — they were resolved before this call.
      i += replacement.length - 1;
      continue;
    }

    found += replaceOutlets(node.children, replacement, onSecond);
    if (found > 1) onSecond();
  }

  return found;
}
