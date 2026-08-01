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
import { computed, signal } from "../../src/runtime/signal.ts";

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
export const onNewProduct = computed(() => route.value === "products/new");
export const onProductDetail = computed(() => route.value === "products/$id");

/** The previous route, for `back()`. History is one entry deep, by decision. */
let previous = "/";

function go(path: string): void {
  if (path === route.value) return;
  previous = route.value;
  route.value = path;
}

export const goOverview = () => go("/");
export const goLayout = () => go("layout");
export const goSpacing = () => go("spacing");
export const goTypography = () => go("typography");
export const goColors = () => go("colors");
export const goBorders = () => go("borders");
export const goFeatures = () => go("features");
export const goProducts = () => go("products/new");
export const goNewProduct = () => go("products/new");
export const goProductDetail = () => go("products/$id");

export const back = () => go(previous);
