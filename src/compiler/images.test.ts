/**
 * `<img>` in the compiler: the reference is emitted, the presentational hints
 * cascade, and a sourceless image earns no row.
 *
 * The render half of the same contract is in `src/engine/images.test.ts`, which
 * runs this output through the engine; the decode itself is covered in
 * `images.rs`. What only this file can assert is what the *compiler* claims —
 * which is the part that can silently rot, since an img with no row compiles
 * cleanly and paints an empty box.
 */
import { expect, test } from "bun:test";
import { compileSnippet } from "./single.ts";
import { toCompiledUi } from "./compile.ts";

function build(html: string, css = "") {
  return toCompiledUi(compileSnippet({ html: `<body>${html}</body>`, css }).result);
}

test("an img with src emits an images row naming its node", () => {
  const ui = build(`<img src="photo.png">`);
  expect(ui.images.count).toBe(1);
  expect(ui.images.node[0]).toBe(1);
  expect(ui.strings[ui.images.src[0]!]).toBe("photo.png");
});

test("an img without src earns no row — there is nothing to fetch", () => {
  const ui = build(`<img alt="nothing here">`);
  expect(ui.images.count).toBe(0);
});

test("width and height attributes size the box, as pixels", () => {
  const ui = build(`<img src="a.png" width="40" height="20">`);
  const slot = ui.nodes.style[1]!;
  expect(ui.styles.width[slot]).toBe(40);
  expect(ui.styles.height[slot]).toBe(20);
});

test("a CSS rule beats the attribute, and inline style beats both", () => {
  const ui = build(`<img src="a.png" width="40">`, "img { width: 10px }");
  const slot = ui.nodes.style[1]!;
  expect(ui.styles.width[slot]).toBe(10);

  const inline = build(`<img src="a.png" width="40" style="width: 12px">`, "img { width: 10px }");
  expect(inline.styles.width[inline.nodes.style[1]!]).toBe(12);
});

test("a percentage width attribute is ignored rather than misread as pixels", () => {
  const ui = build(`<img src="a.png" width="50%">`);
  const slot = ui.nodes.style[1]!;
  // Unset width is NaN — auto — not a confident 50.
  expect(Number.isNaN(ui.styles.width[slot]!)).toBe(true);
});

test("a non-numeric width attribute is ignored the same way", () => {
  const ui = build(`<img src="a.png" width="wide">`);
  expect(Number.isNaN(ui.styles.width[ui.nodes.style[1]!]!)).toBe(true);
});

test("an inline svg compiles to a data: URL image row, and its children are not nodes", () => {
  const ui = build(`<svg viewBox="0 0 24 24"><path d="M0 0 L24 24"/></svg>`);
  expect(ui.images.count).toBe(1);
  const src = ui.strings[ui.images.src[0]!]!;
  expect(src.startsWith("data:image/svg+xml,")).toBe(true);
  expect(decodeURIComponent(src.slice("data:image/svg+xml,".length))).toContain(`d="M0 0 L24 24"`);
  // body + the svg node, and nothing else: no per-child boxes.
  expect(ui.nodes.count).toBe(2);
});
