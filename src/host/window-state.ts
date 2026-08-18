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
import { isSignal, type Signal } from "../runtime/signal.ts";
import type { WindowArtifact } from "./registry.ts";

/**
 * Hot reload's state transfer, both halves.
 *
 * The compiler cannot know which exports are signals worth keeping — only the
 * runtime can recognise one — so the artifact carries the referenced modules as
 * namespaces (`__state`) and these two functions do the walking. The key is the
 * export name: the one identity a recompile cannot move. A renamed or deleted
 * signal silently starts fresh, which is the honest answer — there is no
 * mapping to guess from.
 */

/** What survives a worker swap: signal values by export name, and the route. */
export type CarriedState = { values: Record<string, unknown>; route: string | null };

/**
 * A value that survives the worker boundary *as itself*. structuredClone
 * answers most of it, but it silently declasses — `clone(new Foo())` is a plain
 * object with Foo's fields and none of its methods — so class instances are
 * refused rather than resurrected wrong. Primitives, plain objects, arrays, and
 * the built-ins clone owns (Date, Map, Set, typed arrays) transfer.
 */
function clonable(value: unknown): boolean {
  try {
    structuredClone(value);
  } catch {
    return false;
  }
  return isPlain(value);
}

function isPlain(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(isPlain);
  if (ArrayBuffer.isView(value) || value instanceof Date || value instanceof Map || value instanceof Set) {
    return true;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return (
    (proto === Object.prototype || proto === null) &&
    Object.values(value).every(isPlain)
  );
}

/**
 * The current values of every writable signal the window's modules export.
 * Functions, class instances and read-only computeds are skipped — none survive
 * a worker boundary, and pretending otherwise is how a reload resurrects a half-
 * state.
 */
export function dumpState(artifact: WindowArtifact, route: string | null): CarriedState {
  const values: Record<string, unknown> = {};
  for (const ns of artifact.__state) {
    for (const [name, value] of Object.entries(ns as Record<string, unknown>)) {
      if (!isSignal(value) || typeof (value as Signal<unknown>).set !== "function") continue;
      const current = value.value;
      if (clonable(current)) values[name] = structuredClone(current);
    }
  }
  return { values, route };
}

/**
 * Writes dumped values into the new module graph's same-named signals. Runs
 * before subscriptions exist, so no subscriber fires on the restore — the first
 * frame is computed from the restored state directly.
 */
export function restoreState(artifact: WindowArtifact, values: Record<string, unknown>): void {
  for (const ns of artifact.__state) {
    for (const [name, value] of Object.entries(ns as Record<string, unknown>)) {
      if (!(name in values)) continue;
      if (!isSignal(value) || typeof (value as Signal<unknown>).set !== "function") continue;
      (value as Signal<unknown>).set(values[name]);
    }
  }
}

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
    textAreas: artifact.textAreas,
    forms: artifact.forms,
    disabledBindings: artifact.disabledBindings,
    textBindings: artifact.textBindings,
    paramBindings: artifact.paramBindings,
    dataBindings: artifact.dataBindings,
    errorBindings: artifact.errorBindings,
    imageBindings: artifact.imageBindings,
    handlers: artifact.handlers,
    lists: artifact.lists,
    media: artifact.media,
    tweens: artifact.tweens,
    keyframes: artifact.keyframes,
    controls: artifact.controls,
    images: artifact.images,
    numerics: artifact.numerics,
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
/** Which of a route's three views is showing. */
export type RouteView = "loading" | "success" | "error";

/**
 * The route whose error view shows for a failing leaf — the first route up the
 * chain with non-empty `error` roots. Never -1 at runtime, because the compiler
 * synthesizes a default error view for a leaf with no error boundary anywhere.
 */
function errorOwnerFor(routeNodes: readonly RouteNodes[], index: number): number {
  for (let i = index; i !== -1; i = routeNodes[i]?.parent ?? -1) {
    if (routeNodes[i]!.error.length > 0) return i;
  }
  return -1;
}

export function showRoute(
  ui: CompiledUi,
  routeNodes: readonly RouteNodes[],
  index: number,
  view: RouteView = "success",
): void {
  // The chain leaf-first, so a position in it says "below" vs "above" a boundary.
  const chain: number[] = [];
  for (let i = index; i !== -1; i = routeNodes[i]?.parent ?? -1) {
    if (chain.includes(i)) break;
    chain.push(i);
  }
  const inChain = new Set(chain);
  const errorPos = view === "error" ? chain.indexOf(errorOwnerFor(routeNodes, index)) : -1;

  for (const [i, route] of routeNodes.entries()) {
    let showSuccess = inChain.has(i);
    let showLoading = false;
    let showError = false;

    if (inChain.has(i)) {
      if (view === "loading" && i === index && route.loading.length > 0) {
        // The leaf is in flight: its skeleton if it has one, else success (empty data).
        showSuccess = false;
        showLoading = true;
      } else if (view === "error") {
        const pos = chain.indexOf(i);
        if (pos < errorPos) showSuccess = false;
        else if (pos === errorPos) {
          showSuccess = false;
          showError = true;
        }
        // pos > errorPos: an ancestor above the boundary stays as the layout.
      }
    }

    for (const node of route.roots) ui.nodes.hidden[node] = showSuccess ? 0 : 1;
    for (const node of route.loading) ui.nodes.hidden[node] = showLoading ? 0 : 1;
    for (const node of route.error) ui.nodes.hidden[node] = showError ? 0 : 1;
  }
}

/**
 * A concrete path matched against a route pattern, and the parameters it bound.
 *
 * The matcher was slated for the engine (next to the media-query evaluator, which
 * needs the route table on the wire), but the host already holds `routeNodes` and
 * every consumer of parameters — loaders, `args.id` — lives on this side. Until
 * the wire version lands, this host-side matcher is the binding step navigation
 * runs through, and it is written so moving it to the engine means moving a pure
 * function, not re-deriving its rules.
 */
export type RouteMatch = { index: number; params: Record<string, string> };

/**
 * Matches a concrete path against the window's routes.
 *
 * Exact paths win, then patterns: `products/$id` binds `products/1` to
 * `{ id: "1" }`. A `$` segment binds whatever is in that position (URL-decoded);
 * a literal segment must match exactly. Segment counts must match, so `products`
 * does not match `products/$id` and neither does `products/$id/reviews`. Returns
 * `null` when nothing matches, so navigation can ignore an unknown path rather
 * than blank the window — the same rule `indexOfRoute` already follows.
 */
export function matchRoute(routeNodes: readonly RouteNodes[], path: string): RouteMatch | null {
  const split = (p: string): string[] =>
    p === "/" ? [] : p.split("/").filter((s) => s !== "");

  // Exact first — cheap, and preserves the order indexOfRoute reports.
  for (const [i, route] of routeNodes.entries()) {
    if (route.path === path) return { index: i, params: {} };
  }

  const want = split(path);
  for (const [i, route] of routeNodes.entries()) {
    const have = split(route.path);
    if (have.length !== want.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    for (let k = 0; k < have.length; k++) {
      const h = have[k]!;
      if (h.startsWith("$")) {
        params[h.slice(1)] = decodeURIComponent(want[k]!);
      } else if (h !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return { index: i, params };
  }

  return null;
}
