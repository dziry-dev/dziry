/**
 * Chrome as an oracle for *geometry*, not for computed values.
 *
 *   bun run layout-diff                    # whole corpus
 *   bun run layout-diff --only wrap        # substring filter on the scenario name
 *   bun run layout-diff --verbose          # print rows that agree too
 *   bun run layout-diff --tolerance 1.5    # px; default 0.5
 *
 * `conformance` already asks Chrome what a declaration *computes to*. That cannot
 * catch a laid-out box in the wrong place, because every input can compute
 * correctly and still be arranged wrongly — which is the entire class that text
 * wrapping lives in. So this feeds **the same html+css pair** to dziri's compiler
 * and to headless Chrome, lays both out at the same viewport, and compares boxes.
 *
 * How the two sides are made comparable, which is where the judgement is:
 *
 *  - **dziri ships no default stylesheet**, so Chrome gets `RESET` — dziri's own
 *    initial values from `INITIAL_STYLE`, spelled out as CSS. dziri needs no rule
 *    for them because they *are* its defaults; Chrome does. `RESET` is injected
 *    only into Chrome and is deliberately not part of a scenario's css, so a
 *    scenario never accidentally tests the reset.
 *
 *  - **dziri's defaults are flex-column, not block**, so the reset says so. This
 *    is not a fudge: `display: FLEX` / `Direction.COLUMN` is what `INITIAL_STYLE`
 *    contains, and a browser told to lay out in block flow would be answering a
 *    different question.
 *
 *  - **dziri has no `font-family` property at all** — the engine always uses the
 *    platform sans (Segoe UI here). The reset pins Chrome to the same family and
 *    size, or every text box differs by font metrics and nothing else is legible.
 *
 *  - **`line-height` is left alone on both sides.** Both compute `normal` from
 *    font metrics, and if they disagree about what `normal` means that is a real
 *    finding — so it is reported rather than normalised away.
 *
 * Text nodes are compared on `y`, `height` and line count only, never on `x`/`w`.
 * dziri makes a text run a real node that stretches to its container; Chrome makes
 * it an anonymous flex item with no box you can measure. Their heights and
 * positions are the same question, their widths are not the same measurement, and
 * a tolerant width comparison here would be a lenient normaliser turning a real
 * bug into a pass. The container is an ordinary element, so its width is compared
 * directly one row up — which is what "was the text given the right space" means.
 *
 * A `shape` failure — the two walks disagree about the tree itself — stops that
 * scenario. Comparing geometry across trees that are not the same tree produces
 * confident nonsense.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeSession } from "./cdp.ts";
import type { CompiledUi } from "../src/ir.ts";
import { Engine } from "../src/engine/host.ts";
import { Uploader, capacitiesFor } from "../src/engine/upload.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i > -1 ? (argv[i + 1] ?? null) : null;
};
const ONLY = flag("--only");
const TOLERANCE = Number(flag("--tolerance") ?? 0.5);

/**
 * dziri's `INITIAL_STYLE`, as a stylesheet, so Chrome starts where dziri starts.
 *
 * Kept as narrow as that claim: every declaration here corresponds to a field in
 * `src/ir.ts`'s `INITIAL_STYLE`, or to the absence of a field (`font-family`,
 * `border-style`). Nothing is here because it made a number look better.
 *
 * **`body, body *` and not `*`.** `*` also matches `head`, `style` and `meta`,
 * whose `display: none` comes from the UA stylesheet — so `* { display: flex }`
 * overrides it, and Chrome renders the scenario's own CSS as visible text above
 * the body. It reads as an 84 px offset on every box in the document, which looks
 * exactly like a layout bug and is not one. Left as a warning: a reset written to
 * make two engines comparable is itself capable of contaminating the measurement.
 *
 * **`height: 100%` on `html` and `body`** states dziri's root sizing rather than
 * changing it: the engine lays the root node out against the surface, so dziri's
 * node 0 *is* the viewport box. Chrome's `body` is content-sized by default, and
 * comparing a viewport-sized box with a content-sized one would report a
 * difference on node 0 of every scenario forever.
 *
 * `box-sizing: content-box` agrees with both sides as of `d56611d`, which made
 * dziri size the content box. It used to be a stated divergence — Taffy's default
 * is `BorderBox` — and this tool reported it as `w 424 vs 400` on the control until
 * that landed. It is still spelled out rather than dropped, because Chrome's
 * default is only a default.
 *
 * **Two kinds of line live in the reset, and they are not the same kind.** Some
 * state a difference dziri means to close — those are bug reports waiting to be
 * filed, and this block should shrink as they are fixed, exactly as box-sizing
 * did. The rest normalise a difference dziri will never close: it has no block
 * layout, no `font-family` property, and no UA stylesheet at all. Every line of
 * the second kind is a blind spot, because a difference normalised away is never
 * reported.
 *
 * **Which is why inherited properties go on `body` and not on `body, body *`.** A
 * selector that matches the child beats the value the child would have inherited,
 * so `body * { font-size: 16px }` flattens inheritance on Chrome's side: measured,
 * a child of `.parent { font-size: 24px }` computes 16px rather than 24px. A dziri
 * inheritance bug would then read as *agreement*, because Chrome had been told not
 * to inherit either — two engines wrong in the same direction is a green run. The
 * non-inherited half has to stay on `body *`: it does not inherit, and Chrome's UA
 * stylesheet sets it per element.
 */
const RESET = `
  html, body { height: 100%; margin: 0 }
  body { font-family: "Segoe UI"; font-size: 16px; font-weight: 400 }
  body, body * {
    margin: 0; padding: 0; border: 0 solid; box-sizing: content-box;
    display: flex; flex-direction: column; flex-wrap: nowrap;
  }
`;

type Scenario = {
  name: string;
  width: number;
  height: number;
  html: string;
  css: string;
  /** What the scenario is for, printed on failure so a diff explains itself. */
  asks: string;
};

const SENTENCE = "The quick brown fox jumps over the lazy dog near the river bank";

const CORPUS: Scenario[] = [
  // The control. If this disagrees, the harness or the reset is wrong and every
  // other row in the run is untrustworthy — so it is first, and it has no text.
  {
    name: "boxes-no-text",
    asks: "geometry agrees at all when text is not involved",
    width: 600,
    height: 300,
    html: `<body><div class="outer"><div class="a"></div><div class="b"></div></div></body>`,
    css: `.outer { padding: 12px; width: 400px }
.a { width: 120px; height: 40px; margin-bottom: 8px }
.b { width: 240px; height: 24px }`,
  },

  {
    name: "wrap-narrow",
    asks: "a sentence too long for a 200px box breaks onto several lines",
    width: 400,
    height: 400,
    html: `<body><div class="box">${SENTENCE}</div></body>`,
    css: `.box { width: 200px }`,
  },
  {
    name: "wrap-wide",
    asks: "the same sentence needs fewer lines in a 600px box",
    width: 800,
    height: 400,
    html: `<body><div class="box">${SENTENCE}</div></body>`,
    css: `.box { width: 600px }`,
  },
  {
    name: "wrap-padding",
    asks: "wrapping uses the content box, not the border box",
    width: 400,
    height: 400,
    html: `<body><div class="box">${SENTENCE}</div></body>`,
    css: `.box { width: 240px; padding: 16px }`,
  },
  {
    name: "wrap-unbreakable",
    asks: "a token with no break opportunity overflows rather than being cut",
    width: 400,
    height: 300,
    html: `<body><div class="box">Unbreakablesupercalifragilistic</div></body>`,
    css: `.box { width: 120px }`,
  },
  {
    name: "wrap-in-a-row",
    asks: "two text children of a flex row each wrap in their own share",
    width: 400,
    height: 400,
    html: `<body><div class="row"><div class="cell">${SENTENCE}</div><div class="cell">${SENTENCE}</div></div></body>`,
    css: `.row { flex-direction: row; width: 360px }
.cell { width: 180px }`,
  },
  {
    name: "wrap-auto-width",
    asks: "a box with no width takes its parent's, and wraps to it",
    width: 320,
    height: 400,
    html: `<body><div class="outer"><div class="box">${SENTENCE}</div></div></body>`,
    css: `.outer { width: 260px; padding: 10px }`,
  },

  // The scenario that makes a wrong text measurement *visible*.
  //
  // Every `wrap-*` case above pins its container's width, and text rows are compared
  // on `y`/`h` only — so the measured *width* of a string reaches nothing that is
  // checked, and all five stay green even when the engine is deliberately made to
  // measure 3 px too wide. Verified by injecting exactly that. Here the boxes are
  // content-sized inside a row, so the text's width is the box's width, and the box
  // is an ordinary element whose width is compared directly.
  {
    name: "text-sizes-its-box",
    asks: "a content-sized box is exactly as wide as the text measured",
    width: 600,
    height: 200,
    html:
      `<body><div class="row">` +
      `<div class="tag">Clear</div><div class="tag">object</div><div class="tag">a</div>` +
      `</div></body>`,
    css: `.row { flex-direction: row; gap: 8px }
.tag { padding: 8px 14px; border: 1px solid #333 }`,
  },

  // Reported from the real window at ~400px: "even button are out of container".
  // This is `app.css`'s `.newrow` — a `flex: 1` field and two content-sized
  // buttons — in a container too narrow to hold their combined minimum. The
  // question is not whether it overflows; it is whether dziri overflows *by the
  // same amount Chrome does*, because a flex item's `min-width: auto` floor is
  // exactly the rule that decides it.
  {
    name: "row-too-narrow",
    asks: "a flex row past its minimum overflows by the amount CSS says, not more",
    width: 300,
    height: 200,
    html:
      `<body><div class="row">` +
      `<div class="field"></div><div class="btn">Add</div><div class="btn">Clear</div>` +
      `</div></body>`,
    css: `.row { flex-direction: row; width: 150px; gap: 8px }
.field { flex-grow: 1; flex-basis: 0; border: 1px solid #333; padding: 9px 12px }
.btn { border: 1px solid #333; padding: 8px 14px }`,
  },

  // The same row with room to spare, as the control: if this disagrees then the
  // disagreement above is about flex distribution generally, not about the floor.
  {
    name: "row-with-room",
    asks: "the same row, given enough width, distributes the same way",
    width: 600,
    height: 200,
    html:
      `<body><div class="row">` +
      `<div class="field"></div><div class="btn">Add</div><div class="btn">Clear</div>` +
      `</div></body>`,
    css: `.row { flex-direction: row; width: 420px; gap: 8px }
.field { flex-grow: 1; flex-basis: 0; border: 1px solid #333; padding: 9px 12px }
.btn { border: 1px solid #333; padding: 8px 14px }`,
  },
];

// ── the walk both sides produce ──────────────────────────────────────────────
type Row = {
  /** `div` / `#text` — for reporting; alignment is checked structurally. */
  label: string;
  /** Index of the parent in this same list, or -1. */
  parent: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Chrome only, and only for text: how many line boxes the run produced. */
  lines?: number;
};

const isText = (r: Row) => r.label === "#text";

// ── dziri side ───────────────────────────────────────────────────────────────
async function dziriWalk(dir: string, s: Scenario, i: number): Promise<Row[]> {
  const html = join(dir, `s${i}.html`);
  const css = join(dir, `s${i}.css`);
  const out = join(dir, `s${i}.gen.ts`);
  await writeFile(html, s.html);
  await writeFile(css, s.css);

  const proc = Bun.spawn(["bun", "run", "src/compile.ts", html, css, "-o", out], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    // The whole of stderr, not its first line: Bun prints a source excerpt first,
    // so `split("\n")[0]` reports `162 |` and hides the actual message.
    const err = (await new Response(proc.stderr).text()).trim();
    // `^error:` and not /error/i — the excerpt Bun prints usually contains the
    // literal text `throw new Error(...)`, which matches and says nothing.
    const message = err.split("\n").find((l) => l.trimStart().startsWith("error:")) ?? err.split("\n").pop();
    throw new Error((message ?? "compile failed").trim());
  }

  const m = await import(`${out}?t=${Date.now()}`);
  const ui: CompiledUi = {
    strings: m.strings,
    styles: m.styles,
    nodes: m.nodes,
    variants: m.variants,
    interactive: m.interactive,
    textBindings: m.textBindings,
    handlers: m.handlers,
    lists: m.lists,
    media: m.media,
    root: m.root,
  };

  const engine = Engine.open({
    ...capacitiesFor(ui),
    width: s.width,
    height: s.height,
    root: ui.root,
    windowed: false,
  });
  try {
    new Uploader(engine, ui).uploadAll();
    engine.tick();

    const rows: Row[] = [];
    for (let n = 0; n < ui.nodes.count; n++) {
      const [x, y, w, h] = engine.bounds(n);
      rows.push({
        label: ui.nodes.text[n]! === -1 ? "div" : "#text",
        parent: ui.nodes.parent[n]!,
        x,
        y,
        w,
        h,
      });
    }
    return rows;
  } finally {
    engine.close();
  }
}

// ── chrome side ──────────────────────────────────────────────────────────────
/**
 * Walks `document.body` in the order dziri's compiler emits nodes: body first,
 * then depth-first, elements and non-whitespace text runs alike.
 *
 * Whitespace-only text nodes are skipped because the compiler drops them, and a
 * text run's own text is trimmed for the same reason. That is a real difference —
 * dziri has no inline flow, so it cannot preserve a collapsed space between two
 * inline boxes — but it is `html-coverage`'s finding, not this tool's, and
 * leaving it in here would misalign every row after it.
 */
const WALK = `(() => {
  const rows = [];
  const visit = (node, parent) => {
    const at = rows.length;
    if (node.nodeType === 3) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      if (!rects.length) return;
      const top = Math.min(...rects.map(r => r.top));
      const bottom = Math.max(...rects.map(r => r.bottom));
      const left = Math.min(...rects.map(r => r.left));
      const right = Math.max(...rects.map(r => r.right));
      rows.push({ label: "#text", parent, x: left, y: top, w: right - left, h: bottom - top, lines: rects.length });
      return;
    }
    const r = node.getBoundingClientRect();
    rows.push({ label: node.tagName.toLowerCase(), parent, x: r.left, y: r.top, w: r.width, h: r.height });
    for (const child of node.childNodes) {
      if (child.nodeType === 3 && !child.textContent.trim()) continue;
      if (child.nodeType !== 1 && child.nodeType !== 3) continue;
      visit(child, at);
    }
  };
  visit(document.body, -1);
  return rows;
})()`;

// ── comparison ───────────────────────────────────────────────────────────────
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
const px = (v: number) => (Math.round(v * 100) / 100).toString();

/** Returns a reason when the two walks are not walks of the same tree. */
function shapeMismatch(dz: Row[], ch: Row[]): string | null {
  if (dz.length !== ch.length) {
    return `${dz.length} nodes in dziri, ${ch.length} in Chrome`;
  }
  for (let i = 0; i < dz.length; i++) {
    if (dz[i]!.parent !== ch[i]!.parent) {
      return `node ${i}: parent ${dz[i]!.parent} in dziri, ${ch[i]!.parent} in Chrome`;
    }
    if (isText(dz[i]!) !== isText(ch[i]!)) {
      return `node ${i}: ${dz[i]!.label} in dziri, ${ch[i]!.label} in Chrome`;
    }
  }
  return null;
}

const dir = await mkdtemp(join(tmpdir(), "dziri-layout-"));
const session = await chromeSession();

/** A fresh target per scenario, so no scenario inherits another's viewport. */
async function chromeWalk(s: Scenario): Promise<Row[]> {
  const wire = session.wire;
  const t = await wire.send("Target.createTarget", { url: "about:blank" });
  const a = await wire.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  try {
    await wire.send("Runtime.enable", {}, sid);
    await wire.send("Page.enable", {}, sid);
    await wire.send(
      "Emulation.setDeviceMetricsOverride",
      { width: s.width, height: s.height, deviceScaleFactor: 1, mobile: false },
      sid,
    );
    const { frameTree } = await wire.send("Page.getFrameTree", {}, sid);
    await wire.send(
      "Page.setDocumentContent",
      {
        frameId: frameTree.frame.id,
        html: `<!doctype html><meta charset=utf-8><style>${RESET}${s.css}</style>${s.html}`,
      },
      sid,
    );
    const r = await wire.send("Runtime.evaluate", { expression: WALK, returnByValue: true }, sid);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value as Row[];
  } finally {
    await wire.send("Target.closeTarget", { targetId: t.targetId });
  }
}

const list = ONLY ? CORPUS.filter((s) => s.name.includes(ONLY)) : CORPUS;
if (!list.length) {
  console.log(`no scenario matches "${ONLY}". known: ${CORPUS.map((s) => s.name).join(", ")}`);
  await session.close();
  await rm(dir, { recursive: true, force: true });
  process.exit(1);
}

/**
 * Scenarios that differ from Chrome **on purpose**, keyed by scenario name.
 *
 * Empty today, and deliberately so. The one scenario that currently differs,
 * `wrap-unbreakable`, is a bug — dziri splits a token with no break opportunity
 * across two lines where Chrome keeps it on one and lets it overflow — and a bug
 * is something to fix, not something to accept. Putting it here would be using
 * the mechanism to make a red run green, which is precisely the failure this is
 * shaped to avoid.
 *
 * The bar, same as `html-coverage`'s: the decision is already written down
 * somewhere else and the entry cites it. An entry that stops matching fails the
 * run, so the list cannot quietly become a way of not fixing things.
 *
 * Worth knowing why this exists at all, given it is empty: box-sizing *was* a
 * deliberate divergence, recorded in three sentences at the top of this file. It
 * was fixed in `d56611d` and the comment went on asserting it for hours. A comment
 * cannot notice it has stopped being true; an entry here fails the next run.
 */
const KNOWN: Record<string, string> = {};
const matchedKnown = new Set<string>();

let agreed = 0;
let disagreed = 0;
let broke = 0;
let knownCount = 0;

try {
  for (const [i, s] of list.entries()) {
    let dz: Row[];
    let ch: Row[];
    try {
      [dz, ch] = [await dziriWalk(dir, s, i), await chromeWalk(s)];
    } catch (e) {
      broke++;
      console.log(`BROKE  ${s.name} — ${(e as Error).message}`);
      continue;
    }

    const shape = shapeMismatch(dz, ch);
    if (shape) {
      disagreed++;
      console.log(`SHAPE  ${s.name} — ${shape}`);
      console.log(`       asks: ${s.asks}`);
      continue;
    }

    const bad: string[] = [];
    for (let n = 0; n < dz.length; n++) {
      const d = dz[n]!;
      const c = ch[n]!;
      // See the header: a text run's width is not the same measurement on the two
      // sides, so it is not compared. Its height is the wrapping question.
      const fields: Array<keyof Row> = isText(d) ? ["y", "h"] : ["x", "y", "w", "h"];
      const off = fields.filter((f) => !near(d[f] as number, c[f] as number));
      if (!off.length) continue;

      const where = off.map((f) => `${f} ${px(c[f] as number)} vs ${px(d[f] as number)}`).join(", ");
      const lines = c.lines === undefined ? "" : `  [chrome ${c.lines} line${c.lines === 1 ? "" : "s"}]`;
      bad.push(`node ${n} ${d.label.padEnd(5)} chrome vs dziri: ${where}${lines}`);
    }

    if (!bad.length) {
      agreed++;
      if (VERBOSE) console.log(`ok     ${s.name}  (${dz.length} nodes)`);
      continue;
    }

    const why = KNOWN[s.name];
    if (why) {
      matchedKnown.add(s.name);
      knownCount++;
      console.log(`KNOWN  ${s.name} — ${why}`);
      for (const b of bad) console.log(`       ${b}`);
      continue;
    }

    disagreed++;
    console.log(`DIFFER ${s.name} @ ${s.width}x${s.height}`);
    console.log(`       asks: ${s.asks}`);
    for (const b of bad) console.log(`       ${b}`);
  }
} finally {
  await session.close();
  await rm(dir, { recursive: true, force: true });
}

const total = list.length;
console.log(
  `\nlayout-diff ${agreed}/${total} scenarios agree within ${TOLERANCE}px` +
    `  ${disagreed} differ, ${knownCount} known, ${broke} error`,
);

// Skipped under --only for the same reason as html-coverage's: a filtered corpus
// makes a live entry look unused, which would turn a narrowing flag into a failure.
const stale = ONLY ? [] : Object.keys(KNOWN).filter((n) => !matchedKnown.has(n));
if (stale.length) {
  console.log(`\nSTALE known-divergence entries — these scenarios now agree:`);
  for (const n of stale) console.log(`  ${n}\n    was: ${KNOWN[n]}`);
  console.log(`Delete them; the divergence they excuse no longer exists.`);
}

process.exit(disagreed || broke || stale.length ? 1 : 0);
