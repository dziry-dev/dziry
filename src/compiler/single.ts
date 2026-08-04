/**
 * One document and its stylesheet, compiled in this process.
 *
 * `src/compile.ts` is the argv in front of this, the way `compile-window.ts` is the
 * argv in front of `build.ts`'s `compileProject`. Before it existed, nothing could
 * *import* the single-entry compiler — it was a top-level script — so six harnesses
 * reached the compiler by writing two temp files, spawning `bun run src/compile.ts`,
 * parsing its stderr, importing the emitted module through a cache-busted specifier,
 * and reassembling a `CompiledUi` by hand from its exports.
 *
 * Every one of those five steps existed only because the seam was a process boundary.
 * `compileSnippet` plus the `toCompiledUi` that was already there replaces all of it
 * with two calls and no filesystem at all.
 *
 * Parsing stderr is the part that was actively wrong rather than merely indirect, and
 * `html-coverage` carries the scar in a comment: Bun prints a source excerpt before a
 * thrown message, so `stderr.split("\n")[0]` is the *compiler's own source line* and
 * says nothing about the input. Two harnesses had independently worked out that the
 * message is the line starting `error:`. An exception needs none of that.
 *
 * Deliberately the HTML front-end only. The JSX one has to `import()` the input to
 * evaluate its components, which means an absolute file URL, `installCssGraph()`
 * before the import, `setCompiling()` around it, and `findToggles`/`compileVariants`/
 * `resolveRefs` after — a driver, not a function, and one every current caller of this
 * would have to supply paths to anyway. An HTML document cannot express a conditional
 * class in the first place: `parseHtml` sets `classWhen: null` at all three of its
 * construction sites, so `findToggles` returns nothing for this front-end by
 * construction rather than by omission.
 */
import { compileTree, type CompileResult } from "./compile.ts";
import { parseHtml, type Element } from "./html.ts";
import { SheetMap, type CssSource } from "./stylesheet.ts";
import { extractStyleElements } from "./style-element.ts";

export type SnippetInput = {
  /** The document. */
  html: string;
  /**
   * A stylesheet, as text. Sugar for a single-entry `sheets`, which is what almost
   * every caller wants: a snippet's CSS is a string it just built, not a file.
   */
  css?: string;
  /**
   * Stylesheets already loaded, most general first — for a caller that went through
   * `loadStylesheet` and so may be handing over Tailwind output or a resolved
   * `@import` chain. Taking them loaded rather than doing it here is what keeps this
   * synchronous and keeps Tailwind out of the harnesses' way.
   */
  sheets?: readonly CssSource[];
  /** What to call the document in a diagnostic. */
  label?: string;
};

export type SnippetResult = {
  doc: Element;
  /** Every sheet that went into the cascade, for `formatError` and for a header. */
  sheet: SheetMap;
  result: CompileResult;
};

/**
 * Wraps the cascade so a caller can render a `CssError` against the sheet it is
 * thrown against — which only exists once the sheets have been assembled, and so
 * cannot be in the caller's hands beforehand.
 *
 * The default runs it directly, which is what a harness wants: an exception with a
 * stack, rather than a message it has to reconstruct from a subprocess's output.
 */
export type Reporter = <T>(sheet: SheetMap, run: () => T) => T;

/**
 * `<style>` is how a document carries its own CSS, and it goes last.
 *
 * The rules written inside the document beat the stylesheet handed alongside it, the
 * same way a browser resolves two sources by order. It exists for this front-end and
 * not for JSX, which has `import`: a document has no import statement, so without it
 * a single self-contained file could not be styled — and self-contained is the whole
 * reason this front-end is here, since every probe and characterization case is one
 * file.
 */
export function compileSnippet(
  input: SnippetInput,
  report: Reporter = (_sheet, run) => run(),
): SnippetResult {
  const label = input.label ?? "<snippet>";
  const doc = parseHtml(input.html);

  const named: readonly CssSource[] =
    input.sheets ?? (input.css === undefined ? [] : [{ path: `${label} css`, text: input.css }]);

  const blocks = extractStyleElements(doc).map((block) => ({
    path: `${label} ${block.label}`,
    text: block.text,
  }));

  const sheet = new SheetMap([...named, ...blocks]);
  const result = report(sheet, () => compileTree(doc, sheet.text));

  return { doc, sheet, result };
}
