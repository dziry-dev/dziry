#!/usr/bin/env bun
/**
 * `dziri` — the CLI.
 *
 *   dziri compile [window]     compile every window under ./windows, or one
 *   dziri dev [-- flags]       compile, then run
 *   dziri build                one executable, engine included
 *
 * The project is the working directory: whatever holds `windows/`. That is the
 * whole difference from `bun run window`, which always compiles this repository —
 * and it is why the compiler had to stop taking its own location for the project's.
 *
 * Flags the CLI does not recognise go to the app, which is what makes
 * `dziri dev --route products/new --size 400x600` mean what it looks like. The
 * host's own flags are documented in `window-host.ts`.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compileProject,
  describe,
  formatBuildError,
  ENTRY_FILE,
  SINGLE_FILE,
} from "../compiler/build.ts";
import { PACKAGE } from "../compiler/compile.ts";
import { buildApp } from "./build.ts";
import { buildStylesheets } from "./tailwind.ts";

const HELP = `dziri — compiled UI on a native engine

usage
  dziri compile [window]        compile every window under ./windows, or just one
  dziri dev [-- app flags]      compile, then run the app
  dziri build [options]         package the app as one executable

options
  --no-css                      skip the Tailwind step (a window's in.css -> index.css)
  --dump                        compile: also print the IR
  --out <dir>                   build: where the executable goes (default: dist)
  --name <name>                 build: the executable's name (default: the folder's)
  --keep-scratch                build: leave the generated wrapper entry in place
  --single                      dev: run both halves in one thread (the pre-Worker path)
  --console                     build: keep the console window (Windows; needed to see output)
  --no-minify                   build: leave the bundled JavaScript readable
  -h, --help                    this
  -v, --version                 the version

app flags — anything not listed above is passed straight to the app
  --route <path>                start on a route other than the initial one
  --window <id>                 open a window other than the first
  --size WxH                    open at that size
  --min-size WxH|none           lift the engine's minimum window size
  --screenshot <file>           render one frame headlessly and exit
  --stats                       print frame timings

  dziri dev --route products/new --size 520x700
`;

const argv = process.argv.slice(2);

/** CLI flags that take the next argument as their value. */
const TAKES_VALUE = new Set(["--out", "--name"]);
/** CLI flags that stand alone. */
const STANDALONE = new Set([
  "--no-css",
  "--dump",
  "--keep-scratch",
  "--single",
  "--console",
  "--no-minify",
  "-h",
  "--help",
  "-v",
  "--version",
]);

/**
 * Ours versus the app's, decided by recognition rather than by a separator.
 *
 * `dziri dev -- --screenshot out.png` was the original design, and it does not
 * survive contact with `bun run`: a package script written `bun run dev --
 * --screenshot x` arrives here having already lost the `--`, so the app's flag
 * looked like a window name and the compile failed with "no window
 * "scaffold.png"". Recognising our own small set and passing everything else on
 * makes `bun run dev --screenshot x` mean what it reads as. An explicit `--` still
 * works, for anyone who wants to force it.
 */
const explicit = argv.indexOf("--");
const scanned = explicit === -1 ? argv : argv.slice(0, explicit);
const forced = explicit === -1 ? [] : argv.slice(explicit + 1);

const ours: string[] = [];
const theirs: string[] = [...forced];
const positional: string[] = [];

for (let i = 0; i < scanned.length; i++) {
  const arg = scanned[i]!;

  if (TAKES_VALUE.has(arg)) {
    ours.push(arg, scanned[++i] ?? "");
    continue;
  }
  if (STANDALONE.has(arg)) {
    ours.push(arg);
    continue;
  }
  if (arg.startsWith("-")) {
    // Not ours, so it is the app's — with its value, if it has one.
    theirs.push(arg);
    if (scanned[i + 1] !== undefined && !scanned[i + 1]!.startsWith("-")) theirs.push(scanned[++i]!);
    continue;
  }
  positional.push(arg);
}

const flags = new Set(ours.filter((a) => a.startsWith("-")));
const valueOf = (name: string): string | undefined => {
  const i = ours.indexOf(name);
  return i !== -1 ? ours[i + 1] : undefined;
};

const command = positional[0];

if (flags.has("-h") || flags.has("--help") || command === undefined) {
  console.log(HELP);
  process.exit(command === undefined && !flags.has("-h") && !flags.has("--help") ? 1 : 0);
}

if (flags.has("-v") || flags.has("--version")) {
  const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
    version: string;
  };
  console.log(pkg.version);
  process.exit(0);
}

const projectDir = resolve(process.cwd());

if (!existsSync(join(projectDir, "windows"))) {
  console.error(
    `  error: no ./windows directory here.\n` +
      `  dziri compiles the project in the working directory, and a project is a folder\n` +
      `  with windows/<id>/index.tsx in it. \`bun create dziri my-app\` makes one.`,
  );
  process.exit(1);
}

/** Compile, reporting an author-facing error rather than a stack trace. */
async function compile(only?: string): Promise<void> {
  if (!flags.has("--no-css")) {
    for (const css of await buildStylesheets(projectDir)) {
      console.log(`  css   ${css.from} -> ${css.to}`);
    }
  }

  try {
    for (const one of await compileProject({ projectDir, only, dump: flags.has("--dump") })) {
      console.log(describe(one, projectDir));
    }
  } catch (e) {
    const message = await formatBuildError(e, projectDir);
    if (message === null) throw e;
    console.error(message);
    process.exit(1);
  }
}

switch (command) {
  case "compile": {
    await compile(positional[1]);
    break;
  }

  case "dev": {
    await compile(positional[1]);

    /* A child process rather than an `import()`, so the app gets a clean argv and
       so the CLI's own module graph — the compiler, oxc, Tailwind — is not sharing
       a heap with the running app. It also means Ctrl-C reaches the app directly.

       `--preload` rather than a `bunfig.toml` entry in the project. Running from
       source, the app imports `state.ts` and friends for real, so the rewrite has
       to be installed in *this* process — but putting that in the project's bunfig
       would mean a packaged app started from the project directory reads it too,
       and tries to preload the compiler out of an executable that does not contain
       it. Passing it here scopes it to the run that needs it. */
    const proc = Bun.spawn(
      // No `run` verb: `bun --preload X run file` is a usage error, because the
      // flag has to belong to the invocation rather than to the subcommand.
      // `bun --preload X file` runs the file with the preload applied.
      [
        "bun",
        "--preload",
        `${PACKAGE}/compiler/reactive-preload.ts`,
        join(projectDir, flags.has("--single") ? SINGLE_FILE : ENTRY_FILE),
        ...theirs,
      ],
      { cwd: projectDir, stdio: ["inherit", "inherit", "inherit"] },
    );
    process.exit(await proc.exited);
  }

  case "build": {
    try {
      const result = await buildApp({
        projectDir,
        outDir: valueOf("--out"),
        name: valueOf("--name"),
        noCss: flags.has("--no-css"),
        keepScratch: flags.has("--keep-scratch"),
        console: flags.has("--console"),
        noMinify: flags.has("--no-minify"),
      });

      const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;
      console.log(
        `\nbuilt ${result.outFile}\n` +
          `  ${mb(result.bytes)} total — ${mb(result.engineBytes)} engine, ` +
          `${mb(result.bytes - result.engineBytes)} Bun runtime and app\n` +
          `  engine ${result.engineHash}, unpacked to a user cache on first run\n` +
          `  ${(result.elapsed / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      const message = await formatBuildError(e, projectDir);
      if (message !== null) {
        console.error(message);
        process.exit(1);
      }
      /* Bun's bundler throws an `AggregateError` whose `message` is only
         "Bundle failed" — every useful word is in `errors`. Printing the message
         alone once cost a debugging round trip. */
      const errors = (e as { errors?: unknown[] }).errors;
      console.error(`  error: ${e instanceof Error ? e.message : String(e)}`);
      if (Array.isArray(errors)) for (const one of errors) console.error(`    ${String(one)}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.error(`  error: no command "${command}".\n`);
    console.log(HELP);
    process.exit(1);
}
