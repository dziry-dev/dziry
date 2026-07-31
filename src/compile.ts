/**
 * CLI for the compiler.
 *
 *   bun run compile                       # app/app.tsx (or app.html) + app/app.css
 *   bun run compile --dump                # also print the IR in readable form
 *   bun run compile app/app.html app/app.css -o out.ts
 *
 * Both authoring front-ends land on the same `Element` tree, so everything after
 * the parse is shared.
 */
import { join, relative, extname, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { compile, compileTree, emit, dump } from "./compiler/compile.ts";
import { CssError, formatCssError } from "./compiler/css.ts";
import { buildRefIndex, resolveRefs, type RefSource } from "./compiler/resolve-refs.ts";
import {
  compileVariants,
  findToggles,
  type VariantCompiled,
} from "./compiler/variant-compile.ts";
import { toDocument } from "./compiler/jsx-runtime.ts";
import { setCompiling } from "./runtime/signal.ts";
import type { Element, Node } from "./compiler/html.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);

const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--") && a !== "-o");

const outIndex = argv.indexOf("-o");
const outPath =
  outIndex !== -1 && argv[outIndex + 1] ? argv[outIndex + 1]! : join(ROOT, "app", "ui.gen.ts");

/** JSX is the default authoring form; HTML still works when it is what exists. */
function defaultInput(): string {
  const tsx = join(ROOT, "app", "app.tsx");
  return existsSync(tsx) ? tsx : join(ROOT, "app", "app.html");
}

const inputPath = positional[0] ?? defaultInput();
const cssPath = positional[1] ?? join(ROOT, "app", "app.css");

const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

const css = await Bun.file(cssPath).text();
const isJsx = [".tsx", ".jsx"].includes(extname(inputPath).toLowerCase());

/**
 * Turns a stylesheet error into the author's problem rather than ours.
 *
 * Uncaught, a `CssError` printed a Bun stack trace whose frames are all inside
 * `src/compiler/css.ts` — file and line, of the compiler. The one place the
 * source text and the file name are both in hand is here, so this is where the
 * offset becomes a position someone can act on.
 */
function reportCssErrors<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof CssError) {
      console.error(formatCssError(e, css, rel(cssPath)));
      process.exit(1);
    }
    throw e;
  }
}

const started = performance.now();

let result;
let imports = new Map<string, Set<string>>();
let variants: VariantCompiled | undefined;

if (isJsx) {
  // Bun transpiles the JSX against our jsx-runtime, so importing the module
  // *is* evaluating the components. Nothing is executed at run time.
  // Must be an absolute file URL: a bare relative path would resolve against
  // this module rather than the working directory.
  // While the document module evaluates, reading `.value` on an array-valued
  // signal yields a proxy that remembers its owner, so `todos.value.map(…)`
  // compiles to a dynamic list instead of silently freezing the initial data.
  const specifier = pathToFileURL(resolve(inputPath)).href;
  setCompiling(true);
  let mod: Record<string, unknown> & { default?: Node | Node[] };
  try {
    mod = (await import(specifier)) as Record<string, unknown> & { default?: Node | Node[] };
  } finally {
    setCompiling(false);
  }
  if (!mod.default) {
    throw new Error(`${rel(inputPath)} has no default export`);
  }
  const doc: Element = toDocument(mod.default);
  result = reportCssErrors(() => compileTree(doc, css));

  // Conditional classes: compile one extra variant per toggle and diff, so each
  // becomes a list of style-table writes rather than a class the runtime resolves.
  const toggles = findToggles(doc);
  if (toggles.length > 0) {
    variants = compileVariants(doc, css, result, toggles);

    // A variant warning is not advisory. Each one means two toggles write the
    // same (field, slot), so the style table's value depends on which patch was
    // applied last rather than on the cascade — the composition guarantee the
    // whole variant design rests on. Printing it and exiting 0 means a build
    // that silently mis-styles still ships.
    if (variants.warnings.length > 0) {
      for (const w of variants.warnings) console.error(`  error: ${w}`);
      console.error(
        `\n${variants.warnings.length} conditional-class conflict(s). Two toggles writing the\n` +
          `same style field of the same slot cannot both be correct: the result depends on\n` +
          `apply order, not on specificity. Split the rules so each toggle owns its fields.`,
      );
      process.exit(1);
    }
  }

  // `{count}` and `onClick={increment}` reached the tree as live objects. Resolve
  // them back to the exports they came from, so the generated module can import
  // them by name — the only way a reference survives the compiler/runtime file
  // boundary.
  const importPath = (p: string) =>
    "./" + relative(dirname(outPath), p).replace(/\\/g, "/");

  const sources: RefSource[] = [];
  const statePath = join(dirname(inputPath), "state.ts");
  if (existsSync(statePath)) {
    sources.push({
      specifier: importPath(statePath),
      exports: (await import(pathToFileURL(resolve(statePath)).href)) as Record<string, unknown>,
    });
  }
  // The entry module too, so handlers may live beside the markup.
  sources.push({ specifier: importPath(inputPath), exports: mod });

  ({ imports } = resolveRefs(result, buildRefIndex(sources), variants));
} else {
  const html = await Bun.file(inputPath).text();
  result = reportCssErrors(() => compile(html, css));
}

const elapsed = performance.now() - started;

for (const w of result.warnings) console.warn(`  warn: ${w}`);

// Where the generated module finds the types it declares it satisfies. A
// package build would make this a bare specifier; until then it is a path.
const typesFrom = relative(dirname(outPath), join(ROOT, "src")).replaceAll("\\", "/");
const source = emit(
  result,
  { html: rel(inputPath), css: rel(cssPath), typesFrom: typesFrom || "." },
  imports,
  variants,
);
await Bun.write(outPath, source);

if (flags.has("--dump")) {
  console.log("");
  console.log(dump(result));
  console.log("");
}

const bytes = new TextEncoder().encode(source).length;
const styleNote = variants
  ? `${variants.slotCount} style slots (${result.styles.length} baseline)`
  : `${result.styles.length} unique styles`;

const patchNote = variants
  ? `\n  ${variants.patches.length} conditional class(es): ` +
    variants.patches
      .map((p) => `.${p.className} ${p.writes} writes${p.affectsLayout ? " +relayout" : ""}`)
      .join(", ")
  : "";

console.log(
  `compiled ${rel(inputPath)} + ${rel(cssPath)} -> ${rel(outPath)}\n` +
    `  ${result.nodes.length} nodes, ${styleNote}, ${result.strings.length} strings` +
    patchNote +
    `\n  ${bytes} bytes of IR, ${elapsed.toFixed(1)}ms`,
);
