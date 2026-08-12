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
 * The difference table IS the default stylesheet's specification. Write the
 * rules (in `src/compiler/ua-sheet.ts`), re-run, watch rows disappear. When a
 * row says `no field`, the property does not exist in STYLE_FIELDS yet and must
 * be added before any rule can set it — `list-style-type` is the last one.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { chromeSession } from "./cdp.ts";
import { Display } from "../src/ir.ts";
import { FontStyle, FontFamily } from "../src/protocol/generated.ts";
import { compileSnippet } from "../src/compiler/single.ts";
import { toCompiledUi } from "../src/compiler/compile.ts";

const ROOT = join(import.meta.dir, "..");
const MDN = join(ROOT, "vendor/mdn/files/en-us/web/html/reference/elements");
const argv = process.argv.slice(2);
const SHOW_SAME = argv.includes("--same");
const SHOW_KNOWN = argv.includes("--known");
const onlyIdx = argv.indexOf("--only");
const ONLY = onlyIdx > -1 ? argv[onlyIdx + 1]!.split(",") : null;

/**
 * The properties a default stylesheet actually sets. Kept narrow on purpose:
 * widen this and every row lights up with differences that no UA rule would fix.
 *
 * `field` is the STYLE_FIELDS key, or null when dziri has no way to express the
 * property at all — which is itself the finding. `match` decodes the enum or
 * bit set the field stores and compares it against Chrome's computed keyword;
 * without one, a keyword row would compare a number to a string and differ
 * forever.
 */
const PROPS: {
  css: string;
  field: string | null;
  kind: "keyword" | "px" | "int";
  match?: (chrome: string, dziri: number) => boolean;
}[] = [
  { css: "display", field: "display", kind: "keyword" },
  { css: "font-weight", field: "fontWeight", kind: "int" },
  { css: "font-size", field: "fontSize", kind: "px" },
  { css: "margin-block-start", field: "marT", kind: "px" },
  { css: "margin-block-end", field: "marB", kind: "px" },
  { css: "padding-inline-start", field: "padL", kind: "px" },
  {
    css: "font-style",
    field: "fontStyle",
    kind: "keyword",
    match: (chrome, dz) =>
      (dz === FontStyle.ITALIC) === (chrome === "italic" || chrome.startsWith("oblique")),
  },
  {
    css: "font-family",
    field: "fontFamily",
    kind: "keyword",
    // dziri stores a generic family, not a name: match on the category. Chrome
    // computes its UA monospace to the literal keyword "monospace", and every
    // other default here (Times New Roman, Arial on controls) is non-monospace.
    match: (chrome, dz) => (dz === FontFamily.MONOSPACE) === /mono/i.test(chrome),
  },
  { css: "list-style-type", field: null, kind: "keyword" },
  {
    css: "text-decoration-line",
    field: "decorationLine",
    kind: "keyword",
    // The field is a bit set (1 underline, 2 overline, 4 line-through); Chrome's
    // computed value is a space-separated keyword list, "none" when empty.
    match: (chrome, dz) => {
      const bits =
        (chrome.includes("underline") ? 1 : 0) |
        (chrome.includes("overline") ? 2 : 0) |
        (chrome.includes("line-through") ? 4 : 0);
      return dz === bits;
    },
  },
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
function dziriRow(el: string): Record<string, number> | string {
  // In this process, so a compile failure is an exception with a message rather
  // than a subprocess's stderr to be mined. The parsing this replaced is worth
  // remembering: Bun prints a source excerpt before a thrown message, so
  // `split("\n")[0]` was the *compiler's own source* (`167 | if (…) continue;`) and
  // said nothing about the element. Matching /Error/ was the same trap one step on,
  // since the excerpt frequently *is* a `throw new Error(...)` line. The message was
  // the line starting `error:`, and none of that is needed to read `e.message`.
  let ui;
  try {
    ui = toCompiledUi(compileSnippet({ html: `<body>${markup(el)}</body>`, css: SHEET, label: `<${el}>` }).result);
  } catch (e) {
    return (e as Error).message || "compile failed";
  }
  if (ui.nodes.count < 2) return "produced no node";
  const slot = ui.nodes.style[1]!;
  const styles = ui.styles as unknown as Record<string, ArrayLike<number> | undefined>;
  const row: Record<string, number> = {};
  for (const { field } of PROPS) if (field) row[field] = styles[field]?.[slot] as number;
  return row;
}

// ── compare ──────────────────────────────────────────────────────────────────
const px = (s: string) => Math.round(parseFloat(s) * 100) / 100;

/** Reverse the enum so the report says FLEX, not 0. */
const DISPLAY_NAME = Object.fromEntries(Object.entries(Display).map(([k, v]) => [v, k])) as Record<number, string>;

/**
 * Differences that are decisions, not gaps.
 *
 * This table exists because the headline number was two unrelated things added
 * together. `<p>` differs from Chrome because dziri has no default stylesheet yet
 * — a real gap, and the reason this tool exists. `<span>` differs because dziri
 * has no inline layout, deliberately, permanently. Printed identically, they
 * forced every reader to re-derive which was which, and a backlog you have to
 * mentally filter is a backlog nobody reads.
 *
 * Three rules keep this from decaying into a suppression list, which is how a
 * report like this normally dies:
 *
 *  1. **Every entry carries a reason, and the reason is printed.** Not hidden in a
 *     config file — `--known` shows the lot, and the count is always in the summary.
 *  2. **An entry that matches nothing is a failure.** If the divergence it excuses
 *     stops happening, the entry is stale and says so. That is the property a
 *     comment cannot have: `layout-diff`'s box-sizing note was true when written,
 *     became false hours later when the engine changed, and nothing noticed.
 *  3. **Nothing is added here without it already being decided somewhere else.**
 *     Both entries below cite where the decision lives. This table records
 *     decisions; it does not make them, because a tool that can shrink its own
 *     backlog by fiat is worthless.
 */
type KnownDivergence = {
  id: string;
  why: string;
  /** `dziri` is null when the finding is "dziri has no field for this at all". */
  when: (el: string, css: string, chrome: string, dziri: string | null) => boolean;
};

const KNOWN: KnownDivergence[] = [
  {
    id: "block-is-flex-column",
    why: "no block layout: INITIAL_STYLE is display FLEX with direction COLUMN, which stacks children the way block does (src/ir.ts)",
    when: (_el, css, chrome, dziri) => css === "display" && chrome === "block" && dziri === "FLEX",
  },
  // There was a second entry here, `no-font-family-field`, and removing it is the
  // clearest illustration of the bar above. It excused every `font-family`
  // difference on the grounds that dziri has no such field — citing layout-diff's
  // header, which says exactly that. But that sentence is a statement of a *current
  // limitation*, written to justify pinning Chrome's font in a reset. It is not a
  // decision that the field will never exist, and HTML-ELEMENT-COVERAGE-RESEARCH.md
  // lists `font-family` first among the ten properties Tier 0b needs.
  //
  // So the entry was an exemption hiding backlog, which is the one thing this table
  // must never do. "Cite where the decision was made" has to mean a decision, not
  // any sentence that describes the same fact.
];

/** Which entries earned their place this run. An unused one is stale, not silent. */
const matched = new Set<string>();

function knownReason(el: string, css: string, chrome: string, dziri: string | null): string | null {
  const hit = KNOWN.find((k) => k.when(el, css, chrome, dziri));
  if (!hit) return null;
  matched.add(hit.id);
  return hit.why;
}

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

// No temp directory: the dziri side compiles in this process, so there are no paths
// to hand a subprocess and nothing to clean up.
const session = await chromeSession();

type Row = { el: string; diffs: string[]; missing: string[]; known: string[] };
const rows: Row[] = [];
const knownOnly: Row[] = [];
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

    const dz = dziriRow(el);
    if (typeof dz === "string") {
      broke.push(`${el}: ${dz}`);
      continue;
    }

    const html =
      `<!doctype html><meta charset=utf-8><style>${SHEET}</style>` +
      `<body>${markup(el)}</body>`;
    const diffs: string[] = [];
    const missing: string[] = [];
    const known: string[] = [];

    const chromeDisplay = (await session.computedIn(html, el, "display")).trim();
    if (chromeDisplay === "inline" || chromeDisplay === "inline-block") inlineElements.push(el);

    for (const { css, field, kind, match } of PROPS) {
      const chrome = (await session.computedIn(html, el, css)).trim();

      if (css === "display") {
        const f = displayFinding(chrome, dz[field!]!);
        if (f) {
          const name = DISPLAY_NAME[dz[field!]!] ?? String(dz[field!]);
          const why = knownReason(el, css, chrome, name);
          if (why) known.push(`${f}  — ${why}`);
          else diffs.push(f);
        }
        continue;
      }

      if (!field) {
        // dziri cannot express this at all — which is the finding. But only when
        // Chrome's value differs from the property's CSS *initial* value: those
        // are the ones a default stylesheet is actually setting. `list-style-type`
        // is `disc` on every element by initial value and renders a marker only
        // where display is list-item, so reporting it everywhere was noise.
        const boring =
          (css === "list-style-type" && chromeDisplay !== "list-item");
        if (!boring) {
          const why = knownReason(el, css, chrome, null);
          if (why) known.push(`no field · ${css}=${chrome}  — ${why}`);
          else missing.push(`${css}=${chrome}`);
        }
        continue;
      }

      const different = match ? !match(chrome, dz[field]!) : differs(kind, chrome, dz[field]!);
      if (different) {
        const why = knownReason(el, css, chrome, String(dz[field]));
        if (why) known.push(`${css}: chrome ${chrome} · dziri ${dz[field]}  — ${why}`);
        else diffs.push(`${css}: chrome ${chrome} · dziri ${dz[field]}`);
      }
    }

    // An element whose *only* differences are known ones is not backlog. It is
    // counted separately rather than as "already match", because it does not
    // match — it differs for a reason that has been accepted.
    if (diffs.length || missing.length) rows.push({ el, diffs, missing, known });
    else if (known.length) knownOnly.push({ el, diffs, missing, known });
    else same.push(el);
  }
} finally {
  await session.close();
}

for (const r of rows) {
  console.log(`  <${r.el}>`);
  for (const d of r.diffs) console.log(`      ${d}`);
  for (const m of r.missing) console.log(`      no field · ${m}`);
}

const knownCount = [...rows, ...knownOnly].reduce((n, r) => n + r.known.length, 0);

console.log(
  `\n  ${rows.length} differ · ${knownOnly.length} known only · ${same.length} already match · ` +
    `${outOfScope.length} out of scope · ${skipped.length} not rendered · ${broke.length} failed to compile`,
);
console.log(`  ${knownCount} finding(s) accepted by ${matched.size}/${KNOWN.length} known-divergence entries`);

if (SHOW_KNOWN) {
  console.log("\nknown divergences — decisions, not backlog");
  for (const r of [...knownOnly, ...rows].sort((a, b) => a.el.localeCompare(b.el))) {
    if (!r.known.length) continue;
    console.log(`  <${r.el}>`);
    for (const k of r.known) console.log(`      ${k}`);
  }
} else if (knownCount) {
  console.log(`  (--known to see them and why)`);
}

if (SHOW_SAME && same.length) console.log(`\nalready match:\n  ${same.join(", ")}`);
if (broke.length) console.log(`\nfailed to compile:\n  ${broke.slice(0, 8).join("\n  ")}`);
console.log(
  `\nThis table is the default stylesheet's spec. "no field" means the property is not in\n` +
    `STYLE_FIELDS yet and must exist before any rule can set it.`,
);

/**
 * The one thing that makes the table above a ledger rather than a mute list: an
 * entry that excuses nothing has outlived the divergence it was written for, and
 * says so instead of sitting there being quietly wrong. This is the only condition
 * under which this tool exits non-zero — 59 differences are a report, a stale
 * exemption is a defect in the report itself.
 *
 * Note it can also fire for an innocent reason: `--only` narrows the run, so an
 * entry that would have matched an element outside the filter looks unused. Hence
 * the check is skipped when the corpus was filtered.
 */
const stale = ONLY ? [] : KNOWN.filter((k) => !matched.has(k.id));
if (stale.length) {
  console.log("\nSTALE known-divergence entries — they matched nothing this run:");
  for (const k of stale) console.log(`  ${k.id}\n    was: ${k.why}`);
  console.log(
    `\nEither the divergence was fixed, in which case delete the entry, or the finding\n` +
      `it matched changed shape, in which case it is no longer accepted and should be\n` +
      `re-read rather than re-worded.`,
  );
  process.exit(1);
}
