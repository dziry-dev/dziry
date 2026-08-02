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
  kind: "color" | "px" | "number" | "int" | "keyword";
  /**
   * For `keyword`: the CSS keyword each of dziri's enum values encodes, indexed
   * by the value. Per-check rather than global, for the same reason `spec-audit`
   * scopes its keyword table per field — the same word is a different number in
   * different properties, and a shared table would make one of them a false pass.
   */
  keywords?: string[];
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

  // `color-mix()` against `transparent` is how Tailwind v4 spells every opacity
  // modifier, and the fold in `parseColorMix` rests on one claim: CSS
  // interpolates premultiplied, so a zero-alpha operand contributes nothing but
  // its weight and the result is the other colour with a scaled alpha —
  // identically in every interpolation space. That is exactly the kind of claim
  // that must come from the oracle rather than from memory, so these three are
  // the assertion. The oklab/srgb pair must agree because Tailwind emits both,
  // srgb as its `@supports` fallback.
  // Mixed `in srgb` so Chrome's answer converts exactly — see the `color(srgb …)`
  // branch in `normalise`, which also records what the oklab spelling returns.
  { decl: "background: color-mix(in srgb, red 50%, transparent)", field: "bg", prop: "background-color", kind: "color" },
  { decl: "background: color-mix(in srgb, red, transparent)", field: "bg", prop: "background-color", kind: "color" },
  {
    decl: "background: color-mix(in srgb, oklch(63.7% 0.237 25.331) 25%, transparent)",
    field: "bg",
    prop: "background-color",
    kind: "color",
  },

  // `border-style` is deliberately spelled out. Chrome computes
  // `border-*-width: 0` unless a style is set, and dziri has no `border-style`
  // field at all — so bare `border-width: 2px` paints in dziri and paints
  // nothing in a browser. Recorded in BROWSER-FACTS.md; testing the shorthand
  // here keeps this case about width rather than re-reporting that divergence.
  { decl: "border: 2px solid #3f3f46", field: "borderWidth", prop: "border-top-width", kind: "px" },
  { decl: "border-radius: 6px", field: "radTL", prop: "border-top-left-radius", kind: "px" },
  // The corner CSS puts last, to pin the shorthand's expansion rather than only its
  // first value — the case the one-field version could not have failed.
  { decl: "border-radius: 1px 2px 3px 4px", field: "radBL", prop: "border-bottom-left-radius", kind: "px" },
  { decl: "border-top-left-radius: 12px", field: "radTL", prop: "border-top-left-radius", kind: "px" },

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

  // The form-control properties (ROADMAP C2 phase 0). Nothing draws a control
  // yet, which is exactly why these belong here: the claim being checked is that
  // the *computed value* is right, and that claim can be settled a milestone
  // before any pixel depends on it.
  //
  // `auto` is deliberately not a case for either colour. dziri encodes it as
  // alpha 0 and Chrome reports the resolved platform colour, so the two are
  // answering different questions — and pretending otherwise would need a
  // normaliser lenient enough to hide a real disagreement.
  { decl: "accent-color: #0284c7", field: "accentColor", prop: "accent-color", kind: "color" },
  { decl: "caret-color: rgb(20, 30, 40)", field: "caretColor", prop: "caret-color", kind: "color" },
  {
    decl: "appearance: none",
    field: "appearance",
    prop: "appearance",
    kind: "keyword",
    keywords: ["none", "auto"],
  },
  {
    decl: "appearance: auto",
    field: "appearance",
    prop: "appearance",
    kind: "keyword",
    keywords: ["none", "auto"],
  },
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
function normalise(c: Check, chrome: string, dziri: number): [string, string] {
  switch (c.kind) {
    case "color": {
      // dziri packs ARGB into a u32; Chrome says "rgb(r, g, b)" / "rgba(...)".
      const a = (dziri >>> 24) & 0xff;
      const r = (dziri >>> 16) & 0xff;
      const g = (dziri >>> 8) & 0xff;
      const b = dziri & 0xff;

      // `color(srgb r g b / a)` — Chrome serialises a `color-mix()` result in the
      // space it was mixed in, not as rgb(). The srgb form converts exactly:
      // components are already sRGB, in 0..1. Handled rather than tolerated,
      // because the alternative is an empty match that compares "undefined" to a
      // real colour and calls it a failure.
      //
      // The `oklab(...)` form Chrome returns for `in oklab` mixes is deliberately
      // NOT handled. Converting it would mean either duplicating the OKLab
      // matrices here or borrowing dziri's own, and borrowing them would compare
      // dziri against itself and make the conversion untestable. Mix `in srgb`
      // when a case needs to assert a colour; observed 2026-08-02, Chrome returns
      // `color-mix(in oklab, red 50%, transparent)` as
      // `oklab(0.627966 0.22488 0.125859 / 0.5)`, which is red's exact oklab
      // triple at half alpha — the space cancels out, as the fold assumes.
      const srgb = chrome.match(/^color\(srgb\s+([^)]+)\)$/);
      if (srgb) {
        const n = srgb[1]!.split(/[/\s]+/).filter(Boolean).map(Number);
        const to255 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
        const ca = n[3] === undefined ? 255 : Math.round(n[3] * 255);
        return [`${to255(n[0]!)},${to255(n[1]!)},${to255(n[2]!)},${ca}`, `${r},${g},${b},${a}`];
      }

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
    case "keyword":
      // `?? String(dziri)` rather than a throw: an unmapped value should read as
      // a disagreement with the number in it, not as a crashed run.
      return [chrome.trim().toLowerCase(), c.keywords?.[dziri] ?? String(dziri)];
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
/**
 * Declarations where dziri differs from Chrome **on purpose**, keyed by the
 * declaration exactly as it appears in CORPUS, valued by the reason.
 *
 * Empty today, and that is the honest state: all 23 cases agree. It exists so the
 * first real divergence has somewhere to go that is not "delete the case", which
 * is what happens to a corpus with no way to say "expected".
 *
 * The bar for adding one, same as `html-coverage`'s: the decision must already be
 * written down somewhere else, and the entry cites it. This records decisions, it
 * does not make them. An entry that stops matching fails the run, so the list
 * cannot rot into a way of not fixing things — that check is at the bottom.
 */
const KNOWN: Record<string, string> = {};
const matched = new Set<string>();

const fails: string[] = [];
const known: string[] = [];
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
    const [want, got] = normalise(c, chrome, dz);

    if (want === got) {
      pass++;
      if (VERBOSE) console.log(`ok    ${c.decl.padEnd(34)} ${c.prop} = ${chrome}`);
    } else {
      const why = KNOWN[c.decl];
      if (why) {
        matched.add(c.decl);
        known.push(`${c.decl.padEnd(34)} ${c.prop}  chrome ${want} · dziri ${got}\n        — ${why}`);
      } else {
        fails.push(`${c.decl.padEnd(34)} ${c.prop}\n        chrome ${want}   dziri ${got}   (raw: "${chrome}" / ${dz})`);
      }
    }
  }
} finally {
  await session.close();
  await rm(dir, { recursive: true, force: true });
}

for (const f of fails) console.log(`FAIL  ${f}`);
for (const k of known) console.log(`KNOWN ${k}`);
for (const e of errors) console.log(`ERR   ${e}`);

const total = cases.length;
const pct = total ? Math.round((pass / total) * 1000) / 10 : 0;
console.log(
  `\nconformance ${pass}/${total} (${pct}%)  ${fails.length} disagree, ` +
    `${known.length} known, ${errors.length} error`,
);

// A recorded divergence that stopped happening is news, and the only reason this
// list cannot quietly become a way of not fixing things. See KNOWN's comment.
const stale = Object.keys(KNOWN).filter((d) => !matched.has(d));
if (stale.length) {
  console.log(`\nSTALE known-divergence entries — these declarations now agree with Chrome:`);
  for (const d of stale) console.log(`  ${d}\n    was: ${KNOWN[d]}`);
  console.log(`Delete them from KNOWN; the divergence they excuse no longer exists.`);
}

process.exit(fails.length || errors.length || stale.length ? 1 : 0);
