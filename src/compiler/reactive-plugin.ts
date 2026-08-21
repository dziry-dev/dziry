/**
 * The Bun plugin that applies the reactive rewrite while the compiler imports pages.
 *
 * `compile-window.ts` compiles a window by *importing* it — components are ordinary
 * functions, so expanding them is calling them. That makes `onLoad` the only place a
 * rewrite can happen: by the time the compiler has a module object, the source is
 * gone.
 *
 * Scoped to `windows/**` on purpose. The framework's own sources under `src/` are
 * where `$` and `computed` are *defined*, and rewriting them would be circular —
 * `signal.ts` would import its own helpers through the transform that needs them.
 * Authored windows are the only code that should be getting this.
 *
 * On by default, and `DZIRY_REACTIVE=0` turns it off. It has to be on: the authoring
 * types now say a signal behaves as its value — `count * 2` type-checks — and only
 * the rewrite makes that true. A build with the types and without the rewrite would
 * accept code it then compiles wrong, which is worse than either half alone.
 *
 * The escape hatch stays because it is the only way to ask "did the rewrite cause
 * this?", and because `golden` used it to prove the wiring changed no pixels.
 */
import { plugin, type BunPlugin } from "bun";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { PACKAGE } from "./compile.ts";
import { transformReactive } from "./reactive-transform.ts";

const WINDOWS = resolve(process.cwd(), "windows");

/**
 * `reactive-runtime.ts`, not `signal.ts`.
 *
 * A rewritten window needs `inline` as well as `$` and `$m`, and `inline` is
 * build-time only — it records an expression's source for the compiler to emit.
 * Keeping it in a compiler module is what stops it reaching the shipped runtime,
 * since nothing under `windows/` is ever bundled.
 *
 * A package specifier, not a path. It used to be resolved against `process.cwd()`
 * and then made relative to the importing file, which quietly assumed the project
 * being compiled *was* this repository — in a scaffolded app there is no
 * `./src/compiler/` under the working directory, and the rewrite would have
 * emitted an import of a file that does not exist. The bare specifier resolves
 * the same from either.
 */
const HELPERS = `${PACKAGE}/compiler/reactive-runtime.ts`;

/** Whether the rewrite is on for this build. */
export function reactiveEnabled(): boolean {
  return process.env.DZIRY_REACTIVE !== "0";
}

/**
 * `windows/**` only, and `scripts/signals.tsx` deliberately not.
 *
 * Including the harness was tried and reverted. It builds its cases by passing
 * values to a helper — `el(count)` — rather than through JSX braces, so the rewrite
 * turned the *identity* cases into plain reads and every row went frozen. It also
 * rewrote the harness's own plumbing: `withWindowRoute(route, …)` became
 * `withWindowRoute($(route), …)`, a string where a signal was expected.
 *
 * The lesson generalises. This transform is for code shaped like a component, and a
 * file that manipulates signals as *data* is not that. The rewrite is covered by
 * `reactive-transform.test.ts` and end-to-end by the `reactivity` golden.
 *
 * Exported for the compile server's invalidation plugin, which answers the same
 * question for version-stamped module paths.
 */
export function isAuthored(file: string): boolean {
  const path = resolve(file);
  return path.startsWith(WINDOWS + sep) && !path.endsWith(".gen.ts");
}

export const reactivePlugin: BunPlugin = {
  name: "dziry-reactive",
  setup(build) {
    // The filter does the scoping, not a check inside the callback.
    //
    // A *runtime* plugin's `onLoad` must return a module — `undefined` means "the
    // mock returned nothing", not "skip this file", which is a bundler-only
    // affordance. So the hook must never fire for a file it does not intend to
    // rewrite, and every path it does fire for gets contents back.
    build.onLoad({ filter: /[\\/]windows[\\/].+\.tsx?$/ }, async ({ path }) => {
      const loader = path.endsWith(".tsx") ? ("tsx" as const) : ("ts" as const);
      const source = await readFile(path, "utf8");

      if (!isAuthored(path)) return { contents: source, loader };

      const result = transformReactive(source, path, { helpers: HELPERS });
      return { contents: result?.code ?? source, loader };
    });
  },
};

let installed = false;

/**
 * Registers the rewrite with the module loader. Safe to call more than once.
 *
 * Must run before the first `import()` of a window module, and Bun caches a module
 * after loading it — so a plugin registered late silently does nothing to anything
 * already imported. `compileProject` calls this at the top for that reason.
 */
export function installReactivePlugin(): void {
  if (installed || !reactiveEnabled()) return;
  installed = true;
  plugin(reactivePlugin);
}
