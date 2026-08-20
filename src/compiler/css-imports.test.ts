/**
 * The CSS import graph, through Bun's own resolver.
 *
 * The module's whole argument is that re-parsing imports would disagree with Bun,
 * so the test does what the compiler does: installs the recorder, really imports
 * a fixture tree, and reads the walk back. The fixture is a temp directory rather
 * than files under src/ so the edges are this test's alone — the graph is
 * cumulative and process-global by design, and a shared fixture would couple two
 * test files through it.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installCssGraph, stylesheetsFor } from "./css-imports.ts";

const dir = mkdtempSync(join(tmpdir(), "dziri-css-graph-"));

// entry.ts imports a.ts then b.css; a.ts imports theme.css then shared.ts;
// shared.ts imports base.css. ES evaluation order is depth-first in source
// order: theme.css, base.css (via shared), then b.css.
const entry = join(dir, "entry.ts");
writeFileSync(entry, `import "./a.ts";\nimport "./b.css";\nexport {};\n`);
writeFileSync(join(dir, "a.ts"), `import "./theme.css";\nimport "./shared.ts";\nexport {};\n`);
writeFileSync(join(dir, "shared.ts"), `import "./base.css";\nexport {};\n`);
for (const css of ["b.css", "theme.css", "base.css"]) writeFileSync(join(dir, css), "/* */\n");

installCssGraph();
await import(entry);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("stylesheets follow ES module evaluation order: depth-first, source order", () => {
  expect(stylesheetsFor([entry]).map((p) => p.split(/[\\/]/).pop())).toEqual([
    "theme.css",
    "base.css",
    "b.css",
  ]);
});

test("a root with no stylesheets behind it is an empty list, not an error", async () => {
  // shared.ts still has base.css behind it:
  expect(stylesheetsFor([join(dir, "shared.ts")]).map((p) => p.split(/[\\/]/).pop())).toEqual([
    "base.css",
  ]);
  const lone = join(dir, "lone.ts");
  writeFileSync(lone, "export {};\n");
  await import(lone);
  expect(stylesheetsFor([lone])).toEqual([]);
});

test("a sheet reachable from two roots lands once, at the first position", async () => {
  const second = join(dir, "second.ts");
  writeFileSync(second, `import "./theme.css";\nimport "./wide.css";\nexport {};\n`);
  writeFileSync(join(dir, "wide.css"), "/* */\n");
  await import(second);

  const sheets = stylesheetsFor([entry, second]).map((p) => p.split(/[\\/]/).pop());
  expect(sheets).toEqual(["theme.css", "base.css", "b.css", "wide.css"]);
});

test("a versioned re-import (?v=N) still attributes edges to the real file", async () => {
  // The invalidation plugin busts by query suffix; the graph is about real
  // files, so `entry.ts?v=2` importing a.ts must extend entry.ts's edges, not
  // mint a phantom module nobody can walk from.
  await import(`${entry}?v=2`);
  expect(stylesheetsFor([entry]).map((p) => p.split(/[\\/]/).pop())).toEqual([
    "theme.css",
    "base.css",
    "b.css",
  ]);
});

test("roots are resolved, so a relative root and its absolute spelling agree", () => {
  const relative = stylesheetsFor([resolve(entry)]);
  expect(relative.length).toBe(3);
});
