#!/usr/bin/env bun
/**
 * `dziri` — the CLI.
 *
 *   dziri compile [window]     compile every window under ./windows, or one
 *   dziri dev [-- flags]       compile, then run — and keep watching
 *   dziri build                one executable, engine included
 *
 * The project is the working directory: whatever holds `windows/`. That is the
 * whole difference from `bun run window`, which always compiles this repository —
 * and it is why the compiler had to stop taking its own location for the project's.
 *
 * Flags the CLI does not recognise go to the app, which is what makes
 * `dziri dev --route products/new --size 400x600` mean what it looks like. The
 * host's own flags are documented in `host/main.ts` and `host/worker.ts`.
 */
import { existsSync, mkdirSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compileProject, describe, formatBuildError, ENTRY_FILE } from "../compiler/build.ts";
import { PACKAGE } from "../compiler/compile.ts";
import { buildApp } from "./build.ts";
import type { HotManifest, HotManifestEntry, HotPayload } from "../hot.ts";

const HELP = `dziri — compiled UI on a native engine

usage
  dziri compile [window]        compile every window under ./windows, or just one
  dziri dev [-- app flags]      compile, then run the app — watching for changes:
                                a CSS save swaps styles live, anything else restarts
  dziri build [options]         package the app as one executable

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

  dziri dev --route products/new --size 520x700
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
  try {
    // DZIRI_HOT_MANIFEST is set by the dev watcher's subprocess compiles: collect
    // each window's fingerprint and style payload and write them there, so the
    // watcher (a different process, by module-cache necessity) can read them.
    const manifestPath = process.env.DZIRI_HOT_MANIFEST;
    const hot = manifestPath ? new Map<string, HotManifestEntry>() : undefined;
    const compiled = await compileProject({ projectDir, only, dump: flags.has("--dump"), hot });
    for (const one of compiled) {
      console.log(describe(one, projectDir));
    }
    if (manifestPath && hot) {
      mkdirSync(dirname(manifestPath), { recursive: true });
      // Typed arrays do not survive JSON — they become {"0": …} objects — so they
      // are written as plain arrays. The worker's `.set()` accepts ArrayLike, and
      // the IPC leg re-constitutes nothing: arrays cross structured clone as-is.
      await Bun.write(
        manifestPath,
        JSON.stringify(Object.fromEntries(hot), (_key, value: unknown) =>
          ArrayBuffer.isView(value) && !(value instanceof DataView)
            ? Array.from(value as unknown as ArrayLike<number>)
            : value,
        ),
      );
    }
  } catch (e) {
    const message = await formatBuildError(e, projectDir);
    if (message === null) throw e;
    console.error(message);
    process.exit(1);
  }
}

/**
 * Where a watched compile's manifest goes. A file rather than the return value,
 * because the watched compile runs in a *subprocess* — Bun caches modules
 * in-process, and a recompile in this one would read the app modules the first
 * compile already loaded. See src/hot.ts for the format.
 */
const HOT_DIR = join(projectDir, "node_modules", ".cache", "dziri");
const HOT_MANIFEST = join(HOT_DIR, "hot.json");

/**
 * One watched compile. In-process when `hot` is passed (the first compile —
 * nothing is cached yet), a subprocess on every later one.
 */
async function compileWatched(only?: string, hot?: Map<string, HotManifestEntry>): Promise<boolean> {
  if (hot !== undefined) {
    try {
      for (const one of await compileProject({ projectDir, only, hot })) {
        console.log(describe(one, projectDir));
      }
      return true;
    } catch (e) {
      const message = await formatBuildError(e, projectDir);
      console.error(message ?? `  error: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  mkdirSync(HOT_DIR, { recursive: true });
  const proc = Bun.spawn(
    [process.execPath, process.argv[1]!, "compile", ...(only ? [only] : [])],
    {
      cwd: projectDir,
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, DZIRI_HOT_MANIFEST: HOT_MANIFEST },
    },
  );
  return (await proc.exited) === 0;
}

/**
 * The watch half of `dziri dev` (ROADMAP D1, stages 1 and the fallback for 2–3).
 *
 * A `.css`-only save tries stage 1: recompile, compare the structural
 * fingerprint, and if nothing but style values moved, ship the new numbers to
 * the running app over IPC — state, focus and scroll survive. Any other change
 * (markup, handlers, a rule that mints a new interned style row) restarts the
 * app: a compile is ~30 ms, so the fallback is a blink, not a build.
 */
async function dev(theirs: string[], only?: string): Promise<void> {
  /** The fingerprints and payloads from the last successful compile. */
  const hot = new Map<string, HotManifestEntry>();

  if (!(await compileWatched(only, hot))) process.exit(1);

  /* A child process rather than an `import()`, so the app gets a clean argv and
     so the CLI's own module graph — the compiler, oxc, Tailwind — is not sharing
     a heap with the running app. It also means Ctrl-C reaches the app directly.

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
        stdio: ["inherit", "inherit", "inherit"],
        ipc() {},
        env: { ...process.env, DZIRI_HOT: "1" },
      },
    );

  let proc = spawnApp();
  /**
   * Set while a reload is killing the child — the supervisor loop below is the
   * *only* awaiter of `proc.exited`, and this flag is how it tells "killed by a
   * reload, respawn" from "the app quit, exit". Two awaiters was the bug: a
   * resolved promise re-settles instantly, so a second waiter could lap around
   * and re-read the dead process's exit as the live one's (measured: the CLI
   * exited 143 on every restart, having adopted the killed child's code).
   */
  let restarting = false;

  /** The windows/ tree, watched. Generated files are ignored — we wrote those. */
  const pending = new Map<string, NodeJS.Timeout>();
  const isSource = (f: string) =>
    /\.(css|tsx?|jsx?)$/.test(f) && !f.endsWith(".gen.ts") && !f.endsWith(".gen.tsx");

  const onChanged = (files: Set<string>): void => {
    const cssOnly = [...files].every((f) => f.endsWith(".css"));
    void reload(cssOnly);
  };

  let reloading = false;
  let queuedCssOnly: boolean | null = null;

  async function reload(cssOnly: boolean): Promise<void> {
    // One reload at a time; a save landing mid-reload is queued, and its
    // classification wins conservatively (any code change makes it a restart).
    if (reloading) {
      queuedCssOnly = queuedCssOnly === null ? cssOnly : queuedCssOnly && cssOnly;
      return;
    }
    reloading = true;
    try {
      if (!(await compileWatched(only))) return;

      let manifest: HotManifest;
      try {
        manifest = (await Bun.file(HOT_MANIFEST).json()) as HotManifest;
      } catch {
        console.error("  hot reload: the watched compile wrote no manifest; restarting.");
        await restart();
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
        proc.send({ t: "hot", payload: entry.payload } satisfies { t: "hot"; payload: HotPayload });
        console.log("  hot: styles swapped, state kept");
        return;
      }

      hot.clear();
      for (const [k, v] of Object.entries(manifest)) hot.set(k, v);
      await restart();
    } finally {
      reloading = false;
      if (queuedCssOnly !== null) {
        const next = queuedCssOnly;
        queuedCssOnly = null;
        await reload(next);
      }
    }
  }

  async function restart(): Promise<void> {
    // Flag first, then kill: the supervisor loop owns the respawn.
    restarting = true;
    proc.kill();
    await proc.exited;
  }

  const watchers: FSWatcher[] = [];
  const watchDir = (dir: string, recursive: boolean): void => {
    try {
      const w = watch(dir, { recursive }, (_event, file) => {
        if (file === null || !isSource(file)) return;
        const existing = pending.get(file);
        if (existing) clearTimeout(existing);
        pending.set(
          file,
          setTimeout(() => {
            const files = new Set(pending.keys());
            pending.clear();
            onChanged(files);
          }, 60),
        );
      });
      watchers.push(w);
    } catch {
      // A directory that vanishes mid-watch (a deleted window) is not fatal.
    }
  };

  // fs.watch's recursive mode works on Windows and macOS. On Linux it throws,
  // so each directory under windows/ gets its own watcher instead.
  try {
    watchDir(join(projectDir, "windows"), true);
  } catch {
    const walk = (dir: string): void => {
      watchDir(dir, false);
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
      }
    };
    walk(join(projectDir, "windows"));
  }
  console.log("  watching windows/ — CSS saves swap live, everything else restarts");

  // The supervisor: the only place `proc.exited` is awaited, so an exit is
  // attributed to exactly one decision.
  while (true) {
    const code = await proc.exited;
    if (restarting) {
      restarting = false;
      proc = spawnApp();
      console.log("  restarted (structure changed)");
      continue;
    }
    for (const w of watchers) w.close();
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
