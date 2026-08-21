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
import { parseCss, parseSelector } from "./css.ts";
import {
  animationFrom,
  extendVarEnv,
  parseColor,
  parseEasing,
  parseLength,
  parseTime,
  substituteVars,
  transitionFrom,
  transitionMask,
} from "./values.ts";
import { expandDeclaration, parseContent } from "./properties.ts";
import { CssError, formatCssError } from "./diagnostics.ts";
import { Easing, StepPosition } from "../ir.ts";
import { ANIM_ALL, ANIM_BIT } from "../protocol/generated.ts";

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
  // twenty-two that share the `input` tag. A pseudo-element dziry does not have
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
  //
  // The example is a sibling combinator, not `>` — that one is supported now, as
  // of `space-y-*`, which needs `:where(.space-y-4 > :not(:last-child))`.
  const src = "/* a comment\n   spanning\n   three lines */\n.a + .b { color: red }\n";
  const out = diagnose(src);
  expect(out).toContain("sheet.css:4:1");
  expect(out).toContain('the "+" sibling combinator is not supported');
});

test("a comment on the same line does not shift the column", () => {
  const out = diagnose("/* lead */ .a + .b { color: red }\n");
  expect(out).toContain("sheet.css:1:12");
});

test("a declaration without a colon points at the declaration", () => {
  const out = diagnose(".a { color: red;\n     background red }\n");
  expect(out).toContain("sheet.css:2:6");
  expect(out).toContain("declaration without a colon");
});

test("the second selector in a list is located, not the first", () => {
  const out = diagnose(".fine, .a + .b { color: red }\n");
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

/**
 * Tailwind's ring utilities, as the compiler actually receives them.
 *
 * Not hand-written approximations of the CSS: these are the strings dziry's own
 * `var()`/`@property` machinery produces from real Tailwind v4.3.3 output, measured and
 * recorded in BROWSER-FACTS.md. The four transparent placeholders are the unset
 * `--tw-*-shadow` variables reaching their `@property` initial values, and they matter —
 * a parser that choked on `0 0 #0000` would reject every ring in the framework.
 */
const RING = {
  bare: "0 0 #0000, 0 0 #0000, 0 0 #0000,  0 0 0 calc(2px + 0px) #38bdf8, 0 0 #0000",
  offset: "0 0 #0000, 0 0 #0000,  0 0 0 2px #000,  0 0 0 calc(2px + 2px) #38bdf8, 0 0 #0000",
  inset: "0 0 #0000, inset 0 0 0 2px #38bdf8, 0 0 #0000, 0 0 #0000, 0 0 #0000",
  shadowMd:
    "0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, " +
    "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
};

/** Only the ring fields, so a test reads as what the ring is rather than what it is not. */
function rings(value: string): Record<string, number> {
  const all = expand("box-shadow", value);
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== 0));
}

test("Tailwind's ring utilities become concentric bands", () => {
  // `ring-2 ring-sky-400`: one band, two pixels out from the border box.
  expect(rings(RING.bare)).toEqual({ ringOuterWidth: 2, ringOuterColor: 0xff38bdf8 });

  // Add `ring-offset-2 ring-offset-black` and the ring moves out to 4 while a black band
  // fills 0..2. That is what a ring offset *is* — a narrower layer painted over the wider
  // one — and getting it from the same `box-shadow` list is the reason this is one property
  // and not two invented ones.
  expect(rings(RING.offset)).toEqual({
    ringOuterWidth: 4,
    ringOuterColor: 0xff38bdf8,
    ringInnerWidth: 2,
    ringInnerColor: 0xff000000,
  });

  // `inset-ring-2` goes inward and touches neither outset field.
  expect(rings(RING.inset)).toEqual({ ringInsetWidth: 2, ringInsetColor: 0xff38bdf8 });
});

test("a blurred or offset shadow is dropped, not approximated", () => {
  // `shadow-md`. A style row cannot hold a blur, and rendering one as a hard ring would
  // look like a bug in the stylesheet rather than a missing feature — so it warns and
  // draws nothing. It must not *throw*: `shadow-md` is ordinary Tailwind, and a build that
  // failed on it would be unusable.
  expect(rings(RING.shadowMd)).toEqual({});

  // The shorthand resets, so a ring does not survive `box-shadow: none` written after it.
  expect(expand("box-shadow", "none")).toEqual({
    ringOuterWidth: 0,
    ringOuterColor: 0,
    ringInnerWidth: 0,
    ringInnerColor: 0,
    ringInsetWidth: 0,
    ringInsetColor: 0,
  });
});

test("a box-shadow band hidden behind a wider one is dropped", () => {
  // Later layers are painted *behind* earlier ones. A narrow band written after a wide one
  // is entirely covered by it, so storing it would put a colour on screen that CSS does not
  // put there — the opposite order is the ring-offset case above.
  expect(rings("0 0 0 4px red, 0 0 0 2px blue")).toEqual({
    ringOuterWidth: 4,
    ringOuterColor: 0xffff0000,
  });
});

test("a malformed box-shadow layer is refused", () => {
  for (const bad of [
    "0", // one length; CSS needs at least x and y
    "0 0 0 0 0 red", // five lengths
    "0 0 0 2px red blue", // two colours
    "inset inset 0 0 0 2px red", // two insets
  ]) {
    expect(() => expand("box-shadow", bad), bad).toThrow(CssError);
  }
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

test("text-decoration: the line is a bit set and the parts combine", () => {
  expect(expand("text-decoration-line", "underline")).toEqual({ decorationLine: 1 });
  expect(expand("text-decoration-line", "underline overline")).toEqual({ decorationLine: 3 });
  expect(expand("text-decoration-line", "none")).toEqual({ decorationLine: 0 });
  expect(expand("text-decoration", "underline dotted #ff0000 2px")).toEqual({
    decorationLine: 1,
    decorationStyle: 2,
    decorationColor: 0xffff0000,
    decorationThickness: 2,
  });
  expect(expand("text-decoration", "none")).toEqual({ decorationLine: 0 });
  expect(expand("text-underline-offset", "4px")).toEqual({ underlineOffset: 4 });
  expect(expand("text-underline-offset", "auto")).toEqual({ underlineOffset: NaN });
  expect(() => expand("text-decoration-style", "curly")).toThrow(/text-decoration-style/);
});

test("outline is a band outside the border box: width, colour, offset, none", () => {
  expect(expand("outline", "2px solid #ff0000")).toEqual({
    outlineWidth: 2,
    outlineColor: 0xffff0000,
  });
  // `outline: none` is the style talking, and style none is width 0.
  expect(expand("outline", "none")).toMatchObject({ outlineWidth: 0 });
  expect(expand("outline-style", "none")).toEqual({ outlineWidth: 0 });
  expect(expand("outline-offset", "-2px")).toEqual({ outlineOffset: -2 });
  expect(expand("outline-width", "thick")).toEqual({ outlineWidth: 5 });
});

test("per-side borders: the family maps physical and logical onto four fields", () => {
  expect(expand("border-top-color", "#ff0000")).toEqual({ borderTopColor: 0xffff0000 });
  expect(expand("border-inline-color", "#00ff00")).toEqual({
    borderLeftColor: 0xff00ff00,
    borderRightColor: 0xff00ff00,
  });
  expect(expand("border-block-start-width", "2px")).toEqual({ borderTopWidth: 2 });
  expect(expand("border-width", "1px 2px")).toEqual({
    borderTopWidth: 1,
    borderRightWidth: 2,
    borderBottomWidth: 1,
    borderLeftWidth: 2,
  });
  // `border-style: solid none` zeroes right *and* left — the two-value form is
  // [top/bottom, left/right], and the side is the style.
  expect(expand("border-style", "solid none")).toEqual({
    borderRightWidth: 0,
    borderLeftWidth: 0,
  });
  expect(expand("border-top-width", "thick")).toEqual({ borderTopWidth: 5 });
});

test("flex keywords expand as CSS says", () => {
  expect(expand("flex", "none")).toEqual({ grow: 0, shrink: 0, basis: NaN, basisPct: 0 });
  expect(expand("flex", "auto")).toEqual({ grow: 1, shrink: 1, basis: NaN, basisPct: 0 });
  // `flex: 1` is `1 1 0`, not `1 1 auto`: whether an item sizes from its content
  // before growing is visible, and this is the form Tailwind's `flex-1` emits.
  expect(expand("flex", "1")).toEqual({ grow: 1, shrink: 1, basis: 0, basisPct: 0 });
  expect(expand("flex", "2 3")).toEqual({ grow: 2, shrink: 3, basis: 0, basisPct: 0 });
});

test("`flex` with a length basis keeps the basis", () => {
  // A non-numeric second value is the basis, not the shrink: the grammar is
  // `<grow> <shrink>? <basis>?` and the basis is the only length among them.
  expect(expand("flex", "1 100px")).toEqual({ grow: 1, shrink: 1, basis: 100, basisPct: 0 });
  expect(expand("flex", "0 0 auto")).toEqual({ grow: 0, shrink: 0, basis: NaN, basisPct: 0 });
  // Both were once recorded as KNOWN WRONG — the scan compared tokens by value,
  // so a length that *was* parts[1] could never be the basis. The fix came with
  // the percentage channels: telling basis from shrink by *kind* (length vs
  // number) rather than by position is what both needed.
});

// --- recorded defects --------------------------------------------------------
//
// The next one locks in values that are *wrong*, from the review's
// `compiler-css/shorthand-expansion-vs-spec` (MEDIUM). It is here so the
// wrongness is executable rather than filed: nothing in `app.css` reaches these
// forms today, and when the shorthand is rewritten against the spec this test
// fails and says what the new answer should be.

test("`border` resets style to none and honours it, as CSS says", () => {
  // A shorthand with no style keyword resets style to its `none` initial, so a
  // browser paints nothing here — and now neither does dziry.
  expect(expand("border", "#ff0000")).toEqual({
    borderTopWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    borderTopColor: 0xffff0000,
    borderRightColor: 0xffff0000,
    borderBottomColor: 0xffff0000,
    borderLeftColor: 0xffff0000,
  });
  // `none` wins over the width, in either order.
  expect(expand("border", "1px none red")).toMatchObject({ borderTopWidth: 0 });
  expect(expand("border", "none")).toMatchObject({ borderLeftWidth: 0 });
});

test("KNOWN WRONG: `border` with no colour paints nothing instead of currentcolor", () => {
  // Spec: an omitted colour is `currentColor`. The shorthand has no colour token
  // to substitute, so the fields keep their alpha-0 initial and a
  // `border: 2px solid` paints nothing at all. BROWSER-FACTS.md records what
  // implementing the fallback would have to do.
  expect(expand("border", "2px solid")).toEqual({
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
  });
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
  // refused. dziry's field stores the effect; Chrome's computed value is
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

  // `<compat-special>`: real distinct effects, and dziry has neither an input-type
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
  expect(one.pseudos).toEqual(["hover"]);
  // A pseudo-element counts in the type column, a pseudo-class in the class one.
  expect(one.specificity).toEqual([0, 2, 2]);

  // CSS2's single-colon spelling is the same thing — MDN: "Browsers also accept
  // single-colon notation". Refusing it would reject valid stylesheets to make a
  // point about a notation change from Selectors Level 3.
  expect(parseSelector("p:after").element).toBe("after");

  // `::placeholder` parses now — it needed nothing the others need. A picker wants an
  // overlay layer and a checkmark wants a control that can be in that state; a
  // placeholder is a box holding text the markup already carries, which is what
  // `::before` is. It is a *pseudo-element* rather than a pseudo-class, so it lands in
  // the type column exactly as `::before` does.
  const ph = parseSelector("input::placeholder");
  expect(ph.element).toBe("placeholder");
  expect(ph.specificity).toEqual([0, 0, 2]);

  // Named rather than lumped into "unsupported syntax", because these are the
  // ones a form-control stylesheet will reach for next.
  expect(() => parseSelector("select::picker-icon")).toThrow(/unsupported pseudo-element/);
  expect(() => parseSelector("select::checkmark")).toThrow(/unsupported pseudo-element/);

  // Only on the subject, only one, and a pseudo-class may not follow it.
  expect(() => parseSelector("div::before span")).toThrow(CssError);
  expect(() => parseSelector("div::before::after")).toThrow(CssError);
  expect(() => parseSelector("div::before:hover")).toThrow(CssError);
});

/**
 * `space-y-4`, parsed. Tailwind emits it as
 * `:where(.space-y-4 > :not(:last-child))`, so this one selector is the whole
 * feature — the `:where()` wrapper, the child combinator, `:not()` and a
 * structural pseudo-class, in the arrangement they actually arrive in.
 */
test("the space-y selector parses into what it means", () => {
  const sel = parseSelector(":where(.space-y-4 > :not(:last-child))");

  // `:where()` weighs nothing, which is what lets a `margin` utility lose to any
  // author rule that also sets margin.
  expect(sel.specificity).toEqual([0, 0, 0]);
  // One compound — the `:where()` is written on it, not beside it — matching any
  // element that also matches the argument as its subject.
  expect(sel.compounds).toHaveLength(1);

  const arg = sel.compounds[0]!.anyOf![0]![0]!;
  expect(arg.compounds.map((c) => c.classes)).toEqual([["space-y-4"], []]);
  expect(arg.compounds[1]!.combinator).toBe("child");
  expect(arg.compounds[1]!.noneOf![0]!.compounds[0]!.structural).toEqual(["last-child"]);
});

test("the child combinator is recorded, and the sibling ones are refused by name", () => {
  expect(parseSelector(".a > .b").compounds[1]!.combinator).toBe("child");
  // No whitespace around it, which is the form that used to tokenize as one
  // compound and match nothing.
  expect(parseSelector(".a>.b").compounds[1]!.combinator).toBe("child");
  // A descendant leaves it absent rather than spelling it out.
  expect(parseSelector(".a .b").compounds[1]!.combinator).toBeUndefined();

  // Named, because "unsupported syntax" reads as a parser limitation when the
  // reason is that the matcher walks ancestors and these ask about siblings.
  expect(() => parseSelector(".a + .b")).toThrow(/"\+" sibling combinator is not supported/);
  expect(() => parseSelector(".a ~ .b")).toThrow(/"~" sibling combinator is not supported/);
  // A `~` inside an attribute test is an operator, not a combinator. This is the
  // regression the old pre-scan over the raw string caused.
  expect(parseSelector(`[data-tags~="beta"]`).compounds[0]!.attrs).toHaveLength(1);
  // Nothing to the right of it is a mistake, not a selector one compound shorter.
  expect(() => parseSelector(".a > ")).toThrow(/ends in a ">"/);
});

test(":is() takes its argument's specificity and :where() takes none", () => {
  // Both match identically; only the weight differs. Per Selectors 4, the value is
  // the *most specific* argument's, which is why this is a whole triple and not a
  // bump of the class column.
  expect(parseSelector(".a:where(#id.c.d)").specificity).toEqual([0, 1, 0]);
  expect(parseSelector(".a:is(#id.c.d)").specificity).toEqual([1, 3, 0]);
  // `:not()` weighs like `:is()`.
  expect(parseSelector(".a:not(#id)").specificity).toEqual([1, 1, 0]);
  // The most specific of a list wins, not the last or the sum.
  expect(parseSelector(":is(div, #id, .c)").specificity).toEqual([1, 0, 0]);

  // Two `:is()` on one compound are a conjunction, so they stay separate entries.
  // Flattening them would turn "both" into "either" and widen the selector.
  const two = parseSelector(".a:is(.b, .c):is(.d)");
  expect(two.compounds[0]!.anyOf).toHaveLength(2);
  expect(two.compounds[0]!.anyOf![0]).toHaveLength(2);
  // Two `:not()` are also a conjunction, but negation distributes — `:not(a):not(b)`
  // and `:not(a, b)` mean the same thing — so one flat list is enough.
  expect(parseSelector(".a:not(.b):not(.c)").compounds[0]!.noneOf).toHaveLength(2);
  expect(parseSelector(".a:not(.b, .c)").compounds[0]!.noneOf).toHaveLength(2);
});

test("a functional pseudo-class does not confuse the splitters", () => {
  // A top-level comma inside `:is()` belongs to the argument. Splitting the rule
  // prelude on every comma handed the parser `:is(h1` and blamed the author.
  const rules = parseCss(":is(h1, h2) .x { width: 1px }");
  expect(rules).toHaveLength(1);
  expect(rules[0]!.selectors).toHaveLength(1);

  // Whitespace and `>` inside the argument likewise, or the pseudo-class is cut in
  // half at its own space.
  expect(parseSelector(":where(.a > .b)").compounds).toHaveLength(1);

  // Tailwind writes `space-y-(--gap)` as the class `.space-y-\(--gap\)`. An escaped
  // paren is an ident character, so it must not open a functional pseudo-class —
  // otherwise every theme-variable utility reads as unterminated.
  expect(parseSelector(":where(.space-y-\\(--gap\\) > :not(:last-child))").compounds).toHaveLength(1);
  const inner = parseSelector(".space-y-\\(--gap\\)");
  expect(inner.compounds[0]!.classes).toEqual(["space-y-(--gap)"]);

  // An argument may contain an attribute test, which is why the functional pseudos
  // come out *before* the attributes: lifting `[title]` first would leave
  // `:where()` empty and match everything.
  expect(parseSelector("abbr:where([title])").compounds[0]!.anyOf![0]![0]!.compounds[0]!.attrs)
    .toHaveLength(1);

  expect(() => parseSelector(":not()")).toThrow(/has no arguments/);
  expect(() => parseSelector(":where(.a")).toThrow(/unterminated/);
  // Named, and the message says these are the same kind of question rather than a
  // different one, because they are: resolvable straight off the tree.
  expect(() => parseSelector("li:nth-child(2)")).toThrow(/:first-child, :last-child/);
});

test("an interaction pseudo-class is refused inside :is(), :where() and :not()", () => {
  // `:hover` names a style *variant* for the whole rule, so there is no way to make
  // it hold for one compound of a selector. Refused rather than dropped, which
  // would compile `:where(.a:hover)` into a rule that always applies.
  for (const sel of [":where(.a:hover)", ".x:is(.a:focus)", ".x:not(.a:checked)"]) {
    expect(() => parseSelector(sel), sel).toThrow(/cannot be used inside :is\(\)/);
  }
  expect(() => parseSelector(":where(.a::before)")).toThrow(/cannot be used inside :is\(\)/);

  // On the rule itself it is still fine, including alongside a `:where()`.
  expect(parseSelector(":where(.a).b:hover").pseudos).toEqual(["hover"]);
});

/**
 * A compound may name several interaction states, and the rule then holds only
 * while every one does. This parsed for as long as pseudo-classes have existed
 * here — and was silently wrong: a single `pseudo` slot kept whichever was
 * written last, so `:checked:disabled` meant `:disabled`. Found by the UA
 * sheet's disabled-control rules drawing a dot on a disabled unchecked radio.
 */
test("a compound with two pseudo-classes requires both states", () => {
  expect(parseSelector("input:checked:disabled").pseudos).toEqual(["checked", "disabled"]);
  // Both count in specificity, even the duplicate spelling — per the spec.
  expect(parseSelector("input:hover:hover").specificity).toEqual([0, 2, 1]);
  expect(parseSelector("input:hover:hover").pseudos).toEqual(["hover"]);
  // The variant-level consequence is asserted in cascade.test.ts, where the
  // run-reading helpers live: the rule contributes to the checked∧disabled
  // combination and to no other.
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

/**
 * The viewport rule: `visible` on the window root means `auto`.
 *
 * Every case corresponds to a row of the table in BROWSER-FACTS.md
 * (`probes/viewport-default-scroll.html`, Chromium 152): an unstyled page scrolls while
 * `html` and `body` both compute `overflow: visible`, an *explicit* `visible` changes
 * nothing, and `hidden` or `clip` on the root is how page scrolling is turned off.
 * This is why the rule is a root coercion and not a `body { overflow: auto }` UA rule —
 * a UA rule would lose to the author's explicit `visible`.
 */
test("the window root scrolls by default, like a browser page", () => {
  const rootDeclared = (css: string): { x: number; y: number } => {
    const ui = toCompiledUi(compile(`<body><div class="a"></div></body>`, css));
    const styles = ui.styles as unknown as Record<string, ArrayLike<number>>;
    // node 0 is the body, whose box is the viewport.
    const slot = ui.nodes.style[0]!;
    return { x: styles.overflowX![slot]!, y: styles.overflowY![slot]! };
  };

  const HIDDEN = 1;
  const SCROLL = 3;
  const CLIP = 4;

  // Unstyled: an unstyled window scrolls, with no stylesheet anywhere.
  expect(rootDeclared("")).toEqual({ x: SCROLL, y: SCROLL });

  // Explicit `visible` changes nothing — measured, and the reason this is not a UA rule.
  expect(rootDeclared("body { overflow: visible }")).toEqual({ x: SCROLL, y: SCROLL });

  // The author still turns page scrolling off the way a browser author does.
  expect(rootDeclared("body { overflow: hidden }")).toEqual({ x: HIDDEN, y: HIDDEN });

  // `clip` stays `clip`: on the viewport it behaves as `hidden`, and both spell
  // "no page scroll", so there is nothing to coerce it to.
  expect(rootDeclared("body { overflow: clip }")).toEqual({ x: CLIP, y: CLIP });

  // One axis authored: the other is still the viewport's default, not `visible`.
  expect(rootDeclared("body { overflow-y: hidden }")).toEqual({ x: SCROLL, y: HIDDEN });

  // An authored `auto` on the root is untouched — the rule only rewrites `visible`.
  expect(rootDeclared("body { overflow-y: auto }")).toEqual({ x: SCROLL, y: SCROLL });
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
// Lengths layout finishes: percentages and viewport units
//
// Sizing, inset and flex-basis carry three channels — px now, a fraction of the
// containing block, a fraction of the window — and these pin the split.
// ---------------------------------------------------------------------------

test("a percentage length keeps the fraction and zeroes the px", () => {
  expect(expand("width", "50%")).toEqual({ width: 0, widthPct: 0.5, widthVp: 0 });
  expect(expand("width", "calc(1 / 2 * 100%)")).toEqual({ width: 0, widthPct: 0.5, widthVp: 0 });
  // Tailwind's negative fractions nest a calc inside the negation.
  expect(expand("top", "calc(calc(1 / 2 * 100%) * -1)")).toEqual({ insetT: 0, insetTPct: -0.5 });
  expect(expand("flex-basis", "calc(1 / 3 * 100%)")).toEqual({ basis: 0, basisPct: 1 / 3 });
});

test("a viewport length is a fraction of the window, dvh included", () => {
  expect(expand("height", "100vh")).toEqual({ height: 0, heightPct: 0, heightVp: 1 });
  // No browser chrome in a dziry window, so the small/large/dynamic sizes are one.
  expect(expand("height", "100dvh")).toEqual({ height: 0, heightPct: 0, heightVp: 1 });
  // The header-offset pattern: viewport and absolute parts sum.
  expect(expand("height", "calc(100vh - 4rem)")).toEqual({ height: -64, heightPct: 0, heightVp: 1 });
  expect(expand("width", "calc(100vw - 2rem)")).toEqual({ width: -32, widthPct: 0, widthVp: 1 });
});

test("a winning declaration clears the channels the loser set", () => {
  // `width: 50%` then `width: 100px` in one cascade is 100px with *no* fraction —
  // the second declaration writes all three channels, or the sum would be both.
  const patch = { ...expand("width", "50%"), ...expand("width", "100px") };
  expect(patch).toEqual({ width: 100, widthPct: 0, widthVp: 0 });
});

test("the channels refuse what they cannot express", () => {
  // Taffy takes a percent or a length and has no calc to sum them, so a
  // percentage beside an absolute or viewport part is refused, not approximated.
  expect(() => expand("width", "calc(100% - 2rem)")).toThrow(/mixes a percentage/);
  // A width cannot be a function of the window's height — the channel is per-axis.
  expect(() => expand("width", "50vh")).toThrow(/viewport's height/);
  // vmin/vmax pick an axis at run time; no field can.
  expect(() => expand("width", "50vmin")).toThrow(/vmin/);
  // Inset has no viewport channel at all.
  expect(() => expand("top", "10vh")).toThrow(/viewport/);
});

test("the inset shorthand spreads percentages over the four channels", () => {
  expect(expand("inset", "25% 10px")).toEqual({
    insetT: 0,
    insetTPct: 0.25,
    insetR: 10,
    insetRPct: 0,
    insetB: 0,
    insetBPct: 0.25,
    insetL: 10,
    insetLPct: 0,
  });
});

test("flex: 1 1 0% — how Tailwind spells flex-1 — keeps the basis at zero", () => {
  expect(expand("flex", "1 1 0%")).toEqual({ grow: 1, shrink: 1, basis: 0, basisPct: 0 });
  expect(expand("flex", "1 1 50%")).toEqual({ grow: 1, shrink: 1, basis: 0, basisPct: 0.5 });
  // `flex: 1` after `flex: 1 1 50%` means basis 0 — the fraction goes with it.
  const patch = { ...expand("flex", "1 1 50%"), ...expand("flex", "1") };
  expect(patch).toEqual({ grow: 1, shrink: 1, basis: 0, basisPct: 0 });
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
  const { substituteVars } = await import("./values.ts");
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
 * dziry stores: translate, rotate, skewX, skewY, scale. The engine has to do
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
    /not in an order dziry can store/,
  );
  expect(() => expand("transform", "scale(2) rotate(45deg)")).toThrow(/order/i);
  // Same rank either way round, so this one is fine.
  expect(() => expand("transform", "translateX(10px) translateY(5px)")).not.toThrow();
});

test("transform functions dziry cannot store are refused by name", () => {
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
  // The third value is a Z origin, and dziry is 2D.
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

// ---------------------------------------------------------------------------
// Transitions and animations
// ---------------------------------------------------------------------------

test("a CSS <time> needs a unit, and a bare number is not one", () => {
  expect(parseTime("150ms")).toBeCloseTo(0.15, 6);
  expect(parseTime("1s")).toBe(1);
  expect(parseTime("0s")).toBe(0);
  expect(parseTime(" 2S ")).toBe(2);
  // Not a time, and this is load-bearing rather than pedantry: in the `animation`
  // shorthand a bare number is the *iteration count*, so `animation: spin 2 1s` runs
  // twice for one second. Accepting `2` as seconds would silently swap them.
  expect(parseTime("2")).toBeNaN();
  expect(parseTime("0")).toBeNaN();
  expect(parseTime("fast")).toBeNaN();
});

test("the easing keywords carry the control points the spec gives them", () => {
  expect(parseEasing("linear")).toEqual({ easing: Easing.LINEAR, a: 0, b: 0, c: 0, d: 0 });
  expect(parseEasing("ease")).toEqual({
    easing: Easing.CUBIC_BEZIER,
    a: 0.25,
    b: 0.1,
    c: 0.25,
    d: 1,
  });
  expect(parseEasing("ease-in")).toEqual({ easing: Easing.CUBIC_BEZIER, a: 0.42, b: 0, c: 1, d: 1 });
  expect(parseEasing("ease-out")).toEqual({
    easing: Easing.CUBIC_BEZIER,
    a: 0,
    b: 0,
    c: 0.58,
    d: 1,
  });
  // Tailwind's own `--ease-in` is `cubic-bezier(0.4, 0, 1, 1)`, which is a *different*
  // curve wearing the same name. Both have to work, which is why the keyword table and
  // the function parser are separate paths.
  expect(parseEasing("cubic-bezier(0.4, 0, 1, 1)")).toEqual({
    easing: Easing.CUBIC_BEZIER,
    a: 0.4,
    b: 0,
    c: 1,
    d: 1,
  });
  // The two keywords CSS itself normalises, measured.
  expect(parseEasing("step-start")).toEqual({
    easing: Easing.STEPS,
    a: 1,
    b: StepPosition.JUMP_START,
    c: 0,
    d: 0,
  });
  expect(parseEasing("step-end")?.b).toBe(StepPosition.JUMP_END);
  expect(parseEasing("steps(4, jump-both)")).toEqual({
    easing: Easing.STEPS,
    a: 4,
    b: StepPosition.JUMP_BOTH,
    c: 0,
    d: 0,
  });
});

test("an easing dziry cannot express is refused rather than approximated", () => {
  // An `x` outside 0..1 makes the curve not a function of time, and CSS rejects it.
  expect(parseEasing("cubic-bezier(1.5, 0, 0.2, 1)")).toBe(null);
  // `y` outside it is legal, and is how an overshoot is written.
  expect(parseEasing("cubic-bezier(0.4, -0.5, 0.2, 1.8)")?.b).toBe(-0.5);
  // Zero steps has no output values; `jump-none` with one step has none either.
  expect(parseEasing("steps(0)")).toBe(null);
  expect(parseEasing("steps(1, jump-none)")).toBe(null);
  // An arbitrary-length stop list is a side table, not four control points, and
  // taking the first two stops would be a different curve with the same name.
  expect(parseEasing("linear(0, 0.25 75%, 1)")).toBe(null);
  expect(parseEasing("bouncy")).toBe(null);
});

test("the transition longhands are folded in cascade order, not shorthand-first", () => {
  // The shorthand *resets* all four longhands, so it cannot simply be read first.
  // Tailwind's output triggers this: `.duration-150` sets `transition-duration`, and a
  // `.transition` class may cascade either side of it.
  const shorthandLast = transitionFrom([
    ["transition-duration", "300ms"],
    ["transition", "opacity 1s linear"],
  ]);
  expect(shorthandLast?.duration).toBe(1);

  const longhandLast = transitionFrom([
    ["transition", "opacity 1s linear"],
    ["transition-duration", "300ms"],
  ]);
  expect(longhandLast?.duration).toBeCloseTo(0.3, 6);
  expect(longhandLast?.easing.easing).toBe(Easing.LINEAR);
});

test("the transition shorthand is order-free, and the first time is the duration", () => {
  // Measured: in `transition: opacity 1s 2s` the first time is the duration.
  const spec = transitionFrom([["transition", "opacity 1s 2s ease-in"]]);
  expect(spec?.duration).toBe(1);
  expect(spec?.delay).toBe(2);
  expect(spec?.properties).toEqual(["opacity"]);
  expect(spec?.easing.a).toBe(0.42);

  // Order-free, and a shorthand naming no property means `all` — that longhand's own
  // initial value rather than "nothing".
  expect(transitionFrom([["transition", "1s"]])?.properties).toEqual(["all"]);
  expect(transitionFrom([["transition", "ease-out 1s opacity"]])?.duration).toBe(1);

  // Nothing at all, which is the overwhelmingly common answer.
  expect(transitionFrom([])).toBe(null);
  expect(transitionFrom([["transition-property", "none"]])?.properties).toEqual([]);
});

test("transition-property becomes a mask, and refuses layout by name", () => {
  const bit = (field: keyof typeof ANIM_BIT) => 1 << ANIM_BIT[field];
  const quiet = () => {};

  expect(transitionMask(["opacity"], quiet)).toBe(bit("opacity"));
  expect(transitionMask(["background-color"], quiet)).toBe(bit("bg"));
  // `transform` is nine fields, which is the whole reason this map exists separately
  // from the expander: the expander is given a value, this is given only a name.
  expect(transitionMask(["transform"], quiet)).toBe(
    bit("translateX") |
      bit("translateY") |
      bit("translatePercentX") |
      bit("translatePercentY") |
      bit("rotate") |
      bit("scaleX") |
      bit("scaleY") |
      bit("skewX") |
      bit("skewY"),
  );
  expect(transitionMask(["all"], quiet)).toBe(ANIM_ALL);
  expect(transitionMask([], quiet)).toBe(0);

  // A layout-affecting property is named in a warning, because the author is about to
  // watch a box jump and needs to know why.
  const warned: string[] = [];
  expect(transitionMask(["width", "opacity"], (m) => warned.push(m))).toBe(bit("opacity"));
  expect(warned).toHaveLength(1);
  expect(warned[0]).toContain("width");
  expect(warned[0]).toContain("changes layout");

  // A property dziry does not have at all is dropped in silence — Tailwind's default
  // `.transition` names twenty-two of them and dziry has six, so warning would print
  // sixteen lines per build and bury the one that matters.
  const quietWarned: string[] = [];
  expect(transitionMask(["filter", "fill", "box-shadow"], (m) => quietWarned.push(m))).toBe(0);
  expect(quietWarned).toEqual([]);
});

test("the animation shorthand fills the longhands CSS says it does", () => {
  // Every row measured against Chromium in probes/animation-semantics.html.
  expect(animationFrom([["animation", "spin 1s linear infinite"]])).toMatchObject({
    name: "spin",
    duration: 1,
    delay: 0,
    iterations: Infinity,
    direction: "normal",
    fill: "none",
  });
  // Order-free, and the default easing is `ease` rather than `linear`.
  expect(animationFrom([["animation", "1s spin"]])).toMatchObject({
    name: "spin",
    duration: 1,
    iterations: 1,
  });
  expect(animationFrom([["animation", "bounce 1s infinite"]])?.easing.a).toBe(0.25);
  // Second time is the delay; a bare number is the iteration count.
  expect(animationFrom([["animation", "spin 1s 2s 3 reverse both"]])).toMatchObject({
    name: "spin",
    duration: 1,
    delay: 2,
    iterations: 3,
    direction: "reverse",
    fill: "both",
  });
  // A keyframes identifier is case-sensitive where a property name is not.
  expect(animationFrom([["animation", "FadeIn 1s"]])?.name).toBe("FadeIn");
  expect(animationFrom([["animation-name", "none"]])?.name).toBe("");
});

test("keyframe blocks are collected, with multi-offset selectors duplicated", () => {
  const sheet = parseCss(`
    @keyframes ping { 75%, 100% { transform: scale(2); opacity: 0 } }
    @keyframes drift { from { opacity: 0 } to { opacity: 1 } }
    .a { color: red }
  `);
  // Not rules: a keyframe's declarations apply to no element until something names the
  // animation, so the sheet still has exactly one rule.
  expect(sheet).toHaveLength(1);

  const ping = sheet.keyframes.get("ping")!;
  expect(ping).toHaveLength(1);
  // Measured: `75%, 100%` is two keyframes with one set of declarations, and a list
  // built that way reads halfway to *75%* a third of the way through.
  expect(ping[0]!.offsets).toEqual([0.75, 1]);
  expect(ping[0]!.decls.get("transform")).toBe("scale(2)");

  // `from` and `to` fold to 0 and 1, so nothing downstream learns the keywords.
  expect(sheet.keyframes.get("drift")!.map((b) => b.offsets)).toEqual([[0], [1]]);
});

test("an unreadable keyframe selector loses its block, not the sheet", () => {
  // CSS invalidates a whole block on a bad selector, and an out-of-range percentage is
  // one — clamping would silently move a keyframe written at 150% onto the end.
  const sheet = parseCss(`
    @keyframes bad { 150% { opacity: 0 } 50% { opacity: 1 } }
    .after { color: red }
  `);
  expect(sheet.keyframes.get("bad")!.map((b) => b.offsets)).toEqual([[0.5]]);
  // And the rule after the at-rule still parses, which a mis-skipped block breaks.
  expect(sheet).toHaveLength(1);
  expect(sheet[0]!.decls.get("color")).toBe("red");
});

test("a transition and an animation reach the style rows they describe", () => {
  const result = compile(
    `<body><div class="btn">a</div><div class="spin"></div></body>`,
    `@keyframes spin { to { transform: rotate(360deg) } }
     .btn { background: #111111; transition: background-color 150ms ease-in }
     .btn:hover { background: #222222 }
     .spin { background: #ff0000; animation: spin 1s linear infinite }`,
  );

  expect(result.warnings).toEqual([]);
  expect(result.tweens).toHaveLength(2);

  // The transition: a mask of exactly `bg`, and no keyframe span.
  const transition = result.tweens[0]!;
  expect(transition.mask).toBe(1 << ANIM_BIT["bg"]);
  expect(transition.duration).toBeCloseTo(0.15, 6);
  expect(transition.iterations).toBe(1);
  expect(transition.firstSegment).toBe(-1);

  // The animation: the same row shape, distinguished only by having segments.
  const animation = result.tweens[1]!;
  expect(animation.iterations).toBe(Infinity);
  expect(animation.segmentCount).toBe(2);
  expect(result.keyframes.map((k) => k.offset)).toEqual([0, 1]);

  // Both endpoints are ordinary interned style rows, and the implicit `from` is the
  // element's *own* row — measured, so no synthetic value is invented for it.
  const [from, to] = result.keyframes.map((k) => result.styles[k.style]!);
  expect(from!.bg).toBe(0xffff0000);
  expect(to!.bg).toBe(0xffff0000);
  expect(from!.rotate).toBe(0);
  expect(to!.rotate).toBe(360);

  // The reference is index **+ 1**, so zero can mean "none" in a zeroed table.
  const rows = result.nodes.map((n) => result.styles[n.style]!);
  expect(rows.some((s) => s.transition === 1)).toBe(true);
  expect(rows.some((s) => s.animation === 2)).toBe(true);
  expect(result.styles[0]!.transition).toBe(0);
});

test("a transition on a layout property is refused by name, once", () => {
  const result = compile(
    `<body><div class="a">x</div></body>`,
    `.a { width: 100px; transition: width 1s }
     .a:hover { width: 200px }`,
  );
  // One warning for one mistake, even though the declaration is resolved once per
  // predicate combination — a `:hover` node would otherwise report it twice.
  const refusals = result.warnings.filter((w) => w.includes("cannot transition"));
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toContain("width");
  // And no tween row: a mask of nothing is a per-frame cost that cannot move a pixel.
  expect(result.tweens).toHaveLength(0);
});

test("an animation naming no keyframes says so and emits nothing", () => {
  const result = compile(
    `<body><div class="a">x</div></body>`,
    `.a { animation: nope 1s linear infinite }`,
  );
  expect(result.warnings.some((w) => w.includes("nope"))).toBe(true);
  expect(result.tweens).toHaveLength(0);

  // A zero duration is CSS's initial value, so a name with no duration is the ordinary
  // case rather than an error — and must not warn on every build.
  const silent = compile(`<body><div class="a">x</div></body>`, `.a { animation-name: nope }`);
  expect(silent.warnings).toEqual([]);
});

test("calc() knows the numeric constants, which is what rounded-full needs", () => {
  // Tailwind v4 spells `rounded-full` as `calc(infinity * 1px)`. Without this the most
  // common rounding utility in the framework failed to parse, with an error naming
  // `calc()` rather than the class — found by rendering a page that used one.
  expect(expand("border-radius", "calc(infinity * 1px)")).toEqual({
    radTL: Infinity,
    radTR: Infinity,
    radBR: Infinity,
    radBL: Infinity,
  });
  // Unary minus handles the sign, so `-infinity` needs no entry of its own.
  expect(parseLength("calc(-1 * infinity * 1px)")).toBe(-Infinity);
  expect(parseLength("calc(pi * 1px)")).toBeCloseTo(Math.PI, 6);
  // An identifier that is neither a constant nor a unit still fails, and now fails
  // with the length parser's message rather than the tokeniser's.
  expect(() => parseLength("calc(wat * 1px)")).toThrow(CssError);
});
