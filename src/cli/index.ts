#!/usr/bin/env bun
/**
 * `dziry` — the CLI.
 *
 *   dziry compile [window]     compile every window under ./windows, or one
 *   dziry dev [-- flags]       compile, then run — and keep watching
 *   dziry build                one executable, engine included
 *
 * The project is the working directory: whatever holds `windows/`. That is the
 * whole difference from `bun run window`, which always compiles this repository —
 * and it is why the compiler had to stop taking its own location for the project's.
 *
 * Flags the CLI does not recognise go to the app, which is what makes
 * `dziry dev --route products/new --size 400x600` mean what it looks like. The
 * host's own flags are documented in `host/main.ts` and `host/worker.ts`.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileProject, describe, formatBuildError, ENTRY_FILE } from "../compiler/build.ts";
import { PACKAGE } from "../compiler/compile.ts";
import { buildApp } from "./build.ts";
import type { HotManifestEntry } from "../hot.ts";

const HELP = `dziry — compiled UI on a native engine

usage
  dziry compile [window]        compile every window under ./windows, or just one
  dziry dev [-- app flags]      compile, then run the app — watching for changes:
                                a CSS save swaps styles live, anything else restarts
  dziry build [options]         package the app as one executable

options
  --dump                        compile: also print the IR
  --out <dir>                   build: where the executable goes (default: dist)
  --name <name>                 build: the executable's name (default: the folder's)
  --keep-scratch                build: leave the generated wrapper entry in place
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

  dziry dev --route products/new --size 520x700
`;

const argv = process.argv.slice(2);

/** CLI flags that take the next argument as their value. */
const TAKES_VALUE = new Set(["--out", "--name"]);
/** CLI flags that stand alone. */
const STANDALONE = new Set([
  "--dump",
  "--keep-scratch",
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
 * `dziry dev -- --screenshot out.png` was the original design, and it does not
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
      `  dziry compiles the project in the working directory, and a project is a folder\n` +
      `  with windows/<id>/index.tsx in it. \`bun create dziry my-app\` makes one.`,
  );
  process.exit(1);
}

/** Compile, reporting an author-facing error rather than a stack trace. */
async function compile(only?: string): Promise<void> {
  try {
    const compiled = await compileProject({ projectDir, only, dump: flags.has("--dump") });
    for (const one of compiled) {
      console.log(describe(one, projectDir));
    }
  } catch (e) {
    const message = await formatBuildError(e, projectDir);
    if (message === null) throw e;
    console.error(message);
    process.exit(1);
  }
}

/**
/**
 * The watch half of `dziry dev` (ROADMAP D1).
 *
 * Two children, with different lifetimes. The **compile server** is warm: it
 * loads the compiler and the app's module graph once, and a save re-imports
 * only the changed files and their importers (compiler/module-cache.ts) — a
 * LiveStore app's recompile drops from ~2.8s of module loading to the cascade's
 * own milliseconds. The **app** reads the artifacts from disk; the manifest
 * crosses as a message, so there is no manifest file and no cold compile per
 * save.
 *
 * Per `compiled` message: a CSS-only save whose structural fingerprint is
 * unchanged swaps style values into the running window (state, focus, scroll
 * survive); anything else swaps the app's worker under the live window; a dead
 * channel falls back to a process restart.
 */
async function dev(theirs: string[], only?: string): Promise<void> {
  /** The fingerprints and payloads from the last successful compile. */
  const hot = new Map<string, HotManifestEntry>();

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  /** Resolves when the first successful compile has spawned the app. */
  let firstSpawn!: () => void;
  const firstApp = new Promise<void>((resolve) => {
    firstSpawn = resolve;
  });
  /**
   * Set while a restart is killing the child — the supervisor loop below is the
   * *only* awaiter of `proc.exited`, and this flag is how it tells "killed by a
   * restart, respawn" from "the app quit, exit". Two awaiters was the bug: a
   * resolved promise re-settles instantly, so a second waiter could lap around
   * and re-read the dead process's exit as the live one's (measured: the CLI
   * exited 143 on every restart, having adopted the killed child's code).
   */
  let restarting = false;

  /* A child process rather than an `import()`, so the app gets a clean argv and
     so the CLI's own module graph is not sharing a heap with the running app.
     It also means Ctrl-C reaches the app directly.

     `--preload` rather than a `bunfig.toml` entry in the project. Running from
     source, the app imports `state.ts` and friends for real, so the rewrite has
     to be installed in *this* process — but putting that in the project's bunfig
     would mean a packaged app started from the project directory reads it too,
     and tries to preload the compiler out of an executable that does not contain
     it. Passing it here scopes it to the run that needs it. */
  const spawnApp = (): ReturnType<typeof Bun.spawn> =>
    Bun.spawn(
      // No `run` verb: `bun --preload X run file` is a usage error, because the
      // flag has to belong to the invocation rather than to the subcommand.
      // `bun --preload X file` runs the file with the preload applied.
      [
        "bun",
        "--preload",
        `${PACKAGE}/compiler/reactive-preload.ts`,
        join(projectDir, ENTRY_FILE),
        ...theirs,
      ],
      {
        cwd: projectDir,
        // The `ipc` callback is what opens the IPC channel a hot payload crosses
        // (measured: without it, Subprocess.send throws ERR_IPC_CHANNEL_CLOSED).
        // Incoming: the app asks for a process restart when a reloaded module
        // graph cannot boot — the one failure a worker swap cannot absorb.
        stdio: ["inherit", "inherit", "inherit"],
        ipc(message) {
          if ((message as { t?: unknown } | null)?.t === "restart") void restart();
        },
        env: { ...process.env, DZIRY_HOT: "1" },
      },
    );

  async function restart(): Promise<void> {
    // Flag first, then kill: the supervisor loop owns the respawn.
    restarting = true;
    proc!.kill();
    await proc!.exited;
  }

  function onCompiled(cssOnly: boolean, manifest: Record<string, HotManifestEntry>): void {
    if (proc === null) {
      hot.clear();
      for (const [k, v] of Object.entries(manifest)) hot.set(k, v);
      proc = spawnApp();
      firstSpawn();
      console.log("  watching windows/ — CSS saves swap live, code swaps the worker under it");
      return;
    }

    // One window per process — the one the command line named, or the first.
    const windowIndex = theirs.indexOf("--window");
    const wanted = windowIndex !== -1 ? theirs[windowIndex + 1] : undefined;
    const id = wanted ?? Object.keys(manifest)[0]!;
    const entry = manifest[id];
    const current = hot.get(id);

    if (cssOnly && entry !== undefined && current?.fingerprint === entry.fingerprint) {
      hot.set(id, entry);
      proc.send({ t: "hot", payload: entry.payload });
      console.log("  hot: styles swapped, state kept");
      return;
    }

    hot.clear();
    for (const [k, v] of Object.entries(manifest)) hot.set(k, v);

    /* Stage 2: swap the app thread under the live window. The engine keeps the
       window; the new worker — a fresh module graph over the new artifacts —
       starts with the old one's signals and route. */
    if (proc.exitCode === null) {
      proc.send({ t: "reload" });
      console.log("  reloaded — window stayed open, state carried over");
      return;
    }
    void restart();
  }

  /* The compile server: watches, invalidates, compiles, reports. Its module
     graph stays warm across every save — and across app restarts. */
  const serverPath = new URL("./compile-server.ts", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  /* A failed compile is painted in the window as well as printed here — the red
     box. Tracked so the *next* successful compile clears it: a code fix clears
     by swapping the worker anyway, but a CSS-only fix keeps the worker, and the
     box would otherwise outlive the error it reports. */
  let buildBroken = false;

  const server = Bun.spawn([process.execPath, serverPath, projectDir, ...(only ? [only] : [])], {
    cwd: projectDir,
    stdio: ["inherit", "inherit", "inherit"],
    ipc(message) {
      const m = message as
        | { t: "compiled"; cssOnly: boolean; manifest: Record<string, HotManifestEntry> }
        | { t: "failed"; message: string };
      if (m.t === "compiled") {
        if (buildBroken && proc !== null && proc.exitCode === null) {
          buildBroken = false;
          proc.send({ t: "redbox_clear" });
        }
        onCompiled(m.cssOnly, m.manifest);
      } else if (m.t === "failed") {
        // The server printed the error and the app keeps its last good
        // artifacts; this only puts the same words in front of the author.
        buildBroken = true;
        if (proc !== null && proc.exitCode === null) {
          proc.send({ t: "redbox", title: "Build failed", detail: m.message });
        }
      }
    },
  });

  /* If the server dies before the first compile there is nothing to run; after
     it, the running app keeps its artifacts and saves no longer reload — said
     out loud rather than silently stale. */
  void server.exited.then((code) => {
    if (proc === null) {
      console.error("  the compile server exited before the first compile finished.");
      process.exit(code ?? 1);
    }
    console.error("  the compile server died; the app keeps running but saves no longer reload.");
  });

  // The supervisor: the only place `proc.exited` is awaited, so an exit is
  // attributed to exactly one decision. Waits for the first compile to spawn
  // the app — a project whose first compile fails gets its window the moment
  // the fix lands, without restarting dev.
  await firstApp;
  for (;;) {
    const code = await proc!.exited;
    if (restarting) {
      restarting = false;
      proc = spawnApp();
      console.log("  restarted (the app asked, or the channel was gone)");
      continue;
    }
    server.kill();
    process.exit(code);
  }
}

switch (command) {
  case "compile": {
    await compile(positional[1]);
    break;
  }

  case "dev": {
    await dev(theirs, positional[1]);
    break;
  }

  case "build": {
    try {
      const result = await buildApp({
        projectDir,
        outDir: valueOf("--out"),
        name: valueOf("--name"),
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
