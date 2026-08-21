#!/usr/bin/env bun
/**
 * `bun create dziry my-app` — a new project, from the demo this framework is
 * developed against.
 *
 * The template is not a reduced "hello window". It is the same window the
 * framework's own goldens render: eleven routes covering Tailwind utilities,
 * conditional classes compiled to style-table patches, a keyed list in an arena,
 * component-local state, and nested routing. That is deliberate — a starter that
 * exercises one feature teaches nothing about the ones that have sharp edges, and
 * the sharp edges here (signals must be module-level exports; CSS resolves at build
 * time) are exactly what a new project trips over.
 *
 * The demo template's window sources are copied from `windows/` by
 * `scripts/template-sync.ts` rather than maintained here, and `bun run
 * template:check` fails if the two have drifted. Other templates — `todo`
 * (LiveStore + Effect), `todo-drizzle` (Drizzle over bun:sqlite, routes,
 * themes) — are authored: they are apps, not mirrors of this repository's demo.
 */
import { Glob } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const HELP = `create-dziry — scaffold a dziry app

usage
  bun create dziry <directory>

options
  --template <name>  which template (default: demo)
                       demo   the framework's own demo — every route is one
                              family of CSS or one feature, derived from the
                              repo it develops against
                       todo   a small real app — Tailwind, a LiveStore store
                              on disk, held in an Effect layer
  --local <path>     depend on a dziry checkout instead of the published package
  --no-install       write the files and stop
  -h, --help         this
`;

const argv = process.argv.slice(2);

if (argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const valueOf = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const local = valueOf("--local");
// `--local` with nothing after it (or the next flag after it) silently fell back to
// the published `dziry@^0.0.0`, which 404s and reads as a broken checkout. Say so.
if (argv.includes("--local") && (local === undefined || local.startsWith("-"))) {
  console.error(
    `  error: --local takes a path to a dziry checkout, e.g. --local .\n` +
      `  Point it at a checkout with a package.json so the scaffold depends on\n` +
      `  file:... rather than the published dziry.`,
  );
  process.exit(1);
}
const noInstall = argv.includes("--no-install");
const template = valueOf("--template") ?? "demo";

const positional = argv.filter(
  (a, i) => !a.startsWith("-") && argv[i - 1] !== "--local" && argv[i - 1] !== "--template",
);

const target = resolve(positional[0] ?? "my-dziry-app");
const name = basename(target);

/**
 * A directory name npm and Bun will both accept as a package name.
 *
 * Not cosmetic: `bun install` refuses a manifest whose `name` has a capital or a
 * space, and the failure arrives after the files are already written.
 */
function packageName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return cleaned || "dziry-app";
}

if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(
    `  error: ${relative(process.cwd(), target) || target} already exists and is not empty.`,
  );
  process.exit(1);
}

const TEMPLATES = new URL("./templates", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const TEMPLATE = join(TEMPLATES, template);

if (!existsSync(TEMPLATE)) {
  const known = existsSync(TEMPLATES)
    ? readdirSync(TEMPLATES).filter((d) => existsSync(join(TEMPLATES, d, "package.json")))
    : [];
  console.error(
    known.length
      ? `  error: no template "${template}". Available: ${known.join(", ")}.`
      : `  error: this copy of create-dziry has no templates directory.\n` +
          `  Expected it at ${TEMPLATES}. In a checkout, run \`bun run template:sync\`.`,
  );
  process.exit(1);
}

/**
 * What `dziry` the scaffolded project should depend on.
 *
 * `--local` points at a checkout. In Bun, `link:` links a *globally-linked*
 * package by name — not a path — so the checkout is `bun link`ed first (see the
 * install step below), and this returns that name. A link rather than a copy is
 * required: the engine is found at `../../native-src/...` relative to src/, which
 * only a symlink into the checkout preserves.
 */
function dependency(): string {
  if (local === undefined) return "^0.0.0";

  const from = resolve(local);
  const pkgPath = join(from, "package.json");
  if (!existsSync(pkgPath)) {
    console.error(`  error: --local ${local} has no package.json`);
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
  if (typeof pkg.name !== "string" || pkg.name === "") {
    console.error(`  error: --local ${local} has no package name`);
    process.exit(1);
  }
  return `link:${pkg.name}`;
}

const substitutions: Record<string, string> = {
  "{{name}}": packageName(name),
  "{{dziry}}": dependency(),
};

/**
 * `_gitignore`, not `.gitignore`.
 *
 * npm silently renames a `.gitignore` inside a published package to `.npmignore`,
 * so a template shipping one arrives without it. Every scaffolder works around this
 * the same way.
 */
const RENAMES: Record<string, string> = { _gitignore: ".gitignore" };

let written = 0;

for await (const entry of new Glob("**/*").scan({ cwd: TEMPLATE, onlyFiles: true, dot: true })) {
  const rel = entry.replaceAll("\\", "/");
  const source = await Bun.file(join(TEMPLATE, rel)).text();

  let contents = source;
  for (const [token, value] of Object.entries(substitutions)) {
    contents = contents.replaceAll(token, value);
  }

  const parts = rel.split("/");
  const last = parts[parts.length - 1]!;
  parts[parts.length - 1] = RENAMES[last] ?? last;

  const dest = join(target, ...parts);
  mkdirSync(dirname(dest), { recursive: true });
  await Bun.write(dest, contents);
  written++;
}

const shown = relative(process.cwd(), target) || ".";
console.log(`created ${shown} — ${written} files`);

if (!noInstall) {
  // `link:` resolves a globally-linked package by name, so register the checkout
  // first: `bun link` in the checkout maps its package name to its directory.
  if (local !== undefined) {
    const link = Bun.spawn(["bun", "link"], {
      cwd: resolve(local),
      stdio: ["inherit", "inherit", "inherit"],
    });
    if ((await link.exited) !== 0) {
      console.error(`\n  bun link failed in ${resolve(local)}.`);
      process.exit(1);
    }
  }

  const proc = Bun.spawn(["bun", "install"], {
    cwd: target,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n  bun install failed (exit ${code}). The files are written; try again in ${shown}.`);
    process.exit(code);
  }

  /* The first compile, here rather than left for `bun run dev`: the `*.gen.ts`
     files do not ship (they would be someone else's stale IR), but router.ts
     imports one — so until a compile has run, `bun run check` fails on a fresh
     project that is not actually broken. Failure is reported but not fatal: the
     project is written and installed, and `bun run dev` compiles again anyway. */
  const compile = Bun.spawn(["bun", "run", "compile"], {
    cwd: target,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if ((await compile.exited) !== 0) {
    console.error(`\n  the first compile failed — the project is written; \`bun run dev\` will retry.`);
  }
}

console.log(
  `\nnext\n` +
    (shown === "." ? "" : `  cd ${shown}\n`) +
    (noInstall ? `  bun install\n` : "") +
    `  bun run dev      compile and open the window\n` +
    `  bun run build    one executable in dist/\n`,
);
