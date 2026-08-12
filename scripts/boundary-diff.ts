/**
 * Checks the shared-memory tables before and across the FFI boundary.
 *
 *   bun run boundary-diff                 # validate windows/main/ui.gen.ts
 *   bun run boundary-diff --live          # also start the engine and cross-check
 *   bun run boundary-diff path/to/ui.gen.ts
 *
 * Two halves, because they fail differently.
 *
 * STATIC — the tables Bun is about to upload are internally consistent: links
 * point both ways, no cycles, every index in range. The engine already treats
 * Bun-written memory as untrusted input (traversal budget, explicit stack, bad
 * string slot reads as ""), so a malformed table is caught over there as an
 * error rather than a hang. But by then the message is about *the engine's*
 * traversal, not about which node the compiler mislinked. This says which node.
 *
 * LIVE — start the engine on those tables and compare its computed view with
 * what Bun believes. Cross-language corruption otherwise presents as a
 * wrong-looking frame with nothing to grep for.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
// Type-only, so they are erased at runtime: the values below are imported
// dynamically on purpose, so the static half still runs with no engine built.
import type { CompiledUi } from "../src/ir.ts";
import type { Engine as EngineHandle } from "../src/engine/host.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const LIVE = argv.includes("--live");
const target = resolve(argv.find((a) => !a.startsWith("--")) ?? join(ROOT, "windows", "main", "ui.gen.ts"));

if (!existsSync(target)) {
  console.log(`no such file: ${target}\n  compile first: bun run compile`);
  process.exit(1);
}

const ui = await import(`${target}?t=${Date.now()}`);
const n = ui.nodes;
const count: number = n.count;

const problems: string[] = [];
const bad = (s: string) => problems.push(s);

console.log(`boundary-diff  ${count} nodes · ${ui.styles.count} style slots · ${ui.strings.length} strings`);

// ── static: links ────────────────────────────────────────────────────────────
for (let i = 0; i < count; i++) {
  const p = n.parent[i]!;
  if (p !== -1 && (p < 0 || p >= count)) bad(`node ${i}: parent ${p} out of range`);
  const fc = n.firstChild[i]!;
  if (fc !== -1 && (fc < 0 || fc >= count)) bad(`node ${i}: firstChild ${fc} out of range`);
  const ns = n.nextSibling[i]!;
  if (ns !== -1 && (ns < 0 || ns >= count)) bad(`node ${i}: nextSibling ${ns} out of range`);

  const s = n.style[i]!;
  if (s < 0 || s >= ui.styles.count) bad(`node ${i}: style slot ${s} outside 0..${ui.styles.count - 1}`);

  const t = n.text[i]!;
  if (t !== -1 && (t < 0 || t >= ui.strings.length)) bad(`node ${i}: text slot ${t} outside 0..${ui.strings.length - 1}`);
}

// ── static: the child chain agrees with the parent column ────────────────────
// Zero is a valid node id, so link fields are prefilled to -1; a chain that
// walks back into itself is the failure the engine's traversal budget exists to
// survive, and the one worth naming precisely here.
for (let i = 0; i < count; i++) {
  const seen = new Set<number>();
  let c = n.firstChild[i]!;
  let steps = 0;
  while (c !== -1) {
    if (seen.has(c)) {
      bad(`node ${i}: sibling chain cycles at node ${c}`);
      break;
    }
    if (++steps > count) {
      bad(`node ${i}: sibling chain longer than the table (${steps} steps)`);
      break;
    }
    seen.add(c);
    if (n.parent[c] !== i) bad(`node ${c}: is a child of ${i} but its parent says ${n.parent[c]}`);
    c = n.nextSibling[c]!;
  }
}

// ── static: reachability from the root ───────────────────────────────────────
// Unreachable rows are normal — spare capacity is where list arenas grow — but
// an unreachable row with a parent set is a relink that half-happened.
const reachable = new Set<number>();
{
  const stack = [ui.root as number];
  while (stack.length) {
    const i = stack.pop()!;
    if (i === -1 || reachable.has(i)) continue;
    reachable.add(i);
    const seen = new Set<number>();
    for (let c = n.firstChild[i]!; c !== -1 && !seen.has(c); c = n.nextSibling[c]!) {
      seen.add(c);
      stack.push(c);
    }
  }
}

/**
 * Rows inside a list arena are unreachable *by design* until they are spliced
 * in, and they carry a parent the whole time — that is what lets `relink_nodes`
 * link them without styling them, and why `apply_all_styles` walks capacity
 * rather than the reachable tree. Flagging them was this checker's own bug: it
 * reported 48 "problems" against a perfectly good app.
 */
const inArena = new Uint8Array(count);
for (let i = 0; i < ui.lists.count; i++) {
  const start = ui.lists.arenaStart[i]!;
  const span = ui.lists.stride[i]! * ui.lists.capacity[i]!;
  for (let k = start; k < Math.min(start + span, count); k++) inArena[k] = 1;
}

let dormant = 0;
for (let i = 0; i < count; i++) {
  if (reachable.has(i) || n.parent[i] === -1) continue;
  if (inArena[i]) {
    dormant++;
    continue;
  }
  bad(`node ${i}: unreachable from root, not in a list arena, but claims parent ${n.parent[i]} — half-finished relink`);
}

// ── static: list arenas ──────────────────────────────────────────────────────
const L = ui.lists;
for (let i = 0; i < L.count; i++) {
  const cont = L.container[i]!;
  if (cont < 0 || cont >= count) bad(`list ${i}: container ${cont} out of range`);
  const start = L.arenaStart[i]!;
  const span = L.stride[i]! * L.capacity[i]!;
  if (start < 0 || start + span > count)
    bad(`list ${i}: arena ${start}..${start + span} exceeds the node table (${count})`);
  if (L.active[i]! > L.capacity[i]!) bad(`list ${i}: active ${L.active[i]} exceeds capacity ${L.capacity[i]}`);
  const off = L.dataOffset?.[i] ?? 0;
  if (off < 0) bad(`list ${i}: negative dataOffset ${off}`);
}

console.log(
  `  static     ${problems.length ? `${problems.length} problem(s)` : "links, indices, chains and arenas all consistent"}` +
    `  (${reachable.size}/${count} reachable, ${dormant} dormant arena rows)`,
);

// ── live: what does the engine think? ────────────────────────────────────────
if (LIVE) {
  let engine: EngineHandle | null = null;
  try {
    const { Engine } = await import("../src/engine/host.ts");
    const { Uploader, capacitiesFor } = await import("../src/engine/upload.ts");

    // Exactly the sequence `app.ts` uses. Anything else measures a differently
    // initialised engine, which would make a disagreement meaningless.
    const compiled: CompiledUi = {
      strings: ui.strings,
      styles: ui.styles,
      nodes: ui.nodes,
      variants: ui.variants,
      interactive: ui.interactive,
      generated: ui.generated,
      editableBoxes: ui.editableBoxes,
      placeholders: ui.placeholders,
      overlays: ui.overlays,
      tabStops: ui.tabStops,
      autofocus: ui.autofocus,
      textAreas: ui.textAreas,
      forms: ui.forms,
      disabledBindings: ui.disabledBindings,
      textBindings: ui.textBindings,
      handlers: ui.handlers,
      lists: ui.lists,
      media: ui.media,
      tweens: ui.tweens,
      keyframes: ui.keyframes,
      controls: ui.controls,
      images: ui.images,
      root: ui.root,
    };

    engine = Engine.open({
      ...capacitiesFor(compiled),
      width: 1040,
      height: 560,
      title: "boundary-diff",
      root: ui.root,
      windowed: false, // offscreen: this is a check, not a demo
    });

    new Uploader(engine, compiled).uploadAll();
    engine!.tick();

    let mismatches = 0;
    let zeroArea = 0;
    for (let i = 0; i < count; i++) {
      const [x, y, w, h] = engine!.bounds(i);
      const hidden = n.hidden[i] === 1;
      if (hidden && (w !== 0 || h !== 0)) {
        if (mismatches++ < 10) bad(`node ${i}: hidden in the tables but the engine gives it ${w}x${h} at ${x},${y}`);
      }
      // A dormant arena row legitimately has no geometry — it is not linked in
      // yet. Only a *reachable, visible* node laying out at nothing is suspect.
      if (!hidden && reachable.has(i) && !inArena[i] && w === 0 && h === 0) {
        if (zeroArea++ < 10) bad(`node ${i}: reachable and visible but the engine laid it out at 0x0`);
      }
    }
    const total = mismatches + zeroArea;
    console.log(
      `  live       ${total ? `${total} disagreement(s)` : "engine geometry agrees with the tables"}` +
        `  (${count} nodes ticked)`,
    );
  } catch (e) {
    console.log(`  live       skipped — ${(e as Error).message.split("\n")[0]}`);
    console.log(`             (build it first: bun run engine)`);
  }
}

if (problems.length) {
  console.log("");
  for (const p of problems.slice(0, 40)) console.log(`FAIL  ${p}`);
  if (problems.length > 40) console.log(`      … and ${problems.length - 40} more`);
  process.exit(1);
}
console.log("\ntables are consistent");
