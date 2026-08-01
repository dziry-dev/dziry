/**
 * CLI for compiling a window.
 *
 *   bun run window                 # every window under ./windows
 *   bun run window main            # just that one
 *   bun run window --dump          # also print the IR
 *
 * The difference from `bun run compile` is that a window is *many* modules: the
 * shell plus one per route, each imported, called, and spliced into one tree that
 * is compiled once. Everything after the splice is the existing pipeline —
 * cascade, variants, interning, emit — because a window with its routes in it is
 * just a bigger tree.
 *
 * A window's stylesheet is `windows/<id>/index.css`, beside its `index.tsx`, and
 * is optional. Styles intern across every route in the window, which is the
 * decided design and was measured: two pages of one design system shared 6 of 8
 * style rows.
 */
import { join, relative, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { compileTree, emit, dump, type EmittedRouting } from "./compiler/compile.ts";
import { CssError, formatCssError } from "./compiler/css.ts";
import { buildRefIndex, resolveRefs, RefError, type RefSource } from "./compiler/resolve-refs.ts";
import { compileVariants, findToggles, type VariantCompiled } from "./compiler/variant-compile.ts";
import { toDocument } from "./compiler/jsx-runtime.ts";
import { RouteError, scanWindows, type WindowDef } from "./compiler/routes.ts";
import { withPage, withWindowRoute } from "./compiler/route.ts";
import { configOf, routeSignalOf, WindowError } from "./compiler/window.ts";
import { spliceWindow, WindowTreeError, type PageTree } from "./compiler/window-tree.ts";
import { setCompiling } from "./runtime/signal.ts";
import type { Element, Node } from "./compiler/html.ts";
import { routeChain, type RouteNodes } from "./ir.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);

const flags = new Set(argv.filter((a) => a.startsWith("--")));

const outIndex = argv.indexOf("-o");
/** Overrides where the artifact lands, so the characterization harness can divert it. */
const outOverride = outIndex !== -1 && argv[outIndex + 1] ? resolve(argv[outIndex + 1]!) : null;

const positional = argv.filter(
  (a, i) => !a.startsWith("--") && a !== "-o" && argv[i - 1] !== "-o",
);

const projectDir = ROOT;
const only = positional[0];

const rel = (p: string) => relative(projectDir, p).replaceAll("\\", "/");

/**
 * Imports a module and returns its default export as a function to call.
 *
 * The import and the call are separate steps because the call has to happen inside
 * `withPage`, which is synchronous — awaiting inside that scope would close it
 * before the component ran. So: await here, call there.
 *
 * A page exports a *component*, not an element, and the difference is the whole
 * reason `useRoute` can be checked: the compiler calls the function while it knows
 * which route it is calling for.
 */
async function defaultComponent(file: string, what: string): Promise<() => unknown> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };

  if (typeof mod.default !== "function") {
    throw new WindowError(
      `${rel(file)} must export a ${what} function as its default.\n` +
        `  The compiler calls it while it knows which route it is compiling, and that is\n` +
        `  what makes useRoute's path checkable. An element built at module scope —\n` +
        `  \`export default <div/>\` — has already run before anything knows where it is.\n` +
        `    export default function Page() { return <div/>; }`,
    );
  }

  return mod.default as () => unknown;
}

function asNodes(value: unknown): Node[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? (value as Node[]) : [value as Node];
}

/**
 * Warnings, deduplicated with a count.
 *
 * One unsupported property in a stylesheet is not one warning — it is one per node
 * that inherits a rule mentioning it, and Tailwind's `text-*` utilities set
 * `line-height` beside every font size. The Tailwind window printed 110 identical
 * lines, which is worse than printing none: it buries the *distinct* warnings, and
 * the summary line the author is actually waiting for scrolls off the top.
 *
 * Grouped rather than capped, because the count is the useful part — 110 nodes
 * affected is a different story from two, and a cap would hide which it was.
 */
function reportWarnings(warnings: readonly string[]): void {
  const counts = new Map<string, number>();
  for (const w of warnings) counts.set(w, (counts.get(w) ?? 0) + 1);

  for (const [message, n] of counts) {
    console.warn(`  warn: ${message}${n > 1 ? `  (x${n})` : ""}`);
  }
}

type Compiled = {
  window: WindowDef;
  outPath: string;
  nodeCount: number;
  styleCount: number;
  routeCount: number;
  hiddenCount: number;
  bytes: number;
  elapsed: number;
};

async function compileWindow(window: WindowDef): Promise<Compiled> {
  const started = performance.now();

  const dir = join(projectDir, dirname(window.entry));
  const cssPath = join(dir, "index.css");
  const css = existsSync(cssPath) ? await Bun.file(cssPath).text() : "";

  // Modules are imported and called with `compiling` set, so `.value` on an
  // array signal yields the recording proxy and `defineQuery`/`source`/`effect`
  // stay inert. Same contract as the single-entry driver, over more files.
  setCompiling(true);
  let shell: Element;
  let pages: PageTree[];
  const sources: RefSource[] = [];

  /** Where the generated module will sit, so import specifiers are relative to it. */
  const outPath = outOverride ?? join(dir, "ui.gen.ts");
  const specifierFor = (p: string) => "./" + relative(dirname(outPath), p).replaceAll("\\", "/");

  try {
    const entryPath = join(projectDir, window.entry);
    const entry = asNodes((await defaultComponent(entryPath, "window"))());
    const first = entry[0];

    if (entry.length !== 1 || first === undefined || first.type !== "element" || !configOf(first)) {
      throw new WindowError(
        `${rel(entryPath)} must return a single <Window>.\n` +
          `  windows/${window.id}/index.tsx is the window: <Window title="…"> with the chrome\n` +
          `  that stays put across navigation, and an <Outlet/> where the route goes.`,
      );
    }
    shell = first;

    /**
     * Every module in the window folder is a reference source.
     *
     * Not just `state.ts`: the design says the window folder holds ordinary modules,
     * and a window that splits its signals across `state.ts` and `router.ts` is
     * doing exactly what that invites. Hardcoding one filename made the second one
     * fail with "not a module-level export" about a function that plainly was.
     *
     * `state.ts` still goes first, so its name wins when the same object is
     * re-exported elsewhere. The folder only — pages are added as they are compiled,
     * and nothing recurses, because a window's own components are its direct
     * children by convention.
     */
    const folderModules = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
      .map((e) => e.name)
      .filter((name) => name !== "index.tsx" && name !== "ui.gen.ts")
      .sort((a, b) => (a === "state.ts" ? -1 : b === "state.ts" ? 1 : a < b ? -1 : 1));

    for (const name of folderModules) {
      const path = join(dir, name);
      sources.push({
        specifier: specifierFor(path),
        exports: (await import(pathToFileURL(path).href)) as Record<string, unknown>,
      });
    }
    sources.push({
      specifier: specifierFor(entryPath),
      exports: (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>,
    });

    pages = [];
    for (const route of window.routes) {
      const file = join(projectDir, route.file);
      const component = await defaultComponent(file, "page");
      // Two scopes, with different lifetimes. `withPage` is the cursor that makes
      // `useRoute("products/$id")` verifiable — inside it the hook knows the file it
      // is in and refuses a string that disagrees. `withWindowRoute` is the window's
      // own route signal, which `useRouter()` reads and which is the same for every
      // page here. The import already happened, so nothing awaits inside either.
      const value = withWindowRoute(routeSignalOf(shell) ?? null, () =>
        withPage({ path: route.path, file: route.file }, component),
      );
      pages.push({
        path: route.path,
        file: route.file,
        parent: route.parent,
        nodes: asNodes(value),
      });
      sources.push({
        specifier: specifierFor(file),
        exports: (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      });
    }
  } finally {
    setCompiling(false);
  }

  const { root, roots } = spliceWindow(shell, pages);

  const nodeOf = new Map<Element, number>();
  const doc = toDocument(root);
  const result = compileTree(doc, css, { nodeOf });

  let variants: VariantCompiled | undefined;
  const toggles = findToggles(doc);
  if (toggles.length > 0) {
    variants = compileVariants(doc, css, result, toggles);
    if (variants.warnings.length > 0) {
      for (const w of variants.warnings) console.error(`  error: ${w}`);
      console.error(
        `\n${variants.warnings.length} conditional-class conflict(s) in ${window.id}. Two toggles\n` +
          `writing the same style field of the same slot cannot both be correct.`,
      );
      process.exit(1);
    }
  }

  const index = buildRefIndex(sources);
  const { imports } = resolveRefs(result, index, variants);

  /**
   * The route signal, resolved to the export name the artifact will import.
   *
   * Same rule as every other signal reference: it survives the compiler/runtime
   * file boundary only as a name, so it has to be a module-level export.
   */
  let routeSignalName: string | null = null;
  const routeSignal = routeSignalOf(shell);
  if (routeSignal) {
    const ref = index.get(routeSignal);
    if (!ref) {
      throw new WindowError(
        `<Window route={…}> was given a signal that is not a module-level export.\n` +
          `  The generated artifact imports it by name, so it has to be exported — from the\n` +
          `  window's state.ts, its entry, or a page. A signal created inside a component has\n` +
          `  nowhere to live, because components are erased at build time.`,
      );
    }
    routeSignalName = ref.name;
    const names = imports.get(ref.specifier) ?? new Set<string>();
    names.add(ref.name);
    imports.set(ref.specifier, names);
  }

  /**
   * A route's roots as node ids.
   *
   * An element that produced no node is dropped rather than emitted as -1: the
   * walk skips a few children, and a route whose only child was skipped owns
   * nothing, which is already a legitimate state — a layout that is nothing but an
   * outlet is in it by design.
   */
  const routeNodes: RouteNodes[] = window.routes.map((route, i) => ({
    path: route.path,
    roots: roots[i]!.map((el) => nodeOf.get(el)).filter((n): n is number => n !== undefined),
    parent: route.parent,
  }));

  const initial = Math.max(
    0,
    window.routes.findIndex((r) => r.path === "/"),
  );

  const routing: EmittedRouting = {
    window: window.id,
    config: configOf(shell)!,
    routes: routeNodes,
    initial,
    routeSignal: routeSignalName,
  };

  const typesFrom = relative(dirname(outPath), join(ROOT, "src")).replaceAll("\\", "/");
  const source = emit(
    result,
    { html: rel(join(projectDir, window.entry)), css: existsSync(cssPath) ? rel(cssPath) : "no stylesheet", typesFrom },
    imports,
    variants,
    routing,
  );

  await Bun.write(outPath, source);

  reportWarnings(result.warnings);
  if (flags.has("--dump")) console.log(`\n${dump(result)}\n`);

  const chain = routeChain(routeNodes, initial);

  return {
    window,
    outPath,
    nodeCount: result.nodes.length,
    styleCount: variants ? variants.slotCount : result.styles.length,
    routeCount: window.routes.length,
    hiddenCount: routeNodes.filter((_, i) => !chain.has(i)).length,
    bytes: new TextEncoder().encode(source).length,
    elapsed: performance.now() - started,
  };
}

let windows: WindowDef[];
try {
  windows = scanWindows(projectDir);
} catch (e) {
  if (e instanceof RouteError) {
    console.error(`  error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

if (only !== undefined) {
  const wanted = windows.filter((w) => w.id === only);
  if (wanted.length === 0) {
    console.error(
      `  error: no window "${only}". Windows are ${windows.map((w) => w.id).join(", ")}.`,
    );
    process.exit(1);
  }
  windows = wanted;
}

/**
 * A module importing every window's artifact, so one host can run any of them.
 *
 * Static imports rather than a dynamic `import(id)`, because that is what keeps the
 * artifacts type-checked: the host reads `artifacts[id].routeNodes` and `tsc`
 * checks it against what the compiler actually emitted. A dynamic import returns
 * `any` and the one interface a generated-identity project cannot afford to stop
 * checking is this one.
 *
 * The cost is that every window's module is parsed at startup, which is the cost
 * ROADMAP flags for routes and answers the same way — split the *module* behind a
 * dynamic import when it is measured to matter, not before.
 */
function registrySource(all: readonly WindowDef[]): string {
  const imports = all
    .map((w) => `import * as ${w.id.replaceAll("-", "_")} from "./${w.id}/ui.gen.ts";`)
    .join("\n");
  const entries = all.map((w) => `  ${JSON.stringify(w.id)}: ${w.id.replaceAll("-", "_")},`).join("\n");

  return `// GENERATED by src/compile-window.ts. Do not edit.
//
// Every window's artifact, imported statically so the host stays type-checked.

${imports}

export const artifacts = {
${entries}
} as const;

export type WindowId = keyof typeof artifacts;

/** Ids in scan order, which is alphabetical. */
export const windowIds: readonly WindowId[] = Object.keys(artifacts) as WindowId[];
`;
}

for (const window of windows) {
  let compiled: Compiled;
  try {
    compiled = await compileWindow(window);
  } catch (e) {
    // Every one of these names a file the author wrote. A Bun stack trace over the
    // top of it would point at this compiler instead.
    if (e instanceof CssError) {
      const cssPath = join(projectDir, dirname(window.entry), "index.css");
      console.error(formatCssError(e, await Bun.file(cssPath).text(), rel(cssPath)));
      process.exit(1);
    }
    if (e instanceof WindowError || e instanceof WindowTreeError || e instanceof RefError) {
      console.error(`  error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  console.log(
    `compiled window ${compiled.window.id} -> ${rel(compiled.outPath)}\n` +
      `  ${compiled.routeCount} route(s), ${compiled.hiddenCount} hidden on the first frame\n` +
      `  ${compiled.nodeCount} nodes, ${compiled.styleCount} styles, ` +
      `${compiled.bytes} bytes of IR, ${compiled.elapsed.toFixed(1)}ms`,
  );
}

// The registry lists every window the scan found, not just the ones recompiled, so
// `bun run window main` does not silently narrow what the host can open. It is
// written unconditionally because a stale registry is worse than a rewritten one:
// an import of a window that no longer exists fails at startup, not at build.
if (outOverride === null) {
  const all = scanWindows(projectDir);
  await Bun.write(join(projectDir, "windows", "windows.gen.ts"), registrySource(all));
}
