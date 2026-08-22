/**
 * Keeps `data.ts` honest, and regenerates the Markdown rendering of it.
 *
 *   bun run arch:check          # validate
 *   bun run arch:check --emit   # validate, then rewrite guards/architecture/ARCHITECTURE.md
 *
 * A diagram that is not checked becomes a diagram that is wrong, and a wrong one
 * is worse than none — it is read with the same confidence. So every claim in
 * `data.ts` that names something in the repo is verified against the repo here,
 * and a new subsystem nobody documented is a failure rather than an omission.
 *
 * What is checked:
 *
 *   1. every file a stage cites exists
 *   2. every doc listed exists
 *   3. every layer root matches at least one real file
 *   4. every guard is a real `bun run` script
 *   5. every shared table has a documented writer and reader, and no role is stale
 *   6. every source file in the tree belongs to some layer
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TABLES, PROTOCOL_VERSION, ELEM_SIZE } from "../src/protocol/schema.ts";
import {
  BETS,
  DOCS,
  FIGURE_ORDER,
  GUARDS,
  LAYERS,
  MILESTONES,
  STAGES,
  TABLE_ROLES,
} from "./data.ts";
import { collectMetrics, ROOT } from "./metrics.ts";
import { checkFigureGeometry, FIGURE_STEP_COUNT } from "./figures/geometry.ts";

const problems: string[] = [];
const fail = (what: string) => problems.push(what);

const metrics = collectMetrics();
const known = new Set(metrics.files.map((f) => f.path));

// 1 — cited files ------------------------------------------------------------
for (const stage of STAGES) {
  if (stage.files.length === 0) fail(`stage "${stage.id}" cites no files`);
  for (const path of stage.files) {
    if (!existsSync(join(ROOT, path))) fail(`stage "${stage.id}" cites ${path}, which does not exist`);
  }
}

// 1b — figures ----------------------------------------------------------------
// A figure whose module is gone renders as a blank tab rather than an error, so
// the citation check is the only thing that would notice.
for (const fig of FIGURE_ORDER) {
  for (const path of fig.files) {
    if (!existsSync(join(ROOT, path))) fail(`figure "${fig.id}" cites ${path}, which does not exist`);
  }
}

// 1c — figure geometry ---------------------------------------------------------
for (const problem of checkFigureGeometry()) {
  fail(`${problem.figure} step ${problem.step + 1}: ${problem.detail}`);
}

// 2 — docs -------------------------------------------------------------------
for (const doc of DOCS) {
  if (!existsSync(join(ROOT, doc.path))) fail(`DOCS lists ${doc.path}, which does not exist`);
}

// 3 — layer roots ------------------------------------------------------------
for (const layer of LAYERS) {
  for (const root of layer.roots) {
    const hit = [...known].some((p) => p === root || p.startsWith(root));
    if (!hit) fail(`layer "${layer.id}" claims root ${root}, which matches no source file`);
  }
}

// 4 — guards -----------------------------------------------------------------
const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
  scripts?: Record<string, string>;
};
for (const guard of GUARDS) {
  if (!pkg.scripts?.[guard.script]) {
    fail(`guard "${guard.script}" is not a script in package.json`);
  }
}

// 5 — table roles ------------------------------------------------------------
const tableNames = new Set(TABLES.map((t) => t.name));
for (const table of TABLES) {
  if (!TABLE_ROLES[table.name]) fail(`shared table "${table.name}" has no entry in TABLE_ROLES`);
}
for (const name of Object.keys(TABLE_ROLES)) {
  if (!tableNames.has(name)) fail(`TABLE_ROLES documents "${name}", which is not a table any more`);
}

// 6 — nothing undocumented ---------------------------------------------------
const orphans = metrics.files.filter((f) => f.layer === null);
if (orphans.length > 0) {
  fail(
    `${orphans.length} source file(s) belong to no layer — add a root to LAYERS in data.ts:\n` +
      orphans.map((f) => `      ${f.path}`).join("\n"),
  );
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`guards/architecture/data.ts is out of date with the repo:\n`);
  for (const p of problems) console.error(`  · ${p}`);
  console.error(
    `\n${problems.length} problem(s). The view is only worth keeping while this passes.`,
  );
  process.exit(1);
}

console.log(
  `architecture ok — ${FIGURE_ORDER.length} figures (${FIGURE_STEP_COUNT} steps, geometry clean), ` +
    `${STAGES.length} stages, ${TABLES.length} tables, ${GUARDS.length} guards, ` +
    `${metrics.files.length} files accounted for`,
);

// ---------------------------------------------------------------------------
// The Markdown rendering
// ---------------------------------------------------------------------------

if (!process.argv.includes("--emit")) process.exit(0);

/**
 * Deliberately carries no measurements. Line counts belong in the live view,
 * where they are recomputed; committed here they would churn the diff on every
 * edit and be stale in between.
 */
function markdown(): string {
  const out: string[] = [];
  const p = (s = "") => out.push(s);

  p(`# dziry — architecture`);
  p();
  p(`> Generated from \`guards/architecture/data.ts\` by \`bun run arch:check --emit\`. Do not edit.`);
  p(`> Run \`bun run arch\` for the interactive version.`);
  p();
  p(
    `A UI framework that resolves CSS, the cascade and every interaction state before the app ` +
      `runs, then hands a native Rust engine a block of shared memory instead of a call surface.`,
  );
  p();

  p(`## Layers`);
  p();
  for (const l of LAYERS) {
    p(`- **${l.label}** — ${l.blurb}`);
    p(`  <br>\`${l.roots.join("`, `")}\``);
  }
  p();

  p(`## The animated tour`);
  p();
  p(
    `\`bun run arch\` → **How it works**. Six mechanisms, in the order the ideas depend on each ` +
      `other. Each answers one question:`,
  );
  p();
  for (const [n, f] of FIGURE_ORDER.entries()) {
    p(`${n + 1}. **${f.title}** — ${f.answers}`);
  }
  p();

  p(`## The pipeline`);
  p();
  const bands: [string, string][] = [
    ["build", "Build time — runs once, and none of it ships"],
    ["boundary", "The boundary — shared memory, described at startup"],
    ["frame", "Every frame — the loop"],
  ];
  for (const [phase, label] of bands) {
    p(`### ${label}`);
    p();
    for (const s of STAGES.filter((x) => x.phase === phase)) {
      p(`#### ${s.title}`);
      p();
      p(`*${s.summary}*`);
      p();
      for (const d of s.detail) p(`${d}\n`);
      if (s.facts?.length) for (const f of s.facts) p(`- ${f}`);
      p();
      p(`\`${s.files.join("`, `")}\``);
      p();
      if (s.invariant) p(`> **Do not undo.** ${s.invariant}`);
      p();
    }
  }
  p(`A signal changing closes the loop: it mutates the IR in place, and the next upload carries it.`);
  p();

  p(`## The shared-memory boundary`);
  p();
  p(`Protocol version ${PROTOCOL_VERSION}. Struct-of-arrays: every field is its own contiguous span.`);
  p();
  p(`| Table | Fields | Bytes/elem | Sized by | Written by | Read by |`);
  p(`| --- | --- | --- | --- | --- | --- |`);
  for (const t of TABLES) {
    const role = TABLE_ROLES[t.name];
    const bytes = t.fields.reduce((n, f) => n + ELEM_SIZE[f.type], 0);
    p(
      `| \`${t.name}\` | ${t.fields.length} | ${bytes} | ${t.sizedBy} | ` +
        `${role?.writer ?? "—"} | ${role?.reader ?? "—"} |`,
    );
  }
  p();
  for (const t of TABLES) {
    const role = TABLE_ROLES[t.name];
    p(`- **\`${t.name}\`** — ${role?.note ?? t.doc}`);
  }
  p();

  p(`## The six bets`);
  p();
  for (const b of BETS) {
    p(`### ${b.title} — ${b.verdict === "keep" ? "KEEP" : "KEEP WITH CHANGES"}`);
    p();
    p(`> ${b.claim}`);
    p();
    p(b.review);
    p();
  }

  p(`## Roadmap`);
  p();
  for (const m of MILESTONES) {
    p(`- **${m.id} · ${m.title}** — *${m.state}*${m.note ? `. ${m.note}` : ""}`);
  }
  p();

  p(`## What keeps the claims honest`);
  p();
  for (const g of GUARDS) {
    p(`- \`bun run ${g.script}\` — ${g.what}${g.oracle ? ` *(oracle: ${g.oracle})*` : ""}`);
  }
  p();

  p(`## Long-form sources`);
  p();
  for (const d of DOCS) p(`- \`${d.path}\` — ${d.what}`);
  p();

  return out.join("\n");
}

const target = join(import.meta.dir, "ARCHITECTURE.md");
await Bun.write(target, markdown());
console.log(`wrote guards/architecture/ARCHITECTURE.md`);
