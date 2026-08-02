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
 *
 * The resolver lives in `scripts/lib/citations.ts` because the docs site enforces
 * the same rule at build time; see `docs/src/remark/citations.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { citationRe, Resolver, walkMarkdown } from "./lib/citations.ts";

const ROOT = join(import.meta.dir, "..");
const QUIET = process.argv.includes("--quiet");

type Finding = { doc: string; docLine: number; cite: string; why: string };

const resolver = new Resolver(ROOT);
const docs = walkMarkdown(ROOT);

let checked = 0;
let ambiguous = 0;
const rot: Finding[] = [];
const external: Finding[] = [];
const outOfRange: Finding[] = [];

for (const doc of docs) {
  const lines = readFileSync(doc, "utf8").split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(citationRe())) {
      const [whole, rawPath, rawLines] = m as unknown as [string, string, string];
      checked++;

      const r = resolver.resolve(rawPath, rawLines);
      const at = { doc, docLine: i + 1, cite: whole };

      if (r.kind === "external") external.push({ ...at, why: r.why });
      else if (r.kind === "rot") rot.push({ ...at, why: r.why });
      else if (r.kind === "out-of-range")
        outOfRange.push({ ...at, why: `${resolver.rel(r.path)} has ${r.total} lines` });
      else if (r.ambiguous) ambiguous++;
    }
  }
}

const show = (title: string, list: Finding[]) => {
  if (!list.length) return;
  console.log(`\n${title} (${list.length})`);
  for (const f of list) {
    console.log(`  ${resolver.rel(f.doc)}:${f.docLine}  ${f.cite}`);
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
