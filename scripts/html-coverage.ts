/**
 * How each HTML element renders in dziri, versus how it renders in Chrome.
 *
 *   bun run html-coverage              # the difference table
 *   bun run html-coverage --same       # also list elements that already match
 *   bun run html-coverage --only h1,p  # a few elements
 *
 * Unlike `css-coverage`, this cannot be static analysis. dziri has no per-element
 * table — it treats elements as generic boxes — so "supported" is not a lookup,
 * it is a *behaviour*: is `<h1>` bold and larger, does `<ul>` have markers, is
 * `<strong>` distinguishable from `<span>`.
 *
 * So this measures, and the output is a difference table rather than pass/fail.
 * That is deliberate: dziri ships no default stylesheet yet, so nearly every
 * element differs and a pass/fail run would be uniformly red and useless.
 *
 * **The difference table IS the default stylesheet's specification.** Write the
 * rules, re-run, watch rows disappear. When a row says `no field`, the property
 * does not exist in STYLE_FIELDS yet and must be added before any rule can set
 * it — those are the ~10 missing properties HTML-ELEMENT-COVERAGE-RESEARCH.md
 * names, surfaced per element instead of as a list.
 */
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeSession } from "./cdp.ts";
import { Display } from "../src/ir.ts";

const ROOT = join(import.meta.dir, "..");
const MDN = join(ROOT, "vendor/mdn/files/en-us/web/html/reference/elements");
const argv = process.argv.slice(2);
const SHOW_SAME = argv.includes("--same");
const onlyIdx = argv.indexOf("--only");
const ONLY = onlyIdx > -1 ? argv[onlyIdx + 1]!.split(",") : null;

/**
 * The properties a default stylesheet actually sets. Kept narrow on purpose:
 * widen this and every row lights up with differences that no UA rule would fix.
 *
 * `field` is the STYLE_FIELDS key, or null when dziri has no way to express the
 * property at all — which is itself the finding.
 */
const PROPS: { css: string; field: string | null; kind: "keyword" | "px" | "int" }[] = [
  { css: "display", field: "display", kind: "keyword" },
  { css: "font-weight", field: "fontWeight", kind: "int" },
  { css: "font-size", field: "fontSize", kind: "px" },
  { css: "margin-block-start", field: "marT", kind: "px" },
  { css: "margin-block-end", field: "marB", kind: "px" },
  { css: "padding-inline-start", field: "padL", kind: "px" },
  { css: "font-style", field: null, kind: "keyword" },
  { css: "font-family", field: null, kind: "keyword" },
  { css: "list-style-type", field: null, kind: "keyword" },
  { css: "text-decoration-line", field: null, kind: "keyword" },
];

/** Committed non-goals — listed as features, not gaps. */
const OUT_OF_SCOPE = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "col", "colgroup",
  "ruby", "rt", "rp", "rb", "rtc",
  "frame", "frameset", "noframes", "marquee", "blink", "acronym", "big", "center",
  "dir", "font", "strike", "tt", "nobr", "plaintext", "xmp", "listing",
]);

/** Elements that render nothing, or need a parent to mean anything. */
const SKIP = new Set([
  "html", "head", "body", "base", "link", "meta", "script", "style", "title", "template",
  "option", "optgroup", "source", "track", "param", "area", "figcaption", "legend",
  "summary", "slot", "noscript",
  // A line-break *opportunity*, not a box. Meaningless without inline text flow.
  "wbr",
]);

/**
 * Elements MDN documents on a shared page rather than one directory per tag.
 * Without this, `h1`–`h6` are absent from the enumeration entirely — the single
 * most important thing a default stylesheet sets, missing because the directory
 * is called `heading_elements` and the name filter rejects the underscore.
 */
const GROUPED: Record<string, string[]> = {
  heading_elements: ["h1", "h2", "h3", "h4", "h5", "h6"],
};

async function elements(): Promise<string[]> {
  const dirs = (await readdir(MDN, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const names = dirs.flatMap((n) => GROUPED[n] ?? (/^[a-z][a-z0-9]*$/.test(n) ? [n] : []));
  return ONLY ? names.filter((n) => ONLY.includes(n)) : [...new Set(names)].sort();
}

/**
 * Attributes some elements need before the UA sheet applies to them.
 * `a` is the one that bites: `text-decoration: underline` comes from
 * `a:-webkit-any-link`, so a bare `<a>` is not a link and reports no underline.
 */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Void elements take no children and no closing tag; `<br>x</br>` is invalid. */
const markup = (el: string) =>
  VOID.has(el) ? `<${el}${ATTRS[el] ?? ""}>` : `<${el}${ATTRS[el] ?? ""}>x</${el}>`;

const ATTRS: Record<string, string> = {
  a: ' href="#"',
  input: ' type="text"',
  progress: ' value="0.5"',
  meter: ' value="0.5"',
  details: " open",
  dialog: " open",
};

/** A minimal sheet: pin the body so nothing inherits a difference we did not ask for. */
const SHEET = "body { margin: 0; padding: 0; font-size: 16px; font-weight: 400; color: #000 }";

// ── dziri ────────────────────────────────────────────────────────────────────
async function dziriRow(dir: string, el: string): Promise<Record<string, number> | string> {
  const html = join(dir, `${el}.html`);
  const css = join(dir, `${el}.css`);
  const out = join(dir, `${el}.gen.ts`);
  await writeFile(html, `<body>${markup(el)}</body>`);
  await writeFile(css, SHEET);

  const p = Bun.spawn(["bun", "run", "src/compile.ts", html, css, "-o", out], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await p.exited) !== 0) {
    // Not `split("\n")[0]`: Bun prints a source excerpt before the message, so the
    // first line is the compiler's own source (`167 | if (…) continue;`) and says
    // nothing about what went wrong. The message is the line starting `error:`.
    // Matching /Error/ instead is the same trap one step further along — the
    // excerpt frequently *is* a `throw new Error(...)` line.
    const err = (await new Response(p.stderr).text()).trim();
    const line = err.split("\n").find((l) => l.trimStart().startsWith("error:"));
    const message = line ? line.trimStart().slice("error:".length) : (err.split("\n").pop() ?? "");
    return message.trim() || "compile failed";
  }
  const mod = await import(`${out}?t=${Date.now()}`);
  if (mod.nodes.count < 2) return "produced no node";
  const slot = mod.nodes.style[1];
  const row: Record<string, number> = {};
  for (const { field } of PROPS) if (field) row[field] = mod.styles[field]?.[slot];
  return row;
}

// ── compare ──────────────────────────────────────────────────────────────────
const px = (s: string) => Math.round(parseFloat(s) * 100) / 100;

/** Reverse the enum so the report says FLEX, not 0. */
const DISPLAY_NAME = Object.fromEntries(Object.entries(Display).map(([k, v]) => [v, k])) as Record<number, string>;

/**
 * Chrome's `display` for an element is one of block / inline / list-item / none
 * (mostly). dziri's initial is FLEX and it has **no inline layout at all** — a
 * committed non-goal — so `inline` vs `FLEX` would otherwise be reported on
 * every one of a hundred elements as if it were a hundred tasks. It is one
 * architectural divergence, counted once at the bottom.
 *
 * `block`, `list-item` and `none` stay per-element: those a default stylesheet
 * genuinely has to set.
 */
function displayFinding(chrome: string, dziri: number): string | null {
  const name = DISPLAY_NAME[dziri] ?? String(dziri);
  if (chrome === "inline" || chrome === "inline-block") return null; // counted separately
  if (chrome === "block" && dziri === Display.BLOCK) return null;
  if (chrome === "none" && dziri === Display.NONE) return null;
  if (chrome === "flex" && dziri === Display.FLEX) return null;
  if (chrome === "grid" && dziri === Display.GRID) return null;
  return `display: chrome ${chrome} · dziri ${name}`;
}

function differs(kind: string, chrome: string, dziri: number): boolean {
  if (dziri === undefined || dziri === null || Number.isNaN(dziri)) return true;
  if (kind === "px") return px(chrome) !== Math.round(dziri * 100) / 100;
  if (kind === "int") return parseInt(chrome, 10) !== Math.round(dziri);
  return true;
}

const dir = await mkdtemp(join(tmpdir(), "dziri-htmlcov-"));
const session = await chromeSession();

type Row = { el: string; diffs: string[]; missing: string[] };
const rows: Row[] = [];
const same: string[] = [];
const skipped: string[] = [];
const outOfScope: string[] = [];
const broke: string[] = [];
const inlineElements: string[] = [];

try {
  const list = await elements();
  console.log(`html-coverage  ${list.length} elements from vendor/mdn\n`);

  for (const el of list) {
    if (SKIP.has(el)) {
      skipped.push(el);
      continue;
    }
    if (OUT_OF_SCOPE.has(el)) {
      outOfScope.push(el);
      continue;
    }

    const dz = await dziriRow(dir, el);
    if (typeof dz === "string") {
      broke.push(`${el}: ${dz}`);
      continue;
    }

    const html =
      `<!doctype html><meta charset=utf-8><style>${SHEET}</style>` +
      `<body>${markup(el)}</body>`;
    const diffs: string[] = [];
    const missing: string[] = [];

    const chromeDisplay = (await session.computedIn(html, el, "display")).trim();
    if (chromeDisplay === "inline" || chromeDisplay === "inline-block") inlineElements.push(el);

    for (const { css, field, kind } of PROPS) {
      const chrome = (await session.computedIn(html, el, css)).trim();

      if (css === "display") {
        const f = displayFinding(chrome, dz[field!]!);
        if (f) diffs.push(f);
        continue;
      }

      if (!field) {
        // dziri cannot express this at all — which is the finding. But only when
        // Chrome's value differs from the property's CSS *initial* value: those
        // are the ones a default stylesheet is actually setting. `list-style-type`
        // is `disc` on every element by initial value and renders a marker only
        // where display is list-item, so reporting it everywhere was noise.
        const boring =
          (css === "font-style" && chrome === "normal") ||
          (css === "text-decoration-line" && chrome === "none") ||
          (css === "list-style-type" && chromeDisplay !== "list-item") ||
          (css === "font-family" && !/mono|serif|cursive|fantasy/i.test(chrome));
        if (!boring) missing.push(`${css}=${chrome}`);
        continue;
      }

      if (differs(kind, chrome, dz[field]!)) diffs.push(`${css}: chrome ${chrome} · dziri ${dz[field]}`);
    }

    if (diffs.length || missing.length) rows.push({ el, diffs, missing });
    else same.push(el);
  }
} finally {
  await session.close();
  await rm(dir, { recursive: true, force: true });
}

for (const r of rows) {
  console.log(`  <${r.el}>`);
  for (const d of r.diffs) console.log(`      ${d}`);
  for (const m of r.missing) console.log(`      no field · ${m}`);
}

console.log(
  `\n  ${rows.length} differ · ${same.length} already match · ${outOfScope.length} out of scope · ` +
    `${skipped.length} not rendered · ${broke.length} failed to compile`,
);
if (SHOW_SAME && same.length) console.log(`\nalready match:\n  ${same.join(", ")}`);
if (broke.length) console.log(`\nfailed to compile:\n  ${broke.slice(0, 8).join("\n  ")}`);
console.log(
  `\nThis table is the default stylesheet's spec. "no field" means the property is not in\n` +
    `STYLE_FIELDS yet and must exist before any rule can set it.`,
);
