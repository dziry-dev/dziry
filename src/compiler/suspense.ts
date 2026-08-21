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
import { conditionOf, fallbackOf, isLiveCondition, SHOW_TAG, type ShowBoundary } from "./show.ts";
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
 * Replaces every `<Suspense>` and `<Show>` marker with its trees, spliced in
 * place as siblings — content first, then fallback — and reports each
 * boundary's top-level elements so the build can resolve them to node ids after
 * the walk. A `<Show>` whose `when` is a plain constant is resolved here
 * instead: the winning tree is spliced, the loser is dropped, and no boundary
 * is reported — the build never learns it existed.
 *
 * One walk over both marker kinds, and that is load-bearing rather than tidy:
 * a fallback tree lives in a side map until its own marker dissolves, so two
 * separate passes would each be blind to the other's markers inside fallbacks.
 * Splicing re-scans what it inserted, so a marker anywhere under a spliced
 * tree is seen — and a *bare* marker at the top level of another's list is
 * refused, because that list would name an element that never becomes a node.
 *
 * Runs on the window root after routes are spliced, so a marker inside a page
 * is already in the tree.
 */
export function spliceBoundaries(root: Element): {
  suspense: SuspenseBoundary[];
  shows: ShowBoundary[];
} {
  const suspense: SuspenseBoundary[] = [];
  const shows: ShowBoundary[] = [];
  walk(root, suspense, shows);
  return { suspense, shows };
}

/** Element children only: the boundary hides by node, and only elements are ones it can. */
function elementsOf(nodes: Node[], owner: string, what: string): Element[] {
  for (const node of nodes) {
    if (node.type === "element") continue;
    // jsx's normalization has already collapsed whitespace, so anything left is real.
    throw new SuspenseError(
      `<${owner}> has bare ${what} that is not an element.\n` +
        `  The boundary switches visibility by hiding nodes, and a bare text child\n` +
        `  would stay visible in both states. Wrap it in an element.`,
    );
  }
  return nodes as Element[];
}

/** Refuses a bare marker of either kind at the top level of a captured list. */
function refuseBareMarkers(els: readonly Element[], owner: string): void {
  if (!els.some(isMarker)) return;
  throw new SuspenseError(
    `<Suspense> or <Show> directly inside <${owner}>.\n` +
      `  A boundary dissolves into its trees, so a bare inner boundary is not a node\n` +
      `  the outer one can hide — its content would escape the outer's control.\n` +
      `  Wrap the inner boundary in an element.`,
  );
}

function walk(el: Element, suspense: SuspenseBoundary[], shows: ShowBoundary[]): void {
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i]!;
    if (child.type !== "element") continue;

    if (child.tag === SUSPENSE_TAG) {
      const content = elementsOf(child.children, "Suspense", "content");
      const fallback = elementsOf(fallbacks.get(child) ?? [], "Suspense", "fallback");
      refuseBareMarkers(content, "Suspense");
      refuseBareMarkers(fallback, "Suspense");

      suspense.push({ content, fallback, on: explicitOn.get(child) ?? [] });
      el.children.splice(i, 1, ...content, ...fallback);
      // Re-scan from the first spliced element: their own subtrees may hold markers.
      i--;
      continue;
    }

    if (child.tag === SHOW_TAG) {
      const when = conditionOf(child);

      // A constant condition is the build's to answer: splice the winner —
      // bare text and all, since nothing will ever need to hide it — and drop
      // the loser before it costs a single node.
      if (!isLiveCondition(when)) {
        el.children.splice(i, 1, ...(when ? child.children : fallbackOf(child)));
        i--;
        continue;
      }

      const content = elementsOf(child.children, "Show", "content");
      const fallback = elementsOf(fallbackOf(child), "Show", "fallback");
      refuseBareMarkers(content, "Show");
      refuseBareMarkers(fallback, "Show");

      shows.push({ content, fallback, when });
      el.children.splice(i, 1, ...content, ...fallback);
      i--;
      continue;
    }

    walk(child, suspense, shows);
  }
}

function isMarker(el: Element): boolean {
  return el.tag === SUSPENSE_TAG || el.tag === SHOW_TAG;
}
