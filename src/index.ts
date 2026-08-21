/**
 * `dziry` — the authoring surface, and the only import an app should need.
 *
 * Everything here is what a window, a page or a state module reaches for. The
 * deep paths still exist and still resolve (`dziry/runtime/signal.ts` and the
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

export { defineRoute, useRoute, useRouter } from "./compiler/route.ts";
export { navigate, back } from "./runtime/navigate.ts";
export type {
  Args,
  ComponentProps,
  ErrorComponentProps,
  LoaderData,
  LoaderError,
  Route,
  RouteDefinition,
  Router,
} from "./compiler/route.ts";

// --- state, the part that survives the compiler ------------------------------
export { $, batch, computed, createScope, effect, isSignal, signal, untrack } from "./runtime/signal.ts";
export type { DisposalScope, MapOptions, ReadonlySignal, Signal } from "./runtime/signal.ts";

/** A stream-backed signal — Effect's `Stream` feeding a dziry signal. */
export { source } from "./runtime/source.ts";

/**
 * Pull-based async data, and the boundary that shows a fallback while it pends.
 * `source` = push, from outside the process; `resource` = pull, async, drives a
 * boundary. `<Suspense>` compiles to co-resident subtrees switched by `hidden`
 * bytes — the route mechanism — when a watched resource's status crosses pending.
 */
export { resource } from "./runtime/resource.ts";
export type { Resource, ResourceStatus } from "./runtime/resource.ts";
export { Suspense } from "./compiler/suspense.ts";

/**
 * Compiled conditional rendering: both trees are compiled in, and the `when`
 * cell's truthiness picks one with a `hidden`-byte write — the same switch a
 * navigation makes. A constant `when` is resolved at build time and the losing
 * tree never becomes nodes.
 */
export { Show } from "./compiler/show.ts";

/**
 * The platform's own modal message box.
 *
 * Exported by name because Bun has a *global* `alert()` that reads stdin, and an author who
 * forgets the import gets that one — it blocks the app thread waiting for Enter on a terminal
 * nobody is watching.
 */
export { alert } from "./runtime/alert.ts";
export type { AlertLevel } from "./runtime/alert.ts";

/**
 * Reading a file the user picked via `input[type=file]`.
 *
 * The dialog returns a path; these helpers turn it into metadata or bytes.
 * `fileInfo` gives name/size/type like a browser's `File` object; `readFile`
 * and `readFileText` load the content.
 */
export { fileInfo, readFile, readFileText } from "./runtime/files.ts";
export type { FileInfo } from "./runtime/files.ts";

// Navigation as control flow — thrown by plain handlers/loaders, failed by Effect
// ones; the router interprets them (data-layer-design.md §4). Exported now so the
// tags' identity does not move when the loader lands.
export { Cancel, Redirect } from "./runtime/effects.ts";
