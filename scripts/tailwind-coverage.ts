/**
 * What fraction of Tailwind actually works in dziri, and what is blocking the rest.
 *
 *   bun run tailwind-coverage             # summary + ranked blockers
 *   bun run tailwind-coverage --missing   # every unsupported property
 *   bun run tailwind-coverage --sample p- # inspect classes matching a prefix
 *
 * The corpus is Tailwind's own, not a curated list: `__unstable__loadDesignSystem`
 * (the API IntelliSense and the Prettier plugin use) enumerates every class the
 * *installed* version can generate — 23,286 of them. Those are compiled by the
 * real CLI, so what we compare against is what Tailwind actually emits, not what
 * the docs say it emits. That distinction matters: the docs show `shadow-lg` as a
 * tidy `box-shadow`, while v4 emits `--tw-shadow` and a `color-mix()`.
 *
 * **Ranked by classes unblocked, not by property count.** Most of the 23k classes
 * fail for the same few reasons, so a per-property list would be a grind of
 * hundreds of items. One parser feature can unblock thousands of classes; that is
 * the number worth ordering by.
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import cssProperties from "mdn-data/css/properties.json";

const ROOT = join(import.meta.dir, "..");
const TMP = join(ROOT, ".tw-tmp");
const argv = process.argv.slice(2);
const SHOW_MISSING = argv.includes("--missing");
const WHAT_IF = argv.includes("--what-if");
const whatIfIdx = argv.indexOf("--what-if");
const WHAT_IF_SET =
  whatIfIdx > -1 && argv[whatIfIdx + 1] && !argv[whatIfIdx + 1]!.startsWith("--")
    ? argv[whatIfIdx + 1]!
    : null;
const sampleIdx = argv.indexOf("--sample");
const SAMPLE = sampleIdx > -1 ? argv[sampleIdx + 1]! : null;

const SPEC = cssProperties as unknown as Record<string, { initial: string | string[]; groups?: string[] }>;

// ── what dziri parses ────────────────────────────────────────────────────────
async function dziriSupported(): Promise<Set<string>> {
  const src = await readFile(join(ROOT, "src/compiler/css.ts"), "utf8");
  const start = src.search(/function expandDeclaration\b/);
  if (start === -1) throw new Error("could not find expandDeclaration() in src/compiler/css.ts");
  const body = src.slice(start, src.indexOf("\n}", start));

  const out = new Set<string>();
  for (const m of body.matchAll(/case\s+"([a-z-]+)":/g)) {
    const name = m[1]!;
    const spec = SPEC[name];
    if (!spec) continue; // a value keyword from a nested switch, not a property
    out.add(name);
    // Supporting a shorthand means supporting its longhands.
    if (Array.isArray(spec.initial)) for (const long of spec.initial) out.add(long);
  }
  out.add("overflow-x");
  out.add("overflow-y"); // `overflow`'s initial is single-valued, so the test above misses it
  return out;
}

// ── Tailwind's own class list, for the installed version ─────────────────────
async function tailwindClasses(): Promise<string[]> {
  const { __unstable__loadDesignSystem } = (await import("tailwindcss")) as any;
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const ds = await __unstable__loadDesignSystem(`@import "tailwindcss";`, {
    base: ROOT,
    loadStylesheet: async (id: string) => {
      const file = join(ROOT, id === "tailwindcss" ? "node_modules/tailwindcss/index.css" : `node_modules/${id}`);
      return { base: path.dirname(file), content: await fs.readFile(file, "utf8") };
    },
  });
  return ds.getClassList().map((e: unknown) => (Array.isArray(e) ? e[0] : e));
}

/** Run the real CLI over every class and return the generated stylesheet. */
async function compileAll(classes: string[]): Promise<string> {
  await mkdir(TMP, { recursive: true });
  // The input file must live inside the project: `@import "tailwindcss"` resolves
  // relative to it, so a temp dir outside node_modules' reach fails to resolve.
  await writeFile(join(TMP, "in.css"), `@import "tailwindcss";\n`);
  await writeFile(join(TMP, "content.html"), `<div class="${classes.join(" ")}"></div>`);
  const p = Bun.spawn(
    ["bunx", "@tailwindcss/cli", "-i", join(TMP, "in.css"), "-o", join(TMP, "out.css"), "--content", join(TMP, "content.html")],
    { cwd: ROOT, stdout: "ignore", stderr: "pipe" },
  );
  if ((await p.exited) !== 0) throw new Error(`tailwind CLI failed:\n${await new Response(p.stderr).text()}`);
  return readFile(join(TMP, "out.css"), "utf8");
}

/**
 * Map each class to the declarations its rule contains.
 *
 * Brace-depth scan rather than a regex: the output nests rules inside `@layer`,
 * `@media` and `@supports`, and a flat regex either misses those or swallows
 * whole layers as one "rule".
 */
function rulesByClass(css: string, known: Set<string>): Map<string, { props: Set<string>; values: string }> {
  const out = new Map<string, { props: Set<string>; values: string }>();
  let selStart = 0;
  const stack: string[] = [];

  /** `.p-4`, `.p-0\.5`, `.w-1\/2`, `.hover\:bg-blue-500:hover` */
  const classesIn = (selector: string): string[] => {
    const names: string[] = [];
    for (const m of selector.matchAll(/\.((?:[\w-]|\\.)+)/g)) names.push(m[1]!.replace(/\\(.)/g, "$1"));
    return names;
  };

  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      // Only the tail is the selector. v4 nests `@supports` *inside* a rule, and
      // puts declarations before it:
      //
      //   .shadow-red-500 {
      //     --tw-shadow-color: color-mix(in oklab, oklch(63.7% 0.237 25.331) …);
      //     @supports (color: color-mix(in lab, red, red)) {   <-- here
      //
      // Slicing from the last brace swept that declaration into the "selector",
      // and `\.[\w-]+` then read `63.7%` as the classes `.7`, `.237`, `.331`.
      // That produced 349 phantom entries in the corpus and was how `color-mix()`
      // appeared to unblock 333 classes that do not exist. Cut at the last `;` or
      // `}` so a selector is only ever a selector.
      const raw = css.slice(selStart, i);
      const cut = Math.max(raw.lastIndexOf(";"), raw.lastIndexOf("}"));
      stack.push(raw.slice(cut + 1).trim());
      selStart = i + 1;
    } else if (c === "}") {
      const body = css.slice(selStart, i);
      const selector = stack.pop() ?? "";
      selStart = i + 1;
      if (body.includes("{")) continue; // a container, not a declaration block

      const props = new Set<string>();
      for (const decl of body.split(";")) {
        const colon = decl.indexOf(":");
        if (colon === -1) continue;
        const name = decl.slice(0, colon).trim();
        if (/^[a-z-]+$/.test(name) || name.startsWith("--")) props.add(name);
      }
      if (!props.size) continue;

      // A nested block's own selector often names no class — `.divide-y` wraps
      // `:where(& > :not(:last-child))`, and `@supports` wraps nothing at all —
      // so attribute to the nearest enclosing selector that does. Without this
      // those declarations were dropped and the class looked free of blockers.
      let names = classesIn(selector);
      for (let s = stack.length - 1; !names.length && s >= 0; s--) names = classesIn(stack[s]!);

      for (const name of names) {
        // `known` is the authority on what a class is: it comes from Tailwind's
        // own `getClassList()`. Anything else is a scrape artifact, and counting
        // it inflates both the numerator and the denominator.
        if (!known.has(name)) continue;
        const entry = out.get(name) ?? { props: new Set<string>(), values: "" };
        for (const p of props) entry.props.add(p);
        entry.values += body;
        out.set(name, entry);
      }
    }
  }
  return out;
}

/**
 * Value-level features dziri's parser would also have to learn. A class can be
 * blocked by *how* a value is written even when the property itself is supported.
 */
const VALUE_FEATURES: { name: string; test: RegExp }[] = [
  // `color-mix()` is implemented for the one form that folds exactly: against a
  // transparent operand, which is how Tailwind spells every opacity modifier.
  // Narrowed rather than deleted, same as calc() below.
  //
  // What is left is `currentcolor`, which `parseColor` has no value for — there
  // is no inherited colour at parse time. A mix between two *visible* colours is
  // also unsupported (it needs real interpolation, and `parseColorMix` throws
  // rather than approximating), but it gets no entry here because the corpus
  // contains none: every color-mix Tailwind v4 emits is against `transparent`.
  // If that changes, this is the line that has to grow — a regex for a form that
  // does not occur is untested either way.
  { name: "color-mix() with currentcolor", test: /color-mix\([^;]*currentcolor/ },

  // `var()` and plain `calc()` are gone from this list because they are
  // implemented: the compiler resolves custom properties through the cascade and
  // folds calc() to a number. What is left of calc() is the part that cannot be
  // folded — a length that is not knowable until layout runs. Those are still
  // blockers, and narrowing the pattern rather than deleting the entry is what
  // keeps this honest: the number moved because the feature landed, not because
  // the measuring stick was shortened.
  { name: "calc() over percentages / viewport units", test: /calc\([^)]*(%|\d(vw|vh|vmin|vmax)\b)/ },

  // A bare percentage length, which `parseLength` rejects outright
  // (`css.ts:1044`) for the same reason as the calc() case above: there is no
  // parent box to resolve it against until layout runs.
  //
  // This entry was missing, and its absence was not a rounding error. Nothing
  // else here tests for a percentage *outside* calc(), so every class Tailwind
  // emits as a plain `%` length counted as working — including `w-full` and
  // `h-full`, which are `width: 100%` and `height: 100%` and throw a fatal
  // CssError through `compile.ts:290`. The tool reported support for two of the
  // most-used classes in Tailwind while the compiler refused to build them.
  //
  // The `[^;(){}]*` is the whole trick: it forbids an opening paren between the
  // colon and the `%`, which is what separates a percentage used as a length
  // from one used as a component inside a function. `width: 50%` matches;
  // `oklch(70% 0.1 200)` does not, because its `%` is a lightness; gradient
  // stops and `calc(100% - 1rem)` do not either, and the calc() entry above
  // already owns the latter.
  { name: "percentage length", test: /:[^;(){}]*\d%/ },

  // `@property` was listed here and is now implemented — the compiler records
  // `initial-value` and honours `inherits: false`, which is what Tailwind's
  // `--tw-*` transform variables need.
  //
  // Worth recording how it left this list, because the entry was wrong in a way
  // that flattered the number: `test` was matched against declaration *values*
  // while the pattern `/^--tw-/` describes a property *name*, so it never fired.
  // For as long as it sat here, `translate-x-4` counted as working — the property
  // was supported and `var()` was not a blocker — while it rendered nothing at
  // all, because `--tw-translate-y` had no value and CSS drops a declaration whose
  // `var()` cannot resolve. The percentage did not move when `@property` landed;
  // it became true.
  //
  // The lesson for anything added below: a `test` over `values` cannot see a
  // property name, and a blocker that never fires is indistinguishable from a
  // feature that works.
];

const supported = await dziriSupported();
const classes = await tailwindClasses();
console.log(`tailwind-coverage  ${classes.length} classes from the installed tailwindcss\n`);

const css = await compileAll(classes);
const rules = rulesByClass(css, new Set(classes));

// Not every enumerable class emits a rule on its own — some only produce one in a
// variant or container context. They are outside the denominator because there is
// nothing for dziri to succeed or fail at, but the count is printed rather than
// dropped silently: a denominator that quietly excludes classes reads as coverage.
const noRule = classes.filter((c) => !rules.has(c)).length;

const allProps = new Set<string>();
for (const { props } of rules.values()) for (const p of props) if (!p.startsWith("--")) allProps.add(p);

/** class -> the reasons it cannot work today */
const blockers = new Map<string, Set<string>>();
let clean = 0;

for (const [name, { props, values }] of rules) {
  const why = new Set<string>();
  for (const p of props) {
    // Declaring a custom property is no longer a blocker — the compiler keeps
    // `--*` declarations, inherits them, and substitutes `var()` before any
    // property parser runs. Only `--tw-*` is still special, and `VALUE_FEATURES`
    // says why.
    if (p.startsWith("--")) continue;
    if (!supported.has(p)) why.add(`property: ${p}`);
  }
  for (const f of VALUE_FEATURES) if (f.test.test(values)) why.add(f.name);
  if (why.size) blockers.set(name, why);
  else clean++;
}

const impact = new Map<string, number>();
for (const why of blockers.values()) for (const w of why) impact.set(w, (impact.get(w) ?? 0) + 1);

const propsHave = [...allProps].filter((p) => supported.has(p)).length;
console.log(`  properties   ${propsHave}/${allProps.size} supported (${((propsHave / allProps.size) * 100).toFixed(1)}%)`);
console.log(
  `  classes      ${clean}/${rules.size} work today (${((clean / rules.size) * 100).toFixed(1)}%)`,
);
console.log(`               ${noRule} of ${classes.length} emit no rule alone and are not counted\n`);

console.log("  blockers, ranked by classes unblocked:");
for (const [why, n] of [...impact].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`    ${String(n).padStart(6)}  ${why}`);
}

/**
 * What the ranked list above cannot answer: a class usually has *several*
 * blockers, so the counts overlap and do not add up. "20431 for var()" is the
 * number of classes that would stop being blocked *by var()*, not the number that
 * would start working. This walks the ranked list cumulatively, removing one
 * blocker at a time and reporting how many classes end up with no reasons left —
 * which is the only figure a plan can be built on.
 */
if (WHAT_IF) {
  console.log("\n  cumulative, in rank order — classes that actually work once each lands:");
  const order = [...impact].sort((a, b) => b[1] - a[1]).map(([why]) => why);
  const removed = new Set<string>();
  let previous = clean;
  for (const why of order.slice(0, 12)) {
    removed.add(why);
    const works = [...rules.keys()].filter((n) => {
      const w = blockers.get(n);
      return !w || [...w].every((r) => removed.has(r));
    }).length;
    const pct = ((works / rules.size) * 100).toFixed(1);
    const delta = works - previous;
    console.log(
      `    +${String(delta).padStart(6)}  ->  ${String(works).padStart(6)}/${rules.size} (${pct.padStart(5)}%)  after ${why}`,
    );
    previous = works;
  }

  // And an arbitrary combination, because the cumulative list can only answer
  // questions in rank order — "var() and calc(), but not masks" is not a prefix
  // of it, and that is exactly the shape of a real plan.
  if (WHAT_IF_SET) {
    const wanted = WHAT_IF_SET.split(",").map((s) => s.trim().toLowerCase());
    const matches = (r: string) => wanted.some((w) => r.toLowerCase().includes(w));
    const named = [...impact.keys()].filter(matches);
    const works = [...rules.keys()].filter((n) => {
      const w = blockers.get(n);
      return !w || [...w].every(matches);
    }).length;
    console.log(
      `\n  just [${named.join(", ")}]:\n` +
        `    ${works}/${rules.size} (${((works / rules.size) * 100).toFixed(1)}%), up from ${clean} (${((clean / rules.size) * 100).toFixed(1)}%)`,
    );
  }
}

if (SHOW_MISSING) {
  const missing = [...allProps].filter((p) => !supported.has(p)).sort();
  const byGroup = new Map<string, string[]>();
  for (const p of missing) {
    const g = (SPEC[p]?.groups ?? ["(not a standard property)"])[0]!;
    byGroup.set(g, [...(byGroup.get(g) ?? []), p]);
  }
  console.log(`\n  unsupported properties (${missing.length}), by spec group:`);
  for (const [g, ps] of [...byGroup].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n    ${g} (${ps.length})`);
    console.log(`      ${ps.join(", ")}`);
  }
}

if (SAMPLE) {
  const hits = [...rules].filter(([n]) => n.startsWith(SAMPLE)).slice(0, 12);
  console.log(`\n  classes starting "${SAMPLE}":`);
  for (const [n, { props }] of hits) {
    const why = blockers.get(n);
    console.log(`    ${n.padEnd(22)} ${[...props].join(", ")}`);
    if (why) console.log(`    ${" ".repeat(22)} blocked: ${[...why].join(" · ")}`);
  }
}

await rm(TMP, { recursive: true, force: true });
console.log(
  `\n  Ranked by classes unblocked, not by property count — most of these fail for\n` +
    `  the same few reasons, and one parser feature moves thousands at once.`,
);
