/**
 * This window's route.
 *
 * The route is a signal held here rather than in the framework, because a route is
 * **per window** — a module-level `currentRoute` inside dziri would make every
 * window share one, and two windows on different routes is the normal case. The
 * window hands its signal to `<Window route={…}>` and the host does the rest.
 *
 * This file used to export fifteen `go*` click handlers and a hand-rolled `back()`.
 * They are gone: navigation is `<a href>` now — checked against the route table at
 * build time, with the click handler synthesized by the compiler — and anything a
 * link cannot express imports `navigate`/`back` from `dziri`. What remains here is
 * only what the framework cannot own: the signal itself, and state derived from it.
 */
import { computed, signal } from "dziri";

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
export const onProductDetail = computed(() => route === "products/1");
