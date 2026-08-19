/**
 * Selective module invalidation — what makes the compile server warm.
 *
 * A dev compile imports the app's modules to evaluate its components, and Bun
 * caches each module by resolved path. A cold compile pays for the whole graph
 * every time: measured, `effect` + `@livestore/livestore` alone are ~1.9s of
 * module loading in a small app whose cascade is 29ms. Most of that graph did
 * not change between two saves.
 *
 * Bun gives a fresh module for a fresh specifier — `state.ts?v=2` is not
 * `state.ts` (measured) — so invalidation is a version counter per file plus an
 * `onResolve` that appends it. The bust set is the changed files *and their
 * transitive importers*: a page's cached record holds its imports' old
 * identities, so re-importing `state.ts` fresh is not enough — everything that
 * imports it must re-execute to see the new one. The importer graph is recorded
 * here, by the same `onResolve`.
 *
 * One plugin does both halves (redirect + load), because the versioned path is
 * not a file on disk: `onResolve` points at `state.ts?v=2` and the `onLoad`
 * below serves it — with the reactive rewrite applied, since the reactive
 * plugin's filter does not recognise a query-stamped path.
 */
import { plugin } from "bun";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isAuthored } from "./reactive-plugin.ts";
import { transformReactive } from "./reactive-transform.ts";
import { PACKAGE } from "./compile.ts";

const HELPERS = `${PACKAGE}/compiler/reactive-runtime.ts`;

/** The version query this module owns. */
const VERSIONED = /\?v=(\d+)$/;

/** The real path under a possibly version-stamped one. */
export function stripVersion(path: string): string {
  return path.replace(VERSIONED, "");
}

/** Absolute path -> invalidation count. Absent means "never busted". */
const versions = new Map<string, number>();
/** imported -> its importers, for the transitive bust. */
const dependents = new Map<string, Set<string>>();

function toPath(specifier: string, importer: string): string {
  return resolve(dirname(stripVersion(importer)), specifier);
}

let installed = false;

/**
 * Registers the invalidation plugin. The compile server calls it once at
 * startup, before the first compile — a module loaded before registration is
 * cached under its plain path forever, and busting it later would mint a
 * versioned twin of a graph that half-references the old one.
 */
export function installInvalidation(): void {
  if (installed) return;
  installed = true;

  plugin({
    name: "dziri:invalidate",
    setup(build) {
      /* Relative specifiers only, and measured as the reason: redirecting an
         absolute or file:-URL import runs it back through resolution with no
         importer, where Bun 1.3.14 on Windows mangles the plugin-returned path
         ("file:C:\…", then ENOENT — five probes of increasingly creative
         spellings). Relative redirects take the plain path fine. The compiler's
         own dynamic imports are absolute, so those are versioned at the call
         site instead — see versionedHref, used by build.ts. */
      build.onResolve({ filter: /^\./ }, (args) => {
        if (args.importer === "") return undefined;
        const target = toPath(args.path, args.importer);

        // Record the edge under real paths — the graph outlives any version.
        const importer = stripVersion(args.importer);
        let importers = dependents.get(target);
        if (!importers) {
          importers = new Set();
          dependents.set(target, importers);
        }
        importers.add(importer);

        const v = versions.get(target);
        return v === undefined ? undefined : { path: `${target}?v=${v}` };
      });

      // Only version-stamped paths land here — everything else belongs to Bun's
      // loader and the other plugins, whose filters anchor `$` and so miss a
      // query. The reactive rewrite and the css graph's empty-module answer both
      // have to happen here for those paths, or a hot edit would load
      // unrewritten code / a real css module where the plain path gets neither.
      build.onLoad({ filter: VERSIONED }, async ({ path }) => {
        const real = stripVersion(path);
        if (real.endsWith(".css")) return { contents: "export default {};", loader: "js" as const };

        const source = await readFile(real, "utf8");
        const loader = real.endsWith(".tsx")
          ? ("tsx" as const)
          : real.endsWith(".jsx")
            ? ("jsx" as const)
            : ("ts" as const);

        if (!isAuthored(real)) return { contents: source, loader };
        const result = transformReactive(source, real, { helpers: HELPERS });
        return { contents: result?.code ?? source, loader };
      });
    },
  });
}

/**
 * The specifier the compiler's own dynamic imports should use. Absolute paths
 * cannot go through the plugin (see installInvalidation), so build.ts appends
 * the version itself.
 */
export function versionedHref(path: string): string {
  const href = pathToFileURL(resolve(path)).href;
  const v = versions.get(resolve(path));
  return v === undefined ? href : `${href}?v=${v}`;
}

/**
 * The bust set: the changed files plus everything that transitively imports
 * them. A page's cached module record holds its imports' old identities, so
 * re-importing `state.ts` fresh is not enough — everything that imports it must
 * re-execute to see the new one. Factored pure for the test.
 */
export function bustSet(
  changed: readonly string[],
  dependents: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const bust = new Set<string>();
  const queue = [...changed];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (bust.has(file)) continue;
    bust.add(file);
    for (const importer of dependents.get(file) ?? []) queue.push(importer);
  }
  return bust;
}

/**
 * Marks files changed and everything that transitively imports them, so the
 * next compile re-imports fresh copies. The graph is the one this process
 * observed: a module nobody imported yet has no dependents, which is correct —
 * it will be read fresh on first import regardless.
 */
export function invalidate(changed: readonly string[]): void {
  for (const file of bustSet(changed.map((f) => resolve(f)), dependents)) {
    versions.set(file, (versions.get(file) ?? 0) + 1);
  }
}

/** Test and debugging surface: the current version of a path. */
export function versionOf(path: string): number {
  return versions.get(resolve(path)) ?? 0;
}
