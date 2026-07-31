/**
 * Stylesheet errors point at the stylesheet.
 *
 * Before this, a `CssError` escaped as a bare `Error` and Bun printed a stack
 * trace whose every frame is inside `css.ts` — the compiler's file and line,
 * never the author's. The parser had the position all along: `parseCss` tracks
 * `i` and simply never recorded it.
 */
import { expect, test } from "bun:test";

import {
  CssError,
  expandDeclaration,
  formatCssError,
  parseColor,
  parseCss,
  parseLength,
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
  const out = diagnose(".ok { color: red }\n\ninput[type=text] { color: red }\n");
  expect(out).toContain("sheet.css:3:1");
  expect(out).toContain("unsupported selector syntax");
  // The offending source line, and a caret under it.
  expect(out).toContain("input[type=text] { color: red }");
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

test("overflow maps CSS's five keywords onto the three the engine has", () => {
  expect(expand("overflow", "visible")).toEqual({ overflowX: 0, overflowY: 0 });
  // `clip` and `hidden` differ only in programmatic scrollability, which does not
  // exist yet.
  expect(expand("overflow", "hidden")).toEqual({ overflowX: 1, overflowY: 1 });
  expect(expand("overflow", "clip")).toEqual({ overflowX: 1, overflowY: 1 });
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
