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
 * Opt-in via `DZIRI_REACTIVE=1` while the rewrite is proven. Off, the build is
 * byte-for-byte what it was; that is what makes `golden` a meaningful check of it.
 */
import { plugin } from "bun";
import { readFile } from "node:fs/promises";
import { relative, dirname, resolve, sep } from "node:path";
import { transformReactive } from "./reactive-transform.ts";

const WINDOWS = resolve(process.cwd(), "windows");

/**
 * `reactive-runtime.ts`, not `signal.ts`.
 *
 * A rewritten window needs `inline` as well as `$` and `$m`, and `inline` is
 * build-time only — it records an expression's source for the compiler to emit.
 * Keeping it in a compiler module is what stops it reaching the shipped runtime,
 * since nothing under `windows/` is ever bundled.
 */
const HELPERS = resolve(process.cwd(), "src", "compiler", "reactive-runtime.ts");

/** Whether the rewrite is on for this build. */
export function reactiveEnabled(): boolean {
  return process.env.DZIRI_REACTIVE === "1";
}

/**
 * The specifier a rewritten file should import its helpers by.
 *
 * A path relative to the importer rather than an absolute one: Bun resolves both,
 * but an absolute path bakes this machine's directory layout into the module graph,
 * and the same source is read by `characterize` and by the tests.
 */
function helpersFor(file: string): string {
  const rel = relative(dirname(file), HELPERS).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function isAuthored(file: string): boolean {
  const path = resolve(file);
  return path.startsWith(WINDOWS + sep) && !path.endsWith(".gen.ts");
}

let installed = false;

/**
 * Registers the rewrite. Safe to call more than once.
 *
 * Must run before the first `import()` of a window module, and Bun caches a module
 * after loading it — so a plugin registered late silently does nothing to anything
 * already imported. `compile-window.ts` calls this at the top for that reason.
 */
export function installReactivePlugin(): void {
  if (installed || !reactiveEnabled()) return;
  installed = true;

  plugin({
    name: "dziri-reactive",
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

        const result = transformReactive(source, path, { helpers: helpersFor(path) });
        return { contents: result?.code ?? source, loader };
      });
    },
  });
}
