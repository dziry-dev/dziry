/**
 * The cascade: specificity, source order, shorthand-vs-longhand, and inline.
 *
 * The compiler had no unit tests at all, and the cascade is the part of it whose
 * output is *plausible* when wrong — a box with the wrong padding looks like a
 * design choice, not a bug. These pin the rules that the resolution order
 * actually has to honour.
 *
 * `compile()` is the real entry point, so these exercise parsing, matching,
 * specificity, inheritance and expansion together rather than a seam.
 */
import { expect, test } from "bun:test";
import { compile, toCompiledUi } from "./compile.ts";
import type { StyleField } from "../ir.ts";

/** The computed value of one field on the node matching `tag`. */
function styleOf(html: string, css: string, field: StyleField, tag = "div"): number {
  const ui = toCompiledUi(compile(html, css));
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;

  // body is node 0; the first element of `tag` is what the tests target.
  for (let i = 0; i < ui.nodes.count; i++) {
    if (ui.nodes.kind[i] === 0 && i > 0) return styles[field][ui.nodes.style[i]!]!;
  }
  throw new Error(`no <${tag}> in the compiled tree`);
}

test("specificity decides, not source order", () => {
  expect(styleOf(`<body><div class="a b"></div></body>`, `.b { width: 10px } .a { width: 20px }`, "width")).toBe(20);
  expect(
    styleOf(`<body><div class="a b"></div></body>`, `.a.b { width: 10px } .a { width: 20px }`, "width"),
  ).toBe(10);
});

test("source order breaks a specificity tie", () => {
  expect(styleOf(`<body><div class="a b"></div></body>`, `.a { width: 10px } .b { width: 20px }`, "width")).toBe(20);
});

// ---------------------------------------------------------------------------
// The regression: shorthand expansion position
// ---------------------------------------------------------------------------

test("a higher-specificity shorthand beats a lower-specificity longhand", () => {
  // `.x .card` (0,2,0) outranks `.card` (0,1,0), so its `padding` wins outright.
  //
  // This produced padL = 4 before: `padding` kept the position it was first
  // inserted at, so it expanded *before* the longhand and lost to it, inverting
  // the cascade.
  const html = `<body class="x"><div class="card"></div></body>`;
  const css = `.card { padding: 14px } .card { padding-left: 4px } .x .card { padding: 2px }`;

  expect(styleOf(html, css, "padL")).toBe(2);
  expect(styleOf(html, css, "padT")).toBe(2);
});

test("a longhand still beats a shorthand of equal rank declared before it", () => {
  const html = `<body><div class="card"></div></body>`;
  const css = `.card { padding: 14px; padding-left: 4px }`;

  expect(styleOf(html, css, "padL")).toBe(4);
  expect(styleOf(html, css, "padR")).toBe(14);
});

test("a shorthand declared after a longhand overwrites it", () => {
  const html = `<body><div class="card"></div></body>`;
  const css = `.card { padding-left: 4px; padding: 14px }`;

  expect(styleOf(html, css, "padL")).toBe(14);
});

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

test("inline beats every selector, however specific", () => {
  const html = `<body class="x"><div class="card" style="width: 5px"></div></body>`;
  const css = `.x .card { width: 100px } .card { width: 50px }`;

  expect(styleOf(html, css, "width")).toBe(5);
});

test("an inline shorthand beats a longhand from the sheet", () => {
  // The same position bug, reached the other way: an inline `padding` that only
  // replaced the cascade's `padding` would expand at the cascade's position and
  // then lose to `padding-left` from a matched rule.
  const html = `<body><div class="card" style="padding: 0"></div></body>`;
  const css = `.card { padding: 14px; padding-left: 9px }`;

  expect(styleOf(html, css, "padL")).toBe(0);
  expect(styleOf(html, css, "padT")).toBe(0);
});

test("inline only overrides what it declares", () => {
  const html = `<body><div class="card" style="width: 5px"></div></body>`;
  const css = `.card { width: 50px; height: 30px }`;

  expect(styleOf(html, css, "width")).toBe(5);
  expect(styleOf(html, css, "height")).toBe(30);
});

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

test("inherited properties pass down, non-inherited do not", () => {
  const html = `<body><div class="card"></div></body>`;
  const css = `body { color: #ff0000; width: 200px }`;

  expect(styleOf(html, css, "fg")).toBe(0xffff0000);
  // `width` is not inherited: the child is `auto`, which is NaN.
  expect(Number.isNaN(styleOf(html, css, "width"))).toBe(true);
});
