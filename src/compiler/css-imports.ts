/**
 * Which stylesheets a window imported, and in what order.
 *
 * A window is compiled by *importing* it — components are ordinary functions, so
 * expanding them is calling them. That makes the module graph the compiler already
 * walks the same graph a bundler would use to order CSS, and this records it.
 *
 * # Why the graph is recorded rather than parsed
 *
 * The obvious alternative is to parse each source with `oxc-parser` — already a
 * dependency — and follow the import specifiers. It was not chosen because it
 * means re-implementing module resolution: extensions, directory indexes,
 * `tsconfig` paths, `exports` maps. Every one of those is a chance to disagree with
 * what Bun *actually* imported a moment earlier, and a disagreement shows up as a
 * stylesheet that silently is not in the cascade.
 *
 * `onResolve` is Bun's own resolver answering the question, so there is nothing to
 * disagree with.
 *
 * # Why the graph is cumulative and never reset
 *
 * Measured, because it decides correctness for a multi-window project: `onResolve`
 * fires for every edge, including one whose target is already in the module cache —
 * compiling window B still reports `B/index.tsx -> shared/util.ts`. What it does
 * *not* re-report is anything below that cached module, so `shared/util.ts ->
 * theme.css` fires once, while compiling A, and never again.
 *
 * So a per-window graph would give window B a stylesheet-free `shared/util.ts` and
 * drop the theme, silently. Accumulating across the whole run and walking per
 * window from that window's own roots is what makes B's walk find the edge A's
 * import recorded.
 */
import { plugin } from "bun";
import { dirname, extname, isAbsolute, resolve } from "node:path";

/** importer -> what it imported, in source order, deduped. */
const EDGES = new Map<string, string[]>();

let installed = false;

function record(importer: string, target: string): void {
  let targets = EDGES.get(importer);
  if (targets === undefined) {
    targets = [];
    EDGES.set(importer, targets);
  }
  // `onResolve` fires twice per edge in Bun today. Deduping here rather than
  // relying on the walk's `visited` set, because order matters and a duplicate
  // would be harmless only by luck.
  if (!targets.includes(target)) targets.push(target);
}

/**
 * Guards against `onResolve` calling the resolver that calls `onResolve`.
 *
 * `Bun.resolveSync` runs the full plugin pipeline, so asking it to resolve the
 * specifier this callback was handed re-enters this callback with the same
 * arguments — unbounded, and it stack-overflows before the first window compiles.
 *
 * Relative specifiers never reach it, so in practice this only covers bare ones,
 * where the extra resolution is worth a flag: a package's own CSS is reachable only
 * through the edge into that package.
 */
let resolving = false;

/**
 * Resolves a specifier the way the import that produced it resolved.
 *
 * Relative and absolute paths are joined directly rather than handed to
 * `Bun.resolveSync` — no plugin pipeline, so no re-entrancy, and nothing to guard.
 *
 * A specifier that does not resolve is dropped. It is not this module's job to
 * report it: the import itself is about to fail, with a better message than
 * anything available here.
 */
function resolveTarget(specifier: string, importer: string): string | null {
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    return resolve(dirname(importer), specifier);
  }
  if (resolving) return null;

  resolving = true;
  try {
    return Bun.resolveSync(specifier, dirname(importer));
  } catch {
    return null;
  } finally {
    resolving = false;
  }
}

/**
 * Registers the recorder. Idempotent — the compiler may compile many windows in
 * one process, and the graph has to outlive all of them.
 */
export function installCssGraph(): void {
  if (installed) return;
  installed = true;

  plugin({
    name: "dziri:css-graph",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // An entry point has no importer. Nothing to attribute it to, and the
        // compiler names the roots itself.
        if (args.importer === "") return undefined;

        const target = resolveTarget(args.path, args.importer);
        if (target !== null) record(args.importer, target);

        // Falling through to Bun's own resolution. This plugin observes; it must
        // never change where an import points.
        return undefined;
      });

      // A `.css` import is a side effect, not a value. Bun's own answer is the
      // file's path as a default export, which works but means a typo in the
      // specifier of an unused import is invisible. Replacing it with an empty
      // module makes the intent explicit and keeps the artifact free of a string
      // nobody reads.
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {};", loader: "js" }));
    },
  });
}

const isCss = (path: string): boolean => extname(path).toLowerCase() === ".css";

/**
 * The stylesheets reachable from `roots`, in the order ES modules evaluate them.
 *
 * Depth-first post-order: a module's imports evaluate before the module does, in
 * source order, and anything already visited is skipped. That is the order a
 * bundler emits CSS in, which is the order the cascade then reads it in — so
 * `import "./base.css"` before `import "./theme.css"` means theme wins, the same
 * way it would on the web.
 *
 * One `visited` set across all roots, so a sheet two pages share lands once, at the
 * first position that pulled it in.
 */
export function stylesheetsFor(roots: readonly string[]): string[] {
  const visited = new Set<string>();
  const out: string[] = [];

  const walk = (module: string): void => {
    if (visited.has(module)) return;
    visited.add(module);

    for (const target of EDGES.get(module) ?? []) walk(target);

    if (isCss(module)) out.push(module);
  };

  for (const root of roots) walk(resolve(root));
  return out;
}
