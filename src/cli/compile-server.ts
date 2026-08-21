#!/usr/bin/env bun
/**
 * `dziri dev`'s warm compiler — a persistent process, because the alternative
 * was the bottleneck.
 *
 * A dev compile imports the app's modules to evaluate its components, and a
 * cold process pays for the whole module graph every time: measured in a small
 * LiveStore app, 1.9s of a 2.8s compile was `effect` + `@livestore/livestore`
 * module loading alone, while the cascade took 29ms. None of that graph changes
 * between two saves. This process loads it once and re-imports only what the
 * watcher reports changed, plus whatever imports those (module-cache.ts).
 *
 * The watcher lives here rather than in the CLI because invalidation has to
 * know the changed set the moment it is known — a manifest through the CLI
 * would be a round trip for a fact this process needs first.
 *
 * Protocol with the CLI, over the spawn IPC channel:
 *
 *   → { t: "compiled", cssOnly, manifest }   a compile landed; the manifest's
 *   → { t: "failed" }                        fingerprints decide hot vs reload
 *
 * The compile's own log lines print directly (stdio is inherited); a failure's
 * author-facing message too. `failed` is only a marker so the CLI knows the
 * running app is now behind the sources on purpose.
 */
import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { compileProject, describe, formatBuildError } from "../compiler/build.ts";
import { installInvalidation, invalidate } from "../compiler/module-cache.ts";
import type { HotManifestEntry } from "../hot.ts";

// Before anything imports a window module: a module cached under its plain
// path can never be version-busted without leaving a split graph behind.
installInvalidation();

const projectDir = resolve(process.argv[2] ?? process.cwd());
const only = process.argv[3];

const sendRaw = (process as unknown as { send?: (m: unknown) => void }).send;
if (!sendRaw) {
  console.error("  the compile server is spawned by `dziri dev` — it needs its IPC channel.");
  process.exit(1);
}
const send: (m: unknown) => void = (m) => sendRaw.call(process, m);

type Compiled = { t: "compiled"; cssOnly: boolean; manifest: Record<string, HotManifestEntry> };
/** `message` is the formatted, author-facing error — what the terminal shows,
 *  carried along so the CLI can put the same words in the window's red box. */
type Failed = { t: "failed"; message: string };

let compiling = false;
let pending: { files: Set<string>; cssOnly: boolean } | null = null;

async function compile(changed: readonly string[], cssOnly: boolean): Promise<void> {
  if (compiling) {
    // Coalesce, conservatively: a code change in the queue makes it not-css-only.
    if (pending === null) pending = { files: new Set(), cssOnly };
    else pending.cssOnly = pending.cssOnly && cssOnly;
    for (const f of changed) pending.files.add(f);
    return;
  }
  compiling = true;
  try {
    invalidate(changed);
    const hot = new Map<string, HotManifestEntry>();
    try {
      for (const one of await compileProject({ projectDir, only, hot })) {
        console.log(describe(one, projectDir));
      }
      send({ t: "compiled", cssOnly, manifest: Object.fromEntries(hot) } satisfies Compiled);
    } catch (e) {
      const message =
        (await formatBuildError(e, projectDir)) ??
        `  error: ${e instanceof Error ? e.message : String(e)}`;
      console.error(message);
      send({ t: "failed", message } satisfies Failed);
    }
  } finally {
    compiling = false;
    if (pending !== null) {
      const next = pending;
      pending = null;
      await compile([...next.files], next.cssOnly);
    }
  }
}

// --- the watcher ---------------------------------------------------------------
//
// Same rules as the CLI's old watcher: source files only, `*.gen.ts` is ours,
// and Windows reports one save as several events, so dedupe on mtime — the
// extras would each buy a full recompile of the same bytes.

const pendingEvents = new Map<string, NodeJS.Timeout>();
const handled = new Map<string, number>();

const isSource = (f: string) =>
  /\.(css|tsx?|jsx?)$/.test(f) && !f.endsWith(".gen.ts") && !f.endsWith(".gen.tsx");

const onChanged = (files: Set<string>): void => {
  const fresh = [...files].filter((f) => {
    try {
      const m = statSync(join(projectDir, "windows", f)).mtimeMs;
      if (handled.get(f) === m) return false;
      handled.set(f, m);
      return true;
    } catch {
      return false; // deleted between event and stat
    }
  });
  if (fresh.length === 0) return;
  void compile(
    fresh.map((f) => join(projectDir, "windows", f)),
    fresh.every((f) => f.endsWith(".css")),
  );
};

const watchers: FSWatcher[] = [];
const watchDir = (dir: string, recursive: boolean): void => {
  try {
    watchers.push(
      watch(dir, { recursive }, (_event, file) => {
        if (file === null || !isSource(file)) return;
        const existing = pendingEvents.get(file);
        if (existing) clearTimeout(existing);
        pendingEvents.set(
          file,
          setTimeout(() => {
            const files = new Set(pendingEvents.keys());
            pendingEvents.clear();
            onChanged(files);
          }, 60),
        );
      }),
    );
  } catch {
    // A directory that vanishes mid-watch (a deleted window) is not fatal.
  }
};

// fs.watch's recursive mode works on Windows and macOS; on Linux it throws and
// each directory gets its own watcher instead.
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

// The first compile: no invalidation, everything is cold by definition.
await compile([], true);
