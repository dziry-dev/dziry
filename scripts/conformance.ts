/**
 * Chrome as a build-time oracle for the CSS subset.
 *
 *   bun run conformance                 # whole corpus, coverage %
 *   bun run conformance --only padding  # substring filter
 *   bun run conformance --verbose       # print agreements too
 *
 * ROADMAP A1 asks for exactly this: "compile a utility, diff computed values
 * against getComputedStyle", over a curated corpus rather than a generated one,
 * so coverage is a number against a defined denominator instead of a vibe.
 *
 * How it works, per case:
 *   1. write `<div class="probe">` + one rule into a temp html/css pair
 *   2. compile it with dziri, import the emitted module, read the probe's row
 *      out of the style table
 *   3. load the same html/css in headless Chrome, read getComputedStyle
 *   4. normalise both to a comparable string and compare
 *
 * Step 4 is where the judgement lives. dziri stores packed integers and floats;
 * Chrome returns "rgb(24, 24, 27)" and "12px". A mismatch in *representation* is
 * not a conformance failure, so the normalisers below are part of the spec, not
 * incidental plumbing — and each is deliberately strict rather than forgiving,
 * because a lenient normaliser turns a real bug into a pass.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeSession } from "./cdp.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const onlyIdx = argv.indexOf("--only");
const ONLY = onlyIdx > -1 ? argv[onlyIdx + 1] : null;

/** dziri field -> the CSS property Chrome reports it under. */
type Check = {
  decl: string; // what goes inside `.probe { … }`
  field: string; // key in the emitted `styles` object
  prop: string; // CSS property to read from getComputedStyle
  kind: "color" | "px" | "number" | "int";
};

/**
 * The corpus. Small and curated on purpose — A1 says a generated corpus is
 * infinite and untestable because Tailwind's JIT emits arbitrary values we do
 * not support. Everything here is a value the compiler claims to handle.
 */
const CORPUS: Check[] = [
  { decl: "background: #18181b", field: "bg", prop: "background-color", kind: "color" },
  { decl: "background: rgb(20, 30, 40)", field: "bg", prop: "background-color", kind: "color" },
  { decl: "color: #e4e4e7", field: "fg", prop: "color", kind: "color" },
  { decl: "border-color: #3f3f46", field: "borderColor", prop: "border-top-color", kind: "color" },

  // `border-style` is deliberately spelled out. Chrome computes
  // `border-*-width: 0` unless a style is set, and dziri has no `border-style`
  // field at all — so bare `border-width: 2px` paints in dziri and paints
  // nothing in a browser. Recorded in BROWSER-FACTS.md; testing the shorthand
  // here keeps this case about width rather than re-reporting that divergence.
  { decl: "border: 2px solid #3f3f46", field: "borderWidth", prop: "border-top-width", kind: "px" },
  { decl: "border-radius: 6px", field: "radius", prop: "border-top-left-radius", kind: "px" },

  { decl: "padding: 8px", field: "padT", prop: "padding-top", kind: "px" },
  { decl: "padding: 4px 16px", field: "padL", prop: "padding-left", kind: "px" },
  { decl: "padding-bottom: 12px", field: "padB", prop: "padding-bottom", kind: "px" },
  { decl: "margin: 10px", field: "marT", prop: "margin-top", kind: "px" },
  { decl: "margin-right: 7px", field: "marR", prop: "margin-right", kind: "px" },

  { decl: "width: 120px", field: "width", prop: "width", kind: "px" },
  { decl: "height: 40px", field: "height", prop: "height", kind: "px" },
  { decl: "min-width: 30px", field: "minW", prop: "min-width", kind: "px" },
  { decl: "max-width: 300px", field: "maxW", prop: "max-width", kind: "px" },

  { decl: "display: flex; flex-grow: 2", field: "grow", prop: "flex-grow", kind: "number" },
  { decl: "display: flex; flex-shrink: 3", field: "shrink", prop: "flex-shrink", kind: "number" },
  { decl: "display: flex; gap: 12px", field: "gapRow", prop: "row-gap", kind: "px" },
  { decl: "display: flex; column-gap: 9px", field: "gapCol", prop: "column-gap", kind: "px" },

  { decl: "font-size: 18px", field: "fontSize", prop: "font-size", kind: "px" },
  { decl: "font-weight: 600", field: "fontWeight", prop: "font-weight", kind: "int" },

  { decl: "top: 5px; position: absolute", field: "insetT", prop: "top", kind: "px" },
  { decl: "aspect-ratio: 2", field: "aspectRatio", prop: "aspect-ratio", kind: "number" },
];

const page = (decl: string) =>
  `<!doctype html><meta charset=utf-8><title>c</title><link rel=stylesheet href="./case.css">` +
  `<body><div class="probe">x</div></body>`;

const sheet = (decl: string) =>
  // A fixed body so nothing inherits a UA default we did not ask for. dziri has
  // no UA stylesheet yet, so anything left to a default would differ for reasons
  // that are not this test's subject.
  `body { margin: 0; padding: 0; font-size: 16px; color: #000; background: #fff }\n` +
  `.probe { ${decl} }\n`;

// ── dziri side ───────────────────────────────────────────────────────────────
async function dziriValue(dir: string, c: Check, i: number): Promise<number | null> {
  const html = join(dir, `c${i}.html`);
  const css = join(dir, `c${i}.css`);
  const out = join(dir, `c${i}.gen.ts`);
  await writeFile(html, `<body><div class="probe">x</div></body>`);
  await writeFile(css, sheet(c.decl));

  const proc = Bun.spawn(["bun", "run", "src/compile.ts", html, css, "-o", out], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) throw new Error((await new Response(proc.stderr).text()).trim().split("\n")[0]);

  const mod = await import(`${out}?t=${Date.now()}`);
  // The probe is the only element inside <body>, so it is node 1 (0 is body).
  const slot = mod.nodes.style[1];
  const arr = mod.styles[c.field];
  if (!arr) throw new Error(`no field "${c.field}" in the emitted style table`);
  return arr[slot] ?? null;
}

// ── chrome side ──────────────────────────────────────────────────────────────
function normalise(kind: Check["kind"], chrome: string, dziri: number): [string, string] {
  switch (kind) {
    case "color": {
      // dziri packs ARGB into a u32; Chrome says "rgb(r, g, b)" / "rgba(...)".
      const a = (dziri >>> 24) & 0xff;
      const r = (dziri >>> 16) & 0xff;
      const g = (dziri >>> 8) & 0xff;
      const b = dziri & 0xff;
      const m = chrome.match(/rgba?\(([^)]+)\)/);
      const parts = m ? m[1]!.split(",").map((s) => s.trim()) : [];
      const ca = parts[3] === undefined ? 255 : Math.round(Number(parts[3]) * 255);
      return [`${parts[0]},${parts[1]},${parts[2]},${ca}`, `${r},${g},${b},${a}`];
    }
    case "px":
      return [String(Math.round(parseFloat(chrome) * 100) / 100), String(Math.round(dziri * 100) / 100)];
    case "number": {
      // Chrome renders aspect-ratio as "2 / 1"; take the ratio.
      const slash = chrome.match(/^([\d.]+)\s*\/\s*([\d.]+)$/);
      const v = slash ? Number(slash[1]) / Number(slash[2]) : parseFloat(chrome);
      return [String(Math.round(v * 1000) / 1000), String(Math.round(dziri * 1000) / 1000)];
    }
    case "int":
      return [String(parseInt(chrome, 10)), String(Math.round(dziri))];
  }
}

const dir = await mkdtemp(join(tmpdir(), "dziri-conf-"));
// No server needed here: each case is a single rule in one sheet, so inline
// <style> via Page.setDocumentContent is equivalent and avoids a navigation per
// case. Probes that ask about *sheet* interaction (origins, @layer, @import) do
// need the server — that is what `browser-oracle` is for.
const session = await chromeSession();

const cases = ONLY ? CORPUS.filter((c) => c.decl.includes(ONLY) || c.prop.includes(ONLY)) : CORPUS;
let pass = 0;
const fails: string[] = [];
const errors: string[] = [];

try {
  for (const [i, c] of cases.entries()) {
    let dz: number | null;
    try {
      dz = await dziriValue(dir, c, i);
    } catch (e) {
      errors.push(`${c.decl.padEnd(34)} dziri: ${(e as Error).message}`);
      continue;
    }
    if (dz === null || dz === undefined) {
      errors.push(`${c.decl.padEnd(34)} dziri emitted nothing for "${c.field}"`);
      continue;
    }

    const chrome = await session.computed(sheet(c.decl), ".probe", c.prop);
    const [want, got] = normalise(c.kind, chrome, dz);

    if (want === got) {
      pass++;
      if (VERBOSE) console.log(`ok    ${c.decl.padEnd(34)} ${c.prop} = ${chrome}`);
    } else {
      fails.push(`${c.decl.padEnd(34)} ${c.prop}\n        chrome ${want}   dziri ${got}   (raw: "${chrome}" / ${dz})`);
    }
  }
} finally {
  await session.close();
  await rm(dir, { recursive: true, force: true });
}

for (const f of fails) console.log(`FAIL  ${f}`);
for (const e of errors) console.log(`ERR   ${e}`);

const total = cases.length;
const pct = total ? Math.round((pass / total) * 1000) / 10 : 0;
console.log(`\nconformance ${pass}/${total} (${pct}%)  ${fails.length} disagree, ${errors.length} error`);
process.exit(fails.length || errors.length ? 1 : 0);
