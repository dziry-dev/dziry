/**
 * Compares dynamic-styling strategies on a real page.
 *
 *   bun run variants                    # app/app.tsx + app/app.css
 *   bun run variants some/other.tsx some/other.css
 *
 * Reports IR size for each strategy, which toggles can skip relayout, where
 * toggles collide, and the measured cost of applying a change either way.
 */
import { join, relative, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { toDocument } from "./compiler/jsx-runtime.ts";
import { parseHtml, type Element, type Node } from "./compiler/html.ts";
import {
  analyzeVariants,
  analyzePatches,
  strategyBytes,
  type ToggleSpec,
} from "./compiler/variants.ts";
import { compileTree } from "./compiler/compile.ts";
import { findToggles, verifyCompose } from "./compiler/variant-compile.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// `app/todo.tsx` was the default and has not existed for some time, so the tool
// could not be run at all without arguments — it failed on the CSS read, one line
// later, which read like a missing stylesheet rather than a missing default.
const inputPath = argv[0] ?? join(ROOT, "app", "app.tsx");
const cssPath = argv[1] ?? join(ROOT, "app", "app.css");
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

const css = await Bun.file(cssPath).text();

let doc: Element;
let toggles: ToggleSpec[];

if ([".tsx", ".jsx"].includes(extname(inputPath).toLowerCase())) {
  const mod = (await import(pathToFileURL(resolve(inputPath)).href)) as {
    default: Node | Node[];
    TOGGLES?: ToggleSpec[];
  };
  doc = toDocument(mod.default);
  toggles = mod.TOGGLES ?? [];
} else {
  doc = parseHtml(await Bun.file(inputPath).text());
  toggles = [];
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

console.log(`\nvariant analysis — ${rel(inputPath)} + ${rel(cssPath)}`);

// --- correctness, against the shipped compiler -------------------------------
//
// First, unconditionally, and on production's own terms: `findToggles` discovers
// conditional classes from `classWhen`, which is how the compiler finds them. The
// size comparison below needs an explicit `TOGGLES` export because it injects
// classes by selector — an older model than `classWhen`, kept because it is what
// lets the report compile the same page three ways.
const productionToggles = findToggles(doc);
console.log("correctness: patches vs the compiler's own output");
if (productionToggles.length === 0) {
  console.log("  no conditional classes in this document");
} else {
  const mismatches = verifyCompose(doc, css, compileTree(doc, css), productionToggles);
  const names = productionToggles.map((t) => "." + t.className).join(", ");
  if (mismatches.length === 0) {
    console.log(`  all ${1 << productionToggles.length} combinations of ${names} reproduced exactly`);
  } else {
    const combinations = new Set(mismatches.map((m) => m.combination));
    console.log(`  ${combinations.size} combination(s) WRONG, ${mismatches.length} field(s):`);
    for (const m of mismatches.slice(0, 8)) {
      console.log(
        `    [${m.classNames.join(" + ")}] node ${m.node} ${m.field}: ` +
          `patched ${m.patched}, compiled ${m.compiled}`,
      );
    }
    process.exitCode = 1;
  }
}

if (toggles.length === 0) {
  console.log(
    `\n${rel(inputPath)} exports no TOGGLES, so the size comparison is skipped.\n` +
      `Pass a document that exports one to compare the three IR strategies.`,
  );
  process.exit(process.exitCode ?? 0);
}

console.log(`\n${toggles.length} toggles: ${toggles.map((t) => t.name).join(", ")}\n`);

const a = analyzeVariants(doc, css, toggles);

console.log(
  `${a.nodeCount} nodes, ${a.baselineStyles} baseline styles, ` +
    `${a.globalStyles} unique styles across all ${a.combos.length} combinations`,
);
console.log(`compiled ${a.combos.length} variants in ${a.compileMs.toFixed(0)}ms\n`);

// --- per-toggle shape --------------------------------------------------------
console.log("per toggle");
console.log("  name       nodes    % of tree  relayout  changed fields");
for (const d of a.deltas) {
  const pct = ((d.nodes.length / a.nodeCount) * 100).toFixed(1);
  console.log(
    `  ${d.name.padEnd(10)} ${String(d.nodes.length).padStart(5)}  ${pct.padStart(8)}%  ` +
      `${(d.affectsLayout ? "yes" : "no").padEnd(8)}  ${d.fields.join(", ")}`,
  );
}

// --- collisions --------------------------------------------------------------
console.log("\ncollisions (toggles writing the same node)");
if (a.collisions.length === 0) {
  console.log("  none — write lists compose by sequencing");
} else {
  for (const c of a.collisions) {
    console.log(`  ${c.toggles.join(" + ")}: ${c.nodes.length} shared nodes`);
  }
}

// --- size --------------------------------------------------------------------
const bytes = strategyBytes(a);
const perToggleTotal = bytes.perToggle + bytes.collisionExtra;

console.log("\nIR size");
console.log(`  combinations (${a.combos.length} x ${a.nodeCount})   ${kb(bytes.combinations)}`);
console.log(
  `  per toggle + collisions          ${kb(perToggleTotal)}` +
    `  (${kb(bytes.perToggle)} + ${kb(bytes.collisionExtra)})`,
);
console.log(
  `  ratio                            ${(bytes.combinations / perToggleTotal).toFixed(1)}x smaller`,
);

// Extrapolate, since the interesting regime is more toggles than a demo has.
console.log("\n  extrapolated at this page size");
const avgDelta = a.deltas.reduce((n, d) => n + d.nodes.length, 0) / a.deltas.length;
for (const k of [4, 8, 12, 16]) {
  const combo = 2 ** k * a.nodeCount * 2;
  const per = a.nodeCount * 2 + k * avgDelta * 8;
  console.log(
    `    ${String(k).padStart(2)} toggles   combinations ${kb(combo).padStart(12)}   ` +
      `per-toggle ${kb(per).padStart(10)}`,
  );
}

// --- apply cost --------------------------------------------------------------
const style = new Uint16Array(a.nodeCount);
const base = a.combos[0]!;

function bench(label: string, runs: number, fn: () => void): void {
  fn();
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const sorted = times.sort((x, y) => x - y);
  console.log(`  ${label.padEnd(42)} ${sorted[sorted.length >> 1]!.toFixed(4)} ms`);
}

console.log("\napply cost");
let mask = 0;
bench("combinations: whole-array copy", 500, () => {
  mask = (mask + 1) % a.combos.length;
  style.set(a.combos[mask]!);
});

const cheapest = [...a.deltas].sort((x, y) => x.nodes.length - y.nodes.length)[0]!;
const dearest = [...a.deltas].sort((x, y) => y.nodes.length - x.nodes.length)[0]!;

let on = false;
bench(`per-toggle flip: ${cheapest.name} (${cheapest.nodes.length} nodes)`, 500, () => {
  on = !on;
  const next = on ? cheapest.on : cheapest.off;
  for (let i = 0; i < cheapest.nodes.length; i++) style[cheapest.nodes[i]!] = next[i]!;
});

bench(`per-toggle flip: ${dearest.name} (${dearest.nodes.length} nodes)`, 500, () => {
  on = !on;
  const next = on ? dearest.on : dearest.off;
  for (let i = 0; i < dearest.nodes.length; i++) style[dearest.nodes[i]!] = next[i]!;
});

style.set(base);

// --- strategy C: style-table patches ----------------------------------------
const p = analyzePatches(a, toggles);

console.log("\n--- style-table patches ------------------------------------------");
console.log(
  `  ${a.baselineStyles} baseline styles -> ${p.variantStyles} slots interned over variant vectors` +
    `  (node pointers never change)`,
);
console.log(
  `  slots by role: base ${p.roleSlots.base}, hover ${p.roleSlots.hover}, ` +
    `active ${p.roleSlots.active}, focus ${p.roleSlots.focus}`,
);
if (p.materializedStates > 0) {
  console.log(
    `  ${p.materializedStates} node state pointers materialized (a toggle introduces a\n` +
      `    hover/active/focus style the baseline lacked) — so those pointers must exist in\n` +
      `    every variant, and interactivity cannot be inferred from hover >= 0`,
  );
}

console.log("\n  toggle       writes  relayout  fields");
for (const t of p.patches) {
  console.log(
    `  ${t.name.padEnd(12)} ${String(t.writes).padStart(6)}  ` +
      `${(t.affectsLayout ? "yes" : "no").padEnd(8)}  ${t.fields.join(", ")}`,
  );
}

console.log("\n  field-level collisions (same field AND same style)");
if (p.fieldCollisions.length === 0) {
  console.log("    none — every pair of toggles composes by sequencing");
} else {
  for (const c of p.fieldCollisions) {
    console.log(`    ${c.toggles.join(" + ")}: ${c.conflicts} conflicting writes`);
  }
}

// Correctness is reported at the top, against the shipped compiler, rather than
// here against this file's measurement model.

console.log("\nIR size, all three strategies");
console.log(`  combinations                     ${kb(bytes.combinations)}`);
console.log(`  per-node write lists             ${kb(perToggleTotal)}`);
console.log(`  style-table patches              ${kb(p.bytes)}`);

console.log("\n  patch apply cost");
const table = new Map(
  [...p.patches[0]!.entries].map((e) => [e.field, new Float64Array(p.variantStyles)]),
);
for (const t of p.patches) {
  for (const e of t.entries) if (!table.has(e.field)) table.set(e.field, new Float64Array(p.variantStyles));
}
for (const t of p.patches) {
  let flag = false;
  bench(`  ${t.name} (${t.writes} writes)`, 500, () => {
    flag = !flag;
    for (const e of t.entries) {
      const col = table.get(e.field)!;
      const src = flag ? e.on : e.off;
      for (let i = 0; i < e.styles.length; i++) col[e.styles[i]!] = src[i]!;
    }
  });
}

const paintOnly = a.deltas.filter((d) => !d.affectsLayout).map((d) => d.name);
console.log(
  `\nrelayout avoidance: ${paintOnly.length}/${a.deltas.length} toggles are paint-only` +
    (paintOnly.length ? ` (${paintOnly.join(", ")})` : ""),
);
console.log(
  "  a snapshot cannot tell which fields moved, so it must relayout or diff;\n" +
    "  a write list carries affectsLayout from the compiler.",
);
