/**
 * Stylesheet errors point at the stylesheet.
 *
 * Before this, a `CssError` escaped as a bare `Error` and Bun printed a stack
 * trace whose every frame is inside `css.ts` — the compiler's file and line,
 * never the author's. The parser had the position all along: `parseCss` tracks
 * `i` and simply never recorded it.
 */
import { expect, test } from "bun:test";

import { CssError, formatCssError, parseCss } from "./css.ts";

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
