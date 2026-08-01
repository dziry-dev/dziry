/**
 * How much of dziri is still dynamic, as a number that can only go down.
 *
 *   bun run runtime-surface           # check against the ratchet
 *   bun run runtime-surface --bless   # record the current numbers as the new limit
 *   bun run runtime-surface --list    # name every exported symbol
 *
 * The governing rule of this project is that nothing stays dynamic unless it is
 * proven it must. Today that rule is enforced by `compile-time-gate`, which is a
 * text skill — judgement, applied one decision at a time, with no memory. Nothing
 * notices when the runtime grows by fifty lines a week, because no single week
 * looks like a violation.
 *
 * This is the same rule with a memory. Two numbers are committed, and the check is
 * one-directional: they may fall freely, and they may not rise without editing the
 * baseline in the same commit — which forces the growth to appear in a diff that a
 * reviewer can argue with. That is the whole mechanism. A principle you cannot
 * regress against is an aspiration.
 *
 * **Exported symbols** is the ratchet with no tolerance. It is what the rest of the
 * system can reach at runtime, it cannot be gamed by reformatting, and it is the
 * closest honest reading of "surface". Type-only exports do not count and should
 * not: they are erased, so they are not runtime surface at all. That falls out of
 * using Bun's transpiler scan rather than a regex over the word `export`.
 *
 * **Bytes** carries a tolerance, because it is not purely a function of this
 * repo's design: a Bun upgrade can move it without anybody deciding anything. The
 * Bun version is recorded next to the number so a jump explains itself instead of
 * looking like a regression. Symbols are the gate that matters; bytes are the gate
 * that catches a symbol count held flat while the code behind it doubles.
 *
 * **Per-frame allocations are deliberately missing.** They are the closest
 * measurement to the actual principle — work done on every tick that could have
 * been done once, at compile time — and they need instrumentation inside the
 * engine to obtain. Adding that while the engine is being actively changed would
 * measure the scaffolding. Left as a stated gap rather than approximated, because
 * a bad proxy for the most important number is worse than an admitted hole.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RUNTIME = join(ROOT, "src", "runtime");
const BASELINE = join(ROOT, "runtime-surface", "baseline.json");
const argv = process.argv.slice(2);
const BLESS = argv.includes("--bless");
const LIST = argv.includes("--list");

/** Bytes may drift with the bundler; symbols may not drift at all. */
const BYTES_TOLERANCE = 0.02;

/**
 * Tests are not surface. They are never imported by an app, so counting them would
 * make writing a test look like a violation of the compile-time-first rule — which
 * would teach exactly the wrong lesson.
 */
const sources = (await readdir(RUNTIME))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort();

if (sources.length === 0) throw new Error(`no runtime sources under ${RUNTIME}`);

const transpiler = new Bun.Transpiler({ loader: "ts" });
const byFile: Array<{ file: string; exports: string[] }> = [];
for (const f of sources) {
  const { exports } = transpiler.scan(await readFile(join(RUNTIME, f), "utf8"));
  byFile.push({ file: f, exports: [...exports].sort() });
}
const symbols = byFile.flatMap((f) => f.exports.map((e) => `${f.file}:${e}`)).sort();

/**
 * One synthetic barrel rather than one bundle per file.
 *
 * Building each entry separately inlines the shared modules into every output —
 * `signal.ts` lands inside `bindings.js` *and* `list-runtime.js` *and*
 * `patches.js` — so summing the outputs counts the same bytes three times and
 * reports a runtime substantially larger than the one that ships. The barrel makes
 * the bundler resolve the graph once, which is what an app importing the runtime
 * would get.
 */
const barrel = sources.map((f) => `export * from ${JSON.stringify(join(RUNTIME, f))};`).join("\n");
const built = await Bun.build({
  entrypoints: ["barrel.ts"],
  minify: true,
  target: "bun",
  plugins: [
    {
      name: "barrel",
      setup(build) {
        build.onResolve({ filter: /^barrel\.ts$/ }, () => ({ path: "barrel.ts", namespace: "barrel" }));
        build.onLoad({ filter: /.*/, namespace: "barrel" }, () => ({ contents: barrel, loader: "ts" }));
      },
    },
  ],
});
if (!built.success) {
  console.log("runtime-surface  could not bundle the runtime:");
  for (const m of built.logs) console.log(`  ${m}`);
  process.exit(1);
}
let bytes = 0;
for (const o of built.outputs) bytes += (await o.arrayBuffer()).byteLength;

const current = { symbols: symbols.length, bytes, bun: Bun.version };

console.log(`runtime-surface  ${sources.length} modules under src/runtime`);
console.log("");
for (const f of byFile) {
  console.log(`  ${f.file.padEnd(20)} ${String(f.exports.length).padStart(3)} exported`);
  if (LIST) for (const e of f.exports) console.log(`      ${e}`);
}
console.log("");
console.log(`  exported symbols  ${String(current.symbols).padStart(6)}`);
console.log(`  bundled bytes     ${String(current.bytes).padStart(6)}   minified, Bun ${current.bun}`);
console.log("");

if (BLESS) {
  await Bun.write(
    BASELINE,
    `${JSON.stringify({ ...current, recorded: new Date().toISOString().slice(0, 10), inventory: symbols }, null, 2)}\n`,
  );
  console.log(`ratchet set: ${current.symbols} symbols, ${current.bytes} bytes`);
  process.exit(0);
}

let base: { symbols: number; bytes: number; bun?: string; recorded?: string; inventory?: string[] };
try {
  base = JSON.parse(await readFile(BASELINE, "utf8"));
} catch {
  console.log("no ratchet recorded — run `bun run runtime-surface --bless` to set one");
  process.exit(1);
}

const problems: string[] = [];
const slack: string[] = [];

if (current.symbols > base.symbols) {
  const added = symbols.filter((s) => !(base.inventory ?? []).includes(s));
  problems.push(
    `exported symbols rose ${base.symbols} -> ${current.symbols}.\n` +
      (added.length ? `    new: ${added.join(", ")}\n` : "") +
      `    The runtime is meant to shrink. If this symbol has to exist, say why in\n` +
      `    the commit and re-bless in the same commit so the growth is reviewable.`,
  );
} else if (current.symbols < base.symbols) {
  const gone = (base.inventory ?? []).filter((s) => !symbols.includes(s));
  slack.push(
    `exported symbols fell ${base.symbols} -> ${current.symbols}` +
      (gone.length ? ` (${gone.join(", ")})` : "") +
      ` — re-bless to tighten the ratchet.`,
  );
}

const allowed = Math.ceil(base.bytes * (1 + BYTES_TOLERANCE));
if (current.bytes > allowed) {
  problems.push(
    `bundled bytes rose ${base.bytes} -> ${current.bytes} (limit ${allowed}, +${(BYTES_TOLERANCE * 100).toFixed(0)}%).` +
      (base.bun && base.bun !== current.bun
        ? `\n    Baseline was recorded on Bun ${base.bun} and this is ${current.bun}; check\n` +
          `    whether the bundler moved before treating this as a design regression.`
        : ""),
  );
} else if (current.bytes < base.bytes) {
  slack.push(`bundled bytes fell ${base.bytes} -> ${current.bytes} — re-bless to tighten the ratchet.`);
}

for (const s of slack) console.log(`SLACK ${s}`);
if (slack.length) console.log("");

if (problems.length) {
  for (const p of problems) console.log(`FAIL  ${p}`);
  console.log(`\nruntime-surface ratchet broken in ${problems.length} place(s)`);
  process.exit(1);
}

console.log(`runtime-surface holds at or under the ratchet from ${base.recorded ?? "an earlier run"}`);
console.log("per-frame allocations are not measured yet — see the header.");
