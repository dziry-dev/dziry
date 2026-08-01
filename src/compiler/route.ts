/**
 * `useRoute` — the only routing API a page calls.
 *
 * ```tsx
 * // windows/main/pages/products/$id.tsx
 * const { args } = useRoute("products/$id");   // args: { id: string }
 * ```
 *
 * The string repeats the filename on purpose. TypeScript cannot know which file a
 * call is in, so a bare `useRoute()` has nothing to infer from — the repetition is
 * what makes `args` typed at all. What makes the repetition safe is that this runs
 * during compilation, while the compiler knows which page it is expanding: a
 * string that disagrees with the file is a build error, so a rename that is not
 * mirrored fails rather than drifting. (TanStack repeats it for the same reason
 * and needs an editor plugin to keep the two in sync; here the compiler refuses.)
 *
 * There is no runtime half. `useRoute` returns recorders, the compiler turns the
 * reads into bindings, and nothing in this file is reachable after the build.
 *
 * One consequence of the check being *positional* rather than lexical: a component
 * shared between pages is expanded inside whichever page included it, so a
 * `useRoute` in there is checked against the *caller's* route and quietly succeeds
 * for one caller and fails for the next. That is not a case worth detecting —
 * TypeScript cannot type such a component anyway, since its route is not knowable
 * from its own text. Shared components take the value as a prop: `<Title id={args.id} />`.
 */
import { paramsOfPath, routeArgs } from "./route-args.ts";
import { computed, type ReadonlySignal } from "../runtime/signal.ts";

/**
 * The parameter names in a route path.
 *
 * `"products/$id"` -> `"id"`; `"$org/repos/$name"` -> `"org" | "name"`; a path
 * with no `$` -> `never`, so `Args` of it is `{}` and a page with no parameters
 * has nothing to read.
 */
type ParamNames<P extends string> = P extends `${string}$${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? Name | ParamNames<Tail>
    : Rest
  : never;

/** What `useRoute("products/$id").args` is: `{ id: string }`. */
export type Args<P extends string> = { [K in ParamNames<P>]: string };

export type Route<P extends string> = {
  /** The path as written — the same string, so it can be passed on. */
  path: P;
  args: Args<P>;
};

/**
 * The page being expanded, set by the compiler around each page module.
 *
 * Module-level, and that is safe here in a way it would not be for route *state*:
 * this is the compiler's own cursor over files it imports one at a time, not a
 * window's current route. A window's route is per window, always.
 */
let currentPage: { path: string; file: string } | null = null;

/**
 * Scopes a page's expansion, so `useRoute` inside it knows what it is.
 *
 * Synchronous, and it refuses to be handed anything else. `finally` runs when
 * `run` *returns*, so an `async` callback would restore the cursor at its first
 * `await` and the component would expand outside the scope that was opened for
 * it — reported as `useRoute` running with no page at all, which is a true
 * statement about a cause three frames up. Importing is the caller's job; this
 * wraps the call.
 */
export function withPage<T>(page: { path: string; file: string }, run: () => T): T {
  const previous = currentPage;
  currentPage = page;
  try {
    const result = run();
    if (typeof (result as { then?: unknown } | null)?.then === "function") {
      throw new RouteHookError(
        `withPage was given an async callback, which cannot be scoped.\n` +
          `  The page cursor is restored when the callback returns, and an async one returns\n` +
          `  at its first await — before the component runs. Import the module first, then\n` +
          `  call its default export inside withPage.`,
      );
    }
    return result;
  } finally {
    currentPage = previous;
  }
}

export class RouteHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteHookError";
  }
}

/**
 * The window's route signal, set by the driver around the pages it expands.
 *
 * Separate from `currentPage` because it has a different lifetime: the page cursor
 * moves per file, this holds for the whole window.
 */
let currentRouteSignal: ReadonlySignal<string> | null = null;

/** Scopes a window's compilation, so `useRouter` inside its pages finds its route. */
export function withWindowRoute<T>(route: ReadonlySignal<string> | null, run: () => T): T {
  const previous = currentRouteSignal;
  currentRouteSignal = route;
  try {
    return run();
  } finally {
    currentRouteSignal = previous;
  }
}

export type Router = {
  /**
   * The active route path.
   *
   * A signal, so `{router.path}` is a text binding that follows navigation, and
   * anything derived from it is an ordinary `computed`.
   */
  path: ReadonlySignal<string>;

  /**
   * True while the active route is `path`, or is nested under it.
   *
   * ```tsx
   * <button className={cn("link", { active: router.matches("layout") })}>
   * ```
   *
   * The comparison people reach for first is `router.path === "layout"`, and that
   * cannot work: `router.path` is a *signal*, so `===` against a string is `false`
   * at build time, for ever, and the nav would compile clean and never highlight.
   * That is the exact shape of failure this project treats as worse than a crash,
   * so the comparison has to be something the compiler can see rather than
   * something JavaScript evaluates while the compiler is looking away.
   *
   * Prefix-aware: `matches("products")` holds on `products/new` too, because a nav
   * entry names a section and the route table already says what nests under what.
   * Exact equality is what `route.value === p` in the window's own module is for.
   */
  matches(path: string): ReadonlySignal<boolean>;
};

/**
 * What a `matches()` cell was asking, so the emitter can rebuild the question.
 *
 * A `WeakMap` rather than a property on the cell: the cell is a real `computed` and
 * this has to work whether or not that object accepts new keys. Read by
 * `resolve-refs`, which turns it into the expression the artifact contains.
 */
const routeMatches = new WeakMap<object, { signal: ReadonlySignal<string>; path: string }>();

/** The route signal and path behind a `matches()` cell, or undefined. */
export function routeMatchOf(
  value: unknown,
): { signal: ReadonlySignal<string>; path: string } | undefined {
  return typeof value === "object" && value !== null ? routeMatches.get(value) : undefined;
}

/**
 * Read access to the window's current route.
 *
 * ```tsx
 * const router = useRouter();
 * <div>You are at {router.path}</div>
 * ```
 *
 * Read access only, and deliberately. Anything *derived* — "is this tab active",
 * "which section am I in" — belongs in the window's own module as a `computed`,
 * for the same reason the route signal itself does: it is per-window state, and a
 * framework that owned it would own one copy for every window at once.
 *
 * It is also the constraint the compiler imposes rather than a style preference. A
 * `computed()` created inside a component has nowhere to live once components are
 * erased, so a hook that manufactured one per call could not be resolved to a name
 * the generated module can import. Declaring it beside the route makes it a real
 * export, which is what makes it compilable.
 */
export function useRouter(): Router {
  if (currentRouteSignal === null) {
    throw new RouteHookError(
      `useRouter() needs the window to declare its route.\n` +
        `  A route belongs to a window, not to the framework — two windows on different\n` +
        `  routes is the normal case — so the window passes its own signal in:\n` +
        `    <Window route={route}>   // route = signal("/") in the window's own module\n` +
        `  Without it there is no current route to read.`,
    );
  }

  const route = currentRouteSignal;

  return {
    path: route,
    matches(path: string) {
      // A real `computed`, so it is a signal to everything downstream — `cn`
      // records it as a toggle, `findToggles` finds it, the variant compiler
      // resolves the class with it on and off. The only extra fact is *how it was
      // derived*, which the emitter needs because a cell created here has no export
      // name to import; it is written into the artifact as the expression it is.
      const cell = computed(() => {
        const active = route.value;
        return path === "/" ? active === "/" : active === path || active.startsWith(`${path}/`);
      });
      routeMatches.set(cell, { signal: route, path });
      return cell;
    },
  };
}

export function useRoute<const P extends string>(path: P): Route<P> {
  if (currentPage === null) {
    throw new RouteHookError(
      `useRoute("${path}") ran while no page was being compiled.\n` +
        `  Routes are files under windows/*/pages/**, so useRoute only means anything\n` +
        `  during a page's expansion. Reaching here means the call is at module scope of\n` +
        `  something the compiler imported, or in a helper that ran before any page did.`,
    );
  }

  if (path !== currentPage.path) {
    throw new RouteHookError(
      `useRoute("${path}") is in ${currentPage.file}, whose route is "${currentPage.path}".\n` +
        `  The string has to match the file's own path under pages/, because it is what\n` +
        `  types args and nothing else verifies it. Either the file moved and the string\n` +
        `  did not, or this call belongs in another page.\n` +
        `    useRoute("${currentPage.path}")`,
    );
  }

  return {
    path,
    args: routeArgs(path, paramsOfPath(path)) as Args<P>,
  };
}
