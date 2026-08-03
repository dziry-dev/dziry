/**
 * CLI for the route scan.
 *
 *   bun run routes                       # scan ./windows -> windows/routes.gen.ts
 *   bun run routes --list                # print the table instead of writing it
 *   bun run routes some/project -o out.ts
 *
 * Separate from `bun run compile` for now because it is the half that does not
 * need the tree: the route table, the `Href` union and the parameter types are all
 * derived from file paths, so this runs and is checkable before a single page has
 * been compiled into nodes.
 */
import { join, relative, resolve } from "node:path";
import { RouteError, scanWindows, emitRoutes } from "./compiler/routes.ts";
import { PACKAGE } from "./compiler/compile.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);

const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--") && a !== "-o");

const projectDir = resolve(positional[0] ?? ROOT);

const outIndex = argv.indexOf("-o");
const outPath =
  outIndex !== -1 && argv[outIndex + 1]
    ? resolve(argv[outIndex + 1]!)
    : join(projectDir, "windows", "routes.gen.ts");

/**
 * Paths are reported relative to the project, not to this compiler.
 *
 * Everything the scan touches lives under `projectDir`, and for the ordinary case
 * — the project *is* the repo — the two are the same. They diverge when a project
 * elsewhere is scanned, and then `windows/main/index.tsx` is the useful name for a
 * file rather than a climb out of one tree and into another.
 */
const rel = (p: string) => relative(projectDir, p).replaceAll("\\", "/") || ".";

let windows;
try {
  windows = scanWindows(projectDir);
} catch (e) {
  // A `RouteError` is the author's problem, and every one of them names a file.
  // Printing a Bun stack trace over it would bury that under frames from this
  // compiler, which is not where the mistake is.
  if (e instanceof RouteError) {
    console.error(`  error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const flat = windows.flatMap((w) => w.routes);

if (flags.has("--list")) {
  for (const window of windows) {
    console.log(`${window.id}  (${rel(join(projectDir, window.entry))})`);
    for (const route of window.routes) {
      const parent = route.parent === -1 ? "" : `  in ${flat[route.parent]!.path}`;
      const params = route.params.length > 0 ? `  {${route.params.join(", ")}}` : "";
      console.log(`  ${route.path.padEnd(28)}${route.file}${params}${parent}`);
    }
  }
  process.exit(0);
}

/**
 * The package name, not a path relative to the output.
 *
 * `compileProject` writes this same file on every compile, and a relative `../src`
 * only resolves in *this* repository — in a scaffolded project there is no `src/` to
 * point at. Both writers naming the package means running this after a compile
 * rewrites the file identically instead of quietly making it unresolvable.
 */
const source = emitRoutes(windows, {
  from: rel(join(projectDir, "windows")),
  typesFrom: PACKAGE,
});

await Bun.write(outPath, source);

console.log(
  `scanned ${rel(join(projectDir, "windows"))} -> ${rel(outPath)}\n` +
    `  ${windows.length} window(s), ${flat.length} route(s), ` +
    `${flat.filter((r) => r.params.length > 0).length} with parameters`,
);
