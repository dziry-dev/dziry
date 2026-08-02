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
import { compile, compileTree, dump, emit, toCompiledUi } from "./compile.ts";
import { compileVariants, findToggles } from "./variant-compile.ts";
import { parseHtml } from "./html.ts";
import { compactBits, INITIAL_STYLE, Predicate, UNSET, type StyleField } from "../ir.ts";

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

test(":checked and :disabled are predicates like any other", () => {
  // The whole of ROADMAP C2 phase 0, asserted: widening the state set is one
  // entry in `PREDICATE_PSEUDO` and one in `SUPPORTED_PSEUDO`, and everything
  // downstream — mask, run, merge — already worked in bits.
  //
  // So a disabled checkbox that is also checked gets a style resolved with *both*
  // live, which is what a real form needs and what the old named-role triple
  // could not have produced at all.
  const html = `<body><div class="box"></div></body>`;
  const css = `
    .box { background: #000000; border-color: #000000; accent-color: #0284c7 }
    .box:checked { accent-color: #16a34a }
    .box:disabled { background: #cccccc }
  `;

  const ui = toCompiledUi(compile(html, css));
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  const { variants } = ui;

  expect(variants.count).toBe(1);
  const mask = variants.mask[0]!;
  expect(mask).toBe(Predicate.CHECKED | Predicate.DISABLED);

  const start = variants.runStart[0]!;
  const at = (live: number) => start + compactBits(live, mask);

  expect(styles.accentColor[variants.slots[at(0)]!]!).toBe(0xff0284c7);
  expect(styles.accentColor[variants.slots[at(Predicate.CHECKED)]!]!).toBe(0xff16a34a);
  expect(styles.bg[variants.slots[at(Predicate.DISABLED)]!]!).toBe(0xffcccccc);

  // Checked *and* disabled: the green accent and the grey background together.
  const both = variants.slots[at(Predicate.CHECKED | Predicate.DISABLED)]!;
  expect(styles.accentColor[both]!).toBe(0xff16a34a);
  expect(styles.bg[both]!).toBe(0xffcccccc);
});

test("hover and focus still merge when a conditional class is present", () => {
  // The gap this closes. `compileVariants` re-interns every style over the
  // vector of its values across variants, so with a toggle in the document the
  // run had to be rebuilt from its output — and its output was three named
  // roles, so combined entries fell back to precedence.
  //
  // Which meant the merge above held only for documents with no conditional
  // class. This app has two, so the fix applied nowhere real until now.
  // No `theme` in the class attribute: the toggle *adds* it, so the baseline and
  // the variant actually differ and a patch exists to inspect.
  const html = `<body><div class="btn"></div></body>`;
  const css = `
    .btn { color: #111111; background: #222222; border-color: #333333 }
    .btn:hover { color: #ff0000 }
    .btn:focus { background: #0000ff }
    .theme .btn { border-color: #444444 }
  `;

  // This has to go through `compileVariants`, so the tree needs a `classWhen` —
  // which the HTML front-end cannot express. Attaching one by hand is what a
  // `className={cn({ theme: isDark })}` would have produced.
  const doc = parseHtml(html);
  const signal = { fake: "signal" };
  doc.children[0]!.type === "element" && (doc.children[0]!.classWhen = { theme: signal });

  const toggles = findToggles(doc);
  expect(toggles.length).toBe(1);

  const baseline = compileTree(doc, css);
  const compiled = compileVariants(doc, css, baseline, toggles);

  // The button is the only conditional node.
  const node = compiled.masks.findIndex((m) => m !== 0);
  expect(node).toBeGreaterThan(0);
  expect(compiled.masks[node]!).toBe(Predicate.HOVER | Predicate.FOCUS);

  const run = compiled.runs[node]!;
  const both = run[compactBits(Predicate.HOVER | Predicate.FOCUS, compiled.masks[node]!)]!;

  // Read out of the variant compiler's own table, which is what ships.
  const field = (f: StyleField, slot: number) => compiled.table[f][slot]!;

  // Neither declaration is dropped. Before this, `both` was whichever single
  // role precedence ranked highest, so one of these two was the base value.
  expect(field("fg", both)).toBe(0xffff0000);
  expect(field("bg", both)).toBe(0xff0000ff);

  // And the toggle still patches the same slot: `.theme .btn` raises the border
  // colour when it is on, which is a patch entry rather than a second slot.
  const borderPatch = compiled.patches[0]!.entries.find((e) => e.field === "borderColor");
  expect(borderPatch).toBeDefined();
  expect(borderPatch!.on).toContain(0xff444444);
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

// ---------------------------------------------------------------------------
// The emitted artifact
// ---------------------------------------------------------------------------

/**
 * A style column that is the same in every slot is emitted as one value.
 *
 * `emit` already knew this trick for the node tables (`new Int16Array(n).fill(-1)`)
 * and did not use it for the style columns, so most of a style table was identical
 * values spelled out — 2279 bytes of the sample's 19335, which JSC tokenizes on
 * every start. This asserts the shape of the output, not the size: a uniform column
 * collapses, and a column that actually varies keeps every element.
 */
test("a uniform style column is emitted as a fill, and a varying one is not", () => {
  const html = `<body><div class="a"></div><div class="b"></div></body>`;
  // Nothing here sets a margin, so `marT` is uniform; `width` differs per slot.
  const css = `.a { width: 10px } .b { width: 20px }`;
  const source = emit(compile(html, css), { html, css, typesFrom: "../src" });

  // Zero needs no `fill`: a typed array is already zero-filled.
  expect(source).toMatch(/marT: new Float32Array\(\d+\),/);
  // `NaN` and `Infinity` do, and `Number.isNaN` is why the all-`auto` columns
  // collapse at all — `NaN !== NaN` would call every one of them non-uniform.
  expect(source).toMatch(/maxW: new Float32Array\(\d+\)\.fill\(Infinity\),/);
  expect(source).toMatch(/basis: new Float32Array\(\d+\)\.fill\(NaN\),/);
  // Uniform is a property of the values, not of the field.
  expect(source).toMatch(/width: new Float32Array\(\[[^\]]*10[^\]]*20[^\]]*\]\)/);
});

// ---------------------------------------------------------------------------
// Golden IR
// ---------------------------------------------------------------------------

/**
 * One fixture, the whole IR, as text.
 *
 * `dump()` already existed for `bun run compile`, which makes it the cheapest
 * broad assertion available: node kinds and tree shape, style interning and reuse,
 * inheritance, the hover variant, and the string table, all in one comparison.
 * The individual tests above pin *rules*; this pins the *output*, so a change
 * anywhere in the pipeline has to be looked at and either explained or fixed.
 *
 * Written inline rather than as a snapshot file: a golden nobody reads is a golden
 * that gets regenerated on autopilot. Notice what it records — style 2 is shared by
 * `.row` and the nested `.row` span, `fg` is inherited into every slot including
 * the text nodes, and the button's `hover` slot repeats every non-colour field
 * because a variant is a whole resolved style rather than a delta.
 */
test("the IR for one small document is exactly this", () => {
  const html =
    `<body class="page"><h1 id="title">Hi</h1><div class="row">` +
    `<button class="btn">Go</button><span class="row">x</span></div></body>`;
  const css = `
  .page { padding: 8px; display: flex; flex-direction: column; gap: 4px; color: #eeeeee }
  #title { font-size: 20px; font-weight: 700 }
  .row { display: flex; gap: 4px }
  .btn { background: #123456; border: 1px solid #abcdef; border-radius: 6px; padding: 2px 6px }
  .btn:hover { background: #2244aa }
`;

  expect(dump(compile(html, css))).toBe(
    [
      "tree",
      "  #0 box  style=0",
      "    #1 box  style=1",
      '      #2 text "Hi"  style=2',
      "    #3 box  style=3",
      '      #4 button "Go"  style=4 hover=5',
      "      #5 box  style=3",
      '        #6 text "x"  style=6',
      "",
      // Seven, not six: the UA sheet gives `h1` a margin, and margins do not
      // inherit — so the heading and its text run are no longer the same computed
      // style and stop sharing a slot. Every index after it shifts by one. That is
      // the interner working, not a regression: `.row` and the nested `.row` span
      // still share style 3, which is the sharing this fixture exists to pin.
      "styles (7 unique)",
      "    0  fg=#eeeeee padT=8 padR=8 padB=8 padL=8 gapRow=4 gapCol=4",
      "    1  fg=#eeeeee marT=21.44 marB=21.44 fontSize=20 fontWeight=700",
      "    2  fg=#eeeeee fontSize=20 fontWeight=700",
      "    3  fg=#eeeeee direction=row gapRow=4 gapCol=4",
      "    4  bg=#123456 fg=#eeeeee borderColor=#abcdef borderWidth=1 radTL=6 radTR=6 radBR=6 radBL=6 " +
        "padT=2 padR=6 padB=2 padL=6",
      "    5  bg=#2244aa fg=#eeeeee borderColor=#abcdef borderWidth=1 radTL=6 radTR=6 radBR=6 radBL=6 " +
        "padT=2 padR=6 padB=2 padL=6",
      "    6  fg=#eeeeee",
      "",
      "strings (3)",
      '    0  "Hi"',
      '    1  "Go"',
      '    2  "x"',
    ].join("\n"),
  );
});

/**
 * `min-width` and `min-height` are `auto` when nobody sets them.
 *
 * CSS's initial value, and for a flex item `auto` resolves to the content size —
 * which is the rule that stops a column from shrinking its children when the
 * container is too small. `INITIAL_STYLE` said `0`, which is a *different* and
 * legal value meaning "may shrink to nothing", and the symptom was list rows
 * compressing as the window got shorter (see upload.test.ts). Pinned here because
 * this is where the value is decided, not where it is felt.
 */
test("an unset min-size is auto, not zero", () => {
  const html = `<body><div class="a"></div></body>`;
  const css = `.a { width: 10px }`;

  expect(Number.isNaN(styleOf(html, css, "minW"))).toBe(true);
  expect(Number.isNaN(styleOf(html, css, "minH"))).toBe(true);

  // A declared one still wins, including an explicit zero.
  expect(styleOf(html, `.a { min-height: 0 }`, "minH")).toBe(0);
  expect(styleOf(html, `.a { min-height: 24px }`, "minH")).toBe(24);
});
