/**
 * Stylesheet errors point at the stylesheet.
 *
 * Before this, a `CssError` escaped as a bare `Error` and Bun printed a stack
 * trace whose every frame is inside `css.ts` — the compiler's file and line,
 * never the author's. The parser had the position all along: `parseCss` tracks
 * `i` and simply never recorded it.
 */
import { expect, test } from "bun:test";

import { compile, toCompiledUi } from "./compile.ts";
import {
  CssError,
  expandDeclaration,
  extendVarEnv,
  formatCssError,
  parseColor,
  parseContent,
  parseCss,
  parseLength,
  parseSelector,
  substituteVars,
} from "./css.ts";

/** Parses and returns the rendered diagnostic, or `null` if it parsed. */
function diagnose(src: string): string | null {
  try {
    parseCss(src);
    return null;
  } catch (e) {
    if (e instanceof CssError) return formatCssError(e, src, "sheet.css");
    throw e;
  }
}

test("an unsupported selector is reported at its own line and column", () => {
  // This used to use `input[type=text]`, which is now supported — attribute
  // selectors were built so a UA stylesheet could name one control among the
  // twenty-two that share the `input` tag. A pseudo-element dziri does not have
  // is the current example, and a better one: it is refused *by name*, so the
  // diagnostic says which feature is missing rather than "syntax".
  const out = diagnose(".ok { color: red }\n\nselect::picker-icon { color: red }\n");
  expect(out).toContain("sheet.css:3:1");
  expect(out).toContain("unsupported pseudo-element");
  // The offending source line, and a caret under it.
  expect(out).toContain("select::picker-icon { color: red }");
  expect(out).toContain("^");
});

test("a comment does not shift the position of a later error", () => {
  // The whole reason `stripComments` blanks in place instead of deleting.
  // Removing the bytes would move every later offset left by the comment's
  // length, so a stylesheet with a licence header at the top would misreport
  // every line in the file — worse than reporting nothing.
  const src = "/* a comment\n   spanning\n   three lines */\n.a > .b { color: red }\n";
  const out = diagnose(src);
  expect(out).toContain("sheet.css:4:1");
  expect(out).toContain("only the descendant combinator");
});

test("a comment on the same line does not shift the column", () => {
  const out = diagnose("/* lead */ .a > .b { color: red }\n");
  expect(out).toContain("sheet.css:1:12");
});

test("a declaration without a colon points at the declaration", () => {
  const out = diagnose(".a { color: red;\n     background red }\n");
  expect(out).toContain("sheet.css:2:6");
  expect(out).toContain("declaration without a colon");
});

test("the second selector in a list is located, not the first", () => {
  const out = diagnose(".fine, .a > .b { color: red }\n");
  expect(out).toContain("sheet.css:1:8");
});

test("a pseudo-class off the subject is located at its compound", () => {
  const out = diagnose(".a:hover .b { color: red }\n");
  expect(out).toContain("sheet.css:1:1");
  expect(out).toContain("only supported on the subject");
});

test("an unclosed rule is located at the brace that was never closed", () => {
  const out = diagnose(".a { color: red\n");
  expect(out).toContain("sheet.css:1:4");
  expect(out).toContain("unclosed rule");
});

test("an error with no recorded position still renders", () => {
  const out = formatCssError(new CssError("something went wrong"), ".a {}", "sheet.css");
  expect(out).toBe("sheet.css: something went wrong");
});

test("a valid stylesheet still parses", () => {
  const rules = parseCss("/* c */ .a .b:hover, #x { color: red; padding: 1px }\n");
  expect(rules.length).toBe(1);
  expect(rules[0]!.selectors.length).toBe(2);
  expect(rules[0]!.decls.get("color")).toBe("red");
});

// ---------------------------------------------------------------------------
// Value parsers, table-driven
// ---------------------------------------------------------------------------
//
// The value expander is the part of the compiler with the highest ratio of
// behaviour to lines, and it had no tests at all: every case here was previously
// verified only by whatever `app.css` happened to use. Tables rather than
// individual tests, so adding a unit or a shorthand form is one line.

test("lengths resolve to px, with the units this subset supports", () => {
  const cases: Array<[string, number]> = [
    ["0", 0],
    ["12px", 12],
    ["12", 12], // unitless is px, as the shorthand forms rely on
    ["-4px", -4],
    ["1.5px", 1.5],
    ["12pt", 16], // 96/72
    ["1rem", 16],
    ["0.5em", 8], // no nested em: everything resolves against the root's 16px
  ];
  for (const [input, expected] of cases) {
    expect(parseLength(input), input).toBe(expected);
  }

  // `auto` is NaN, which is the sentinel the engine decodes back to Taffy's auto.
  expect(Number.isNaN(parseLength("auto"))).toBe(true);
});

test("a length the subset cannot express is a diagnostic, not a guess", () => {
  // Percentages are the interesting one: they parse fine as a number and would
  // silently mean px, which is a wrong layout rather than a missing feature.
  for (const bad of ["50%", "12qq", "px", "", "1 2"]) {
    expect(() => parseLength(bad), bad).toThrow(CssError);
  }
});

test("colours resolve to ARGB", () => {
  const cases: Array<[string, number]> = [
    ["#123456", 0xff123456],
    ["#abc", 0xffaabbcc],
    ["#abcd", 0xddaabbcc], // 4-digit hex is #rgba, so the last nibble is alpha
    ["#12345678", 0x78123456],
    ["transparent", 0x00000000],
    ["rgb(1, 2, 3)", 0xff010203],
    ["rgba(1, 2, 3, 0.5)", 0x80010203], // the 4th component is 0..1, not 0..255
    ["rgb(1 2 3 / 1)", 0xff010203], // the space-separated form
    ["WHITE", 0xffffffff], // case-insensitive
  ];
  for (const [input, expected] of cases) {
    expect(parseColor(input) >>> 0, input).toBe(expected >>> 0);
  }
});

test("a colour the subset cannot express is a diagnostic", () => {
  for (const bad of ["#12345", "rgb(1,2)", "hsl(0,0%,0%)", "notacolour", "#"]) {
    expect(() => parseColor(bad), bad).toThrow(CssError);
  }
});

/**
 * `color-mix()` against a transparent operand, which is how Tailwind v4 spells
 * every opacity modifier — `bg-red-500/50` compiles to one of these. Verified
 * against Chrome in `scripts/conformance.ts`, which is where the claim that the
 * interpolation space cancels out is actually asserted.
 */
test("color-mix() against transparent folds to a scaled alpha", () => {
  const cases: Array<[string, number]> = [
    ["color-mix(in oklab, red 50%, transparent)", 0x80ff0000],
    ["color-mix(in srgb, red 50%, transparent)", 0x80ff0000], // the space cancels out
    ["color-mix(in oklab, red 25%, transparent)", 0x40ff0000],
    ["color-mix(in oklab, red, transparent)", 0x80ff0000], // omitted percentage is 50/50
    ["color-mix(in oklab, transparent, red 25%)", 0x40ff0000], // either argument may be the transparent one
    ["color-mix(in oklab, red 100%, transparent)", 0xffff0000],
    ["color-mix(in oklab, red 0%, transparent)", 0x00ff0000],
    // an operand that already carries alpha has it scaled, not replaced
    ["color-mix(in oklab, rgb(0 128 255 / 0.8) 50%, transparent)", 0x660080ff],
    // any zero-alpha operand is premultiplied-invisible, not only the keyword
    ["color-mix(in oklab, red 50%, rgb(0 255 0 / 0))", 0x80ff0000],
    // percentages are normalised when they do not sum to 100
    ["color-mix(in oklab, red 25%, transparent 25%)", 0x80ff0000],
  ];
  for (const [input, expected] of cases) {
    expect(parseColor(input) >>> 0, input).toBe(expected >>> 0);
  }
});

test("a color-mix() that needs real interpolation is a diagnostic", () => {
  const bad = [
    "color-mix(in oklab, red 50%, blue)", // two visible colours
    "color-mix(in oklab, currentcolor 50%, transparent)", // no inherited colour at parse time
    "color-mix(oklab, red 50%, transparent)", // missing `in`
    "color-mix(in oklab, red 50%)", // one colour
    "color-mix(in oklab, red 50% 20%, transparent)", // two percentages on one argument
    "color-mix(in oklab, red -10%, transparent)", // negative weight
    "color-mix(in oklab, red 0%, transparent 0%)", // weights sum to zero
  ];
  for (const b of bad) {
    expect(() => parseColor(b), b).toThrow(CssError);
  }
});

/** The fields one declaration expands to, as a plain object. */
function expand(prop: string, value: string): Record<string, number> {
  const out: Record<string, number> = {};
  expandDeclaration(prop, value, out as never);
  return out;
}

test("the 1-to-4-value box shorthand maps as CSS says", () => {
  expect(expand("padding", "1px")).toEqual({ padT: 1, padR: 1, padB: 1, padL: 1 });
  expect(expand("padding", "1px 2px")).toEqual({ padT: 1, padR: 2, padB: 1, padL: 2 });
  expect(expand("padding", "1px 2px 3px")).toEqual({ padT: 1, padR: 2, padB: 3, padL: 2 });
  expect(expand("margin", "1px 2px 3px 4px")).toEqual({ marT: 1, marR: 2, marB: 3, marL: 4 });
});

test("gap takes one value for both axes or row then column", () => {
  expect(expand("gap", "4px")).toEqual({ gapRow: 4, gapCol: 4 });
  expect(expand("gap", "4px 8px")).toEqual({ gapRow: 4, gapCol: 8 });
});

test("grid tracks are counted, not described", () => {
  // The engine only does equal `1fr` tracks, so the IR holds a count. Anything
  // that is not expressible as a count has to be refused rather than approximated.
  expect(expand("grid-template-columns", "repeat(3, 1fr)")).toEqual({ gridCols: 3 });
  expect(expand("grid-template-columns", "1fr 1fr")).toEqual({ gridCols: 2 });
  expect(expand("grid-template-columns", "repeat(2, minmax(0,1fr))")).toEqual({ gridCols: 2 });
  expect(expand("grid-template-rows", "repeat(4, 1fr)")).toEqual({ gridRows: 4 });

  for (const bad of ["repeat(auto-fit, 1fr)", "200px 1fr", "repeat(0, 1fr)", "min-content"]) {
    expect(() => expand("grid-template-columns", bad), bad).toThrow(CssError);
  }
});

test("grid placement is start plus span, and line 0 is refused", () => {
  expect(expand("grid-column", "3")).toEqual({ gridColStart: 3, gridColSpan: 0 });
  expect(expand("grid-column", "span 2")).toEqual({ gridColStart: 0, gridColSpan: 2 });
  // `2 / 5` is lines 2 to 5, which spans three tracks.
  expect(expand("grid-column", "2 / 5")).toEqual({ gridColStart: 2, gridColSpan: 3 });
  expect(expand("grid-row", "2 / span 3")).toEqual({ gridRowStart: 2, gridRowSpan: 3 });
  // Grid lines are 1-based; 0 is what makes taffy panic, so it is a build error.
  expect(() => expand("grid-column", "0")).toThrow(CssError);
  expect(() => expand("grid-column", "first")).toThrow(CssError);
});

test("flex keywords expand as CSS says", () => {
  expect(expand("flex", "none")).toEqual({ grow: 0, shrink: 0, basis: NaN });
  expect(expand("flex", "auto")).toEqual({ grow: 1, shrink: 1, basis: NaN });
  // `flex: 1` is `1 1 0`, not `1 1 auto`: whether an item sizes from its content
  // before growing is visible, and this is the form Tailwind's `flex-1` emits.
  expect(expand("flex", "1")).toEqual({ grow: 1, shrink: 1, basis: 0 });
  expect(expand("flex", "2 3")).toEqual({ grow: 2, shrink: 3, basis: 0 });
});

// --- recorded defects --------------------------------------------------------
//
// The next two lock in values that are *wrong*, from the review's
// `compiler-css/shorthand-expansion-vs-spec` (MEDIUM). They are here so the
// wrongness is executable rather than filed: nothing in `app.css` reaches these
// forms today, and when the shorthands are rewritten against the spec these tests
// fail and say what the new answer should be.

test("KNOWN WRONG: `flex` with a length basis loses the basis", () => {
  // Spec: grow 1, shrink 1, basis 100px. The basis scan excludes any token that
  // *is* parts[1], and here the length is parts[1].
  expect(expand("flex", "1 100px")).toEqual({ grow: 1, shrink: 1, basis: 0 });
  // Spec: basis auto. Only the `flex: auto` keyword form gets that right.
  expect(expand("flex", "0 0 auto")).toEqual({ grow: 0, shrink: 0, basis: 0 });
});

test("KNOWN WRONG: `border` neither resets nor honours `none`", () => {
  // Spec: the shorthand resets style to `none`, so a browser paints nothing here.
  expect(expand("border", "#ff0000")).toEqual({ borderColor: 0xffff0000 });
  // Spec: `none` wins and nothing is painted. The reset guard tests the whole
  // value string, so a `none` among other tokens is skipped instead.
  expect(expand("border", "1px none red")).toEqual({ borderWidth: 1, borderColor: 0xffff0000 });
  // Spec: an omitted colour is `currentColor`. This leaves it at the initial
  // transparent, so `border: 2px solid` paints nothing at all.
  expect(expand("border", "2px solid")).toEqual({ borderWidth: 2 });
  // `border: none` alone is handled, which is what makes the above surprising.
  expect(expand("border", "none")).toEqual({ borderWidth: 0 });
});

test("overflow maps CSS's keywords onto the four the engine has", () => {
  expect(expand("overflow", "visible")).toEqual({ overflowX: 0, overflowY: 0 });
  expect(expand("overflow", "hidden")).toEqual({ overflowX: 1, overflowY: 1 });
  // `clip` was folded into `hidden` until a probe showed why it cannot be: `hidden`
  // makes the box a scroll container and so coerces a `visible` axis to `auto`, and
  // `clip` does not. See BROWSER-FACTS.md.
  expect(expand("overflow", "clip")).toEqual({ overflowX: 4, overflowY: 4 });
  // `auto` is what the engine actually does — a scrollbar only when needed — so
  // `scroll` is the approximation rather than the other way round.
  expect(expand("overflow", "auto")).toEqual({ overflowX: 3, overflowY: 3 });
  expect(expand("overflow", "scroll")).toEqual({ overflowX: 3, overflowY: 3 });

  expect(() => expand("overflow", "overlay")).toThrow(CssError);
});

test("overflow is per axis, which is the case that matters", () => {
  // The asymmetric one: scroll down, never sideways. This is what Tailwind's
  // `overflow-y-auto` emits and what a scrolling column actually needs.
  expect(expand("overflow-y", "auto")).toEqual({ overflowY: 3 });
  expect(expand("overflow-x", "hidden")).toEqual({ overflowX: 1 });

  // Two values are `<x> <y>`, as in CSS.
  expect(expand("overflow", "hidden auto")).toEqual({ overflowX: 1, overflowY: 3 });
  expect(() => expand("overflow", "hidden auto visible")).toThrow(CssError);

  // A longhand after the shorthand wins, which the cascade relies on.
  const out: Record<string, number> = {};
  expandDeclaration("overflow", "hidden", out as never);
  expandDeclaration("overflow-y", "auto", out as never);
  expect(out).toEqual({ overflowX: 1, overflowY: 3 });
});

/**
 * `scrollbar-width`, whose grammar is the one MDN's own guide got wrong.
 *
 * The guide the request cited summarises it as `auto | thin | thick | <length>`.
 * Chromium 151 rejects `thick` and `12px` outright, MDN's own property page lists three
 * keywords, and `mdn-data` agrees — see BROWSER-FACTS.md, "Which scrollbar declarations
 * the parser keeps". So the two extra values are refused here on purpose, and this test
 * is the record of why: accepting them would be implementing documentation rather than
 * CSS.
 */
test("scrollbar-width takes exactly auto, thin and none", () => {
  expect(expand("scrollbar-width", "auto")).toEqual({ scrollbarWidth: 0 });
  expect(expand("scrollbar-width", "thin")).toEqual({ scrollbarWidth: 1 });
  expect(expand("scrollbar-width", "none")).toEqual({ scrollbarWidth: 2 });

  expect(() => expand("scrollbar-width", "thick")).toThrow(CssError);
  expect(() => expand("scrollbar-width", "12px")).toThrow(CssError);
});

test("scrollbar-color takes two colours, thumb then track", () => {
  expect(expand("scrollbar-color", "red orange")).toEqual({
    scrollbarThumb: 0xffff0000,
    scrollbarTrack: 0xffffa500,
  });

  // `auto` is both of them unset, which is alpha 0 — the same "nothing was said here"
  // convention `borderColor` uses.
  expect(expand("scrollbar-color", "auto")).toEqual({
    scrollbarThumb: 0x00000000,
    scrollbarTrack: 0x00000000,
  });

  // A colour can contain spaces, so splitting the value on whitespace is wrong. This is
  // the form `getComputedStyle` hands back, not a contrived one.
  expect(expand("scrollbar-color", "#ff0000 rgb(0 128 0)")).toEqual({
    scrollbarThumb: 0xffff0000,
    scrollbarTrack: 0xff008000,
  });

  // One colour is an invalid declaration in CSS rather than a partial one — Chromium
  // drops the whole thing — so guessing which half was meant would be worse than
  // refusing.
  expect(() => expand("scrollbar-color", "red")).toThrow(CssError);
  expect(() => expand("scrollbar-color", "red orange blue")).toThrow(CssError);
});

/**
 * The three form-control properties, which are ordinary compile-time fields.
 *
 * That is the claim ROADMAP C2 rests on — that `accent-color`, `caret-color` and
 * `appearance` cost the compiler nothing beyond a case here — so it is worth an
 * assertion rather than an assumption.
 */
test("accent-color and caret-color take auto or a colour", () => {
  expect(expand("accent-color", "#0284c7")).toEqual({ accentColor: 0xff0284c7 });
  expect(expand("caret-color", "rgb(0 128 0)")).toEqual({ caretColor: 0xff008000 });

  // `auto` is alpha 0, the same "nothing was said here" sentinel `scrollbar-color`
  // uses — so neither property needs a companion flag field to be expressible.
  expect(expand("accent-color", "auto")).toEqual({ accentColor: 0x00000000 });
  expect(expand("caret-color", "AUTO")).toEqual({ caretColor: 0x00000000 });
});

test("appearance folds <compat-auto> to auto and keeps base-select distinct", () => {
  expect(expand("appearance", "none")).toEqual({ appearance: 0 });
  expect(expand("appearance", "auto")).toEqual({ appearance: 1 });

  // The opt-in for a fully styleable `<select>` and its `::picker(select)`. The
  // one value that changes *what* is drawn rather than merely whether.
  expect(expand("appearance", "base-select")).toEqual({ appearance: 2 });

  // "The values all behave as `auto`" — so they are accepted and folded, not
  // refused. dziri's field stores the effect; Chrome's computed value is
  // as-specified, which is a representation divergence recorded in conformance.
  for (const v of ["button", "checkbox", "radio", "menulist", "listbox", "meter", "progress-bar", "searchfield", "textarea"]) {
    expect(expand("appearance", v)).toEqual({ appearance: 1 });
  }

  // Chromium 151 rejects these three outright, though MDN's prose lists them.
  // Measured — BROWSER-FACTS.md, same class as `scrollbar-width: thick`.
  expect(() => expand("appearance", "push-button")).toThrow(CssError);
  expect(() => expand("appearance", "square-button")).toThrow(CssError);
  expect(() => expand("appearance", "slider-horizontal")).toThrow(CssError);

  // Specified but unimplemented anywhere, and Chromium drops the declaration.
  expect(() => expand("appearance", "base")).toThrow(CssError);

  // `<compat-special>`: real distinct effects, and dziri has neither an input-type
  // system nor a picker to apply them to. Refusing beats accepting-and-ignoring.
  expect(() => expand("appearance", "textfield")).toThrow(CssError);
  expect(() => expand("appearance", "menulist-button")).toThrow(CssError);
});

test("content takes strings, none and normal, and refuses the rest", () => {
  expect(parseContent(`"x"`)).toBe("x");
  // A hex escape, which is how a stylesheet writes a glyph without depending on
  // the file's encoding. The optional trailing space is part of the escape.
  expect(parseContent(`"\\2713"`)).toBe("✓");
  expect(parseContent(`"\\2713 ok"`)).toBe("✓ok");
  expect(parseContent(`'\\201C'`)).toBe("\u201C");
  expect(parseContent(`"\\"q\\""`)).toBe(`"q"`);
  // A content-list of strings concatenates.
  expect(parseContent(`"a" "b"`)).toBe("ab");

  // Not an error case: CSS says the pseudo-element is simply not rendered.
  expect(parseContent("none")).toBeNull();
  expect(parseContent("normal")).toBeNull();

  // Each of these is a *different feature* — counters need tree state, attr()
  // needs attributes in the IR, images need A5 — so rendering nothing for them
  // would look like a stylesheet bug rather than a missing feature.
  expect(() => parseContent("counter(item)")).toThrow(CssError);
  expect(() => parseContent("attr(data-x)")).toThrow(CssError);
  expect(() => parseContent('url("i.png")')).toThrow(CssError);
  expect(() => parseContent('"unterminated')).toThrow(CssError);
});

test("::before and ::after parse, and the rest are refused by name", () => {
  const one = parseSelector("div.btn:hover::before");
  expect(one.element).toBe("before");
  expect(one.pseudo).toBe("hover");
  // A pseudo-element counts in the type column, a pseudo-class in the class one.
  expect(one.specificity).toEqual([0, 2, 2]);

  // CSS2's single-colon spelling is the same thing — MDN: "Browsers also accept
  // single-colon notation". Refusing it would reject valid stylesheets to make a
  // point about a notation change from Selectors Level 3.
  expect(parseSelector("p:after").element).toBe("after");

  // Named rather than lumped into "unsupported syntax", because these are the
  // ones a form-control stylesheet will reach for next.
  expect(() => parseSelector("select::picker-icon")).toThrow(/unsupported pseudo-element/);
  expect(() => parseSelector("input::placeholder")).toThrow(/unsupported pseudo-element/);

  // Only on the subject, only one, and a pseudo-class may not follow it.
  expect(() => parseSelector("div::before span")).toThrow(CssError);
  expect(() => parseSelector("div::before::after")).toThrow(CssError);
  expect(() => parseSelector("div::before:hover")).toThrow(CssError);
});

/**
 * The `visible`-to-`auto` coercion, against what Chromium 151 was measured doing.
 *
 * Every row here corresponds to a row of the table in BROWSER-FACTS.md
 * (`probes/overflow-axis-coercion.html`). This is the test that keeps the compiler and
 * the measurement from drifting: if someone re-runs the probe and the engine has
 * changed, this fails and points at the recorded fact rather than at a guess.
 */
test("a visible axis becomes scrollable when the other axis scrolls", () => {
  // `styleOf` is not usable here — the coercion happens when the cascade finishes, so
  // it has to be observed through a compiled node rather than through `expand`.
  const declared = (css: string): { x: number; y: number } => {
    const ui = toCompiledUi(compile(`<body><div class="a"></div></body>`, `.a { ${css} }`));
    const styles = ui.styles as unknown as Record<string, ArrayLike<number>>;
    // node 1 is the div; node 0 is body.
    const slot = ui.nodes.style[1]!;
    return { x: styles.overflowX![slot]!, y: styles.overflowY![slot]! };
  };

  const VISIBLE = 0;
  const HIDDEN = 1;
  const SCROLL = 3;
  const CLIP = 4;

  // One axis scrolls, so the other cannot stay `visible`: content spilling out of it
  // would have nowhere to go.
  expect(declared("overflow-y: auto")).toEqual({ x: SCROLL, y: SCROLL });
  expect(declared("overflow-y: scroll")).toEqual({ x: SCROLL, y: SCROLL });
  expect(declared("overflow-y: hidden")).toEqual({ x: SCROLL, y: HIDDEN });
  expect(declared("overflow-x: auto")).toEqual({ x: SCROLL, y: SCROLL });

  // Even when the author writes `visible` explicitly. Measured, and surprising enough
  // that it is worth its own case.
  expect(declared("overflow-x: visible; overflow-y: auto")).toEqual({ x: SCROLL, y: SCROLL });
  expect(declared("overflow-x: visible; overflow-y: hidden")).toEqual({ x: SCROLL, y: HIDDEN });

  // `clip` is not a scroll container, so it coerces nothing — the one exception, and
  // the reason `CLIP` exists separately from `HIDDEN`.
  expect(declared("overflow-y: clip")).toEqual({ x: VISIBLE, y: CLIP });
  expect(declared("overflow-x: visible; overflow-y: clip")).toEqual({ x: VISIBLE, y: CLIP });

  // And nothing is coerced when nothing scrolls.
  expect(declared("overflow: visible")).toEqual({ x: VISIBLE, y: VISIBLE });
  expect(declared("width: 10px")).toEqual({ x: VISIBLE, y: VISIBLE });
});

// ---------------------------------------------------------------------------
// calc(), folded at compile time
// ---------------------------------------------------------------------------

test("calc() folds to a number, with CSS's precedence", () => {
  expect(parseLength("calc(4px + 6px)")).toBe(10);
  expect(parseLength("calc(10px - 2px)")).toBe(8);
  // `*` and `/` bind tighter than `+` and `-`.
  expect(parseLength("calc(2px + 3px * 4)")).toBe(14);
  expect(parseLength("calc((2px + 3px) * 4)")).toBe(20);
  expect(parseLength("calc(20px / 4)")).toBe(5);
  // Units are resolved before the arithmetic, so mixing them is fine.
  expect(parseLength("calc(1rem + 4px)")).toBe(20);
  expect(parseLength("calc(100px - 2rem)")).toBe(68);
  // A nested calc() is just a parenthesised sub-expression, per spec.
  expect(parseLength("calc(calc(2px + 2px) * 3)")).toBe(12);
  // Unary minus, which is what `calc(-1 * x)` leaves after substitution.
  expect(parseLength("calc(-4px + 10px)")).toBe(6);
});

test("calc() refuses what it cannot know at compile time", () => {
  // A percentage has no answer until the containing block exists, and guessing
  // one would be worse than refusing: it would silently lay out wrongly.
  expect(() => parseLength("calc(100% - 10px)")).toThrow(/percentage/);
  expect(() => parseLength("calc(4px + )")).toThrow();
  expect(() => parseLength("calc(4px / 0)")).toThrow(/division by zero/);
  expect(() => parseLength("calc((4px)")).toThrow(/unclosed/);
});

// ---------------------------------------------------------------------------
// Custom properties and var()
// ---------------------------------------------------------------------------

test("custom properties inherit, and var() resolves through the cascade", () => {
  const rules = parseCss(`.a { --pad: 8px; --brand: #3b82f6 }`);
  // The declaration survives parsing with its case and its `--` intact.
  expect(rules[0]!.decls.get("--pad")).toBe("8px");
  expect(rules[0]!.decls.get("--brand")).toBe("#3b82f6");
});

test("custom property names keep their case, unlike every other property", () => {
  // `--Foo` and `--foo` are two different properties in CSS. Ordinary property
  // names are folded to lower case; doing that to these would merge them.
  const rules = parseCss(`.a { --Foo: 1px; --foo: 2px; COLOR: red }`);
  expect(rules[0]!.decls.get("--Foo")).toBe("1px");
  expect(rules[0]!.decls.get("--foo")).toBe("2px");
  expect(rules[0]!.decls.get("color")).toBe("red");
});

test("substituteVars handles fallbacks, nesting and cycles", async () => {
  const { substituteVars } = await import("./css.ts");
  const env = new Map([
    ["--a", "4px"],
    ["--b", "var(--a)"],
    ["--loop", "var(--loop2)"],
    ["--loop2", "var(--loop)"],
  ]);

  expect(substituteVars("var(--a)", env)).toBe("4px");
  // A variable whose value is itself a var() resolves through.
  expect(substituteVars("var(--b)", env)).toBe("4px");
  // The fallback is everything after the *first* comma, not the next token.
  expect(substituteVars("var(--nope, 1px 2px)", env)).toBe("1px 2px");
  expect(substituteVars("var(--nope, var(--a))", env)).toBe("4px");
  // var() can supply part of a value, not only the whole of one.
  expect(substituteVars("calc(var(--a) * 2)", env)).toBe("calc(4px * 2)");
  expect(substituteVars("var(--a) 9px var(--a)", env)).toBe("4px 9px 4px");
  // Unset with no fallback invalidates the declaration, which is `null` here.
  expect(substituteVars("var(--nope)", env)).toBeNull();
  // A cycle is invalid rather than a hang.
  expect(substituteVars("var(--loop)", env)).toBeNull();
});

// ---------------------------------------------------------------------------
// At-rules
// ---------------------------------------------------------------------------

test("an at-rule no longer eats the rule that follows it", () => {
  // The old scan took the first `}` after the prelude, which for a nested block
  // is the *inner* one — so parsing resumed mid-at-rule and the next real rule
  // was lost or misparsed. This is the regression test for that.
  //
  // The at-rule used here is one that is still skipped, so what is being tested
  // is the *scan* and not media support: an ignored block must consume exactly
  // itself.
  const rules = parseCss(`@font-face { src: url(x) }\n.b { padding: 4px }`);
  expect(rules.length).toBe(1);
  expect(rules[0]!.decls.get("padding")).toBe("4px");
});

test("a media block keeps its rules, each carrying the condition", () => {
  const rules = parseCss(
    `.a { padding: 1px }\n@media (min-width: 700px) { .a { padding: 99px } .b { color: red } }`,
  );
  expect(rules.length).toBe(3);

  // The unconditional rule is untouched.
  expect(rules[0]!.media).toBeUndefined();

  // Both rules inside carry the same condition, resolved to px.
  for (const r of rules.slice(1)) {
    expect(r.media).toEqual([{ axis: "width", side: "min", px: 700 }]);
  }
});

test("nested media blocks intersect rather than replace", () => {
  const rules = parseCss(
    `@media (min-width: 700px) { @media (max-width: 900px) { .a { color: red } } }`,
  );
  expect(rules.length).toBe(1);
  // Outer first, then inner — a conjunction, which the compiler turns into two
  // predicate bits that both have to be live.
  expect(rules[0]!.media).toEqual([
    { axis: "width", side: "min", px: 700 },
    { axis: "width", side: "max", px: 900 },
  ]);
});

test("a media query this engine cannot evaluate is skipped whole", () => {
  // All-or-nothing on purpose. Understanding half of a conjunction and applying
  // it would make the rules inside apply in a case they were written to exclude.
  const rules = parseCss(
    `@media (min-width: 700px) and (orientation: landscape) { .a { color: red } }\n.b { color: blue }`,
  );
  expect(rules.length).toBe(1);
  expect(rules[0]!.decls.get("color")).toBe("blue");
});

test("media queries accept both the long form and range syntax", () => {
  // Tailwind v4 emits the second: `@media (width >= 48rem)`.
  const long = parseCss(`@media (min-width: 768px) { .a { color: red } }`);
  const range = parseCss(`@media (width >= 48rem) { .a { color: red } }`);
  expect(long[0]!.media).toEqual(range[0]!.media);
  expect(range[0]!.media).toEqual([{ axis: "width", side: "min", px: 768 }]);
});

test("@layer is transparent and @theme declares on :root", () => {
  const rules = parseCss(`@layer utilities { .a { color: red } }`);
  expect(rules.length).toBe(1);
  expect(rules[0]!.decls.get("color")).toBe("red");

  const theme = parseCss(`@theme { --brand: #3b82f6 }`);
  expect(theme.length).toBe(1);
  expect(theme[0]!.selectors[0]!.root).toBe(true);
  expect(theme[0]!.decls.get("--brand")).toBe("#3b82f6");
});

test("a box shorthand containing calc() is one value, not three", () => {
  // `padding: calc(4px * 2)` splits on whitespace into `calc(4px`, `*`, `2)`
  // unless the split is paren-aware. It reached a length parser as "4p".
  const patch: Record<string, number> = {};
  expandDeclaration("padding", "calc(4px * 2)", patch as never);
  expect(patch.padT).toBe(8);
  expect(patch.padL).toBe(8);
});

test("oklch() converts to the sRGB Chrome paints", () => {
  // Not a nicety: Tailwind v4's whole palette is oklch, so without this every
  // bg-*/text-*/border-* in a Tailwind sheet fails and the frame renders black.
  //
  // Every expectation here was read out of Chrome's own rasteriser — fill a 1x1
  // canvas and read the pixel — rather than computed from the same matrices this
  // is being tested against, which would only prove it agrees with itself.
  const rgb = (c: string) => {
    const v = parseColor(c);
    return [(v >>> 16) & 255, (v >>> 8) & 255, v & 255, (v >>> 24) & 255];
  };

  expect(rgb("oklch(21% 0.006 285.885)")).toEqual([24, 24, 27, 255]); // zinc-900
  expect(rgb("oklch(62.3% 0.214 259.815)")).toEqual([43, 127, 255, 255]); // blue-500
  expect(rgb("oklch(63.7% 0.237 25.331)")).toEqual([251, 44, 54, 255]); // red-500
  expect(rgb("oklch(72.3% 0.219 149.579)")).toEqual([0, 201, 80, 255]); // green-500
  expect(rgb("oklch(100% 0 0)")).toEqual([255, 255, 255, 255]);
  expect(rgb("oklch(0% 0 0)")).toEqual([0, 0, 0, 255]);

  // Alpha after a slash. Chrome rasterises this as 245,52,153,128; the one-unit
  // differences are 8-bit rounding from different intermediate precision.
  const a = rgb("oklch(65.6% 0.241 354.308 / 0.5)");
  expect(a[3]).toBe(128);
  expect(Math.abs(a[0]! - 245)).toBeLessThanOrEqual(1);
  expect(Math.abs(a[1]! - 52)).toBeLessThanOrEqual(1);
  expect(Math.abs(a[2]! - 153)).toBeLessThanOrEqual(1);
});

test("`none` is a missing oklch component, not a syntax error", () => {
  // CSS Color 4 §4.2: `none` means the component is missing, and outside
  // interpolation it computes to zero. Tailwind 4.3 emits exactly this for every
  // neutral — `--color-zinc-50: oklch(98.5% 0 none)` — so rejecting it failed the
  // greys a UI is mostly made of while the saturated colours parsed, which reads
  // like a bad token rather than a missing feature. Found by the Tailwind window.
  const rgb = (c: string) => {
    const v = parseColor(c);
    return [(v >>> 16) & 255, (v >>> 8) & 255, v & 255, (v >>> 24) & 255];
  };

  // A hue of `none` is a hue of 0, so these two must agree exactly.
  expect(rgb("oklch(98.5% 0 none)")).toEqual(rgb("oklch(98.5% 0 0)"));
  expect(rgb("oklch(98.5% 0 none)")).toEqual([250, 250, 250, 255]); // zinc-50

  // And in the other components, for the same reason.
  expect(rgb("oklch(none 0 0)")).toEqual([0, 0, 0, 255]);
  expect(rgb("oklch(50% none 180)")).toEqual(rgb("oklch(50% 0 180)"));
});

test("border-radius expands per corner, like padding does", () => {
  // The one-field version took the first value and threw the rest away, so
  // `border-radius: 8px 0 0 8px` was a fully rounded box — and `rounded-t-lg`, most
  // of what Tailwind's radius utilities are, could not be expressed at all.
  const r = (value: string) => {
    const out: Record<string, number> = {};
    expandDeclaration("border-radius", value, out as never);
    return [out.radTL, out.radTR, out.radBR, out.radBL];
  };

  expect(r("8px")).toEqual([8, 8, 8, 8]);
  // Two: top-left/bottom-right, then top-right/bottom-left — the diagonals.
  expect(r("8px 2px")).toEqual([8, 2, 8, 2]);
  expect(r("8px 2px 4px")).toEqual([8, 2, 4, 2]);
  expect(r("1px 2px 3px 4px")).toEqual([1, 2, 3, 4]);

  // The longhands, which is what Tailwind's `rounded-t-*` actually emits.
  const one: Record<string, number> = {};
  expandDeclaration("border-top-left-radius", "12px", one as never);
  expandDeclaration("border-bottom-right-radius", "4px", one as never);
  expect([one.radTL, one.radTR, one.radBR, one.radBL]).toEqual([12, undefined, 4, undefined]);
});

test("elliptical border-radius is refused, not half-read", () => {
  // Taking the part before the slash would silently turn an ellipse into a circle,
  // which is a wrong frame with no diagnostic. Two radii per corner would double
  // the fields for a value almost nobody writes.
  expect(() => expandDeclaration("border-radius", "10px / 20px", {} as never)).toThrow(CssError);
});

test("logical properties map onto the physical ones", () => {
  // `px-4`/`py-2` — the spacing utilities people actually use — compile to
  // `padding-inline`/`padding-block`, not to `padding-left`.
  const p: Record<string, number> = {};
  expandDeclaration("padding-inline", "4px", p as never);
  expandDeclaration("padding-block", "2px", p as never);
  expect(p.padL).toBe(4);
  expect(p.padR).toBe(4);
  expect(p.padT).toBe(2);
  expect(p.padB).toBe(2);

  // Two values are start then end, as in CSS.
  const q: Record<string, number> = {};
  expandDeclaration("margin-inline", "1px 9px", q as never);
  expect(q.marL).toBe(1);
  expect(q.marR).toBe(9);

  const r: Record<string, number> = {};
  expandDeclaration("padding-inline-start", "7px", r as never);
  expandDeclaration("padding-block-end", "3px", r as never);
  expect(r.padL).toBe(7);
  expect(r.padB).toBe(3);
});

test("a statement at-rule does not swallow the rule after it", () => {
  // `@layer properties;` has no block, so a scan that looks for the next `{`
  // runs past its semicolon and takes the following selector into its prelude.
  // Tailwind v4 opens with exactly that, and the rule it ate was the `:root`
  // block holding every design token — so the sheet parsed and every
  // `var(--color-*)` in it silently resolved to nothing.
  const rules = parseCss(`@layer properties;\n:root { --brand: #123456 }\n.a { color: var(--brand) }`);
  expect(rules.length).toBe(2);
  expect(rules[0]!.selectors[0]!.root).toBe(true);
  expect(rules[0]!.decls.get("--brand")).toBe("#123456");
});

test(":host parses and matches nothing, so :root, :host still works", () => {
  // Tailwind writes `:root, :host` for its theme block. Refusing `:host` would
  // throw the `:root` half away with it.
  const rules = parseCss(`:root, :host { --brand: red }`);
  expect(rules[0]!.selectors.length).toBe(2);
  expect(rules[0]!.selectors[0]!.root).toBe(true);
  expect(rules[0]!.selectors[1]!.never).toBe(true);
});

test("a nested block inside a rule body is skipped, not misread", () => {
  // CSS nesting is real and Tailwind emits it. Splitting a body on `;` hands the
  // parser a bare `}` and it reports "declaration without a colon".
  const rules = parseCss(`.container { width: 100%; @media (width >= 40rem) { max-width: 40rem } color: red }`);
  expect(rules[0]!.decls.get("width")).toBe("100%");
  expect(rules[0]!.decls.get("color")).toBe("red");
  // The nested block contributed nothing — it needs predicates that do not exist.
  expect(rules[0]!.decls.has("max-width")).toBe(false);
});

// ---------------------------------------------------------------------------
// transform
//
// The interesting assertions here are against *measured* matrices rather than
// against whatever the code happens to do. `probes/transform-composition.html`
// read the exact matrix Chromium 151 computes for each of these lists; the
// numbers below are those readings, and `composed` rebuilds them from the
// decomposed fields the compiler stores. A wrong composition order still
// produces a plausible-looking matrix, so this is the assertion that catches it.
// ---------------------------------------------------------------------------

/** CSS `matrix(a,b,c,d,e,f)`. */
type Mat = [number, number, number, number, number, number];

/** `p` then `q`, as CSS composes a list: the matrix product `P × Q`. */
function mul(p: Mat, q: Mat): Mat {
  const [pa, pb, pc, pd, pe, pf] = p;
  const [qa, qb, qc, qd, qe, qf] = q;
  return [
    pa * qa + pc * qb,
    pb * qa + pd * qb,
    pa * qc + pc * qd,
    pb * qc + pd * qd,
    pa * qe + pc * qf + pe,
    pb * qe + pd * qf + pf,
  ];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * The decomposed fields composed back into one matrix, in the single order
 * dziri stores: translate, rotate, skewX, skewY, scale. The engine has to do
 * this same composition at paint time.
 */
function composed(f: Record<string, number>): Mat {
  const g = (k: string, dflt: number) => (f[k] === undefined ? dflt : f[k]!);
  let m: Mat = [1, 0, 0, 1, g("translateX", 0), g("translateY", 0)];
  const r = rad(g("rotate", 0));
  m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
  m = mul(m, [1, 0, Math.tan(rad(g("skewX", 0))), 1, 0, 0]);
  m = mul(m, [1, Math.tan(rad(g("skewY", 0))), 0, 1, 0, 0]);
  m = mul(m, [g("scaleX", 1), 0, 0, g("scaleY", 1), 0, 0]);
  return m;
}

function expectMatrix(actual: Mat, want: Mat): void {
  for (let i = 0; i < 6; i++) expect(actual[i]!).toBeCloseTo(want[i]!, 4);
}

test("the decomposed fields compose to the matrix Chromium computes", () => {
  // Every `want` here was read off Chromium 151 with getComputedStyle.
  expectMatrix(composed(expand("transform", "translate(10px,20px) rotate(30deg) scale(2,3)")), [
    1.73205, 1, -1.5, 2.59808, 10, 20,
  ]);
  expectMatrix(
    composed(
      expand("transform", "translate(10px,20px) rotate(30deg) skewX(10deg) skewY(5deg) scale(2,3)"),
    ),
    [1.67128, 1.16696, -1.04189, 2.86257, 10, 20],
  );
  expectMatrix(composed(expand("transform", "skewX(10deg) skewY(5deg)")), [
    1.01543, 0.0874887, 0.176327, 1, 0, 0,
  ]);
  expectMatrix(composed(expand("transform", "rotate(45deg)")), [
    0.707107, 0.707107, -0.707107, 0.707107, 0, 0,
  ]);
  // An eighth of a turn is the same matrix as 45 degrees, measured.
  expectMatrix(composed(expand("transform", "rotate(0.125turn)")), [
    0.707107, 0.707107, -0.707107, 0.707107, 0, 0,
  ]);
  expectMatrix(composed(expand("transform", "scale(2,3)")), [2, 0, 0, 3, 0, 0]);
  // No transform at all is the identity, which is what makes scale's initial 1
  // rather than 0 load-bearing.
  expectMatrix(composed({}), [1, 0, 0, 1, 0, 0]);
});

test("the individual properties compose the same as the equivalent list", () => {
  // Measured: `translate:10px 20px; rotate:30deg; scale:2 3` lands on the same
  // rect as the one-line form. The cascade applies each property once into one
  // patch, so that equivalence has to hold field by field here.
  const separate: Record<string, number> = {};
  expandDeclaration("translate", "10px 20px", separate as never);
  expandDeclaration("rotate", "30deg", separate as never);
  expandDeclaration("scale", "2 3", separate as never);

  expectMatrix(
    composed(separate),
    composed(expand("transform", "translate(10px,20px) rotate(30deg) scale(2,3)")),
  );
});

test("the source order of the individual properties does not matter", () => {
  // Measured: the scrambled declaration order produces an identical rect,
  // because the composition order is the property's and not the stylesheet's.
  const scrambled: Record<string, number> = {};
  expandDeclaration("scale", "2 3", scrambled as never);
  expandDeclaration("rotate", "30deg", scrambled as never);
  expandDeclaration("translate", "10px 20px", scrambled as never);

  expectMatrix(composed(scrambled), [1.73205, 1, -1.5, 2.59808, 10, 20]);
});

test("angles take all four CSS units, and a bare one only at zero", () => {
  expect(expand("rotate", "45deg").rotate).toBeCloseTo(45, 6);
  expect(expand("rotate", "0.125turn").rotate).toBeCloseTo(45, 6);
  expect(expand("rotate", "50grad").rotate).toBeCloseTo(45, 6);
  expect(expand("rotate", "0.7853981634rad").rotate).toBeCloseTo(45, 6);
  expect(expand("rotate", "0").rotate).toBe(0);
  // Not a lenient 45 degrees — an invalid declaration a browser drops.
  expect(() => expand("rotate", "45")).toThrow(/needs a unit/);
});

test("a percentage translate is kept apart from a px one", () => {
  // It cannot be folded: the percentage is of the node's own border box, which
  // is layout's answer and not the compiler's. Both halves travel.
  expect(expand("transform", "translateX(50%)")).toEqual({
    translateX: 0,
    translateY: 0,
    translatePctX: 0.5,
    translatePctY: 0,
  });
  expect(expand("transform", "translate(10px, 25%)")).toEqual({
    translateX: 10,
    translateY: 0,
    translatePctX: 0,
    translatePctY: 0.25,
  });
});

test("one argument means different things to translate, skew and scale", () => {
  // `translate` and `skew` leave the other axis alone; `scale` copies to both.
  expect(expand("transform", "translate(10px)").translateY).toBe(0);
  expect(expand("transform", "skew(10deg)").skewY).toBeUndefined();
  expect(expand("transform", "scale(2)")).toEqual({ scaleX: 2, scaleY: 2 });
  expect(expand("transform", "scale(2,3)")).toEqual({ scaleX: 2, scaleY: 3 });
});

test("repeated functions of the same rank accumulate", () => {
  // Two translations add and two scales multiply however they are nested, so
  // these stay inside the one canonical order rather than breaking it.
  expect(expand("transform", "translateX(10px) translateY(20px) translateX(5px)")).toEqual({
    translateX: 15,
    translateY: 20,
    translatePctX: 0,
    translatePctY: 0,
  });
  expect(expand("transform", "scale(2) scaleX(3)")).toEqual({ scaleX: 6, scaleY: 2 });
  expect(expand("transform", "rotate(45deg) rotate(45deg)").rotate).toBeCloseTo(90, 6);
});

test("a transform list out of canonical order is refused, not reordered", () => {
  // Measured: `rotate(90deg) translateX(100px)` puts the box 100px *below* where
  // the reverse puts it, so silently reordering would render something the
  // author cannot get a browser to show them.
  expect(() => expand("transform", "rotate(45deg) translateX(10px)")).toThrow(
    /not in an order dziri can store/,
  );
  expect(() => expand("transform", "scale(2) rotate(45deg)")).toThrow(/order/i);
  // Same rank either way round, so this one is fine.
  expect(() => expand("transform", "translateX(10px) translateY(5px)")).not.toThrow();
});

test("transform functions dziri cannot store are refused by name", () => {
  expect(() => expand("transform", "matrix(1,0,0,1,10,20)")).toThrow(/matrix\(\) is not supported/);
  expect(() => expand("transform", "translate3d(1px,2px,3px)")).toThrow(/3D/);
  expect(() => expand("transform", "rotateZ(45deg)")).toThrow(/use that/);
  expect(() => expand("transform", "wobble(3px)")).toThrow(/unknown function/);
  expect(() => expand("transform", "translateX 10px")).toThrow(/not a function call/);
});

test("transform: none and the individual nones contribute nothing", () => {
  expect(expand("transform", "none")).toEqual({});
  expect(expand("translate", "none")).toEqual({});
  expect(expand("rotate", "none")).toEqual({});
  expect(expand("scale", "none")).toEqual({});
});

test("transform-origin defaults to the centre and resolves keywords", () => {
  const origin = (v: string) => expand("transform-origin", v);

  // Measured on a 100x50 box: unset reads back `50px 25px`, which is 50% 50%.
  expect(origin("50% 50%")).toEqual({
    originPxX: 0,
    originPxY: 0,
    originPctX: 0.5,
    originPctY: 0.5,
  });
  expect(origin("0 0")).toEqual({ originPxX: 0, originPxY: 0, originPctX: 0, originPctY: 0 });
  expect(origin("25% 75%")).toEqual({
    originPxX: 0,
    originPxY: 0,
    originPctX: 0.25,
    originPctY: 0.75,
  });
  expect(origin("10px 20px")).toEqual({
    originPxX: 10,
    originPxY: 20,
    originPctX: 0,
    originPctY: 0,
  });

  // Both keywords, so either order names the same point — measured, `top left`
  // and `left top` both compute to `0px 0px`.
  expect(origin("top left")).toEqual(origin("left top"));
  expect(origin("left top")).toEqual({ originPxX: 0, originPxY: 0, originPctX: 0, originPctY: 0 });
  expect(origin("bottom right")).toEqual({
    originPxX: 0,
    originPxY: 0,
    originPctX: 1,
    originPctY: 1,
  });
  expect(origin("center")).toEqual({
    originPxX: 0,
    originPxY: 0,
    originPctX: 0.5,
    originPctY: 0.5,
  });

  // One value sets X and centres Y — unless it names the Y axis, where it reads
  // as `center top` and X stays centred.
  expect(origin("left")).toEqual({ originPxX: 0, originPxY: 0, originPctX: 0, originPctY: 0.5 });
  expect(origin("top")).toEqual({ originPxX: 0, originPxY: 0, originPctX: 0.5, originPctY: 0 });
});

test("transform-origin refuses what CSS refuses", () => {
  // The swapped form needs *both* components to be keywords, so a Y keyword
  // cannot sit in the X slot beside a length.
  expect(() => expand("transform-origin", "top 10px")).toThrow(
    /names the Y axis but sits in the X/,
  );
  expect(() => expand("transform-origin", "10px left")).toThrow(
    /names the X axis but sits in the Y/,
  );
  expect(() => expand("transform-origin", "left right")).toThrow(/names the X axis twice/);
  // The third value is a Z origin, and dziri is 2D.
  expect(() => expand("transform-origin", "50% 50% 5px")).toThrow(/2D/);
});

// ---------------------------------------------------------------------------
// @property
//
// Not an academic corner. Ignoring this at-rule made every Tailwind `translate-*`
// and `scale-*` utility compile cleanly and render nothing, because the value they
// depend on comes from `initial-value` and an unresolvable `var()` drops the whole
// declaration. Found by looking at a screenshot.
// ---------------------------------------------------------------------------

test("@property supplies the initial value a var() would otherwise not resolve", () => {
  // Exactly Tailwind's shape: the rule sets X and leaves Y to the registration.
  const rules = parseCss(
    `@property --tw-translate-y { syntax: "*"; inherits: false; initial-value: 0 }\n` +
      `.a { --tw-translate-x: 4px; translate: var(--tw-translate-x) var(--tw-translate-y) }`,
  );
  expect(rules.properties.get("--tw-translate-y")).toEqual({ initial: "0", inherits: false });

  const decls = rules[0]!.decls;
  const env = extendVarEnv(new Map([["--tw-translate-x", "4px"]]), decls, rules.properties);
  const value = substituteVars(decls.get("translate")!, env, 0, rules.properties);
  expect(value).toBe("4px 0");
});

test("an unregistered var with no fallback still drops the declaration", () => {
  // The registration is what makes the difference, so the negative case has to
  // keep working or this would be a blanket "resolve to empty".
  const rules = parseCss(`.a { translate: var(--nope) }`);
  expect(substituteVars(rules[0]!.decls.get("translate")!, new Map(), 0, rules.properties)).toBe(
    null,
  );
});

test("a registered initial value beats a var() fallback", () => {
  // A registered property is never *unset*, so its initial value is its computed
  // value and the fallback arm is never reached.
  const rules = parseCss(
    `@property --x { syntax: "*"; inherits: false; initial-value: 7px }\n.a { width: var(--x, 99px) }`,
  );
  expect(substituteVars(rules[0]!.decls.get("width")!, new Map(), 0, rules.properties)).toBe("7px");
});

test("inherits: false stops a child seeing its parent's value", () => {
  // The case that matters: a translated card containing a translated badge. If
  // `--tw-translate-x` inherited, the badge would pick up the card's shift.
  const rules = parseCss(
    `@property --tw-translate-x { syntax: "*"; inherits: false; initial-value: 0 }\n` +
      `@property --brand { syntax: "*"; inherits: true; initial-value: red }\n` +
      `.child { translate: var(--tw-translate-x) 0 }`,
  );
  const parent = new Map([
    ["--tw-translate-x", "16px"],
    ["--brand", "blue"],
  ]);
  const child = extendVarEnv(parent, new Map(), rules.properties);

  expect(child.has("--tw-translate-x")).toBe(false);
  // So the child falls back to the registration's initial value, not the parent's.
  expect(substituteVars(rules[0]!.decls.get("translate")!, child, 0, rules.properties)).toBe("0 0");
  // An inheriting registration is left alone, which is what keeps themes working.
  expect(child.get("--brand")).toBe("blue");
});

test("a registration with no initial-value is not recorded", () => {
  // `@property --x { syntax: "*" }` is invalid CSS for a non-universal syntax and
  // supplies nothing either way, so it must not register an `undefined` initial
  // that would then resolve to the string "undefined".
  const rules = parseCss(`@property --x { syntax: "*"; inherits: false }\n.a { width: var(--x) }`);
  expect(rules.properties.has("--x")).toBe(false);
  expect(substituteVars(rules[0]!.decls.get("width")!, new Map(), 0, rules.properties)).toBe(null);
});

test("Tailwind's negative and fractional transform utilities fold", () => {
  // Both arrive as calc(), which is how Tailwind writes every negative utility and
  // every fraction. Neither parsed before the demo page was built.
  expect(expand("rotate", "calc(12deg * -1)").rotate).toBeCloseTo(-12, 6);
  expect(expand("translate", "calc(1 / 2 * 100%) 0")).toEqual({
    translateX: 0,
    translateY: 0,
    translatePctX: 0.5,
    translatePctY: 0,
  });
  // A calc that genuinely mixes the two cannot fold — these are two fields
  // precisely because one of them needs the laid-out box.
  expect(() => expand("translate", "calc(10px + 50%) 0")).toThrow(/mixes a length and a percentage/);
});

test("opacity clamps rather than refusing, and takes a percentage", () => {
  expect(expand("opacity", "0.5")).toEqual({ opacity: 0.5 });
  expect(expand("opacity", "50%")).toEqual({ opacity: 0.5 });
  // Legal CSS, and it means fully opaque.
  expect(expand("opacity", "1.5")).toEqual({ opacity: 1 });
  expect(expand("opacity", "-1")).toEqual({ opacity: 0 });
  expect(() => expand("opacity", "opaque")).toThrow(/bad opacity/);
});
