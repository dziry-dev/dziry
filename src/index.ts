/**
 * `dziri` — the authoring surface, and the only import an app should need.
 *
 * Everything here is what a window, a page or a state module reaches for. The
 * deep paths still exist and still resolve (`dziri/runtime/signal.ts` and the
 * rest are in the package's `exports`), but they are there because the *emitter*
 * writes those specifiers into `ui.gen.ts` — not as an invitation.
 *
 * The split is deliberate and is the "public API versus internal" line ROADMAP's
 * D4 asks to be drawn before adoption rather than after. What is re-exported
 * here is what we intend to keep working; what is only reachable through a
 * wildcard is not.
 *
 * # Two halves that run at different times
 *
 * `Window`, `Outlet`, `cn`, `useRoute` and `useRouter` run **at build time**,
 * inside the compiler, and are gone from the shipped app. `signal`, `computed`,
 * `batch` and `$` are the ones that survive into the running process. They are
 * exported together because an author writes them together — a page imports
 * `cn` and the signal it is conditioned on from the same place — but the
 * distinction is why a signal created inside a component has nowhere to live
 * and why an inline style with a non-static value is a build error.
 */

// --- markup, all of it build-time -------------------------------------------
export { cn, bind, Fragment } from "./compiler/jsx-runtime.ts";
export type {
  ClassArg,
  ClassSpec,
  Child,
  Component,
  Props,
  StyleObject,
} from "./compiler/jsx-runtime.ts";

export { Window, Outlet } from "./compiler/window.ts";
export type { WindowConfig, WindowProps } from "./compiler/window.ts";

export { useRoute, useRouter } from "./compiler/route.ts";
export type { Args, Route, Router } from "./compiler/route.ts";

// --- state, the part that survives the compiler ------------------------------
export { $, batch, computed, isSignal, signal } from "./runtime/signal.ts";
export type { MapOptions, ReadonlySignal, Signal } from "./runtime/signal.ts";

/**
 * The platform's own modal message box.
 *
 * Exported by name because Bun has a *global* `alert()` that reads stdin, and an author who
 * forgets the import gets that one — it blocks the app thread waiting for Enter on a terminal
 * nobody is watching.
 */
export { alert } from "./runtime/alert.ts";
export type { AlertLevel } from "./runtime/alert.ts";
