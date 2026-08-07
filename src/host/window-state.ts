/**
 * A compiled window, turned into state something can run.
 *
 * The artifact a window compiles to is inert: typed arrays, string tables and
 * route roots. Three things have to happen before any of it means anything — the
 * IR has to be assembled into the shape the runtime writes through, a route has
 * to be chosen, and the rest of the routes have to be hidden. This is those three
 * things, and it exists because they were written out twice.
 *
 * # Why this is a module rather than lines in the host
 *
 * `host/worker.ts` is the app thread and `engine/upload.test.ts` asserts on real
 * emitter output through the engine, and both need exactly this much: an IR, a
 * route, and the rest hidden. Neither needs the other's scheduling, locking or
 * event dispatch, which is why those stayed where they were. The split is at what
 * both callers share, not at a layer boundary.
 *
 * There was a third caller until this file existed. `src/window-host.ts` ran both
 * halves in one thread for `dziri dev --single`, and it carried its own copy of
 * everything here plus its own copy of the engine loop. It was deleted rather than
 * moved onto this module: it had no automated caller anywhere in the repo, and the
 * doc comment defending it claimed the golden harness rendered every scenario
 * through both paths, which `golden.ts` never did.
 *
 * # What is deliberately not here
 *
 * The apply pass — `applyTextBindings`, `updateLists`, `applyStylePatches` — is
 * three calls the callers still make themselves. It looks like it belongs here and
 * does not: the two callers run it in different orders, and that difference is
 * harmless, because `growU8` copies the old array forward (`list-runtime.ts:91`)
 * so `hidden` survives a list growing, and rows minted by growth are `hidden = 0`,
 * which is right because hiding is per route root and the subtree inherits it.
 * Freezing one order here would claim to fix a bug that does not exist, and would
 * take the choice away from a caller that has a reason to make it.
 */
import { routeChain, type CompiledUi, type RouteNodes } from "../ir.ts";
import type { WindowArtifact } from "./registry.ts";

/**
 * The IR, ready to be written to.
 *
 * A named projection rather than a cast. This used to be `as unknown as
 * CompiledUi` at each call site, which is the one place a project built on
 * generated identity stopped checking — the compiler emits the artifact and the
 * host consumes it, and the cast told `tsc` to take both on trust. The artifact
 * declares `satisfies` on the way out and this names what is needed on the way in,
 * so a field the emitter renames is a compile error rather than an undefined array
 * in whichever caller touches it first.
 *
 * `strings` is copied, and that is the one thing this does beyond selecting
 * fields. It is the only mutable-length member — `bindings.ts:47` writes slots and
 * `list-runtime.ts:188` pushes new ones as a list arena grows — so aliasing it
 * means running a window mutates the imported module. Nothing reads the artifact's
 * own array after setup, so nothing wants the aliasing; a test running several
 * windows off one import actively wants it gone. Copying always, rather than
 * offering a flag, because a caller cannot reason about which behaviour it needs
 * without knowing all of the above.
 */
export function buildUi(artifact: WindowArtifact): CompiledUi {
  return {
    strings: [...artifact.strings],
    styles: artifact.styles,
    nodes: artifact.nodes,
    variants: artifact.variants,
    interactive: artifact.interactive,
    generated: artifact.generated,
    editableBoxes: artifact.editableBoxes,
    placeholders: artifact.placeholders,
    overlays: artifact.overlays,
    tabStops: artifact.tabStops,
    autofocus: artifact.autofocus,
    textBindings: artifact.textBindings,
    handlers: artifact.handlers,
    lists: artifact.lists,
    media: artifact.media,
    tweens: artifact.tweens,
    keyframes: artifact.keyframes,
    controls: artifact.controls,
    root: artifact.root,
  };
}

/**
 * A path to a route index, or -1.
 *
 * Exact paths only. Binding `products/1` to `products/$id` is the matcher's job,
 * and the matcher is decided to live in the engine next to the media-query
 * evaluator — which needs the route table on the wire. Until then a window can
 * navigate between its static routes.
 *
 * Two functions rather than one with a flag, because the two callers want opposite
 * things from a miss and both are right: navigation ignores an unknown path, since
 * blanking the window is worse than doing nothing and a dead link is meant to be a
 * *build* error; startup refuses one, since `--route nope` is a typo worth
 * stopping for. See {@link requireRoute}.
 */
export function indexOfRoute(routeNodes: readonly RouteNodes[], path: string): number {
  return routeNodes.findIndex((r) => r.path === path);
}

/**
 * A path to a route index, throwing with the routes that do exist.
 *
 * The route list is in the message because the failure is almost always a typo or
 * a stale path, and both are answered by seeing what is actually there. `windowId`
 * is named for the same reason: with more than one window in a project, "no route
 * products/new" is ambiguous about which window was asked.
 */
export function requireRoute(
  routeNodes: readonly RouteNodes[],
  path: string,
  windowId: string,
): number {
  const found = indexOfRoute(routeNodes, path);
  if (found === -1) {
    const paths = routeNodes.map((r) => r.path).join(", ");
    throw new Error(`no route "${path}" in window ${windowId}. Routes are ${paths}.`);
  }
  return found;
}

/**
 * Shows one route, hiding the rest.
 *
 * Writes are per route root, so this is bounded by route count and not by node
 * count — a 10,000-node window with twenty routes writes twenty bytes. Every route
 * in the window is already in the node table; nothing is created, destroyed or
 * relinked, which is why navigation costs no allocation and no layout rebuild.
 *
 * The visible set comes from the same `routeChain` the emitter used, so the first
 * frame and every frame after it agree about what "visible together" means. That
 * function was itself extracted because three callers had to agree on it; this is
 * the same argument one level up — a disagreement here shows as a window that is
 * correct until the first navigation, which is the shape of bug that is hardest to
 * catch by looking.
 *
 * This is `navigate` minus two things: a matcher turning a concrete path into a
 * route index and binding its parameters, and the one-entry history `back()`
 * returns to.
 */
export function showRoute(
  ui: CompiledUi,
  routeNodes: readonly RouteNodes[],
  index: number,
): void {
  const chain = routeChain(routeNodes, index);
  for (const [i, route] of routeNodes.entries()) {
    const hide = chain.has(i) ? 0 : 1;
    for (const node of route.roots) ui.nodes.hidden[node] = hide;
  }
}
