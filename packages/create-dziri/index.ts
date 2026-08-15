#!/usr/bin/env bun
/**
 * `bun create dziri my-app` — a new project, from the demo this framework is
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
 * The window sources are copied from `windows/` by `scripts/template-sync.ts`
 * rather than maintained here, and `bun run template:check` fails if the two have
 * drifted.
 */
import { Glob } from "bun";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const HELP = `create-dziri — scaffold a dziri app

usage
  bun create dziri <directory>

options
  --local <path>     depend on a dziri checkout instead of the published package
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
const noInstall = argv.includes("--no-install");

const positional = argv.filter(
  (a, i) => !a.startsWith("-") && argv[i - 1] !== "--local",
);

const target = resolve(positional[0] ?? "my-dziri-app");
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
  return cleaned || "dziri-app";
}

if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(
    `  error: ${relative(process.cwd(), target) || target} already exists and is not empty.`,
  );
  process.exit(1);
}

const TEMPLATE = new URL("./template", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);

if (!existsSync(TEMPLATE)) {
  console.error(
    `  error: this copy of create-dziri has no template directory.\n` +
      `  Expected it at ${TEMPLATE}. In a checkout, run \`bun run template:sync\`.`,
  );
  process.exit(1);
}

/**
 * What `dziri` the scaffolded project should depend on.
 *
 * `--local` points at a checkout, which is how this is tested and how anyone
 * working on the framework tries a change against a fresh app. Bun resolves
 * `file:` against the project directory, so the path has to be made relative to
 * the *target*, not to the caller's cwd.
 */
function dependency(): string {
  if (local === undefined) return "^0.0.0";

  const from = resolve(local);
  if (!existsSync(join(from, "package.json"))) {
    console.error(`  error: --local ${local} has no package.json`);
    process.exit(1);
  }
  return `file:${relative(target, from).replaceAll("\\", "/")}`;
}

const substitutions: Record<string, string> = {
  "{{name}}": packageName(name),
  "{{dziri}}": dependency(),
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
