/**
 * The route table, read off the filesystem.
 *
 * `windows/<name>/index.tsx` is a window and `windows/<name>/pages/**` are its
 * routes, recursively; the route path *is* the file path under `pages/`, with
 * `$segment` a parameter. Nothing is declared and nothing is registered — there
 * is no `route()` function to call, so the only place a route can come from is a
 * file, and the only way to break one is to move it.
 *
 * Everything here runs at build time and emits data. What survives into the
 * process is a table of segments plus a matcher that walks it; deciding *which*
 * routes exist, what each one takes, and whether a link is dead all happen here.
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { paramsOfPath } from "./route-args.ts";

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

/**
 * Extensions that become routes today.
 *
 * `.mdx` is named separately rather than left to the "not a route" case, because
 * the plan records it as a future authoring form: a file that will route later
 * should say so, not read as junk in a directory that forbids junk.
 */
const ROUTE_EXTENSIONS = [".tsx", ".jsx", ".html"];
const PLANNED_EXTENSIONS = [".mdx"];

/** The name that makes a file the route of its containing directory. */
const INDEX = "index";

export type Route = {
  window: string;
  path: string;
  file: string;
  segments: string[];
  params: string[];
  parent: number;
};

export type WindowDef = {
  id: string;
  entry: string;
  /** Its routes, in match order — see `compareRoutes`. */
  routes: Route[];
};

/**
 * The route path a file under `pages/` produces.
 *
 * `index` names the directory it sits in, so `pages/index.tsx` is the root and
 * `pages/products/index.tsx` is `products` — which is also what
 * `pages/products.tsx` produces, and that collision is caught as a duplicate
 * rather than resolved by a rule.
 *
 * @param relPath file path relative to `pages/`, with `/` separators.
 */
export function routePathFor(relPath: string): string {
  const ext = extname(relPath);
  let stem = relPath.slice(0, relPath.length - ext.length);

  if (basename(stem) === INDEX) {
    stem = stem.slice(0, Math.max(0, stem.length - INDEX.length - 1));
  }

  return stem === "" ? "/" : stem;
}

function segmentsOf(path: string): string[] {
  return path === "/" ? [] : path.split("/");
}

/** A route's shape: what the matcher can distinguish, with names erased. */
function shapeOf(segments: string[]): string {
  return segments.map((s) => (s.startsWith("$") ? "$" : s)).join("/");
}

/**
 * Match order, and therefore precedence: static segments before parameters at
 * every depth, shallower before deeper.
 *
 * This is the only place the *proposed* static-beats-param rule is encoded —
 * `products/new` sorts before `products/$id`, so a matcher that stops at the
 * first hit implements it without knowing about it. If the rule is decided the
 * other way, this comparator is the whole change.
 */
function compareRoutes(a: Route, b: Route): number {
  const depth = a.segments.length - b.segments.length;
  if (depth !== 0) return depth;

  for (let i = 0; i < a.segments.length; i++) {
    const x = a.segments[i]!;
    const y = b.segments[i]!;
    if (x === y) continue;
    const xParam = x.startsWith("$");
    const yParam = y.startsWith("$");
    if (xParam !== yParam) return xParam ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Files under `pages/`, depth-first, relative to `pages/` with `/` separators. */
function walkPages(dir: string, prefix: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walkPages(join(dir, entry.name), rel, out);
    } else {
      out.push(rel);
    }
  }
}

/**
 * Turns one window folder into its routes.
 *
 * Every rejection here is a rule from the design, stated as the error it causes:
 * `pages/` holds routes and nothing else, so a file that is not a route is not
 * ignored; two files cannot name one route; and two routes cannot have the same
 * shape, because then a path matches both and the winner is whichever the
 * comparator happened to put first.
 */
function scanWindow(root: string, id: string, dir: string): WindowDef {
  const entry = join(dir, "index.tsx");
  if (!existsSync(entry)) {
    throw new RouteError(
      `windows/${id} has no index.tsx.\n` +
        `  A window is windows/<name>/index.tsx returning <Window>. The folder name is\n` +
        `  the window's id; there is no flat form and no id override.`,
    );
  }

  const pagesDir = join(dir, "pages");
  if (!existsSync(pagesDir)) {
    throw new RouteError(
      `windows/${id} has no pages/ directory.\n` +
        `  A window's routes are windows/${id}/pages/**, recursively. A window with no\n` +
        `  routes has nothing to put in its <Outlet/>.`,
    );
  }

  const files: string[] = [];
  walkPages(pagesDir, "", files);

  const rel = (p: string) => relative(root, p).replaceAll("\\", "/");
  const routes: Route[] = [];
  const byPath = new Map<string, string>();
  const byShape = new Map<string, { path: string; where: string }>();

  for (const file of files) {
    const abs = join(pagesDir, file);
    const ext = extname(file).toLowerCase();
    const where = `windows/${id}/pages/${file}`;

    if (PLANNED_EXTENSIONS.includes(ext)) {
      throw new RouteError(
        `${where} cannot be compiled yet.\n` +
          `  ${ext} routes are planned but not implemented; only ` +
          `${ROUTE_EXTENSIONS.join(", ")} compile today.`,
      );
    }
    if (!ROUTE_EXTENSIONS.includes(ext)) {
      throw new RouteError(
        `${where} is not a route, and pages/ contains routes and nothing else.\n` +
          `  Every file under pages/ is a route — there is no marker filename and no\n` +
          `  opt-out prefix. A page's own components belong in windows/${id}/, where they\n` +
          `  are ordinary modules that nothing scans.`,
      );
    }

    const path = routePathFor(file);
    const segments = segmentsOf(path);
    const params = paramsOfPath(path);

    for (const segment of segments) {
      // A dot in a segment is almost always a second extension that the first
      // `extname` did not take — and `about.test.tsx` under a directory defined as
      // holding only routes would otherwise become the route `about.test`, quietly
      // and in the one place a colocated test is the natural thing to write.
      if (segment.includes(".")) {
        throw new RouteError(
          `${where} would be the route "${path}", which has a "." in a segment.\n` +
            `  pages/ contains routes and nothing else, so a colocated test or a name with a\n` +
            `  second suffix becomes a route rather than being skipped. Tests, helpers and a\n` +
            `  page's own components belong in windows/${id}/, where nothing scans them.`,
        );
      }
      if (segment.startsWith("$") && !/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
        throw new RouteError(
          `${where} has an unusable parameter segment "${segment}".\n` +
            `  A parameter is $ followed by an identifier, because it becomes a property\n` +
            `  name in useRoute("${path}")'s args.`,
        );
      }
    }

    const duplicateParam = params.find((p, i) => params.indexOf(p) !== i);
    if (duplicateParam !== undefined) {
      throw new RouteError(
        `${where} uses the parameter $${duplicateParam} twice.\n` +
          `  Both would bind to args.${duplicateParam} and one would win silently.`,
      );
    }

    const clash = byPath.get(path);
    if (clash !== undefined) {
      throw new RouteError(
        `two files both claim the route "${path}":\n` +
          `    ${clash}\n    ${where}\n` +
          `  index names the directory it sits in, so products/index.tsx and products.tsx\n` +
          `  are the same route. Keep one.`,
      );
    }
    byPath.set(path, where);

    const shape = shapeOf(segments);
    const shapeClash = byShape.get(shape);
    if (shapeClash !== undefined && params.length > 0) {
      throw new RouteError(
        `"${shapeClash.path}" and "${path}" have the same shape:\n` +
          `    ${shapeClash.where}\n    ${where}\n` +
          `  A concrete path matches both, and which one wins would depend on scan order\n` +
          `  rather than on anything you wrote. Two parameters differing only in name is\n` +
          `  not a distinction the matcher can see.`,
      );
    }
    byShape.set(shape, { path, where });

    routes.push({ window: id, path, file: rel(abs), segments, params, parent: -1 });
  }

  routes.sort(compareRoutes);
  linkParents(routes);

  return { id, entry: rel(entry), routes };
}

/**
 * Fills in `parent`: the longest other route whose segments are a proper prefix.
 *
 * The index route is excluded as a parent even though its segment list is a
 * prefix of everything. `pages/index.tsx` is the route at `/`, not a layout
 * wrapping the window — the window's own `index.tsx` already is that.
 */
function linkParents(routes: Route[]): void {
  for (const [i, route] of routes.entries()) {
    let best = -1;
    let bestDepth = 0;

    for (const [j, candidate] of routes.entries()) {
      if (i === j || candidate.segments.length === 0) continue;
      if (candidate.segments.length >= route.segments.length) continue;
      const isPrefix = candidate.segments.every((s, k) => s === route.segments[k]);
      if (isPrefix && candidate.segments.length > bestDepth) {
        best = j;
        bestDepth = candidate.segments.length;
      }
    }

    route.parent = best;
  }
}

/**
 * Every window under `root/windows`, sorted by id.
 *
 * @param root the project directory holding `windows/`.
 */
export function scanWindows(root: string): WindowDef[] {
  const dir = join(root, "windows");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new RouteError(
      `no windows/ directory in ${root}.\n` +
        `  Windows are windows/<name>/index.tsx; their routes are windows/<name>/pages/**.`,
    );
  }

  const ids = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  if (ids.length === 0) {
    throw new RouteError(`windows/ is empty — there is nothing to open.`);
  }

  return ids.map((id) => scanWindow(root, id, join(dir, id)));
}

/**
 * The type a window's `href` accepts, as TypeScript source.
 *
 * A static route becomes a string literal; a parameter becomes `${string}`, so
 * both `href="products/1"` and `` href={`products/${id}`} `` check and a typo in
 * a static segment does not.
 *
 * `${string}` spans slashes, so the editor also accepts `products/a/b/c`. That is
 * the accepted limit of the type: TypeScript catches typos, the compiler catches
 * shape.
 *
 * One case is worse than that limit and worth knowing before it surprises
 * someone: a parameter in the *first* segment — `pages/$slug.tsx` — contributes a
 * bare `` `${string}` ``, which absorbs every other member and leaves the window's
 * `Href` equal to `string`. The type then checks nothing, and every dead link in
 * that window waits for the compiler instead of the editor.
 */
/**
 * The concrete-path matcher: which route, if any, `href` names.
 *
 * `routes` is already in match order — `compareRoutes` sorts static segments
 * before parameters at every depth — so the first hit *is* the winner and
 * static-beats-param needs no rule here. A parameter segment accepts exactly one
 * non-empty segment: `products/` names nothing, and `products/1/x` matches only
 * a route of that depth. This is the compiler's half of the double check the
 * `Href` union documents — `${string}` spans slashes, so TypeScript catches
 * typos and this catches shape.
 */
export function matchHref(routes: readonly Route[], href: string): Route | null {
  const segments = segmentsOf(href);
  outer: for (const route of routes) {
    if (route.segments.length !== segments.length) continue;
    for (let i = 0; i < segments.length; i++) {
      const pattern = route.segments[i]!;
      if (pattern.startsWith("$") ? segments[i] === "" : pattern !== segments[i]) {
        continue outer;
      }
    }
    return route;
  }
  return null;
}

export function hrefUnion(routes: readonly Route[]): string {
  const members = new Set<string>();

  for (const route of routes) {
    if (route.params.length === 0) {
      members.add(JSON.stringify(route.path));
    } else {
      const pattern = route.segments
        .map((s) => (s.startsWith("$") ? "${string}" : s))
        .join("/");
      members.add(`\`${pattern}\``);
    }
  }

  return members.size === 0 ? "never" : [...members].join(" | ");
}

const listOf = (values: readonly string[]): string =>
  `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;

/**
 * The generated route module.
 *
 * Same contract as `ui.gen.ts`: the artifact declares `satisfies` against the
 * types its consumer imports, so a field renamed here is a compile error in the
 * generated file rather than an `undefined` somewhere downstream.
 */
export function emitRoutes(
  windows: readonly WindowDef[],
  source: {
    /** Where the scan ran, for the provenance comment. */
    from: string;
    /** Specifier of `src` relative to the output file. */
    typesFrom: string;
  },
): string {
  /**
   * `parent` is rebased here, because it changes meaning at this line.
   *
   * The scan links parents within one window, since that is the only scope where
   * nesting exists — two windows' route trees are unrelated. `routes` is the
   * concatenation of all of them, so a parent of 0 in the second window would
   * point at the *first* window's first route: a silently wrong edge, and one that
   * a single-window project can never surface.
   */
  const routeRows = windows
    .flatMap((w, i) => {
      const offset = windows.slice(0, i).reduce((sum, prev) => sum + prev.routes.length, 0);
      return w.routes.map(
        (r) =>
          `  { window: ${JSON.stringify(r.window)}, path: ${JSON.stringify(r.path)},` +
          ` segments: ${listOf(r.segments)}, params: ${listOf(r.params)},` +
          ` parent: ${r.parent === -1 ? -1 : r.parent + offset},` +
          ` file: ${JSON.stringify(r.file)} },`,
      );
    })
    .join("\n");

  const flat = windows.flatMap((w) => w.routes);

  let first = 0;
  const windowRows = windows
    .map((w) => {
      const row =
        `  { id: ${JSON.stringify(w.id)}, entry: ${JSON.stringify(w.entry)},` +
        ` firstRoute: ${first}, routeCount: ${w.routes.length} },`;
      first += w.routes.length;
      return row;
    })
    .join("\n");

  const routeTypes = windows
    .map((w) => `  ${JSON.stringify(w.id)}: ${hrefUnion(w.routes)};`)
    .join("\n");

  return `// GENERATED by src/routes.ts from ${source.from}. Do not edit.
//
// ${windows.length} window(s), ${flat.length} route(s). Routes are in match order:
// static segments before parameters, shallower before deeper.

import type { RouteRow, WindowRow } from "${source.typesFrom}/ir.ts";

/**
 * Each window's routes as concrete paths — what \`href\` and \`navigate\` accept.
 *
 * A parameter is \`\${string}\`, so \`href={\`products/\${id}\`}\` checks and
 * \`href="prodcuts/1"\` does not.
 */
export type Routes = {
${routeTypes}
};

/**
 * Any window's route.
 *
 * The union is across windows because \`navigate\` names no window — it acts on
 * the one it was called from. Per-window narrowing is \`Routes["main"]\`.
 */
export type Href = Routes[keyof Routes];

/** Every route of every window, grouped by window and in match order. */
export const routes = [
${routeRows}
] as const satisfies readonly RouteRow[];

/** Window folders, each owning \`routes[firstRoute .. firstRoute + routeCount]\`. */
export const windows = [
${windowRows}
] as const satisfies readonly WindowRow[];
`;
}
