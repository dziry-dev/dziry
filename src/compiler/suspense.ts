/**
 * `<Suspense>` — a compiled boundary over async data.
 *
 * ```tsx
 * <Suspense fallback={<Skeleton />}>
 *   <div className="stats">{stats.map(renderRow, { key })}</div>
 * </Suspense>
 * ```
 *
 * A boundary is not a runtime construct here: both trees are compiled into the
 * window as siblings at the boundary's position — exactly how a route's success,
 * loading and error views co-reside — and the runtime picks one by writing
 * `hidden` bytes when a watched `resource`'s status crosses `"pending"`. No
 * wrapper element is added, for the reason `window-tree.ts` gives for routes: an
 * extra box would be observable in the layout, and there is no `display: contents`.
 *
 * What a boundary watches is the `resource`s read by the bindings under its
 * content — collected by the build after the walk, from the same recorded
 * sources every binding already carries. Reads hidden inside a `computed` are
 * invisible to that collection (the pending bit does not propagate through
 * derived cells yet); the `on` prop names resources explicitly for that case.
 * A boundary whose set comes up empty is a compile error — the design doc's
 * words: *nothing under this boundary can pend.*
 *
 * Like `<Window>` and `<Outlet>`, this is an ordinary function component that
 * runs during the build and leaves a marker element behind; `spliceSuspense`
 * replaces every marker before the tree reaches the cascade, so downstream
 * compilation never knows boundaries exist.
 */
import { jsx, type Props } from "./jsx-runtime.ts";
import type { Element, Node } from "./html.ts";

const SUSPENSE_TAG = "#suspense";
/** Exists only to borrow `jsx`'s child normalization for the fallback tree. */
const FALLBACK_TAG = "#suspense-fallback";

/** Side tables keyed by marker element — the `<Window>` config pattern. */
const fallbacks = new Map<Element, Node[]>();
const explicitOn = new Map<Element, unknown[]>();

export class SuspenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuspenseError";
  }
}

export function Suspense(
  props: Props & {
    fallback: Props["children"];
    /**
     * Resources this boundary watches, *in addition to* the ones collected from
     * the bindings under it. Needed when every read is wrapped in a `computed`,
     * which hides the resource from collection.
     */
    on?: unknown[];
  },
): Element {
  if (props.fallback === undefined || props.fallback === null) {
    throw new SuspenseError(
      `<Suspense> needs a fallback.\n` +
        `  The boundary's whole job is showing something while a resource pends; with\n` +
        `  nothing to show, the pending state would be a blank hole in the layout.`,
    );
  }
  const el = jsx(SUSPENSE_TAG, { children: props.children }) as Element;
  fallbacks.set(el, (jsx(FALLBACK_TAG, { children: props.fallback }) as Element).children);
  if (props.on !== undefined) explicitOn.set(el, props.on);
  return el;
}

/** One boundary, as the pre-pass hands it to the build. */
export type SuspenseBoundary = {
  /** Top-level elements of the content tree — hidden while a resource pends. */
  content: Element[];
  /** Top-level elements of the fallback tree — visible exactly then. */
  fallback: Element[];
  /** The `on` prop's resources, verbatim; the build unions them with collected ones. */
  on: unknown[];
};

/**
 * Replaces every `<Suspense>` marker with its two trees, spliced in place as
 * siblings — content first, then fallback — and reports each boundary's
 * top-level elements so the build can resolve them to node ids after the walk.
 *
 * Runs on the window root after routes are spliced, so a boundary inside a page
 * is already in the tree. Splicing re-scans what it inserted, so a marker at the
 * top level of another's content is *seen* — and refused, because the outer
 * boundary's root list would name a marker that never becomes a node, and the
 * inner trees would silently escape the outer's control.
 */
export function spliceSuspense(root: Element): SuspenseBoundary[] {
  const out: SuspenseBoundary[] = [];
  walk(root, out);
  return out;
}

/** Element children only: the boundary hides by node, and only elements are ones it can. */
function elementsOf(nodes: Node[], what: string): Element[] {
  for (const node of nodes) {
    if (node.type === "element") continue;
    // jsx's normalization has already collapsed whitespace, so anything left is real.
    throw new SuspenseError(
      `<Suspense> has bare ${what} that is not an element.\n` +
        `  The boundary switches visibility by hiding nodes, and a bare text child\n` +
        `  would stay visible in both states. Wrap it in an element.`,
    );
  }
  return nodes as Element[];
}

function walk(el: Element, out: SuspenseBoundary[]): void {
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i]!;
    if (child.type !== "element") continue;

    if (child.tag !== SUSPENSE_TAG) {
      walk(child, out);
      continue;
    }

    const content = elementsOf(child.children, "content");
    const fallback = elementsOf(fallbacks.get(child) ?? [], "fallback");
    if (content.some(isMarker) || fallback.some(isMarker)) {
      throw new SuspenseError(
        `<Suspense> directly inside <Suspense>.\n` +
          `  A boundary dissolves into its trees, so a bare inner boundary is not a node\n` +
          `  the outer one can hide — its content would escape the outer's control.\n` +
          `  Wrap the inner boundary in an element.`,
      );
    }

    out.push({ content, fallback, on: explicitOn.get(child) ?? [] });
    el.children.splice(i, 1, ...content, ...fallback);
    // Re-scan from the first spliced element: their own subtrees may hold markers.
    i--;
  }
}

function isMarker(el: Element): boolean {
  return el.tag === SUSPENSE_TAG;
}
