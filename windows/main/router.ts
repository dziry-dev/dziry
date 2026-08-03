/**
 * This window's route, and one handler per destination.
 *
 * The route is a signal held here rather than in the framework, because a route is
 * **per window** — a module-level `currentRoute` inside dziri would make every
 * window share one, and two windows on different routes is the normal case. The
 * window hands its signal to `<Window route={…}>` and the host does the rest.
 *
 * One exported handler per link, and that is not boilerplate to apologise for: a
 * click handler has to be a module-level export, because the generated artifact
 * imports it by name and that is the only way a function reference survives the
 * compiler/runtime boundary. `onClick={() => go("layout")}` would be a closure
 * created inside a component, which has nowhere to live once components are erased.
 *
 * When `navigate("layout")` exists it will replace these — it needs the matcher,
 * and a way to pass an argument to a compiled handler. Until then the repetition is
 * visible and honest rather than hidden behind something that does not work yet.
 */
import { computed, signal } from "dziri";
import type { Href } from "../routes.gen.ts";

export const route = signal("/");

/**
 * Derived route state, declared here rather than produced by a hook.
 *
 * `useRouter()` gives a page the current path; anything computed *from* it lives
 * beside the route, because that is the only place it can. A `computed()` created
 * inside a component has nowhere to live once components are erased — the generated
 * module imports every signal by name, and an anonymous one has no name. Declaring
 * them makes them exports, which is what makes them compilable.
 *
 * Each of these drives a conditional class, so an active tab costs a handful of
 * style-table writes when the route changes and nothing at all per frame.
 */
/**
 * Exact matches, where `router.matches()` would be wrong.
 *
 * `matches` is prefix-aware — `matches("products")` holds on `products/new` too,
 * which is what a nav entry naming a section wants. These two are tabs *within*
 * that section, so they need equality: on `products/new`, "New" is active and
 * "First" is not.
 */
export const onNewProduct = computed(() => route === "products/new");
export const onProductDetail = computed(() => route === "products/$id");

/** The previous route, for `back()`. History is one entry deep, by decision. */
let previous: Href = "/";

/**
 * Navigate, with the destination checked against the routes that exist.
 *
 * `Href` is generated from the filesystem scan, so `go("prodcuts/new")` is a build
 * error rather than a click that silently does nothing. That was the intent all
 * along — the host ignores an unknown path precisely because "a dead link is meant
 * to be a *build* error" — but the union was generated into a file nothing wrote and
 * this took a bare `string`.
 *
 * A parameter route is `products/${string}`, so a concrete `products/1` checks and a
 * misspelt segment does not.
 */
function go(path: Href): void {
  if (path === route) return;
  // `Signal<Widen<T>>` widens every string literal to `string`, deliberately — a
  // signal of `"/"` that could never hold another path would be useless. So the
  // signal's type cannot carry `Href`, and reading the current route back out gives
  // `string`. The cast is sound because `go` is the only writer and it takes `Href`.
  // The version of this that needs no cast is a framework `navigate()` owning both
  // the signal and the union, which is where routing is headed.
  previous = route as Href;
  route.set(path);
}

export const goOverview = () => go("/");
export const goLayout = () => go("layout");
export const goSpacing = () => go("spacing");
export const goTypography = () => go("typography");
export const goColors = () => go("colors");
export const goBorders = () => go("borders");
export const goControls = () => go("controls");
export const goTransforms = () => go("transforms");
export const goAnimations = () => go("animations");
export const goFeatures = () => go("features");
export const goReactivity = () => go("reactivity");
export const goProducts = () => go("products/new");
export const goNewProduct = () => go("products/new");
export const goProductDetail = () => go("products/$id");

export const back = () => go(previous);
