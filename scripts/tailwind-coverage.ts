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
import { parseSelector, splitSelectorList } from "../src/compiler/css.ts";
import { CssError } from "../src/compiler/diagnostics.ts";
import { expandDeclaration, PROPERTIES } from "../src/compiler/properties.ts";
import { substituteCurrentColor } from "../src/compiler/values.ts";

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
/**
 * What dziri parses, from the compiler's own property table.
 *
 * Was a regex over `css.ts`'s source. The `if (!spec) continue` below used to be
 * load-bearing for a second reason — the regex matched `case` at any depth, so value
 * keywords from nested switches arrived here and had to be filtered out. They no
 * longer do; the guard now only skips properties `mdn-data` does not know.
 */
function dziriSupported(): Set<string> {
  const out = new Set<string>();
  for (const name of Object.keys(PROPERTIES)) {
    const spec = SPEC[name];
    if (!spec) continue;
    out.add(name);
    // Supporting a shorthand means supporting its longhands.
    if (Array.isArray(spec.initial)) for (const long of spec.initial) out.add(long);
  }
  out.add("overflow-x");
  out.add("overflow-y"); // `overflow`'s initial is single-valued, so the test above misses it
  out.add("-webkit-backdrop-filter"); // vendor-prefixed; not in mdn-data, parsed by dziri
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
    // `--bun` is load-bearing: without it bunx defers to the bin's `node` shebang,
    // and the CLI then runs on whatever Node is on PATH — measured failing on a
    // system Node 16 (`isBuiltin` missing) while every other script here runs Bun.
    ["bunx", "--bun", "@tailwindcss/cli", "-i", join(TMP, "in.css"), "-o", join(TMP, "out.css"), "--content", join(TMP, "content.html")],
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
/**
 * Every reason `parseSelector` refused one of the sheet's selectors, per class.
 *
 * This exists because the tool had a blind spot exactly the shape of the two it
 * already documents below, and it cost a build. Everything else here is measured
 * over *declarations* — the property names and the value text — so a class whose
 * property and value were both supported counted as working even when the
 * compiler refused its **selector** and threw a fatal `CssError`.
 *
 * `space-y-*` and `divide-*` are the case. Tailwind emits them as
 * `:where(.space-y-4 > :not(:last-child))`, whose declarations are an ordinary
 * `margin-block-end`; all 450 of them were reported as working while
 * `bun run dev` failed to compile the sheet at all. A selector is as much a
 * parser feature as a value is, and a fatal error is the loudest possible failure
 * to have been counting as a pass.
 */
function selectorBlockers(css: string, known: Set<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let selStart = 0;
  const stack: string[] = [];

  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      const raw = css.slice(selStart, i);
      const cut = Math.max(raw.lastIndexOf(";"), raw.lastIndexOf("}"));
      stack.push(raw.slice(cut + 1).trim());
      selStart = i + 1;
      continue;
    }
    if (ch !== "}") continue;

    const body = css.slice(selStart, i);
    const selector = stack.pop() ?? "";
    selStart = i + 1;
    // A container's own prelude is not a selector, and an at-rule never is.
    if (body.includes("{") || !selector || selector.startsWith("@")) continue;

    for (const part of splitSelectorList(selector)) {
      if (!part.text) continue;
      let why: string;
      try {
        parseSelector(part.text);
        continue;
      } catch (e) {
        if (!(e instanceof CssError)) throw e;
        // The first line only. The messages carry a paragraph of guidance, which
        // is right in a build error and would be unreadable in a ranked table.
        why = `selector: ${e.message.split("\n")[0]!.trim()}`;
      }
      // Attributed to the nearest enclosing selector that names a class, exactly
      // as the declarations are — `.divide-y` wraps a `:where(& > …)` whose own
      // text names nothing.
      for (const scope of [part.text, ...[...stack].reverse()]) {
        const names = classNamesIn(scope).filter((n) => known.has(n));
        if (!names.length) continue;
        for (const n of names) {
          let set = out.get(n);
          if (set === undefined) out.set(n, (set = new Set()));
          set.add(why);
        }
        break;
      }
    }
  }
  return out;
}

/** `.p-4`, `.p-0\.5`, `.w-1\/2`, `.hover\:bg-blue-500:hover` */
function classNamesIn(selector: string): string[] {
  const names: string[] = [];
  for (const m of selector.matchAll(/\.((?:[\w-]|\\.)+)/g)) names.push(m[1]!.replace(/\\(.)/g, "$1"));
  return names;
}

function rulesByClass(css: string, known: Set<string>): Map<string, { props: Set<string>; decls: [string, string][] }> {
  const out = new Map<string, { props: Set<string>; decls: [string, string][] }>();
  let selStart = 0;
  const stack: string[] = [];

  const classesIn = classNamesIn;

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
        const entry = out.get(name) ?? { props: new Set<string>(), decls: [] };
        for (const decl of body.split(";")) {
          const colon = decl.indexOf(":");
          if (colon === -1) continue;
          const prop = decl.slice(0, colon).trim();
          const value = decl.slice(colon + 1).trim();
          if (!/^[a-z-]+$/.test(prop) && !prop.startsWith("--")) continue;
          entry.props.add(prop);
          entry.decls.push([prop, value]);
        }
        out.set(name, entry);
      }
    }
  }
  return out;
}

/**
 * There is no VALUE_FEATURES list anymore, and the history of why matters.
 *
 * It was a list of regexes over a class's declaration text — "calc() over
 * percentages", "percentage length" — and it counted wrong in *both* directions.
 * It reported `w-full` working while `width: 100%` threw a fatal CssError, and
 * reported `opacity: 50%` blocked while the parser folded it; it flagged
 * `--tw-scale-x: 75%`, a custom property whose value is only ever consumed
 * through `var()` somewhere else. The file's own lesson, recorded when
 * `@property` left the list: a `test` over value text cannot see a property
 * name, and a blocker that never fires is indistinguishable from a feature that
 * works.
 *
 * The replacement is not a better regex: the declarations are run through
 * `expandDeclaration` itself, below. The compiler is the only authority on what
 * it accepts, the check cannot drift from it, and a new parser feature moves the
 * number on its own.
 */

const supported = dziriSupported();
const classes = await tailwindClasses();
console.log(`tailwind-coverage  ${classes.length} classes from the installed tailwindcss\n`);

const css = await compileAll(classes);
const rules = rulesByClass(css, new Set(classes));

/**
 * The `@property` registrations Tailwind emits, as name -> initial value.
 *
 * `var()` cannot be judged statically without these: `translate-x-4` reads
 * `var(--tw-translate-x)`, whose initial `0` lives in a registration, not in any
 * class's own declarations. A registration without `initial-value`
 * (`syntax: "*"` above one) has no initial — which is CSS's way of saying the
 * variable is *unset*, and a declaration that references it drops.
 */
const REGISTERED = new Map<string, string>();
for (const m of css.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g)) {
  const initial = /initial-value:\s*([^;]+)/.exec(m[2]!);
  if (initial) REGISTERED.set(m[1]!, initial[1]!.trim());
}

/**
 * Resolves `var()` the way the cascade would for a class standing alone: the
 * class's own `--*` declarations, then the `@property` initials, then the
 * fallback inside the `var()`. `null` when a variable is unresolvable — which is
 * not a blocker: CSS drops the declaration, and so does dziri's compiler, so the
 * class computes exactly as a browser computes it.
 */
function resolveVars(
  value: string,
  own: Map<string, string>,
): string | null {
  let v = value;
  for (let depth = 0; /var\(/.test(v) && depth < 10; depth++) {
    v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (m, name, fb) => {
      const hit = own.get(name) ?? REGISTERED.get(name) ?? fb?.trim();
      return hit ?? "unresolvable";
    });
  }
  return /var\(|unresolvable/.test(v) ? null : v;
}

// Not every enumerable class emits a rule on its own — some only produce one in a
// variant or container context. They are outside the denominator because there is
// nothing for dziri to succeed or fail at, but the count is printed rather than
// dropped silently: a denominator that quietly excludes classes reads as coverage.
const noRule = classes.filter((c) => !rules.has(c)).length;

const allProps = new Set<string>();
for (const { props } of rules.values()) for (const p of props) if (!p.startsWith("--")) allProps.add(p);

/** class -> the reasons it cannot work today */
const selectorWhy = selectorBlockers(css, new Set(classes));

const blockers = new Map<string, Set<string>>();
let clean = 0;

// Warnings are data here, not output — the parser's answer is what counts, and a
// `shadow-md` blur warning does not block the class that carries it.
const warn = console.warn;
console.warn = () => {};
try {
  for (const [name, { decls }] of rules) {
    const why = new Set<string>();
    const own = new Map<string, string>();
    for (const [p, v] of decls) if (p.startsWith("--")) own.set(p, v);
    for (const [p, v] of decls) {
      // Declaring a custom property is not a blocker — the compiler keeps `--*`
      // declarations, inherits them, and substitutes `var()` before any property
      // parser runs. What the *substituted* value does is checked where it lands,
      // which is the declaration naming a real property.
      if (p.startsWith("--")) continue;
      if (!supported.has(p)) {
        why.add(`property: ${p}`);
        continue;
      }
      // An unresolvable var() drops the declaration, as it does in a browser —
      // `scrollbar-thumb-*` colours a var that only exists once the base class
      // sets it, and standing alone the rule computes to nothing. Not a blocker.
      const resolved = resolveVars(v, own);
      if (resolved === null) continue;
      // The value check *is* the compiler, since it is cheap enough to run. A
      // regex over the value text was the previous implementation, and it counted
      // wrong in both directions: `w-full` was reported working while
      // `width: 100%` threw, and `opacity: 50%` was reported blocked while the
      // parser folded it. An error's first line is the reason; the distinct
      // reasons are what the ranking counts.
      try {
        // The pipeline substitutes `currentcolor` against the element's own `color`
        // before expansion (computed.ts); a bare probe has no colour, so use black —
        // the initial `fg` — which is what an element with no `color` rule computes to.
        const value = substituteCurrentColor(resolved, 0xff000000);
        // `inherit` is resolved by the cascade (it needs the parent's computed
        // style), not by the expander — a supported property is enough.
        if (value.trim().toLowerCase() === "inherit") continue;
        expandDeclaration(p, value, {} as never);
      } catch (e) {
        if (!(e instanceof CssError)) throw e;
        why.add(`value: ${e.message.split("\n")[0]!.trim()}`);
      }
    }
    for (const s of selectorWhy.get(name) ?? []) why.add(s);
    if (why.size) blockers.set(name, why);
    else clean++;
  }
} finally {
  console.warn = warn;
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
