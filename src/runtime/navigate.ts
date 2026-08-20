/**
 * `navigate()` and `back()` — the framework surface over the window's route.
 *
 * A route is **per window**, so these cannot own the signal: the window declares
 * it (`export const route = signal("/")`, handed to `<Window route={route}>`)
 * and the host installs it here at launch, before the first dispatch. What this
 * module adds over writing the signal directly is exactly two things: the
 * same-path early-out, and the one-entry history `back()` reads — one entry
 * deep by decision, recorded in API.md, not a stack waiting to become one.
 *
 * Everything else about navigation already exists elsewhere and is not
 * duplicated here: the host matches the path against the compiled route table
 * and writes `hidden` over the routes that left the chain; the compiler checks
 * `<a href>` and `navigate("…")` literals against the same table at build time.
 *
 * Calling `navigate()` at module scope is a no-op with a warning rather than a
 * throw: modules are also imported by the compiler, where no window exists and
 * evaluation must not detonate.
 */
import type { Signal } from "./signal.ts";

let route: Signal<string> | null = null;
let previous: string | null = null;

/** The host's half: hand over the window's route signal at launch. */
export function installNavigation(signal: Signal<string>): void {
  route = signal;
  previous = null;
}

export function navigate(path: string): void {
  if (route === null) {
    console.warn(`navigate(${JSON.stringify(path)}) before the window is up does nothing.`);
    return;
  }
  if (path === route.value) return;
  previous = route.value;
  route.set(path);
}

/**
 * The previous route, once. Going back is itself a navigation, so where you
 * came *from* becomes the new "back" — pressing it twice oscillates rather
 * than walking anywhere, which is what one entry of history means.
 */
export function back(): void {
  if (route === null || previous === null) return;
  navigate(previous);
}
