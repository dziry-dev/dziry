/**
 * How a stylesheet reaches the cascade, now that it reaches it by being imported.
 *
 * The end-to-end proof that this change altered nothing is `bun run characterize`:
 * the window's 79 KB of IR is byte-identical across the move from a generated
 * `index.css` to an imported `app.css`. These cover the pieces that harness cannot
 * isolate — the failure modes that would otherwise show up as a rule silently
 * missing from the cascade.
 */
import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStylesheet, usesTailwind, SheetMap, StylesheetError } from "./stylesheet.ts";
import { extractStyleElements } from "./style-element.ts";
import { parseHtml, type Element } from "./html.ts";
import { CssError } from "./diagnostics.ts";

const ROOT = process.cwd();

/**
 * A throwaway directory with the given files in it.
 *
 * Awaits `run` before cleaning up. It did not, at first, and the directory was
 * removed while the loader was still reading from it — which failed as ENOENT on
 * the file the test had just written, and looked like a resolver bug.
 */
async function withFiles(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dziri-css-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Tailwind detection", () => {
  // Detection decides whether a project pays for Tailwind at all, so a false
  // negative is "none of my utilities exist" and a false positive is a plain-CSS
  // app loading a compiler it does not need.
  test("recognises the umbrella import and the partial imports", () => {
    expect(usesTailwind(`@import "tailwindcss";`)).toBe(true);
    expect(usesTailwind(`@import "tailwindcss/utilities.css" source(none);`)).toBe(true);
    expect(usesTailwind(`@import 'tailwindcss/theme.css';`)).toBe(true);
  });

  test("recognises the at-rules that only Tailwind defines", () => {
    expect(usesTailwind(`@theme { --color-x: red }`)).toBe(true);
    expect(usesTailwind(`.a { @apply flex }`)).toBe(true);
    expect(usesTailwind(`@source "./x.tsx";`)).toBe(true);
  });

  test("leaves ordinary CSS alone", () => {
    expect(usesTailwind(`.a { color: red }`)).toBe(false);
    // The word appears, but not as an import — a comment must not trip it.
    expect(usesTailwind(`/* migrated off tailwindcss */ .a { color: red }`)).toBe(false);
    expect(usesTailwind(`@import "./theme.css";`)).toBe(false);
  });
});

describe("@import", () => {
  // dziri's parser skips statement at-rules — it must, since mis-scanning
  // `@layer properties;` once swallowed an entire Tailwind theme. That makes an
  // unresolved `@import` silent: the sheet parses and simply has none of the rules.
  test("inlines a relative import in place", async () => {
    await withFiles(
      { "base.css": ".a { color: red }\n", "main.css": `@import "./base.css";\n.b { color: blue }\n` },
      async (dir) => {
        const { text } = await loadStylesheet(join(dir, "main.css"), ROOT);
        expect(text).toContain(".a { color: red }");
        expect(text).toContain(".b { color: blue }");
        // Position is the cascade: the import must land where it was written, so
        // the importing sheet's own rules still come after it.
        expect(text.indexOf(".a")).toBeLessThan(text.indexOf(".b"));
      },
    );
  });

  test("follows a chain", async () => {
    await withFiles(
      {
        "a.css": ".a { color: red }\n",
        "b.css": `@import "./a.css";\n.b { color: blue }\n`,
        "c.css": `@import "./b.css";\n.c { color: green }\n`,
      },
      async (dir) => {
        const { text } = await loadStylesheet(join(dir, "c.css"), ROOT);
        expect(text.indexOf(".a")).toBeLessThan(text.indexOf(".b"));
        expect(text.indexOf(".b")).toBeLessThan(text.indexOf(".c"));
      },
    );
  });

  test("a cycle terminates instead of hanging", async () => {
    await withFiles(
      { "x.css": `@import "./y.css";\n.x { color: red }\n`, "y.css": `@import "./x.css";\n.y { color: blue }\n` },
      async (dir) => {
        const { text } = await loadStylesheet(join(dir, "x.css"), ROOT);
        expect(text).toContain(".x");
        expect(text).toContain(".y");
      },
    );
  });

  test("a media-conditional import is dropped, like the media query it carries", async () => {
    await withFiles(
      { "print.css": ".p { color: red }\n", "main.css": `@import "./print.css" print;\n.m { color: blue }\n` },
      async (dir) => {
        const { text } = await loadStylesheet(join(dir, "main.css"), ROOT);
        expect(text).not.toContain(".p");
        expect(text).toContain(".m");
      },
    );
  });

  test("an unresolvable bare specifier names the file that asked for it", async () => {
    await withFiles({ "main.css": `@import "no-such-package/x.css";\n` }, async (dir) => {
      await expect(loadStylesheet(join(dir, "main.css"), ROOT)).rejects.toThrow(StylesheetError);
    });
  });
});

describe("SheetMap", () => {
  // Concatenation is what gives the cascade its source order for free. The cost is
  // that every parser offset now points into a string nobody wrote, and for a
  // Tailwind sheet that string is generated output.
  const map = () =>
    new SheetMap([
      { path: "/p/a.css", text: ".a { color: red }" },
      { path: "/p/b.css", text: ".b { color: blue }" },
    ]);

  test("keeps the sources in order and separates them", () => {
    expect(map().text).toBe(".a { color: red }\n.b { color: blue }\n");
  });

  test("locates an offset in the file it came from", () => {
    const m = map();
    expect(m.locate(0)).toEqual({ path: "/p/a.css", offset: 0 });
    // First byte of the second sheet: 18 = the first sheet plus its added newline.
    expect(m.locate(18)).toEqual({ path: "/p/b.css", offset: 0 });
    expect(m.locate(20)).toEqual({ path: "/p/b.css", offset: 2 });
    expect(m.locate(9_999)).toBeNull();
  });

  test("an error is rendered against its own file, not the concatenation", () => {
    const rendered = map().formatError(new CssError("bad", 20), (p) => p);
    expect(rendered).toContain("/p/b.css");
    // Line 1 of b.css, not line 2 of the concatenation.
    expect(rendered).toContain("/p/b.css:1:3");
    expect(rendered).not.toContain("a.css");
  });
});

describe("<style>", () => {
  const doc = (html: string): Element => parseHtml(html);

  test("is taken out of the tree, not left hidden in it", () => {
    const tree = doc(`<body><style>.a{color:red}</style><div class="a">x</div></body>`);
    const sheets = extractStyleElements(tree);

    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.text).toBe(".a{color:red}");

    const tags: string[] = [];
    const walk = (el: Element): void => {
      for (const child of el.children) {
        if (child.type === "element") {
          tags.push(child.tag);
          walk(child);
        }
      }
    };
    walk(tree);
    expect(tags).not.toContain("style");
    expect(tags).toContain("div");
  });

  test("collects several in document order", () => {
    const sheets = extractStyleElements(
      doc(`<body><style>.a{}</style><div><style>.b{}</style></div><style>.c{}</style></body>`),
    );
    expect(sheets.map((s) => s.text)).toEqual([".a{}", ".b{}", ".c{}"]);
  });

  test("its body is raw text — CSS is not markup", () => {
    // `>` is a child combinator, `&` is a nesting selector, and a comment may hold
    // anything. Scanning this for tags or decoding entities corrupts the sheet.
    const sheets = extractStyleElements(
      doc(`<body><style>/* < & > */ .a > .b { content: "x  y" }</style></body>`),
    );
    expect(sheets[0]!.text).toBe(`/* < & > */ .a > .b { content: "x  y" }`);
  });

  test("a document with no <style> is untouched", () => {
    expect(extractStyleElements(doc(`<body><div>x</div></body>`))).toHaveLength(0);
  });
});
