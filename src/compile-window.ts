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
import { existsSync } from "node:fs";
import { compileTree, emit, dump, type EmittedRouting } from "./compiler/compile.ts";
import { CssError, formatCssError } from "./compiler/css.ts";
import { buildRefIndex, resolveRefs, RefError, type RefSource } from "./compiler/resolve-refs.ts";
import { compileVariants, findToggles, type VariantCompiled } from "./compiler/variant-compile.ts";
import { toDocument } from "./compiler/jsx-runtime.ts";
import { RouteError, scanWindows, type WindowDef } from "./compiler/routes.ts";
import { withPage } from "./compiler/route.ts";
import { configOf, WindowError } from "./compiler/window.ts";
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

    // A window may keep its signals and handlers in a sibling `state.ts`, exactly
    // as `app/` does. Listed first so its name wins when a page re-exports one.
    const statePath = join(dir, "state.ts");
    if (existsSync(statePath)) {
      sources.push({
        specifier: specifierFor(statePath),
        exports: (await import(pathToFileURL(statePath).href)) as Record<string, unknown>,
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
      // The scope that makes `useRoute("products/$id")` verifiable: inside it, the
      // hook knows the file it is in and refuses a string that disagrees. The
      // import already happened, so nothing awaits inside the scope.
      const value = withPage({ path: route.path, file: route.file }, component);
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

  const { imports } = resolveRefs(result, buildRefIndex(sources), variants);

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

  for (const w of result.warnings) console.warn(`  warn: ${w}`);
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
