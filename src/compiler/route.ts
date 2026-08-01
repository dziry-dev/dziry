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

/** Scopes a page's expansion, so `useRoute` inside it knows what it is. */
export function withPage<T>(page: { path: string; file: string }, run: () => T): T {
  const previous = currentPage;
  currentPage = page;
  try {
    return run();
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
