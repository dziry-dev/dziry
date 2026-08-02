/**
 * Compiling a *project* — every window under `./windows`, into the artifacts and
 * the entry the host runs.
 *
 * This used to be `src/compile-window.ts`'s body, and moving it here is what makes
 * `dziri compile` possible: the old code took the project directory to be the
 * framework's own repository (`import.meta.dir/..`), which is true exactly once
 * and false for every scaffolded app. The directory is now an argument.
 *
 * The difference from compiling a single document is that a window is *many*
 * modules: the shell plus one per route, each imported, called, and spliced into
 * one tree that is compiled once. Everything after the splice is the existing
 * pipeline — cascade, variants, interning, emit — because a window with its routes
 * in it is just a bigger tree.
 *
 * A window's stylesheet is `windows/<id>/index.css`, beside its `index.tsx`, and
 * is optional. Styles intern across every route in the window, which is the
 * decided design and was measured: two pages of one design system shared 6 of 8
 * style rows.
 */
import { join, relative, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { compileTree, emit, dump, PACKAGE, type EmittedRouting } from "./compile.ts";
import { CssError, formatCssError } from "./css.ts";
import { buildRefIndex, resolveRefs, RefError, type RefSource } from "./resolve-refs.ts";
import { compileVariants, findToggles, type VariantCompiled } from "./variant-compile.ts";
import { toDocument } from "./jsx-runtime.ts";
import { RouteError, scanWindows, type WindowDef } from "./routes.ts";
import { withPage, withWindowRoute } from "./route.ts";
import { configOf, routeSignalOf, WindowError } from "./window.ts";
import { spliceWindow, WindowTreeError, type PageTree } from "./window-tree.ts";
import { setCompiling, signal } from "../runtime/signal.ts";
import { installReactivePlugin, reactiveEnabled } from "./reactive-plugin.ts";
import { resetLocals } from "./reactive-runtime.ts";
import type { Element, Node } from "./html.ts";
import { routeChain, type RouteNodes } from "../ir.ts";

/** Where the generated registry and entries land, relative to the project. */
export const REGISTRY_FILE = "windows/windows.gen.ts";
/** The engine thread — what `dziri dev` runs and `dziri build` compiles. */
export const ENTRY_FILE = "windows/entry.gen.ts";
/** The app thread, spawned by the entry. Holds the whole application. */
export const WORKER_FILE = "windows/worker.gen.ts";
/** Both threads in one, for `--single`. */
export const SINGLE_FILE = "windows/single.gen.ts";

export type CompileOptions = {
  /** The app's root — the directory holding `windows/`. */
  projectDir: string;
  /** Compile only this window. Everything under `windows/` by default. */
  only?: string | undefined;
  /** Also print the IR. */
  dump?: boolean;
  /**
   * Divert the artifact somewhere else, for the characterization harness.
   *
   * Suppresses the registry and entry too: those name a fixed location, and
   * writing them while the artifact went elsewhere would leave the project
   * importing a module that was never regenerated.
   */
  outOverride?: string | null;
};

export type Compiled = {
  window: WindowDef;
  outPath: string;
  nodeCount: number;
  styleCount: number;
  routeCount: number;
  hiddenCount: number;
  bytes: number;
  elapsed: number;
};

/**
 * A compile that failed for a reason the author can act on.
 *
 * Every one of these names a file somebody wrote. The CLI prints `.message` and
 * exits; a Bun stack trace over the top of it would point at the compiler instead.
 */
export class BuildError extends Error {}

function asNodes(value: unknown): Node[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? (value as Node[]) : [value as Node];
}

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
async function defaultComponent(
  file: string,
  what: string,
  rel: (p: string) => string,
): Promise<() => unknown> {
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
export function reportWarnings(warnings: readonly string[]): void {
  const counts = new Map<string, number>();
  for (const w of warnings) counts.set(w, (counts.get(w) ?? 0) + 1);

  for (const [message, n] of counts) {
    console.warn(`  warn: ${message}${n > 1 ? `  (x${n})` : ""}`);
  }
}

async function compileWindow(window: WindowDef, options: CompileOptions): Promise<Compiled> {
  const started = performance.now();
  const { projectDir } = options;
  const rel = (p: string) => relative(projectDir, p).replaceAll("\\", "/");

  const dir = join(projectDir, dirname(window.entry));
  const cssPath = join(dir, "index.css");
  const css = existsSync(cssPath) ? await Bun.file(cssPath).text() : "";

  // Modules are imported and called with `compiling` set, so `.value` on an
  // array signal yields the recording proxy and `defineQuery`/`source`/`effect`
  // stay inert. Same contract as the single-entry driver, over more files.
  // Per window, because the registry is emitted: two windows sharing it would put the
  // first one's locals in the second one's module.
  resetLocals();

  setCompiling(true);
  let shell: Element;
  let pages: PageTree[];
  const sources: RefSource[] = [];

  /** Where the generated module will sit, so import specifiers are relative to it. */
  const outPath = options.outOverride ?? join(dir, "ui.gen.ts");
  const specifierFor = (p: string) => "./" + relative(dirname(outPath), p).replaceAll("\\", "/");

  try {
    const entryPath = join(projectDir, window.entry);
    const shellComponent = await defaultComponent(entryPath, "window", rel);

    /**
     * The shell is built twice, because of an ordering JSX fixes for nobody.
     *
     * `<Window route={route}>` is where a window declares its route, but JSX
     * evaluates children before the element that contains them — so `<Nav/>`, and
     * its `useRouter()`, run *before* `Window()` has seen the prop. The signal
     * cannot be in scope for the call that reveals it.
     *
     * So: one pass to find it, discarding the tree, then the real pass with it in
     * scope. Safe because a build-time component may read but never write — the
     * rule the compile guard already enforces — so running one twice produces the
     * same tree twice. Only the shell pays; pages are expanded once.
     */
    const discovery = withWindowRoute(signal(""), () => asNodes(shellComponent()));
    const discovered = discovery[0];
    const routeSignal =
      discovered !== undefined && discovered.type === "element"
        ? (routeSignalOf(discovered) ?? null)
        : null;

    const entry = withWindowRoute(routeSignal, () => asNodes(shellComponent()));
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
      .filter((name) => name !== "index.tsx" && !name.endsWith(".gen.ts"))
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
      const component = await defaultComponent(file, "page", rel);
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
      throw new BuildError(
        variants.warnings.map((w) => `  error: ${w}`).join("\n") +
          `\n\n${variants.warnings.length} conditional-class conflict(s) in ${window.id}. Two toggles\n` +
          `writing the same style field of the same slot cannot both be correct.`,
      );
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

  const source = emit(
    result,
    {
      html: rel(join(projectDir, window.entry)),
      css: existsSync(cssPath) ? rel(cssPath) : "no stylesheet",
    },
    imports,
    variants,
    routing,
  );

  await Bun.write(outPath, source);

  reportWarnings(result.warnings);
  if (options.dump) console.log(`\n${dump(result)}\n`);

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
  const ident = (id: string) => id.replaceAll("-", "_");
  const imports = all.map((w) => `import * as ${ident(w.id)} from "./${w.id}/ui.gen.ts";`).join("\n");
  const entries = all.map((w) => `  ${JSON.stringify(w.id)}: ${ident(w.id)},`).join("\n");

  return `// GENERATED by dziri. Do not edit.
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

/**
 * The entry points, generated rather than written.
 *
 * They exist because the host cannot import the project: `dziri/host` lives in
 * `node_modules` and a static import of `../../windows/windows.gen.ts` from there
 * would resolve to nothing. Inverting it — the *project* imports the host and hands
 * it the registry — keeps the static import, and with it the type-checking that is
 * the whole reason the registry is not a dynamic `import(id)`.
 *
 * There are three because the app runs on two threads:
 *
 * - `entry.gen.ts` is the **engine thread**. It imports no application code at
 *   all — the window's size, title and table capacities are reported to it by the
 *   other thread at startup — so its module graph is the engine and the loop.
 * - `worker.gen.ts` is the **app thread**, and it is where the whole application
 *   lives: signals, handlers, and the compiled artifact.
 * - `single.gen.ts` is both in one process, for `--single`. It is not a fallback
 *   nobody runs: the golden harness renders every scenario through both, which is
 *   what proves the split changed no pixels.
 *
 * The separation is what keeps a standalone build from carrying the application
 * twice, and it is why the engine thread cannot be blocked by anything the app
 * does — it has nothing of the app's to run.
 */
function entrySource(): string {
  return `// GENERATED by dziri. Do not edit.
//
// The engine thread: the window and the frame loop. No application code — the app
// runs in the Worker below, so a slow handler cannot stop the window redrawing.

import { runMain } from "${PACKAGE}/host/main.ts";

await runMain({
  worker: new URL("./worker.gen.ts", import.meta.url).href,
  // A Worker does not inherit the parent's loader plugins, so the reactive
  // rewrite has to be named again here. Dropped in a packaged build, where the
  // rewrite already happened at bundle time.
  preload: ["${PACKAGE}/compiler/reactive-preload.ts"],
});
`;
}

function workerSource(): string {
  return `// GENERATED by dziri. Do not edit.
//
// The app thread: this project's windows, their signals and their handlers.

import { runWorker } from "${PACKAGE}/host/worker.ts";
import { artifacts, windowIds } from "./windows.gen.ts";

runWorker({ artifacts, windowIds });
`;
}

function singleSource(): string {
  return `// GENERATED by dziri. Do not edit.
//
// Both halves in one thread, for \`dziri dev --single\`. The pre-Worker behaviour,
// kept so the two can be compared rather than as a way of avoiding the Worker.

import { run } from "${PACKAGE}/host";
import { artifacts, windowIds } from "./windows.gen.ts";

await run({ artifacts, windowIds });
`;
}

/**
 * Compiles every window in a project, then the registry and the entry.
 *
 * Throws {@link BuildError}, {@link WindowError}, {@link WindowTreeError},
 * {@link RefError}, {@link RouteError} or {@link CssError} — all of which name
 * something the author wrote. The CLI turns them into a message and an exit code.
 */
export async function compileProject(options: CompileOptions): Promise<Compiled[]> {
  // Before anything imports a window module. Bun caches a module once it is loaded,
  // so a plugin registered after the first `import()` would silently miss that file
  // — and the failure would look like the rewrite not working rather than not
  // running.
  installReactivePlugin();

  const { projectDir } = options;
  let windows = scanWindows(projectDir);

  if (options.only !== undefined) {
    const wanted = windows.filter((w) => w.id === options.only);
    if (wanted.length === 0) {
      throw new BuildError(
        `no window "${options.only}". Windows are ${windows.map((w) => w.id).join(", ")}.`,
      );
    }
    windows = wanted;
  }

  const compiled: Compiled[] = [];
  for (const window of windows) {
    compiled.push(await compileWindow(window, options));
  }

  // The registry lists every window the scan found, not just the ones recompiled, so
  // `dziri compile main` does not silently narrow what the host can open. Written
  // unconditionally because a stale registry is worse than a rewritten one: an import
  // of a window that no longer exists fails at startup, not at build.
  if (!options.outOverride) {
    const all = scanWindows(projectDir);
    await Bun.write(join(projectDir, REGISTRY_FILE), registrySource(all));
    await Bun.write(join(projectDir, ENTRY_FILE), entrySource());
    await Bun.write(join(projectDir, WORKER_FILE), workerSource());
    await Bun.write(join(projectDir, SINGLE_FILE), singleSource());
  }

  return compiled;
}

/**
 * Renders a compile failure as something an author can act on, or rethrows.
 *
 * Shared by `dziri compile` and `dziri dev`, because a build that fails should
 * read the same either way.
 */
export async function formatBuildError(e: unknown, projectDir: string): Promise<string | null> {
  const rel = (p: string) => relative(projectDir, p).replaceAll("\\", "/");

  if (e instanceof CssError) {
    // The offset is into a stylesheet, and only the scan knows which one. Every
    // window has at most one, so finding the file it parsed is a directory walk.
    for (const window of scanWindows(projectDir)) {
      const cssPath = join(projectDir, dirname(window.entry), "index.css");
      if (existsSync(cssPath)) {
        return formatCssError(e, await Bun.file(cssPath).text(), rel(cssPath));
      }
    }
    return `  error: ${e.message}`;
  }

  if (
    e instanceof BuildError ||
    e instanceof WindowError ||
    e instanceof WindowTreeError ||
    e instanceof RefError ||
    e instanceof RouteError
  ) {
    return e instanceof BuildError ? e.message : `  error: ${e.message}`;
  }

  return null;
}

/** One line per window, for the CLI to print. */
export function describe(compiled: Compiled, projectDir: string): string {
  const rel = (p: string) => relative(projectDir, p).replaceAll("\\", "/");
  return (
    `compiled window ${compiled.window.id} -> ${rel(compiled.outPath)}\n` +
    `  ${compiled.routeCount} route(s), ${compiled.hiddenCount} hidden on the first frame\n` +
    `  ${compiled.nodeCount} nodes, ${compiled.styleCount} styles, ` +
    `${compiled.bytes} bytes of IR, ${compiled.elapsed.toFixed(1)}ms` +
    // Said out loud when *off*, because the authoring types assume it is on: a
    // build without it accepts `count * 2` and compiles it to a frozen value.
    (reactiveEnabled() ? "" : "\n  reactive rewrite OFF (DZIRI_REACTIVE=0)")
  );
}
