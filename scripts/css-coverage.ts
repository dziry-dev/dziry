/**
 * What CSS exists, versus what dziry supports. Named css-coverage, not coverage,
 * because bare "coverage" reads as test coverage — and `coverage/` is where test
 * tooling writes its output.
 *
 *   bun run css-coverage                # the headline numbers
 *   bun run css-coverage --missing      # list what is unsupported and in scope
 *   bun run css-coverage --group grid   # filter by mdn-data group
 *
 * The denominator is the point. A raw diff against all of CSS reports ~460
 * missing properties including `-webkit-box-reflect`, which is not a backlog —
 * it is noise, and worse, it makes deliberate non-goals read as unfinished work.
 * ROADMAP is explicit that full CSS cannot be finished and would destroy the
 * pitch, and that Tailwind defines the subset.
 *
 * So every standard property lands in exactly one bucket:
 *
 *   supported     dziry parses it today
 *   in scope      a UI framework needs it and we do not have it  <- the backlog
 *   out of scope  a committed non-goal, listed as a feature not a gap
 *
 * Only the middle number is actionable, and it is the only one worth tracking
 * over time.
 */
import cssProperties from "mdn-data/css/properties.json";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROPERTIES } from "../src/compiler/properties.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const SHOW_MISSING = argv.includes("--missing");
const groupIdx = argv.indexOf("--group");
const GROUP = groupIdx > -1 ? argv[groupIdx + 1]!.toLowerCase() : null;

type Spec = { initial: string | string[]; inherited: boolean; status: string; groups: string[] };
const SPEC = cssProperties as unknown as Record<string, Spec>;

/**
 * Committed non-goals from ROADMAP, as substring/prefix matchers over property
 * names and mdn-data groups. These are features of the product, not gaps: they
 * are document-layout concerns, and this is a UI framework.
 */
const OUT_OF_SCOPE_GROUPS = [
  "css multi-column layout",
  "css pages", // print
  "css fragmentation",
  "css writing modes",
  "css ruby",
  "css speech",
  "css table", // tables are a committed non-goal
  "filter effects",
  "css scroll snap",
  "css houdini",
];

const OUT_OF_SCOPE_NAMES = [
  /^float$|^clear$/, // floats drag in inline layout
  /^(page|orphans|widows|break-)/, // print and fragmentation
  /^(writing-mode|text-orientation|text-combine)/,
  /^(column-|columns$)/,
  /^ruby-/,
  /^(speak|voice-|pause|rest|cue)/,
  /^(table-layout|border-collapse|border-spacing|caption-side|empty-cells)$/,
  // The two form-control properties ROADMAP C2 declares non-goals. `resize` needs
  // drag handles on a textarea and multi-line editing is deferred indefinitely, so
  // it could never do anything; `field-sizing: content` makes layout depend on the
  // runtime string. The other three — `accent-color`, `caret-color`, `appearance` —
  // are ordinary supported fields and are counted as such.
  /^(resize|field-sizing)$/,
];

const isOutOfScope = (name: string, spec: Spec) =>
  OUT_OF_SCOPE_NAMES.some((re) => re.test(name)) ||
  (spec.groups ?? []).some((g) => OUT_OF_SCOPE_GROUPS.includes(g.toLowerCase()));

/**
 * What dziry parses today: the keys of the compiler's own property table.
 *
 * This used to be a regex over `css.ts`, which made the *layout* of that file's
 * source part of its interface — indentation included. It matched `case` at any
 * depth, so `auto`, `thin` and `none` from `scrollbar-width`'s nested switch arrived
 * here as candidate properties; the `notAProperty` split below is what kept them out
 * of the number, so the published figure was right and the guard was load-bearing.
 * It is not any more: a key in the table is a property by construction.
 */
const parsed = new Set(Object.keys(PROPERTIES));

/**
 * A `case` label is a property only if mdn-data knows it as one. Scoping the
 * scan to `expandDeclaration` was not enough — it contains nested switches over
 * *values*, so `auto`, `thin` and `none` were being counted as supported CSS
 * properties.
 */
const notAProperty = [...parsed].filter((p) => !SPEC[p]);

/**
 * Supporting a shorthand means supporting its longhands: dziry parses `padding`
 * and expands it, so `padding-top` is covered even with no `case "padding-top"`.
 * mdn-data marks a shorthand by giving it an array-valued `initial` listing the
 * longhands it sets, so this needs no table of our own.
 */
/** Shorthands mdn-data does not mark with an array-valued `initial`. */
const EXTRA_SHORTHANDS: Record<string, string[]> = {
  overflow: ["overflow-x", "overflow-y"],
};

const supported = new Set<string>();
for (const p of parsed) {
  const spec = SPEC[p];
  if (!spec) continue;
  supported.add(p);
  if (Array.isArray(spec.initial)) for (const long of spec.initial) supported.add(long);
  // A few shorthands have a single-valued `initial` and so escape the test above.
  for (const long of EXTRA_SHORTHANDS[p] ?? []) supported.add(long);
}

const standard = Object.entries(SPEC).filter(([, v]) => v.status === "standard");

let nSupported = 0;
const inScope: string[] = [];
const outOfScope: string[] = [];

for (const [name, spec] of standard) {
  if (GROUP && !(spec.groups ?? []).some((g) => g.toLowerCase().includes(GROUP))) continue;
  if (supported.has(name)) nSupported++;
  else if (isOutOfScope(name, spec)) outOfScope.push(name);
  else inScope.push(name);
}

// Case labels that are not properties at all. Should stay near zero — if it
// grows, the extraction has started matching another nested switch.
const unknown = notAProperty;

/**
 * The denominator, if one has been defined. One property per line, `#` comments.
 *
 * Deliberately a file rather than a heuristic. "Everything standard minus the
 * committed non-goals" still leaves ~376 properties including `anchor-name` and
 * `view-transition-name`, which a UI framework will never want — so a percentage
 * against it is not just useless, it is actively misleading. ROADMAP says the
 * denominator is Tailwind's utility surface, curated to ~200 cases in A1.
 *
 * Until that file exists, this prints counts and refuses to print a percentage.
 * A made-up denominator is worse than no number.
 */
const DENOM_FILE = join(ROOT, "css-coverage", "in-scope.txt");
let denomList: Set<string> | null = null;
try {
  const text = await readFile(DENOM_FILE, "utf8");
  denomList = new Set(
    text
      .split("\n")
      .map((l) => l.split("#")[0]!.trim()) // split, not regex: `#.*$` cannot cross a CRLF's 
      .filter(Boolean),
  );
} catch {
  /* no denominator defined yet */
}

console.log(`css-coverage  mdn-data ${Object.keys(SPEC).length} properties · ${standard.length} standard`);
console.log("");
console.log(`  supported            ${String(nSupported).padStart(4)}`);
console.log(`  unsupported          ${String(inScope.length).padStart(4)}`);
console.log(`  out of scope         ${String(outOfScope.length).padStart(4)}   committed non-goals (ROADMAP)`);
console.log("");

if (denomList) {
  // A name that is not a real property would silently depress the score forever,
  // and this repo has already been bitten once by an invented CSS value. Fail
  // loudly instead.
  const bogus = [...denomList].filter((p) => !SPEC[p]);
  if (bogus.length) {
    console.log(`  BAD DENOMINATOR — not real CSS properties per mdn-data:`);
    for (const b of bogus) console.log(`    ${b}`);
    console.log(`  fix css-coverage/in-scope.txt`);
    process.exit(1);
  }

  const want = [...denomList];
  const have = want.filter((p) => supported.has(p));
  const missing = want.filter((p) => !supported.has(p));
  const pct = want.length ? Math.round((have.length / want.length) * 1000) / 10 : 0;
  console.log(`  ${pct}% of the defined corpus  (${have.length}/${want.length})   <- the number to publish`);
  if (missing.length && SHOW_MISSING) console.log(`\n  missing from the corpus:\n    ${missing.join(", ")}`);
  // A shorthand is not "outside the corpus" — its longhands are in it. Both kinds
  // of shorthand count: the ones mdn-data marks with an array-valued `initial`,
  // and the ones it does not, which is the entire reason EXTRA_SHORTHANDS exists.
  // Testing only the first listed `overflow` as outside the corpus while
  // `overflow-x` and `overflow-y` were both inside it.
  const isShorthand = (p: string) => Array.isArray(SPEC[p]!.initial) || p in EXTRA_SHORTHANDS;
  const outside = [...supported].filter((p) => SPEC[p] && !denomList!.has(p) && !isShorthand(p));
  if (outside.length) console.log(`  ${outside.length} supported but outside the corpus: ${outside.join(", ")}`);
} else {
  console.log(`  NO PERCENTAGE — no denominator defined.`);
  console.log(`  Create ${"css-coverage/in-scope.txt"} (one property per line) to get one.`);
  console.log(`  "all standard CSS minus non-goals" still leaves ${inScope.length} properties including`);
  console.log(`  anchor-name and view-transition-name, so a % against it would mislead.`);
  console.log(`  ROADMAP A1: the denominator is Tailwind's utility surface, ~200 curated cases.`);
}

// Not "non-standard properties" — they are not properties. They are `case` labels
// from value switches nested inside expandDeclaration, and naming them as
// properties invites someone to go implement `auto`.
if (unknown.length) {
  console.log(`\n  ${unknown.length} case labels that are not properties (nested value switches): ${unknown.join(", ")}`);
}

if (SHOW_MISSING) {
  console.log(`\nin scope and unsupported (${inScope.length})`);
  const byGroup = new Map<string, string[]>();
  for (const name of inScope) {
    const g = (SPEC[name]!.groups ?? ["(ungrouped)"])[0]!;
    byGroup.set(g, [...(byGroup.get(g) ?? []), name]);
  }
  for (const [g, names] of [...byGroup].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${g} (${names.length})`);
    console.log(`    ${names.join(", ")}`);
  }
}

console.log(
  `\nThe in-scope number is the only actionable one. "out of scope" is ROADMAP's committed` +
    `\nnon-goals — floats, tables, writing modes, fragmentation, multi-column, print.`,
);
