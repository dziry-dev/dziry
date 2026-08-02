/**
 * What a frame costs, and whether the cost tracks the change or the document.
 *
 *   bun run bench                 # the table and the shape gates
 *   bun run bench --bless         # rewrite bench/baseline.json from this run
 *   bun run bench --sizes 10,200  # override the tree sizes
 *   bun run bench --reps 400      # samples per measurement (default 200)
 *
 * Every other tool here asks whether dziri is *correct*. None of them ask what it
 * *costs*, which is odd for a project whose whole pitch is that the work happened
 * at compile time. A 10x frame-time regression would ship today and all fourteen
 * would stay green.
 *
 * **The gate is the shape, not the number.** Absolute milliseconds on a laptop move
 * with the thermal state of the room, so a committed `4.2ms +/- 0.3` either fails
 * constantly or is loose enough to let a real regression through. What does not move
 * is the *relationship* between measurements taken seconds apart on the same machine:
 * ambient noise scales both sides and cancels. So the pass/fail lives on ratios, and
 * the raw numbers are recorded next to them for trend only.
 *
 * The three claims under test are the engine's own, not invented for this file:
 *
 *  1. **An idle tick skips layout and paint.** `engine.rs:355` returns early on
 *     `!needs_paint` -- "an idle tick is an event drain and nothing else".
 *  2. **A paint-only change does not relayout.** `tables.rs` `classify()` exists to
 *     name "the narrowest consequence", and notes that two arms used to be wrong in
 *     the expensive direction. If a `bg` write ever costs what a `height` write
 *     costs, that narrowing has regressed.
 *  3. **Idle cost is dominated by a memcmp, not by the tree.** `commit()` compares
 *     staged against live over every shared span, every tick. That is a real floor
 *     and it grows with the tables -- so this measures how fast it grows rather than
 *     pretending it is flat.
 *
 * Claim 3 is why there is no "idle must be O(1)" gate. It would be false, and a gate
 * that asserts something false is worse than no gate: someone eventually "fixes" the
 * code to satisfy it.
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledUi } from "../src/ir.ts";
import { Engine } from "../src/engine/host.ts";
import { Uploader, capacitiesFor } from "../src/engine/upload.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const BLESS = argv.includes("--bless");
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i > -1 ? (argv[i + 1] ?? null) : null;
};
const SIZES = (flag("--sizes") ?? "10,100,1000").split(",").map((s) => Number(s.trim()));
const REPS = Number(flag("--reps") ?? 200);
const BASELINE = join(ROOT, "bench", "baseline.json");

/**
 * A tree with real paint work in it: every box has a background and a border, so
 * `draw()` cannot skip it. Nesting is shallow and wide rather than deep -- a deep
 * tree would measure recursion limits instead of the thing being asked about.
 */
function scene(n: number): { html: string; css: string } {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) rows.push(`<div class="c${i % 8} box"></div>`);
  const palette = ["#1f2933", "#323f4b", "#3e4c59", "#52606d", "#616e7c", "#7b8794", "#9aa5b1", "#cbd2d9"];
  const css = [
    `.box { width: 40px; height: 12px; margin-bottom: 2px; border: 1px solid #000 }`,
    ...palette.map((hex, i) => `.c${i} { background: ${hex} }`),
  ].join("\n");
  return { html: `<body><div class="wrap">${rows.join("")}</div></body>`, css };
}

async function compile(dir: string, n: number): Promise<CompiledUi> {
  const { html, css } = scene(n);
  const h = join(dir, `n${n}.html`);
  const c = join(dir, `n${n}.css`);
  const out = join(dir, `n${n}.gen.ts`);
  await writeFile(h, html);
  await writeFile(c, css);
  const p = Bun.spawn(["bun", "run", "src/compile.ts", h, c, "-o", out], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await p.exited) !== 0) {
    const err = (await new Response(p.stderr).text()).trim();
    const line = err.split("\n").find((l) => l.trimStart().startsWith("error:"));
    throw new Error((line ? line.trimStart().slice(6) : err.split("\n").pop() ?? "").trim() || "compile failed");
  }
  const m = await import(`${out}?t=${Date.now()}`);
  return {
    strings: m.strings,
    styles: m.styles,
    nodes: m.nodes,
    variants: m.variants,
    interactive: m.interactive,
    generated: m.generated,
    textBindings: m.textBindings,
    handlers: m.handlers,
    lists: m.lists,
    media: m.media,
    root: m.root,
  };
}

/**
 * The engine's own `last_frame_ms`, not a wall clock on this side. Timing across the
 * FFI would fold Bun's call overhead into every sample, and that overhead is a
 * constant -- which would quietly flatten exactly the ratios this tool gates on.
 *
 * Reported as the minimum rather than the mean. The minimum is the closest thing to
 * the machine's actual capability: noise only ever adds. A mean over a run that got
 * descheduled once is a measurement of the scheduler.
 */
type Sample = { min: number; median: number };

function summarise(xs: number[]): Sample {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0]!, median: s[Math.floor(s.length / 2)]! };
}

type Row = { nodes: number; idle: Sample; paint: Sample; layout: Sample };

async function measure(dir: string, n: number): Promise<Row> {
  const ui = await compile(dir, n);
  const engine = Engine.open({
    ...capacitiesFor(ui),
    width: 800,
    height: 600,
    root: ui.root,
    windowed: false, // offscreen: a window would measure the compositor
  });
  try {
    new Uploader(engine, ui).uploadAll();
    engine.tick(); // first tick builds everything; never a sample

    const { styles } = engine.tables;
    // Slot 1 rather than 0: slot 0 is the root, whose size is pinned to the surface,
    // so writing to it measures a clamp rather than a relayout.
    const slot = Math.min(1, ui.styles.count - 1);

    const take = (mutate: (i: number) => void): Sample => {
      const out: number[] = [];
      for (let i = 0; i < REPS; i++) {
        mutate(i);
        engine.tick();
        out.push(engine.lastFrameMs());
      }
      return summarise(out);
    };

    const idle = take(() => {});
    /**
     * Both values must differ from each other *and* from whatever the stylesheet
     * already put there. `commit()` is a memcmp, so writing back a value that is
     * already present is not a change — that tick falls through the early return
     * and is an idle tick wearing a mutation's name.
     *
     * This is not hypothetical. The first version alternated `height` between 12
     * and 18 against a scene whose CSS said `height: 12px`, so one sample in the
     * set was a no-op — and since the statistic is the *minimum*, that single
     * sample became the reported cost of a relayout. It read as "a background
     * change costs 41x a height change", and the tool blamed `classify()` for it.
     * Hence the values below are outside anything `scene()` can emit, and hence
     * the self-check after this block.
     */
    const paint = take((i) => {
      styles.bg[slot] = i % 2 === 0 ? 0xff0a0b0c : 0xff0d0e0f;
    });
    const layout = take((i) => {
      styles.height[slot] = i % 2 === 0 ? 101 : 102;
    });

    return { nodes: n, idle, paint, layout };
  } finally {
    engine.close();
  }
}

const dir = await mkdtemp(join(tmpdir(), "dziri-bench-"));
const rows: Row[] = [];
try {
  for (const n of SIZES) rows.push(await measure(dir, n));
} finally {
  await rm(dir, { recursive: true, force: true });
}

const ms = (v: number) => v.toFixed(3).padStart(7);
console.log(`bench  ${REPS} samples per cell, engine-reported frame time, minimum`);
console.log("");
console.log("  nodes      idle    paint   layout   idle/layout  paint/layout");
for (const r of rows) {
  const rIdle = r.idle.min / r.layout.min;
  const rPaint = r.paint.min / r.layout.min;
  console.log(
    `  ${String(r.nodes).padStart(5)}  ${ms(r.idle.min)}  ${ms(r.paint.min)}  ${ms(r.layout.min)}` +
      `   ${rIdle.toFixed(3).padStart(10)}  ${rPaint.toFixed(3).padStart(12)}`,
  );
}
console.log("");

// ── the tool suspects itself first ───────────────────────────────────────────
/**
 * A mutation that costs what an idle tick costs did not happen. That is a bug in
 * this file — a wrong slot, a value that was already present, a stale view — and
 * not evidence about the engine. Report it as such and stop, because every gate
 * below divides by these numbers and would otherwise produce confident nonsense.
 */
/**
 * Ordered after the idle check, not before it, because the two failures look
 * identical from here. "A mutation costs what idle costs" is true both when the
 * mutation is dead (this file's bug) and when idle has started doing real work
 * (the engine's bug, gate 1 below). Verified by injecting each: a dead `height`
 * write left idle at 0.001 against layout 0.002, while an idle tick made to
 * repaint pushed idle to 0.065 against layout 0.080. So a *small* idle with a
 * flat mutation is this file's fault; a *large* idle is not, and belongs to
 * gate 1 rather than being reported here as a broken measurement.
 */
const busiest = (r: Row) => Math.max(r.paint.min, r.layout.min);
const idleIsSuspect = rows.some((r) => r.idle.min / busiest(r) > 0.5);
const notMeasuring = idleIsSuspect
  ? []
  : rows.filter((r) => r.paint.min < r.idle.min * 1.5 || r.layout.min < r.idle.min * 1.5);
if (notMeasuring.length) {
  console.log("BROKEN MEASUREMENT — this is bench's fault, not the engine's.\n");
  for (const r of notMeasuring) {
    console.log(
      `  at ${r.nodes} nodes a mutation tick costs about what an idle tick costs\n` +
        `    idle ${r.idle.min.toFixed(4)}  paint ${r.paint.min.toFixed(4)}  layout ${r.layout.min.toFixed(4)}\n` +
        `    The write is not reaching the staged table, or it is writing a value that\n` +
        `    is already there. Check the style slot and the values in measure().`,
    );
  }
  process.exit(1);
}

// ── the gates ────────────────────────────────────────────────────────────────
const failures: string[] = [];
const biggest = rows[rows.length - 1]!;
const smallest = rows[0]!;

// Claim 1: an idle tick skips layout and paint, so it must be a fraction of a tick
// that does both. Threshold is deliberately loose -- this is here to catch the early
// return being deleted, not to police a few percent.
// Measured against the busiest tick, not against `layout` specifically. Dividing
// by layout alone misreads a *dead* layout write as an expensive idle tick — the
// ratio goes to 1.0 either way — and then blames the engine for this file's bug.
for (const r of rows) {
  const ratio = r.idle.min / busiest(r);
  if (ratio > 0.5) {
    failures.push(
      `idle tick is ${(ratio * 100).toFixed(0)}% of a relayout tick at ${r.nodes} nodes.\n` +
        `    An idle tick is meant to return before draw() (engine.rs, "an idle tick is an\n` +
        `    event drain and nothing else"). At this ratio it is doing the work anyway.`,
    );
  }
}

// Claim 2: a paint-only write must not cost what a layout write costs. If it does,
// classify() has started filing `bg` as a layout consequence.
for (const r of rows) {
  const ratio = r.paint.min / r.layout.min;
  if (ratio > 0.9) {
    failures.push(
      `a background-only change costs ${(ratio * 100).toFixed(0)}% of a height change at ${r.nodes} nodes.\n` +
        `    classify() exists to file the narrowest consequence; a bg write should skip\n` +
        `    relayout entirely. Suspect a span being classified as layout-affecting.`,
    );
  }
}

// Claim 3: idle is memcmp-bound, so it may grow with the tables -- but it must grow
// far slower than the node count, or something in the idle path is walking the tree.
if (rows.length > 1) {
  const nodeGrowth = biggest.nodes / smallest.nodes;
  const idleGrowth = biggest.idle.min / smallest.idle.min;
  if (idleGrowth > nodeGrowth * 0.5) {
    failures.push(
      `idle cost grew ${idleGrowth.toFixed(1)}x while the tree grew ${nodeGrowth}x.\n` +
        `    The idle path should be bounded by commit()'s memcmp, not by node count.\n` +
        `    Growing in step with the tree means something now walks it every tick.`,
    );
  }
}

// ── the numbers, tracked but never gating ────────────────────────────────────
const current = {
  recorded: new Date().toISOString().slice(0, 10),
  reps: REPS,
  rows: rows.map((r) => ({ nodes: r.nodes, idle: r.idle.min, paint: r.paint.min, layout: r.layout.min })),
};

if (BLESS) {
  await Bun.write(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`baseline written to bench/baseline.json (${current.recorded})`);
} else {
  try {
    const prev = JSON.parse(await readFile(BASELINE, "utf8"));
    console.log(`vs baseline ${prev.recorded} (trend only, never a failure)`);
    for (const r of current.rows) {
      const was = prev.rows?.find((p: { nodes: number }) => p.nodes === r.nodes);
      if (!was) continue;
      const d = (now: number, then: number) => {
        const pct = ((now - then) / then) * 100;
        return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
      };
      console.log(
        `  ${String(r.nodes).padStart(5)}  idle ${d(r.idle, was.idle)}  paint ${d(r.paint, was.paint)}` +
          `  layout ${d(r.layout, was.layout)}`,
      );
    }
  } catch {
    console.log("no baseline yet — run `bun run bench --bless` to record one");
  }
}

console.log("");
if (failures.length) {
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(`\nbench ${failures.length} shape gate(s) failed`);
  process.exit(1);
}
console.log(`bench all shape gates hold across ${rows.map((r) => r.nodes).join(", ")} nodes`);
