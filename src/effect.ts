/**
 * The Effect type, re-exported for the route types.
 *
 * Type-only, so it adds nothing to a bundle. `route.ts` uses it to unwrap a
 * loader's `Effect<A, E, R>` channels in `ComponentProps`/`ErrorComponentProps` —
 * without the author installing `effect`, because it is dziry's own dependency.
 * The runtime seam (`runtime/effects.ts`) is unchanged: it recognises Effect values
 * structurally and imports the package lazily, so an app that never uses one still
 * loads zero bytes of it.
 */
export type { Effect } from "effect";
