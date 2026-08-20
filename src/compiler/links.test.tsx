/**
 * `<a href>` — checked against the route table, wired to the route signal.
 *
 * Three layers, cheapest first: `matchHref` as a truth table, `auditLinks` over
 * hand-built trees for each refusal it promises to make by name, and one real
 * `compileProject` over a temp fixture proving the synthesized handler reaches
 * the artifact — and that a dead link stops the build rather than shipping as a
 * click that silently does nothing.
 */
import { expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { matchHref, type Route } from "./routes.ts";
import { auditLinks, compileProject, BuildError } from "./build.ts";
import type { Element, Node } from "./html.ts";

// ---------------------------------------------------------------------------
// matchHref

/** Routes in match order, as `scanWindows` would sort them: static before param. */
const route = (path: string): Route => ({
  window: "main",
  path,
  file: `${path === "/" ? "index" : path}.tsx`,
  segments: path === "/" ? [] : path.split("/"),
  params: path === "/" ? [] : path.split("/").filter((s) => s.startsWith("$")).map((s) => s.slice(1)),
  parent: -1,
});

const TABLE = [route("/"), route("layout"), route("products"), route("products/new"), route("products/$id")];

test("matchHref: the root, a static path, and a param path all resolve", () => {
  expect(matchHref(TABLE, "/")?.path).toBe("/");
  expect(matchHref(TABLE, "layout")?.path).toBe("layout");
  expect(matchHref(TABLE, "products/17")?.path).toBe("products/$id");
});

test("matchHref: static beats param, because the table's order already says so", () => {
  expect(matchHref(TABLE, "products/new")?.path).toBe("products/new");
});

test("matchHref: shape misses are misses — this is the check TypeScript cannot make", () => {
  // `products/${string}` in the Href union accepts all three of these.
  expect(matchHref(TABLE, "products/")).toBeNull(); // an empty param segment
  expect(matchHref(TABLE, "products/1/x")).toBeNull(); // too deep
  expect(matchHref(TABLE, "prodcuts/1")).toBeNull(); // the typo the union also catches
});

// ---------------------------------------------------------------------------
// auditLinks

/** A dynlist wrapper around a template, shaped like the compiler's own node. */
const dynlist = (template: Node): Node =>
  ({ type: "dynlist", template, source: null, key: null }) as unknown as Node;

const asElement = (node: unknown): Element => node as Element;

test("auditLinks: a good link is collected, a dead one is refused with the table in hand", () => {
  const root = asElement(
    <div>
      <a href="layout">fine</a>
      <a href="nowhere">dead</a>
    </div>,
  );
  const { links, errors } = auditLinks(root, TABLE);
  expect(links.map((l) => l.href)).toEqual(["layout"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(`"nowhere" is not a route`);
  expect(errors[0]).toContain("products/$id");
});

test("auditLinks: an interpolated href is refused by name, not half-checked", () => {
  const root = asElement(<a href={"products/\0dziri:param\0id\0dziri:param\0"}>x</a>);
  const { links, errors } = auditLinks(root, TABLE);
  expect(links).toHaveLength(0);
  expect(errors[0]).toContain("interpolates a recorded value");
});

test("auditLinks: a template link needs an authored onClick; with one it passes", () => {
  const bare = asElement(<div>{dynlist(asElement(<a href="layout">row</a>))}</div>);
  expect(auditLinks(bare, TABLE).errors[0]).toContain("inside a list template");

  const handled = asElement(<a href="layout">row</a>);
  handled.onClick = () => {};
  const ok = auditLinks(asElement(<div>{dynlist(handled)}</div>), TABLE);
  expect(ok.errors).toHaveLength(0);
  expect(ok.links[0]).toMatchObject({ href: "layout", inTemplate: true });
});

test("auditLinks: a window with no routes says so instead of listing nothing", () => {
  const { errors } = auditLinks(asElement(<a href="anything">x</a>), []);
  expect(errors[0]).toContain("(this window has no routes)");
});

// ---------------------------------------------------------------------------
// The artifact, end to end

const REPO = resolve(import.meta.dir, "../..");
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // OS temp dir; a straggler is litter, not state.
    }
  }
});

function project(pageBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dziri-links-"));
  fixtures.push(dir);
  const mainDir = join(dir, "windows", "main");
  mkdirSync(join(mainDir, "pages"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(REPO, join(dir, "node_modules", "dziri"), "junction");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "links-e2e", type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "dziri" },
      include: ["windows"],
    }),
  );
  writeFileSync(
    join(mainDir, "state.ts"),
    `import { signal } from "dziri";\nexport const route = signal("/");\n`,
  );
  writeFileSync(
    join(mainDir, "index.tsx"),
    `import { Outlet, Window } from "dziri";
import { route } from "./state.ts";
export default function Main() {
  return (
    <Window title="links" route={route}>
      <Outlet />
    </Window>
  );
}
`,
  );
  writeFileSync(
    join(mainDir, "pages", "index.tsx"),
    `export default function Home() {\n  return ${pageBody};\n}\n`,
  );
  writeFileSync(
    join(mainDir, "pages", "about.tsx"),
    `export default function About() {\n  return <div>about</div>;\n}\n`,
  );
  return dir;
}

test("a checked link compiles to a click handler that writes the route signal", async () => {
  const dir = project(`<div><a href="about">go</a></div>`);
  await compileProject({ projectDir: dir, hot: new Map() });
  const artifact = readFileSync(join(dir, "windows", "main", "ui.gen.ts"), "utf8");
  expect(artifact).toContain(`() => route.set("about")`);
  expect(artifact).toMatch(/kind: "click",\s+fn: \(\) => route\.set\("about"\)/);
});

test("an authored onClick wins: no handler is synthesized next to it", async () => {
  const dir = project(`<div><a href="about" onClick={goMyWay}>go</a></div>`);
  writeFileSync(
    join(dir, "windows", "main", "pages", "index.tsx"),
    `export const goMyWay = () => {};\nexport default function Home() {\n  return <div><a href="about" onClick={goMyWay}>go</a></div>;\n}\n`,
  );
  await compileProject({ projectDir: dir, hot: new Map() });
  const artifact = readFileSync(join(dir, "windows", "main", "ui.gen.ts"), "utf8");
  expect(artifact).not.toContain(`route.set("about")`);
});

test("a dead link fails the build, naming the path and the table", async () => {
  const dir = project(`<div><a href="abuot">typo</a></div>`);
  expect(compileProject({ projectDir: dir, hot: new Map() })).rejects.toThrow(BuildError);
  await compileProject({ projectDir: dir, hot: new Map() }).catch((e: Error) => {
    expect(e.message).toContain(`"abuot" is not a route`);
    expect(e.message).toContain("about");
  });
});
