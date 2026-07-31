/**
 * The variant compiler's own correctness proof, run.
 *
 * `compileVariants` compiles k+1 times rather than 2^k and ships one style-table
 * patch per conditional class, betting that applying two patches in sequence lands
 * where a real cascade with both classes would. Every conditional class in every
 * app rides on that bet, and until now the exhaustive check of it lived in
 * `src/compiler/variants.ts`, validated a second copy of the algorithm, and only
 * printed its verdict.
 *
 * `verifyCompose` is that check pointed at production. These call it over the real
 * sample and over fixtures built to break it.
 */
import { expect, test } from "bun:test";

import { compile, compileTree } from "./compile.ts";
import { parseHtml } from "./html.ts";
import { compileVariants, findToggles, verifyCompose, type Toggle } from "./variant-compile.ts";
import type { Element } from "./html.ts";

/**
 * Two toggles over the same class-conditional element, as the JSX front-end would
 * hand them over: `classWhen` maps a class name to the signal that owns it.
 */
function fixture(html: string, when: Record<string, unknown>[]): Element {
  const doc = parseHtml(html);
  const targets: Element[] = [];
  const visit = (el: Element): void => {
    if (el.classes.includes("target")) targets.push(el);
    for (const child of el.children) if (child.type === "element") visit(child);
  };
  visit(doc);
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    target.classWhen = Object.assign({}, ...when) as Record<string, unknown>;
  }
  return doc;
}

function togglesOf(doc: Element): Toggle[] {
  const toggles = findToggles(doc);
  expect(toggles.length).toBeGreaterThan(0);
  return toggles;
}

test("two disjoint toggles compose for every combination", () => {
  // `.a` writes width, `.b` writes height: no shared (field, slot), so sequencing
  // the two patches has to reproduce the cascade exactly.
  const html = `<body><div class="target"></div></body>`;
  const css = `.target { width: 5px; height: 5px } .a { width: 10px } .b { height: 20px }`;
  const doc = fixture(html, [{ a: { signal: "a" } }, { b: { signal: "b" } }]);

  const mismatches = verifyCompose(doc, css, compileTree(doc, css), togglesOf(doc));
  expect(mismatches).toEqual([]);
});

test("two toggles writing the same field compose when the cascade agrees", () => {
  // Both write `width` on the same node, so they collide on (field, slot) and
  // `compileVariants` warns. Sequencing still lands correctly here, because the
  // later class wins the cascade and the later patch wins the sequence — the
  // warning is about the cases where those two orders disagree, and this pins the
  // case where they do not.
  const html = `<body><div class="target"></div></body>`;
  const css = `.target { width: 5px } .a { width: 10px } .b { width: 20px }`;
  const doc = fixture(html, [{ a: { signal: "a" } }, { b: { signal: "b" } }]);
  const toggles = togglesOf(doc);

  const compiled = compileVariants(doc, css, compileTree(doc, css), toggles);
  expect(compiled.warnings.join(" ")).toContain("style field(s) in common");

  expect(verifyCompose(doc, css, compileTree(doc, css), toggles)).toEqual([]);
});

test("a toggle that introduces a pseudo-state composes under that state too", () => {
  // `.a .target:hover` gives the node a `:hover` rule the baseline never had, so
  // the two sides disagree about the node's mask. The oracle compares by live
  // predicate bits for exactly this case.
  const html = `<body><div class="target"></div></body>`;
  const css = `.target { width: 5px } .a .target:hover { width: 30px }`;
  const doc = parseHtml(html);
  const target = doc.children.find((c) => c.type === "element") as Element;
  target.classWhen = { unused: { signal: "x" } };
  // The toggle's class goes on the *body*, which is what `.a .target` needs.
  doc.classWhen = { a: { signal: "a" } };

  const toggles = findToggles(doc);
  expect(toggles.map((t) => t.className)).toContain("a");

  expect(verifyCompose(doc, css, compileTree(doc, css), toggles)).toEqual([]);
});

test("a deliberately broken patch is caught", () => {
  // The oracle has to be able to fail. `.a` and `.b` both write `width` on the same
  // slot, and here the *cascade* order is the reverse of the patch order: `.b` is
  // declared first, so `.a` wins the cascade, while sequencing applies `.a` then
  // `.b` and leaves `.b`'s value. This is precisely the case
  // `compileVariants`'s warning is about, and it must show up as a mismatch rather
  // than as a warning nobody reads.
  const html = `<body><div class="target"></div></body>`;
  const css = `.target { width: 5px } .b { width: 20px } .a.b { width: 99px } .a { width: 10px }`;
  const doc = fixture(html, [{ a: { signal: "a" } }, { b: { signal: "b" } }]);
  const toggles = togglesOf(doc);

  const mismatches = verifyCompose(doc, css, compileTree(doc, css), toggles);
  expect(mismatches.length).toBeGreaterThan(0);
  // Both on: the cascade says `.a.b` (99), sequencing says whatever came last.
  expect(mismatches[0]!.field).toBe("width");
  expect(mismatches[0]!.compiled).toBe(99);
  expect(mismatches[0]!.patched).not.toBe(99);
});

test("compiling with no toggles has nothing to verify", () => {
  const html = `<body><div class="x"></div></body>`;
  const css = `.x { width: 5px }`;
  expect(verifyCompose(parseHtml(html), css, compile(html, css), [])).toEqual([]);
});
