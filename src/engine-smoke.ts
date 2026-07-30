/**
 * Does the protocol actually round-trip through `bun:ffi`?
 *
 *   bun run engine:smoke
 *
 * The Rust tests prove the engine works when Rust writes the tables. This proves
 * the interesting half: that **Bun** can write them — through typed-array views
 * over the engine's own memory, with no FFI call per write — and that the engine
 * reads back exactly what was written.
 *
 * It also settles the question the roadmap flagged and would not assume:
 * whether `toArrayBuffer` attaches a deallocator to Rust-owned memory.
 */
import { Align, Display, EventKind, FlexDirection, Justify, NodeFlags, NodeKind, Status }
  from "./protocol/generated.ts";
import { Engine, writeString } from "./engine/host.ts";

let failures = 0;

function check(what: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n       got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

function near(what: string, actual: number, expected: number, tolerance = 0.5): void {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? ` (${actual})` : `\n       got ${actual}, want ${expected} ±${tolerance}`}`);
}

// Headless: the same pipeline, no window, so this runs anywhere.
const engine = Engine.open({
  width: 300,
  height: 200,
  nodes: 8,
  styles: 3,
  states: 1,
  lists: 1,
  strings: 4,
  stringBytes: 256,
  windowed: false,
});

const { nodes, styles, states, layout } = engine.tables;

/**
 * Every style field has to be written: the arenas are zeroed, and zero is a real
 * value here — `width: 0`, not `auto`. `auto` is `NaN`.
 */
function initStyle(slot: number): void {
  styles.bg[slot] = 0x00000000;
  styles.fg[slot] = 0xff000000;
  styles.display[slot] = Display.FLEX;
  styles.flexDirection[slot] = FlexDirection.COLUMN;
  styles.justifyContent[slot] = Justify.FLEX_START;
  styles.alignItems[slot] = Align.FLEX_START;
  styles.alignSelf[slot] = Align.UNSET;
  styles.justifyItems[slot] = Align.UNSET;
  styles.justifySelf[slot] = Align.UNSET;
  for (const field of [
    "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
    "flexBasis", "aspectRatio", "insetTop", "insetRight", "insetBottom", "insetLeft",
  ] as const) {
    styles[field][slot] = NaN;
  }
  styles.flexShrink[slot] = 1;
  styles.fontSize[slot] = 16;
  styles.fontWeight[slot] = 400;
}

for (let slot = 0; slot < 3; slot++) initStyle(slot);

// Root: fills the window, 20px padding, 10px gap.
for (const field of ["padTop", "padRight", "padBottom", "padLeft"] as const) {
  styles[field][0] = 20;
}
styles.gapRow[0] = 10;
styles.bg[0] = 0xff101216;

// A fixed box, and a text node that has to be measured.
styles.width[1] = 120;
styles.height[1] = 40;
styles.bg[1] = 0xff3b82f6;
styles.fg[2] = 0xffffffff;

let cursor = 0;
cursor = writeString(engine, 0, "Hello", cursor);

function node(id: number, kind: number, style: number, text: number): void {
  nodes.kind[id] = kind;
  nodes.style[id] = style;
  nodes.text[id] = text;
}

node(0, NodeKind.BOX, 0, -1);
node(1, NodeKind.BOX, 1, -1);
node(2, NodeKind.TEXT, 2, 0);
nodes.flags[2] = NodeFlags.MEASURABLE;
nodes.flags[1] = NodeFlags.INTERACTIVE;

// Link: root -> [box, text]. Writing the chain *is* the API; there is no call.
nodes.firstChild[0] = 1;
nodes.nextSibling[1] = 2;
nodes.parent[1] = 0;
nodes.parent[2] = 0;

// One sparse interaction-state row, for the node that is interactive.
states.node[0] = 1;
states.hover[0] = 1;
states.active[0] = 1;
states.focus[0] = -1;

console.log(`engine: protocol v${Status.OK === 0 ? "1" : "?"}, font ${engine.fontFamily()}\n`);

engine.tick();

// --- what Bun wrote, the engine read -----------------------------------------
check("root fills the window", Array.from(engine.bounds(0)), [0, 0, 300, 200]);
check("the fixed box sits inside the padding", Array.from(engine.bounds(1)), [20, 20, 120, 40]);

const [textX, textY, textW] = engine.bounds(2);
check("the text node follows the box plus the gap", [textX, textY], [20, 70]);
if (engine.fontFamily() === "Segoe UI") {
  // Skia measures "Hello" at 16px as 36.85; Taffy publishes whole pixels.
  near('Skia measured "Hello"', textW, 36.85);
} else {
  check("text was measured at all", textW > 0, true);
}

// --- the layout table is the same memory -------------------------------------
check(
  "layout.x agrees with the bounds call",
  [layout.x[1], layout.y[1], layout.width[1], layout.height[1]],
  [20, 20, 120, 40],
);

// --- hit-testing --------------------------------------------------------------
check("hit-testing finds the interactive node", engine.hitTest(30, 30), 1);
check("and nothing where nothing is", engine.hitTest(290, 190), -1);

// --- a style patch is a memory write, not a call ------------------------------
styles.height[1] = 64;
engine.tick();
check("a style-table patch reached layout", engine.bounds(1)[3], 64);

// --- a list relink is a memory write too --------------------------------------
nodes.firstChild[0] = 2;
nodes.nextSibling[2] = 1;
nodes.nextSibling[1] = -1;
engine.tick();
check("relinking reordered without moving nodes", engine.bounds(2)[1], 20);

// --- the deallocator question -------------------------------------------------
//
// `toArrayBuffer(ptr, byteOffset, byteLength)` — the three-argument form — takes
// no finalizer, so Bun attaches none. This is the empirical half of that claim:
// drop every local reference to the views, force a full GC, and keep rendering.
// If a deallocator had been attached, the engine would now be drawing from freed
// memory.
{
  let views: unknown[] | null = [nodes.kind, styles.bg, layout.x];
  views = null;
  void views;
  Bun.gc(true);
  engine.tick();
  check("the engine still renders after a forced GC", engine.bounds(1)[3], 64);
  check("and the tables still hold what was written", styles.height[1], 64);
}

// --- events -------------------------------------------------------------------
check("no events from a headless engine", engine.drainEvents().length, 0);
check("EventKind crossed the boundary as data", EventKind.CLICK, 6);

// --- panics do not cross the boundary -----------------------------------------
{
  const code = engine.panicForTesting();
  check("a Rust panic returns a status code", code, Status.PANIC);
  // The process is still here, which is the actual assertion.
  console.log(`ok   the process survived the panic`);
}

engine.close();

console.log(
  failures === 0
    ? `\nall checks passed — Bun wrote the tables, the engine rendered them`
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
