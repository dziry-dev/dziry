/**
 * Verifies every `file.ext:LINE` citation in the Markdown docs still points at
 * something real.
 *
 *   bun run doc-lint            # report
 *   bun run doc-lint --quiet    # only failures
 *
 * These docs are unusually citation-dense — `engine.rs:402`, `signal.ts:86,159`,
 * `app.ts:115-118` — and citations rot silently as code moves. On 2026-07-31 a
 * cited comment turned out to say the opposite of what the doc claimed, and a
 * design was built on it. This catches the mechanical half of that: dead files
 * and out-of-range lines. It cannot catch a citation that still resolves but now
 * points at different code — that needs a human.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

const ROOT = join(import.meta.dir, "..");
const QUIET = process.argv.includes("--quiet");
// `vendor` matters as much as `node_modules`: `mdn:sync` puts ~1,500 Markdown
// files there, and they were both being linted *and* added to the basename
// index — so an MDN file could shadow a repo file when resolving a citation.
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "native", "dist", "golden", "vendor"]);

/**
 * A versioned crate or package directory — `skia-bindings-0.87.0/build.rs`,
 * `taffy-0.9.2/src/...`. These are citations into dependency source and are
 * never in this repo, but their *basenames* often are: `build.rs` resolved to
 * `native-src/dziri-engine/build.rs` and reported a false out-of-range. Match
 * the path shape before trusting the basename.
 */
const VERSIONED_DEP = /(^|\/)[a-z0-9_-]+-\d+\.\d+(\.\d+)?([-+][\w.]+)?\//i;

/** `name.ext:12` or `name.ext:12-40` or `name.ext:86,159` */
const CITATION = /\b([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|rs|css|html|json|toml)):(\d+(?:[-,]\d+)*)/g;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") && e.name !== ".claude") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Citations are written as bare basenames, so resolve by searching the tree. */
const index = new Map<string, string[]>();
async function buildIndex(dir: string) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await buildIndex(p);
    else {
      const list = index.get(e.name) ?? [];
      list.push(p);
      index.set(e.name, list);
    }
  }
}

const lineCounts = new Map<string, number>();
async function lineCount(path: string): Promise<number> {
  if (!lineCounts.has(path)) {
    const text = await readFile(path, "utf8");
    lineCounts.set(path, text.split("\n").length);
  }
  return lineCounts.get(path)!;
}

type Finding = { doc: string; docLine: number; cite: string; why: string };

/**
 * Files git has ever known about. This is what separates *rot* from a citation
 * into a dependency's source: the docs quote Taffy, skia-safe, SDL3 and Blitz
 * internals as research, and those were never in this repo, so "not found" is
 * expected. A path git once tracked and no longer resolves is a real dangling
 * reference — `src/engine-smoke.ts` was deleted and is still cited eight times.
 */
async function everTracked(): Promise<Set<string>> {
  const out = new Set<string>();
  const proc = Bun.spawn(["git", "log", "--all", "--pretty=format:", "--name-only", "--diff-filter=AD"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  for (const line of text.split("\n")) {
    const p = line.trim();
    if (p) {
      out.add(p);
      out.add(basename(p));
    }
  }
  return out;
}

await buildIndex(ROOT);
const tracked = await everTracked();
const docs = await walk(ROOT);

let checked = 0;
let ambiguous = 0;
const rot: Finding[] = [];
const external: Finding[] = [];
const outOfRange: Finding[] = [];

for (const doc of docs) {
  const text = await readFile(doc, "utf8");
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    // A fenced code block is illustrative, not a citation of this repo.
    for (const m of lines[i]!.matchAll(CITATION)) {
      const [whole, rawPath, rawLines] = m as unknown as [string, string, string];
      checked++;

      const name = basename(rawPath);
      const normRaw = rawPath.replace(/\\/g, "/");

      // Check the path shape before the basename, or a dependency citation gets
      // resolved to an unrelated repo file that happens to share a filename.
      if (VERSIONED_DEP.test(normRaw)) {
        external.push({ doc, docLine: i + 1, cite: whole, why: "dependency source (versioned package path)" });
        continue;
      }

      let candidates = index.get(name) ?? [];

      // If the citation carries directories, prefer paths that end with it.
      const norm = rawPath.replace(/\\/g, "/");
      if (norm.includes("/")) {
        const narrowed = candidates.filter((c) => relative(ROOT, c).replace(/\\/g, "/").endsWith(norm));
        if (narrowed.length) candidates = narrowed;
      }

      if (candidates.length === 0) {
        // A path given relative to root that the index missed (e.g. generated).
        const direct = join(ROOT, norm);
        if (existsSync(direct) && statSync(direct).isFile()) candidates = [direct];
      }

      if (candidates.length === 0) {
        const known = tracked.has(norm) || tracked.has(name);
        (known ? rot : external).push({
          doc,
          docLine: i + 1,
          cite: whole,
          why: known
            ? "git tracked this path once — the file was deleted or moved"
            : "never in this repo (dependency source, or a typo)",
        });
        continue;
      }
      const nums = rawLines.split(/[-,]/).map(Number);
      const worst = Math.max(...nums);

      // Ambiguous basenames are common here — `compile.ts` is both src/compile.ts
      // and src/compiler/compile.ts. Picking the first match reported dozens of
      // false "out of range" hits. Prefer a candidate the line actually fits in;
      // only if none fits is the citation genuinely out of range.
      let target = candidates[0]!;
      if (candidates.length > 1) {
        ambiguous++;
        for (const c of candidates) {
          if (worst <= (await lineCount(c))) {
            target = c;
            break;
          }
        }
      }

      const total = await lineCount(target);
      if (worst > total) {
        outOfRange.push({
          doc,
          docLine: i + 1,
          cite: whole,
          why: `${relative(ROOT, target).replace(/\\/g, "/")} has ${total} lines`,
        });
      }
    }
  }
}

const show = (title: string, list: Finding[]) => {
  if (!list.length) return;
  console.log(`\n${title} (${list.length})`);
  for (const f of list) {
    console.log(`  ${relative(ROOT, f.doc).replace(/\\/g, "/")}:${f.docLine}  ${f.cite}`);
    console.log(`      ${f.why}`);
  }
};

if (!QUIET) {
  console.log(`doc-lint  ${docs.length} docs · ${checked} citations checked`);
  if (ambiguous) console.log(`          ${ambiguous} resolved by basename with >1 match (first wins)`);
  if (external.length)
    console.log(`          ${external.length} point outside the repo (dependency source) — not checked`);
}

// Only these two fail the run. An external citation is research, not rot.
show("ROT — file was tracked by git and is now gone", rot);
show("OUT OF RANGE — line is past the end of the file", outOfRange);
if (!QUIET && external.length) show("outside the repo (informational)", external.slice(0, 8));

const bad = rot.length + outOfRange.length;
console.log(bad ? `\n${bad} broken citation(s)` : `\nno rot — ${checked - external.length} in-repo citations resolve`);
process.exit(bad ? 1 : 0);
