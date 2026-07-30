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
import { INITIAL_STYLE, Predicate, UNSET, type StyleField } from "../ir.ts";

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

test("hover and focus merge per property instead of one winning", () => {
  // The reason the state table stopped being three named columns.
  //
  // With `(hover, active, focus)` the runtime *picked* one precompiled style, so
  // a node that was hovered and focused at once got whichever role ranked higher
  // and lost the other's declarations entirely — hover beat focus outright. CSS
  // combines them per property.
  const html = `<body><div class="btn"></div></body>`;
  const css = `
    .btn { background: #000000; border-color: #000000 }
    .btn:hover { background: #ff0000 }
    .btn:focus { border-color: #00ff00 }
  `;

  const ui = toCompiledUi(compile(html, css));
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  const { variants } = ui;

  expect(variants.count).toBe(1);
  const mask = variants.mask[0]!;
  expect(mask).toBe(Predicate.HOVER | Predicate.FOCUS);

  // Two predicates, so four entries: base, hover, focus, hover+focus.
  const start = variants.runStart[0]!;
  const run = Array.from(variants.slots.subarray(start, start + 4));
  expect(run.length).toBe(4);

  const bg = (slot: number) => styles.bg[slot]!;
  const border = (slot: number) => styles.borderColor[slot]!;

  expect(bg(run[0]!)).toBe(0xff000000);
  expect(bg(run[1]!)).toBe(0xffff0000); // hover only
  expect(border(run[2]!)).toBe(0xff00ff00); // focus only

  // Both at once: red background *and* green border. Neither declaration is lost.
  expect(bg(run[3]!)).toBe(0xffff0000);
  expect(border(run[3]!)).toBe(0xff00ff00);
});

test("a node whose states resolve to its base style is not conditional", () => {
  // A `:hover` rule that changes nothing must not put the node in the variant
  // table, or every frame pays a binary search to learn there is nothing to do.
  const html = `<body><div class="btn"></div></body>`;
  const css = `.btn { background: #ff0000 } .btn:hover { background: #ff0000 }`;

  expect(toCompiledUi(compile(html, css)).variants.count).toBe(0);
});

test("an unsupported selector is refused, not silently rewritten", () => {
  // Each of these used to parse into a *different, plausible* selector, because
  // the token scanner searched the string instead of covering it.
  const cases: Array<[string, string]> = [
    [`input[type="text"] { width: 1px }`, "attribute selector became the type selector `text`"],
    [`div > span { width: 1px }`, "child combinator became a descendant one"],
    [`div + span { width: 1px }`, "sibling combinator became a descendant one"],
    [`* { width: 1px }`, "universal selector matched nothing"],
  ];

  for (const [css, why] of cases) {
    expect(() => compile(`<body><div></div></body>`, css), why).toThrow();
  }
});

test("align-items defaults to stretch, as CSS's `normal` does", () => {
  // This was `flex-start`, and the cost was paid in stylesheets: the sample
  // carried six `align-items: stretch` declarations purely to undo it. Removing
  // the default *and* all six produced a byte-identical render, which is the
  // evidence that they only ever existed to cancel this.
  //
  // A column's child with no width of its own should fill the cross axis.
  const html = `<body><div class="card"></div></body>`;
  const css = `body { width: 200px } .card { height: 10px }`;
  const ui = toCompiledUi(compile(html, css));

  expect(INITIAL_STYLE.align).toBe(UNSET);
  // Nothing in the sheet sets `align-items`, so the child inherits the default
  // and the engine leaves Taffy's — which is per-display-mode, and is why this
  // is UNSET rather than literally STRETCH.
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  expect(styles.align[ui.nodes.style[1]!]).toBe(UNSET);
});

test("inherited properties pass down, non-inherited do not", () => {
  const html = `<body><div class="card"></div></body>`;
  const css = `body { color: #ff0000; width: 200px }`;

  expect(styleOf(html, css, "fg")).toBe(0xffff0000);
  // `width` is not inherited: the child is `auto`, which is NaN.
  expect(Number.isNaN(styleOf(html, css, "width"))).toBe(true);
});
