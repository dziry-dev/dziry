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
import { join, relative, dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { compileTree, emit, dump, hashText, PACKAGE, type EmittedRouting, type LoaderRef } from "./compile.ts";
import { CssError } from "./diagnostics.ts";
import { installCssGraph, stylesheetsFor } from "./css-imports.ts";
import { loadStylesheet, SheetMap, StylesheetError, type CssSource } from "./stylesheet.ts";
import { buildRefIndex, resolveRefs, RefError, type RefSource } from "./resolve-refs.ts";
import { compileVariants, findToggles, type VariantCompiled } from "./variant-compile.ts";
import { jsx, toDocument } from "./jsx-runtime.ts";
import { emitRoutes, RouteError, scanWindows, type WindowDef } from "./routes.ts";
import { withPage, withWindowRoute } from "./route.ts";
import { routeArgs } from "./route-args.ts";
import { dataRecorder, errorRecorder } from "./route-data.ts";
import { configOf, layerOf, routeSignalOf, WindowError } from "./window.ts";
import { spliceWindow, WindowTreeError, type PageTree } from "./window-tree.ts";
import { setCompiling, signal } from "../runtime/signal.ts";
import { installReactivePlugin, reactiveEnabled } from "./reactive-plugin.ts";
import { resetLocals } from "./reactive-runtime.ts";
import type { Element, Node } from "./html.ts";
import { routeChain, type RouteNodes } from "../ir.ts";
import type { HotManifestEntry } from "../hot.ts";

/** Where the generated registry and entries land, relative to the project. */
export const REGISTRY_FILE = "windows/windows.gen.ts";
/** The engine thread — what `dziri dev` runs and `dziri build` compiles. */
export const ENTRY_FILE = "windows/entry.gen.ts";
/** The app thread, spawned by the entry. Holds the whole application. */
export const WORKER_FILE = "windows/worker.gen.ts";

/**
 * Every window's routes as concrete paths, so navigation is typed.
 *
 * `emitRoutes` and `hrefUnion` were written, tested and then never wired: the only
 * thing that produced this file was `bun run routes`, which nobody ran, so the file
 * did not exist and `Href` typed nothing. Meanwhile the hosts' own comments say a
 * dead link "is meant to be a *build* error" — and navigation took a bare `string`,
 * so it was not one. Writing it here alongside the other three makes the union real.
 */
export const ROUTES_FILE = "windows/routes.gen.ts";

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
  /**
   * Set by the dev watcher: each window's hot-reload fingerprint and payload are
   * put here as it compiles. The watcher writes the collected map to a manifest
   * file, because a watched compile runs in a subprocess and this is how the
   * data crosses back. See src/hot.ts.
   */
  hot?: Map<string, HotManifestEntry>;
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
 * A page's exports, normalised to the parts the compiler calls.
 *
 * A page may export a bare component (the original form, where `export const
 * loader` carries the loader) or a route object built by defineRoute (where the
 * loader is a property of the default export). Both reach the compiler as the
 * same four pieces; `loaderFromObject` records which form, because the loader
 * survives into the artifact differently — a named export is imported by name, a
 * route object's default is imported under an alias and the property read off it.
 */
type PageModule = {
  component: (props: Record<string, unknown>) => unknown;
  loader: unknown;
  errorComponent: ((props: Record<string, unknown>) => unknown) | undefined;
  loadingComponent: ((props: Record<string, unknown>) => unknown) | undefined;
  loaderFromObject: boolean;
};

/**
 * Imports a page module and reads it as either a bare component or a route object.
 *
 * The route-object check is by shape — a default export that is an object with a
 * `component` function — rather than by an import, for the same reason Effect is
 * recognised structurally: nothing here should require the author to name dziri.
 */
async function pageModule(
  file: string,
  rel: (p: string) => string,
  expectedPath: string,
): Promise<PageModule> {
  const mod = (await import(pathToFileURL(file).href)) as {
    default?: unknown;
    loader?: unknown;
  };
  const def = mod.default;

  if (typeof def === "function") {
    return {
      component: def as (props: Record<string, unknown>) => unknown,
      loader: mod.loader,
      errorComponent: undefined,
      loadingComponent: undefined,
      loaderFromObject: false,
    };
  }

  if (typeof def === "object" && def !== null) {
    const route = def as {
      path?: unknown;
      loader?: unknown;
      component?: unknown;
      errorComponent?: unknown;
      loadingComponent?: unknown;
    };
    if (typeof route.component === "function") {
      // The string defineRoute took is checked here rather than in defineRoute,
      // because defineRoute runs at module scope (before the compiler knows which
      // file it is importing). This is the useRoute path check, moved one frame up.
      if (route.path !== expectedPath) {
        throw new WindowError(
          `defineRoute(${JSON.stringify(String(route.path))}) is in ${rel(file)}, whose route is ${JSON.stringify(expectedPath)}.\n` +
            `  The string has to match the file's own path under pages/, because it is what types\n` +
            `  the generated ComponentProps and nothing else verifies it. Either the file moved\n` +
            `  and the string did not, or the route object was written by hand without\n` +
            `  defineRoute and so carries no path.`,
        );
      }
      return {
        component: route.component as (props: Record<string, unknown>) => unknown,
        loader: route.loader,
        errorComponent:
          typeof route.errorComponent === "function"
            ? (route.errorComponent as (props: Record<string, unknown>) => unknown)
            : undefined,
        loadingComponent:
          typeof route.loadingComponent === "function"
            ? (route.loadingComponent as (props: Record<string, unknown>) => unknown)
            : undefined,
        loaderFromObject: true,
      };
    }
  }

  throw new WindowError(
    `${rel(file)} must export a component as its default, or a route object.\n` +
      `  A route is either a bare component — \`export default function Page() { … }\` — or\n` +
      `  a route object — \`export default defineRoute("path")({ component, loader, … })\`.\n` +
      `  The compiler calls the component while it knows which route it is compiling, which\n` +
      `  is what makes useRoute/defineRoute checkable. An element built at module scope has\n` +
      `  already run before anything knows where it is.`,
  );
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
  /** Page modules, in route order — the other roots of the window's import graph. */
  const pageFiles: string[] = [];
  /** Per-route build products, in route order, assembled before the splice. */
  const pageBuilds: {
    successNodes: Node[];
    loadingNodes: Node[];
    /** The errorComponent's nodes, or null when the route declares none. */
    errorNodes: Node[] | null;
    loader: unknown;
    loaderFromObject: boolean;
  }[] = [];

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

    for (const route of window.routes) {
      const file = join(projectDir, route.file);
      pageFiles.push(file);
      const mod = await pageModule(file, rel, route.path);

      // Two scopes, with different lifetimes. `withPage` is the cursor that makes
      // `useRoute("products/$id")`/`defineRoute("products/$id")` verifiable — inside
      // it the hook knows the file it is in and refuses a string that disagrees.
      // `withWindowRoute` is the window's own route signal, which `useRouter()` reads
      // and which is the same for every page here. The import already happened, so
      // nothing awaits inside either.
      const call = (fn: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) =>
        withWindowRoute(routeSignalOf(shell) ?? null, () =>
          withPage({ path: route.path, file: route.file }, () => fn(props)),
        );

      const params = routeArgs(route.path, route.params);
      const successNodes = asNodes(call(mod.component, { ...params, data: dataRecorder() }));
      const loadingNodes = mod.loadingComponent
        ? asNodes(call(mod.loadingComponent, { ...params }))
        : [];
      const errorNodes = mod.errorComponent
        ? asNodes(call(mod.errorComponent, { ...params, error: errorRecorder() }))
        : null;

      pageBuilds.push({
        successNodes,
        loadingNodes,
        errorNodes,
        loader: mod.loader,
        loaderFromObject: mod.loaderFromObject,
      });

      sources.push({
        specifier: specifierFor(file),
        exports: (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      });
    }

    // Error boundary: a route without an explicit errorComponent bubbles to its
    // nearest ancestor that has one; with none anywhere on the chain, it gets the
    // built-in default view. A route with no loader cannot fail, so it needs no
    // default view of its own — it is only a bubble-through node. Runs after the
    // loop because deciding "none anywhere" needs every errorComponent known.
    const defaultErrorView = (): Node =>
      jsx("div", {
        className: "route-error",
        children: ["Something went wrong: ", errorRecorder()],
      });
    const hasExplicitError = pageBuilds.map((b) => b.errorNodes !== null);
    for (const [i, build] of pageBuilds.entries()) {
      if (build.errorNodes !== null) continue;
      if (build.loader === undefined) {
        build.errorNodes = [];
        continue;
      }
      let bubble = false;
      for (let p = window.routes[i]!.parent; p !== -1; p = window.routes[p]!.parent) {
        if (hasExplicitError[p]) {
          bubble = true;
          break;
        }
      }
      build.errorNodes = bubble ? [] : asNodes(defaultErrorView());
    }

    pages = pageBuilds.map((build, i) => ({
      path: window.routes[i]!.path,
      file: window.routes[i]!.file,
      parent: window.routes[i]!.parent,
      nodes: build.successNodes,
      loadingNodes: build.loadingNodes,
      errorNodes: build.errorNodes!,
    }));
  } finally {
    setCompiling(false);
  }

  const { root, roots, loadingRoots, errorRoots } = spliceWindow(shell, pages);

  const nodeOf = new Map<Element, number>();
  const doc = toDocument(root);

  /**
   * The window's CSS, assembled from the two sources that produce a stylesheet.
   *
   * The roots are the entry and the pages — *not* the folder modules imported
   * above for the reference index. Those are already reachable from the entry as
   * ordinary imports, and walking from the entry is what gets them in the order the
   * author's own `import` statements put them in. Seeding the walk with them
   * instead would order the cascade by a readdir.
   *
   * There is no `<style>` case here: a window is authored in JSX, and JSX refuses
   * the tag. `<style>` is the `.html` front-end's way in, handled in `compile.ts`.
   */
  const sheets: CssSource[] = [];
  for (const path of stylesheetsFor([join(projectDir, window.entry), ...pageFiles])) {
    sheets.push(await loadStylesheet(path, projectDir));
  }

  const sheet = new SheetMap(sheets);
  const css = sheet.text;

  /**
   * A parse failure is turned into an author-facing message here, where the map
   * from concatenated offset back to source file still exists.
   *
   * It used to be recovered in `formatBuildError` by walking the project for a
   * file named `index.css`, which worked only while a window could have exactly
   * one stylesheet and it was always that one. With the sheet assembled from
   * imports there is nothing to guess from — and nothing to guess, since the map
   * is right here.
   */
  let result: ReturnType<typeof compileTree>;
  let variants: VariantCompiled | undefined;
  const label = (p: string) => (isAbsolute(p) ? rel(p) : p);

  try {
    result = compileTree(doc, css, { nodeOf });
    const toggles = findToggles(doc);
    if (toggles.length > 0) variants = compileVariants(doc, css, result, toggles);
  } catch (e) {
    if (e instanceof CssError) throw new BuildError(sheet.formatError(e, label));
    throw e;
  }

  if (variants && variants.warnings.length > 0) {
    throw new BuildError(
      variants.warnings.map((w) => `  error: ${w}`).join("\n") +
        `\n\n${variants.warnings.length} conditional-class conflict(s) in ${window.id}. Two toggles\n` +
        `writing the same style field of the same slot cannot both be correct.`,
    );
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
   * The window's Effect layer, resolved to an export name the same way. The
   * error is the route signal's, because it is the same mistake: an object that
   * must survive into the artifact can only do so as a name.
   */
  let layerName: string | null = null;
  const layer = layerOf(shell);
  if (layer !== undefined) {
    const ref = index.get(layer);
    if (!ref) {
      throw new WindowError(
        `<Window layer={…}> was given a value that is not a module-level export.\n` +
          `  The generated artifact imports the layer by name, so it has to be exported —\n` +
          `  conventionally from the window's runtime.ts. A layer built inside a component\n` +
          `  has nowhere to live, because components are erased at build time.`,
      );
    }
    layerName = ref.name;
    const names = imports.get(ref.specifier) ?? new Set<string>();
    names.add(ref.name);
    imports.set(ref.specifier, names);
  }

  /**
   * Each route's loader, resolved to how the artifact references it. A bare page's
   * `export const loader` is a named export; a route object's loader is a property
   * of its default export, which the artifact imports under a synthetic alias. A
   * route with no loader contributes null.
   */
  const loaders: (LoaderRef | null)[] = pageBuilds.map((build, i) => {
    if (build.loader === undefined) return null;
    if (!build.loaderFromObject) {
      const ref = index.get(build.loader);
      if (!ref) {
        throw new WindowError(
          `a route's \`loader\` is not a module-level export.\n` +
            `  The artifact imports it by name, so it has to be exported — \`export const\n` +
            `  loader = …\` beside the page's default export. A loader built inside a\n` +
            `  component has nowhere to live, because components are erased at build time.`,
        );
      }
      const names = imports.get(ref.specifier) ?? new Set<string>();
      names.add(ref.name);
      imports.set(ref.specifier, names);
      return { kind: "name", name: ref.name } satisfies LoaderRef;
    }
    return {
      kind: "default",
      alias: `route_${i}`,
      specifier: specifierFor(join(projectDir, window.routes[i]!.file)),
      prop: "loader",
    } satisfies LoaderRef;
  });

  /**
   * A route's roots as node ids.
   *
   * An element that produced no node is dropped rather than emitted as -1: the
   * walk skips a few children, and a route whose only child was skipped owns
   * nothing, which is already a legitimate state — a layout that is nothing but an
   * outlet is in it by design.
   */
  const nodeIds = (els: readonly Element[]): number[] =>
    els.map((el) => nodeOf.get(el)).filter((n): n is number => n !== undefined);

  const routeNodes: RouteNodes[] = window.routes.map((route, i) => ({
    path: route.path,
    roots: nodeIds(roots[i]!),
    loading: nodeIds(loadingRoots[i]!),
    error: nodeIds(errorRoots[i]!),
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
    layer: layerName,
    loaders,
  };

  const emitted = emit(
    result,
    {
      html: rel(join(projectDir, window.entry)),
      css: sheet.paths.length > 0 ? sheet.paths.map(label).join(", ") : "no stylesheet",
    },
    imports,
    variants,
    routing,
  );
  const source = emitted.source;

  // Hot reload's half of the compile: the fingerprint the watcher compares, and
  // the style values it ships on a match. See src/hot.ts for the ruling.
  options.hot?.set(window.id, {
    fingerprint: hashText(emitted.structural),
    payload: emitted.hot,
  });

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
 * There are two because the app runs on two threads:
 *
 * - `entry.gen.ts` is the **engine thread**. It imports no application code at
 *   all — the window's size, title and table capacities are reported to it by the
 *   other thread at startup — so its module graph is the engine and the loop.
 * - `worker.gen.ts` is the **app thread**, and it is where the whole application
 *   lives: signals, handlers, and the compiled artifact.
 *
 * There used to be a third, `single.gen.ts`, running both halves in one process for
 * `dziri dev --single`. It was kept on the grounds that the golden harness rendered
 * every scenario through both paths and so proved the split changed no pixels. It
 * never did — `golden.ts` spawns `entry.gen.ts` and nothing else — and the claim was
 * not even executable, because `--click` only ever existed on this path. What the
 * duplicate actually cost was a second implementation of the app half, maintained by
 * hand: `--advance` was written twice in one commit with different mechanics, and
 * `--click` was added to one path and not the other.
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
  // Same reason, and the stakes are the same: an edge resolved before the recorder
  // exists is a stylesheet missing from the cascade rather than an error.
  installCssGraph();

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
    // `typesFrom` is the package name rather than a relative path, because this
    // lands in the *project* and resolves dziri the same way every other generated
    // file there does.
    await Bun.write(
      join(projectDir, ROUTES_FILE),
      emitRoutes(all, { from: "windows", typesFrom: PACKAGE }),
    );
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

  if (e instanceof StylesheetError) return `  error: ${e.message}`;

  // A CssError normally arrives already rendered, as a BuildError: `compileWindow`
  // catches it while it still holds the map from concatenated offset back to source
  // file. This is the fallback for one thrown outside that scope, where the offset
  // refers to a string nobody can name.
  if (e instanceof CssError) return `  error: ${e.message}`;

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
