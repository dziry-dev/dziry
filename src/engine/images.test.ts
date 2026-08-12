/**
 * `<img>`, the whole way down: compiled, uploaded, decoded, laid out.
 *
 * `src/compiler/images.test.ts` covers what the compiler claims and
 * `images.rs` covers the decode; this covers the seam between them, which is
 * where the feature actually lives — a row in shared memory becoming a box with
 * the bitmap's shape. The failure it guards against is the quiet kind: every
 * layer passes its own tests while the row never reaches the engine, and the
 * symptom is an empty box that looks like an image that failed to load.
 */
import { expect, test } from "bun:test";
import { compileSnippet } from "../compiler/single.ts";
import { toCompiledUi } from "../compiler/compile.ts";
import { Engine } from "./host.ts";
import { Uploader, capacitiesFor } from "./upload.ts";

/** The same 2x1 red-green PNG `images.rs` tests against. */
const PNG_2X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
  0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x7b,
  0x40, 0xe8, 0xdd, 0x00, 0x00, 0x00, 0x0f, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
  0xcf, 0xc0, 0xc0, 0xf0, 0x9f, 0x01, 0x00, 0x07, 0xff, 0x01, 0xff, 0x01, 0x7f, 0x89, 0xa7,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function open(html: string, css = "") {
  const ui = toCompiledUi(compileSnippet({ html: `<body>${html}</body>`, css }).result);
  const engine = Engine.open({
    ...capacitiesFor(ui),
    width: 300,
    height: 200,
    root: ui.root,
    windowed: false,
  });
  new Uploader(engine, ui).uploadAll();
  return { ui, engine };
}

test("an img is zero-sized while pending and natural-sized once decoded", () => {
  const { engine } = open(`<img src="a.png">`);
  try {
    engine.tick();
    // Node 1: the img. Pending, no CSS size — nothing to show yet.
    expect(engine.bounds(1)).toEqual([0, 0, 0, 0]);

    engine.provideImage("a.png", PNG_2X1);
    engine.tick();
    expect(engine.bounds(1)).toEqual([0, 0, 2, 1]);
  } finally {
    engine.close();
  }
});

test("one known CSS dimension derives the other from the bitmap's ratio", () => {
  const { engine } = open(`<img src="a.png">`, "img { width: 100px }");
  try {
    engine.provideImage("a.png", PNG_2X1);
    engine.tick();
    // 2:1 at 100px wide is 50px high — the aspect rule, not a default height.
    expect(engine.bounds(1)).toEqual([0, 0, 100, 50]);
  } finally {
    engine.close();
  }
});

test("a decode failure keeps the CSS box and breaks nothing else", () => {
  const { engine } = open(`<img src="bad.png" width="40" height="20">`);
  try {
    engine.provideImage("bad.png", new TextEncoder().encode("not a png"));
    engine.tick();
    // The presentational hints were the box all along; the image is just absent.
    expect(engine.bounds(1)).toEqual([0, 0, 40, 20]);
  } finally {
    engine.close();
  }
});

test("the painted pixels are the bitmap's", () => {
  const { engine } = open(`<img src="a.png">`, "img { width: 8px; height: 4px }");
  try {
    engine.provideImage("a.png", PNG_2X1);
    engine.tick();
    // Read back the middle of each half: the left is the red pixel, scaled;
    // the right is the green one. The clear colour is black, so either channel
    // reading zero is the image never having painted.
    const [, , rowBytes] = engine.surfaceInfo();
    const px = engine.readPixels();
    // BGRA_8888: blue, green, red, alpha.
    const at = (x: number, y: number) => {
      const i = y * rowBytes + x * 4;
      return [px[i]!, px[i + 1]!, px[i + 2]!];
    };
    const left = at(2, 2);
    const right = at(6, 2);
    // Left is red: red channel high, green low. Right is green: the reverse.
    expect(left[2]! > 128).toBe(true);
    expect(left[1]! < 128).toBe(true);
    expect(right[1]! > 128).toBe(true);
    expect(right[2]! < 128).toBe(true);
  } finally {
    engine.close();
  }
});
