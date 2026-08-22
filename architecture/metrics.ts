/**
 * Facts about the repo, measured rather than written down.
 *
 * Everything derivable from the tree lives here and is recomputed on every
 * request, so the view cannot show a line count that stopped being true. The
 * hand-written half is `data.ts`.
 *
 * Runs under Bun only — `serve.ts` calls it, `check.ts` calls it, the browser
 * receives its output as JSON.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { LAYERS, type LayerId } from "./data.ts";

export const ROOT = join(import.meta.dir, "..");

/** Directories that are never source, whatever they contain. */
const SKIP = new Set(["node_modules", "target", ".git", "vendor", "native", ".natives-tmp", "architecture"]);

/**
 * `.css` and `.html` are here because the authoring surface is source too — and
 * because a cited file the scan does not know about shows up in the view as
 * "missing", which would be a false alarm rather than the staleness signal it
 * is meant to be.
 */
const SOURCE_EXT = [".ts", ".tsx", ".rs", ".css", ".html"];

export type FileMetric = {
  path: string;
  layer: LayerId | null;
  lines: number;
  /** A test file, by this repo's two conventions: `*.test.ts` and `tests/*.rs`. */
  test: boolean;
  lang: "ts" | "rs" | "other";
};

export type Metrics = {
  /** ISO 8601, stamped when the scan ran. */
  measuredAt: string;
  files: FileMetric[];
  totals: {
    typescript: number;
    rust: number;
    testLines: number;
    /** Per layer: source lines and test lines, keyed by layer id. */
    byLayer: Record<string, { source: number; test: number; files: number }>;
  };
};

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.some((e) => entry.endsWith(e))) out.push(full);
  }
}

/** Repo-relative, forward slashes — the form `data.ts` cites and the view displays. */
export function rel(path: string): string {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function layerOf(path: string): LayerId | null {
  // Longest matching root wins, so `src/compiler/` beats a bare `src/`.
  let best: { id: LayerId; len: number } | null = null;
  for (const layer of LAYERS) {
    for (const root of layer.roots) {
      if (path === root || path.startsWith(root)) {
        if (!best || root.length > best.len) best = { id: layer.id, len: root.length };
      }
    }
  }
  return best?.id ?? null;
}

export function collectMetrics(): Metrics {
  const paths: string[] = [];
  for (const dir of ["src", "windows", "scripts", "native-src"]) {
    const full = join(ROOT, dir);
    try {
      walk(full, paths);
    } catch {
      // A directory that does not exist is not an error here; `check.ts` is what
      // complains about missing paths, and it complains with a citation.
    }
  }

  const files: FileMetric[] = paths
    .map((full) => {
      const path = rel(full);
      // Compiler output — `windows/<id>/ui.gen.ts` and the generated entries
      // (`windows.gen.ts`, `entry.gen.ts`, `worker.gen.ts`, `single.gen.ts`).
      // Counting them would report the size of the demo's integer arrays, and of
      // code the emitter wrote, as if someone had authored them.
      if (/^windows\/.*\.gen\.ts$/.test(path)) return null;
      const text = readFileSync(full, "utf8");
      // Count newlines, not split parts: a file ending in one would otherwise
      // report a phantom last line and disagree with every other tool.
      const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      return {
        path,
        layer: layerOf(path),
        lines,
        test: /\.test\.tsx?$/.test(path) || /\/tests\/[^/]+\.rs$/.test(path),
        lang: path.endsWith(".rs")
          ? ("rs" as const)
          : /\.tsx?$/.test(path)
            ? ("ts" as const)
            : ("other" as const),
      };
    })
    .filter((f): f is FileMetric => f !== null)
    .sort((a, b) => b.lines - a.lines);

  const byLayer: Record<string, { source: number; test: number; files: number }> = {};
  for (const layer of LAYERS) byLayer[layer.id] = { source: 0, test: 0, files: 0 };

  let typescript = 0;
  let rust = 0;
  let testLines = 0;

  for (const f of files) {
    if (f.lang === "ts") typescript += f.lines;
    else if (f.lang === "rs") rust += f.lines;
    if (f.test) testLines += f.lines;

    const bucket = f.layer ? byLayer[f.layer] : undefined;
    if (bucket) {
      bucket.files += 1;
      if (f.test) bucket.test += f.lines;
      else bucket.source += f.lines;
    }
  }

  return {
    measuredAt: new Date().toISOString(),
    files,
    totals: { typescript, rust, testLines, byLayer },
  };
}
