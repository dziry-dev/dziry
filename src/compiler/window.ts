/**
 * `<Window>` and `<Outlet>`.
 *
 * ```tsx
 * // windows/main/index.tsx
 * export default function Main() {
 *   return (
 *     <Window title="dziri">
 *       <Header />
 *       <Outlet />
 *     </Window>
 *   );
 * }
 * ```
 *
 * Both are ordinary function components, so `jsx()` expands them during the build
 * like any other and neither exists afterwards. What they leave behind is one
 * element each: `<Window>` becomes the window's root box and `<Outlet/>` becomes a
 * marker the driver splices routes over.
 *
 * `<Window>` produces a `body` element rather than a tag of its own, because that
 * is what it is — the root box of a window, whose *border* box is the window rect
 * (which is why `layout.rs` excludes the root from `box-sizing`). Reusing `body`
 * means `body { … }` styles a window, the eventual UA stylesheet applies to it
 * without a special case, and nothing in the cascade has to learn a new tag.
 *
 * Its configuration cannot ride on the element, which has a fixed shape shared
 * with the HTML parser, so it goes in a side table keyed by the element. Same
 * reasoning as the signal brand and the recording proxies: keep the extra
 * information beside the tree rather than widening what a tree is.
 */
import { jsx } from "./jsx-runtime.ts";
import type { Element } from "./html.ts";
import type { Props } from "./jsx-runtime.ts";
import type { WindowConfig } from "../ir.ts";
import type { ReadonlySignal } from "../runtime/signal.ts";

/** The marker tag `<Outlet/>` leaves in the tree. Never reaches the cascade. */
export const OUTLET_TAG = "#outlet";

/**
 * Window configuration, defined with the IR because that is what it becomes.
 *
 * Every field is a compile-time constant, which is the whole reason they are
 * props: a window's size floor and title are known before the process starts, so
 * nothing here needs a signal. `title` is the one that will eventually need a
 * binding, for document windows whose title follows what they have open — and
 * that is a reason to keep it a plain string until windows-as-instances is
 * settled, rather than to guess now.
 *
 * `minWidth` is the one with a consequence elsewhere: its absence is why
 * `window.rs` hardcodes a 564x320 floor and reads `DZIRI_MIN_WINDOW` from the
 * environment to escape it. Once this reaches the wire, that constant becomes this
 * default and the environment variable goes back to being a debug hatch.
 */
export type { WindowConfig };

export type WindowProps = Props &
  WindowConfig & {
    /**
     * The window's current route path, as a signal.
     *
     * This is the whole of navigation's plumbing: the host subscribes, looks the
     * path up in the route table, and writes `hidden` over the routes that left the
     * chain. Everything else about a route is compile-time.
     *
     * A signal rather than a `navigate()` import because a window's route is *per
     * window* — a module-level `let currentRoute` would make two windows share one
     * route, and two windows on different routes is the normal case. Passing it in
     * makes the ownership explicit and leaves `navigate`'s eventual shape open.
     */
    route?: ReadonlySignal<string>;
  };

/**
 * Configs by the element `Window` produced.
 *
 * A `Map` rather than a `WeakMap` on purpose: the compiler is a process that
 * exits, the entries are one per window, and a `WeakMap` would make the config
 * unenumerable — which matters when the driver has an element and wants to check
 * whether it *is* a window rather than looking one up by guess.
 */
const configs = new Map<Element, WindowConfig>();

/** Route signals by window root, kept apart from the config because it is not data. */
const routeSignals = new Map<Element, ReadonlySignal<string>>();

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

export function Window(props: WindowProps): Element {
  if (typeof props.title !== "string" || props.title === "") {
    throw new WindowError(
      `<Window> needs a title.\n` +
        `  It is what the OS puts in the title bar and the task switcher, and there is no\n` +
        `  sensible default for it — a window with no title is a window nobody can find.`,
    );
  }

  for (const name of ["width", "height", "minWidth", "minHeight"] as const) {
    const value = props[name];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new WindowError(
        `<Window ${name}={${String(value)}}> is not a usable size.\n` +
          `  Window sizes are compile-time integers in physical pixels; they are constants\n` +
          `  because a window's geometry is known before the process starts.`,
      );
    }
  }

  // Built by `jsx` rather than by hand, so the window root's children are
  // flattened, fragment-spliced and whitespace-collapsed by the same code as every
  // other element's. Building the element here would have quietly exempted the
  // window from `normalize`, and `<Window>Loading…</Window>` would keep a text node
  // nothing else in the tree would.
  const root = jsx("body", props) as Element;

  configs.set(root, {
    title: props.title,
    width: props.width,
    height: props.height,
    minWidth: props.minWidth,
    minHeight: props.minHeight,
  });

  if (props.route) {
    routeSignals.set(root, props.route);
    // `jsx` above sees `route` as a prop holding a signal that no attribute can carry, and
    // records it as dropped so the build can warn — which is right for `disabled={sig}` and
    // wrong here, because it was not dropped: this line is where it goes. Cleared rather
    // than exempted inside `attrsOf`, which has no idea it is building a window.
    //
    // The false positive is the reason this is written down: the warning found it on its
    // first run against the demo, which is a warning working, and the fix belongs at the
    // consumer rather than in a list of special names.
    root.droppedSignals = root.droppedSignals?.filter((p) => p !== "route");
  }

  return root;
}

/**
 * Where a route renders.
 *
 * Takes nothing. Boundaries — `fallback`, `error`, `notFound` — are carried in
 * API.md as unrevisited proposals, and adding them here would settle by accident
 * what has not been decided.
 */
export function Outlet(): Element {
  return jsx(OUTLET_TAG, {}) as Element;
}

/** True if this element is an `<Outlet/>` marker. */
export function isOutlet(node: { type: string; tag?: string }): boolean {
  return node.type === "element" && node.tag === OUTLET_TAG;
}

/** The config of a window root, or `undefined` if this element is not one. */
export function configOf(root: Element): WindowConfig | undefined {
  return configs.get(root);
}

/** The route signal `<Window route=…>` was given, if any. */
export function routeSignalOf(root: Element): ReadonlySignal<string> | undefined {
  return routeSignals.get(root);
}
