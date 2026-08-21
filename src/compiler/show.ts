/**
 * `<Show>` — compiled conditional rendering.
 *
 * ```tsx
 * <Show when={filter === "done"} fallback={<EmptyState />}>
 *   <DoneList />
 * </Show>
 * ```
 *
 * The same construction as `<Suspense>`: both trees are compiled into the window
 * as siblings at the marker's position, and the runtime picks one by writing
 * `hidden` bytes — the switch navigation already rides. The difference is what
 * drives it: a boundary watches a resource's status, a Show watches any cell.
 * `when={done}` passes the signal by identity; `when={count > 5}` is wrapped by
 * the reactive transform into an inline cell whose source the artifact contains
 * as `computed(() => $(count) > 5)` — both arrive here as live objects.
 *
 * A `when` that is no cell at all — a literal, a plain constant — is resolved at
 * build time: the winning tree is spliced and the loser never becomes nodes.
 * That is the gate's first question answered "yes", and it is also why a Show
 * can wrap `{cond && <div/>}`-style stubs during development without paying for
 * a boundary.
 *
 * `fallback` is optional, unlike Suspense's. A pending resource with nothing to
 * show is a blank hole where data will appear; a closed Show is the author
 * saying *nothing belongs here* — the layout collapsing is the feature.
 */
import { jsx, type Props } from "./jsx-runtime.ts";
import type { Element, Node } from "./html.ts";

export const SHOW_TAG = "#show";
/** Exists only to borrow `jsx`'s child normalization for the fallback tree. */
const FALLBACK_TAG = "#show-fallback";

/** Side tables keyed by marker element — the `<Window>` config pattern. */
const fallbacks = new Map<Element, Node[]>();
const conditions = new Map<Element, unknown>();

export class ShowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShowError";
  }
}

export function Show(
  props: Props & {
    /**
     * The condition. A signal, a computed, or an inline expression the transform
     * wraps — anything with a current value the worker can subscribe to. A plain
     * constant is legal and resolved at build time.
     */
    when: unknown;
    fallback?: Props["children"];
  },
): Element {
  if (!("when" in props) || props.when === undefined) {
    throw new ShowError(
      `<Show> needs a when.\n` +
        `  The component's whole job is switching on a condition; without one there is\n` +
        `  nothing to switch on. Write <Show when={cond}>…</Show>.`,
    );
  }
  if (typeof props.when === "function") {
    throw new ShowError(
      `<Show when={…}> was given a function.\n` +
        `  when takes the condition itself — a signal, or an expression like\n` +
        `  when={count > 5} — not a function returning one. Drop the () =>.`,
    );
  }
  const el = jsx(SHOW_TAG, { children: props.children }) as Element;
  conditions.set(el, props.when);
  if (props.fallback !== undefined && props.fallback !== null) {
    fallbacks.set(el, (jsx(FALLBACK_TAG, { children: props.fallback }) as Element).children);
  }
  return el;
}

/** One dynamic Show, as the pre-pass hands it to the build. */
export type ShowBoundary = {
  /** Top-level elements of the content tree — visible while `when` is truthy. */
  content: Element[];
  /** Top-level elements of the fallback tree — visible exactly otherwise. May be empty. */
  fallback: Element[];
  /** The `when` prop's cell, verbatim; the build resolves it to a name or expression. */
  when: unknown;
};

export function fallbackOf(marker: Element): Node[] {
  return fallbacks.get(marker) ?? [];
}

export function conditionOf(marker: Element): unknown {
  return conditions.get(marker);
}

/**
 * Whether a `when` value can change after the build.
 *
 * Every cell shape the transform produces is an object — a signal, an inline
 * cell, a component-local, a route match wrapper — and every constant an author
 * can write is a primitive, because `inline` folds an expression that read no
 * signal down to its value. A plain data object slips through as "live" and
 * fails resolution with the named-export message, which is the honest report:
 * the compiler cannot watch it.
 */
export function isLiveCondition(when: unknown): boolean {
  return typeof when === "object" && when !== null;
}
