/**
 * The route scan: what the filesystem means, and what it refuses to mean.
 *
 * Every route in dziri comes from a file path and nothing else — there is no
 * `route()` call to declare one and no registry to check against. That makes the
 * scan the whole specification of the router's input, so the interesting tests are
 * the rejections: two files claiming one route, two routes of one shape, and a
 * non-route file in a directory that is defined as holding routes and nothing else.
 * Each of those, left to a rule, would resolve silently in favour of whichever file
 * `readdir` happened to return first.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RouteError,
  emitRoutes,
  hrefUnion,
  routePathFor,
  scanWindows,
  type WindowDef,
} from "./routes.ts";
import type { RouteRow, WindowRow } from "../ir.ts";

let dir: string;

/** Builds a project tree from `path -> contents`, creating directories as needed. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(dir, "p-"));
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
  return root;
}

const PAGE = "export default function P() { return null; }\n";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "dziri-routes-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The path is the route
// ---------------------------------------------------------------------------

test("a file path under pages/ is the route path", () => {
  expect(routePathFor("index.tsx")).toBe("/");
  expect(routePathFor("about.tsx")).toBe("about");
  expect(routePathFor("products.tsx")).toBe("products");
  expect(routePathFor("products/new.tsx")).toBe("products/new");
  expect(routePathFor("products/$id.tsx")).toBe("products/$id");
  expect(routePathFor("docs/get-started.html")).toBe("docs/get-started");
});

test("index names the directory it sits in", () => {
  expect(routePathFor("products/index.tsx")).toBe("products");
  expect(routePathFor("a/b/index.tsx")).toBe("a/b");
  // Only as a basename. A directory called `index` is an ordinary segment.
  expect(routePathFor("index/detail.tsx")).toBe("index/detail");
});

test("the scan produces routes, params and files", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/Header.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/about.tsx": PAGE,
    "windows/main/pages/products.tsx": PAGE,
    "windows/main/pages/products/new.tsx": PAGE,
    "windows/main/pages/products/$id.tsx": PAGE,
  });

  const [main] = scanWindows(root);

  expect(main!.id).toBe("main");
  expect(main!.entry).toBe("windows/main/index.tsx");
  expect(main!.routes.map((r) => r.path)).toEqual([
    "/",
    "about",
    "products",
    "products/new",
    "products/$id",
  ]);

  const byId = main!.routes.find((r) => r.path === "products/$id")!;
  expect(byId.params).toEqual(["id"]);
  expect(byId.segments).toEqual(["products", "$id"]);
  expect(byId.file).toBe("windows/main/pages/products/$id.tsx");

  // A component beside the window entry is not a route: only `pages/` is scanned.
  expect(main!.routes.some((r) => r.file.includes("Header"))).toBe(false);
});

test("multi-parameter and deep routes keep parameter order", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/$org/repos/$name/settings.tsx": PAGE,
  });

  const route = scanWindows(root)[0]!.routes.find((r) => r.params.length > 0)!;
  expect(route.path).toBe("$org/repos/$name/settings");
  expect(route.params).toEqual(["org", "name"]);
});

// ---------------------------------------------------------------------------
// Order and nesting
// ---------------------------------------------------------------------------

test("static segments sort before parameters, so first match wins is static wins", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/products/$id.tsx": PAGE,
    "windows/main/pages/products/new.tsx": PAGE,
    "windows/main/pages/products/$id/edit.tsx": PAGE,
  });

  expect(scanWindows(root)[0]!.routes.map((r) => r.path)).toEqual([
    "/",
    "products/new",
    "products/$id",
    "products/$id/edit",
  ]);
});

test("parent is the longest route whose path is a proper prefix", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/about.tsx": PAGE,
    "windows/main/pages/products.tsx": PAGE,
    "windows/main/pages/products/$id.tsx": PAGE,
    "windows/main/pages/products/$id/edit.tsx": PAGE,
  });

  const routes = scanWindows(root)[0]!.routes;
  const parentOf = (path: string) => {
    const parent = routes.find((r) => r.path === path)!.parent;
    return parent === -1 ? null : routes[parent]!.path;
  };

  expect(parentOf("products/$id/edit")).toBe("products/$id");
  expect(parentOf("products/$id")).toBe("products");
  expect(parentOf("products")).toBe(null);

  // The index route is not a layout: `pages/index.tsx` is the route at "/", and
  // the window's own index.tsx is what wraps everything.
  expect(parentOf("about")).toBe(null);
  expect(parentOf("/")).toBe(null);
});

// ---------------------------------------------------------------------------
// pages/ contains routes and nothing else
// ---------------------------------------------------------------------------

test("a non-route file under pages/ is an error, not something ignored", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/helpers.ts": "export const x = 1;\n",
  });

  expect(() => scanWindows(root)).toThrow(RouteError);
  expect(() => scanWindows(root)).toThrow(/routes and nothing else/);
});

test("a planned extension says so rather than reading as junk", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/guide.mdx": "# hi\n",
  });

  expect(() => scanWindows(root)).toThrow(/planned but not implemented/);
});

test("a colocated test does not quietly become a route", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/about.tsx": PAGE,
    "windows/main/pages/about.test.tsx": PAGE,
  });

  // `extname` takes only the last suffix, so this would otherwise route as
  // "about.test" — in the one directory where writing a test beside the thing it
  // tests is the habit the rest of this repo follows.
  const run = () => scanWindows(root);
  expect(run).toThrow(RouteError);
  expect(run).toThrow(/"about\.test"/);
  expect(run).toThrow(/belong in windows\/main\//);
});

test("dotfiles are skipped, because a .DS_Store is not the author's mistake", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/.DS_Store": "",
  });

  expect(scanWindows(root)[0]!.routes.map((r) => r.path)).toEqual(["/"]);
});

// ---------------------------------------------------------------------------
// Ambiguity is a build error
// ---------------------------------------------------------------------------

test("two files claiming one route name both files", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/products.tsx": PAGE,
    "windows/main/pages/products/index.tsx": PAGE,
  });

  const run = () => scanWindows(root);
  expect(run).toThrow(RouteError);
  expect(run).toThrow(/both claim the route "products"/);
  expect(run).toThrow(/products\/index\.tsx/);
});

test("two routes of the same shape are ambiguous, whatever the parameters are called", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/$id.tsx": PAGE,
    "windows/main/pages/$slug.tsx": PAGE,
  });

  expect(() => scanWindows(root)).toThrow(/have the same shape/);
});

test("a static route and a parameter route of the same depth are not ambiguous", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/new.tsx": PAGE,
    "windows/main/pages/$id.tsx": PAGE,
  });

  expect(scanWindows(root)[0]!.routes.map((r) => r.path)).toEqual(["/", "new", "$id"]);
});

test("a parameter has to be usable as a property name", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/$my-id.tsx": PAGE,
  });

  expect(() => scanWindows(root)).toThrow(/unusable parameter segment/);
});

test("one route cannot bind the same parameter twice", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/$id/$id.tsx": PAGE,
  });

  expect(() => scanWindows(root)).toThrow(/uses the parameter \$id twice/);
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

test("a window folder without index.tsx is not a window", async () => {
  const root = await project({ "windows/main/pages/index.tsx": PAGE });
  expect(() => scanWindows(root)).toThrow(/has no index\.tsx/);
});

test("a window without pages/ has nothing to put in its Outlet", async () => {
  const root = await project({ "windows/main/index.tsx": PAGE });
  expect(() => scanWindows(root)).toThrow(/has no pages\/ directory/);
});

test("no windows/ directory, and an empty one, both say so", async () => {
  const empty = await project({ "app/app.tsx": PAGE });
  expect(() => scanWindows(empty)).toThrow(/no windows\/ directory/);

  const root = await project({ "windows/.keep": "" });
  expect(() => scanWindows(root)).toThrow(/windows\/ is empty/);
});

test("windows are scanned independently and sorted by id", async () => {
  const root = await project({
    "windows/settings/index.tsx": PAGE,
    "windows/settings/pages/index.tsx": PAGE,
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/about.tsx": PAGE,
  });

  const windows = scanWindows(root);
  expect(windows.map((w) => w.id)).toEqual(["main", "settings"]);
  expect(windows[1]!.routes.map((r) => r.path)).toEqual(["/"]);

  // Two windows may hold the same route path; they are separate trees.
  expect(windows[0]!.routes[0]!.path).toBe("/");
  expect(windows[0]!.routes[0]!.window).toBe("main");
  expect(windows[1]!.routes[0]!.window).toBe("settings");
});

// ---------------------------------------------------------------------------
// Codegen
// ---------------------------------------------------------------------------

test("the href union is literals for static routes and ${string} for parameters", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/about.tsx": PAGE,
    "windows/main/pages/products.tsx": PAGE,
    "windows/main/pages/products/new.tsx": PAGE,
    "windows/main/pages/products/$id.tsx": PAGE,
    "windows/main/pages/docs/get-started.tsx": PAGE,
  });

  // In match order, which is the order the scan produces: shallower first, and
  // static before parameter at equal depth.
  expect(hrefUnion(scanWindows(root)[0]!.routes)).toBe(
    '"/" | "about" | "products" | "docs/get-started" | "products/new" | `products/${string}`',
  );
});

test("the generated module round-trips the table it was built from", async () => {
  const root = await project({
    "windows/main/index.tsx": PAGE,
    "windows/main/pages/index.tsx": PAGE,
    "windows/main/pages/products/$id.tsx": PAGE,
    "windows/settings/index.tsx": PAGE,
    "windows/settings/pages/index.tsx": PAGE,
  });

  const windows = scanWindows(root);
  const outPath = join(root, "routes.gen.ts");
  // `typesFrom` only feeds a type-only import, which the loader erases — so the
  // emitted module runs from anywhere, and this asserts the data, not the paths.
  await writeFile(outPath, emitRoutes(windows, { from: "windows", typesFrom: "../src" }));

  const mod = (await import(pathToFileURL(outPath).href)) as {
    routes: readonly RouteRow[];
    windows: readonly WindowRow[];
  };

  expect(mod.routes.map((r) => [r.window, r.path])).toEqual([
    ["main", "/"],
    ["main", "products/$id"],
    ["settings", "/"],
  ]);
  expect(mod.routes[1]!.params).toEqual(["id"]);
  expect(mod.routes[1]!.segments).toEqual(["products", "$id"]);

  expect(mod.windows).toEqual([
    { id: "main", entry: "windows/main/index.tsx", firstRoute: 0, routeCount: 2 },
    { id: "settings", entry: "windows/settings/index.tsx", firstRoute: 2, routeCount: 1 },
  ]);

  // Each window's span covers its own routes and only its own.
  for (const window of mod.windows) {
    const span = mod.routes.slice(window.firstRoute, window.firstRoute + window.routeCount);
    expect(span.every((r) => r.window === window.id)).toBe(true);
  }
});

test("a window with no routes emits `never` rather than an empty union", () => {
  const windows: WindowDef[] = [{ id: "main", entry: "windows/main/index.tsx", routes: [] }];
  expect(hrefUnion([])).toBe("never");
  expect(emitRoutes(windows, { from: "windows", typesFrom: "../src" })).toContain(
    '"main": never;',
  );
});
