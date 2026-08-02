/**
 * Loading one stylesheet the way a bundler would: resolve its imports, run
 * Tailwind if it asked for Tailwind, hand back flat CSS text.
 *
 * This is what replaced the `in.css` -> `index.css` CLI step. That step was a
 * convention with two problems. It named the file for you, so a window could have
 * exactly one stylesheet and no say in where it lived; and it wrote its output back
 * into the source tree, so the thing the compiler read was a *generated file that
 * was committed* — which meant a stale `index.css` and a fresh `in.css` looked
 * identical to everyone including git.
 *
 * Now a stylesheet reaches the compiler because a `.tsx` module imported it, and
 * this turns that file into the text the cascade parses. Nothing is written to
 * disk, so there is nothing to be stale.
 *
 * # Why Tailwind runs in-process
 *
 * `@tailwindcss/node` and `@tailwindcss/oxide` are dziri's own dependencies, and
 * `tailwindcss` is the *project's* — the same split `@tailwindcss/vite` uses, and
 * for the same reason. The engine that compiles the sheet belongs to the framework;
 * the theme and utilities the sheet imports belong to the app, so
 * `@import "tailwindcss"` has to resolve against the app's `node_modules` or a
 * project pinning a different minor gets the framework's. `compile()` resolves it
 * from `base`, which is the stylesheet's own directory, so it does.
 *
 * Verified equivalent to the CLI before the CLI was removed: the programmatic path
 * reproduces `@tailwindcss/cli`'s output for `windows/main` byte for byte.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { CssError, formatCssError } from "./css.ts";

/** One stylesheet's flattened text, and where it came from. */
export type CssSource = {
  /** Absolute path. Used for error attribution and nothing else. */
  path: string;
  /** Flat CSS — every `@import` already inlined, every utility already generated. */
  text: string;
};

/**
 * A stylesheet dziri could not load, phrased for whoever wrote the import.
 *
 * Separate from `CssError`, which is a *parse* failure with an offset into a
 * sheet. By the time this throws there may be no sheet to point at.
 */
export class StylesheetError extends Error {}

/**
 * At-rules that mean "this sheet is Tailwind's problem, not ours".
 *
 * Detection rather than configuration, because the alternative is asking every
 * project to declare something its stylesheet already says out loud. A sheet with
 * none of these is plain CSS and never loads Tailwind at all — which is the point:
 * a plain-CSS app should not pay for a dependency it does not use.
 *
 * `@import "tailwindcss"` is handled separately below, since the keyword alone
 * does not distinguish it from an ordinary relative import.
 */
const TAILWIND_AT_RULES =
  /@(?:tailwind|apply|theme|source|plugin|utility|variant|custom-variant|reference)\b/;

/** `@import "tailwindcss"`, `@import "tailwindcss/utilities.css"`, url() form included. */
const TAILWIND_IMPORT = /@import\s+(?:url\(\s*)?["']tailwindcss(?:\/[^"']*)?["']/;

export function usesTailwind(text: string): boolean {
  return TAILWIND_AT_RULES.test(text) || TAILWIND_IMPORT.test(text);
}

/** `@import "…";` / `@import url("…") …;` — prelude captured so media queries survive the check. */
const IMPORT_RULE = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*([^;]*);/g;

/**
 * Inlines `@import` for a plain-CSS sheet.
 *
 * dziri's own parser skips statement at-rules — it has to, since Tailwind v4 opens
 * with `@layer properties;` and mis-scanning that swallowed the entire theme block
 * behind it (see `css.ts`). Skipping is right for `@layer`; for `@import` it is a
 * silent hole, because the sheet parses fine and simply has none of the rules the
 * author expected. So imports are resolved here, before the parser ever sees them.
 *
 * A conditional import — `@import "print.css" print;` — is dropped rather than
 * inlined, matching how `@media print` is already treated: a condition this engine
 * cannot evaluate degrades to "the unconditional styles only".
 */
async function inlineImports(
  path: string,
  text: string,
  seen: Set<string>,
  projectDir: string,
): Promise<string> {
  IMPORT_RULE.lastIndex = 0;

  const edits: { from: number; to: number; with: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = IMPORT_RULE.exec(text)) !== null) {
    const specifier = match[1]!;
    const condition = match[2]!.trim();
    const from = match.index;
    const to = from + match[0].length;

    if (condition !== "" && condition !== "all") {
      edits.push({ from, to, with: "" });
      continue;
    }

    const target = await resolveCss(specifier, path, projectDir);

    // A cycle, or a sheet already pulled in by an earlier import. Both resolve to
    // "emit nothing": CSS `@import` is idempotent, so the first copy is the one
    // whose position in the cascade counts.
    if (seen.has(target)) {
      edits.push({ from, to, with: "" });
      continue;
    }
    seen.add(target);

    const nested = await readCss(target);
    edits.push({ from, to, with: await inlineImports(target, nested, seen, projectDir) });
  }

  if (edits.length === 0) return text;

  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.from) + edit.with;
    cursor = edit.to;
  }
  return out + text.slice(cursor);
}

/** Resolves an `@import` specifier the way an import in a module would resolve. */
async function resolveCss(
  specifier: string,
  importer: string,
  projectDir: string,
): Promise<string> {
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    return resolve(dirname(importer), specifier);
  }

  // A bare specifier — `@import "@acme/theme/base.css"`. Resolved against the
  // *project*, not against dziri, for the same reason Tailwind is.
  try {
    return Bun.resolveSync(specifier, projectDir);
  } catch {
    throw new StylesheetError(
      `${rel(importer, projectDir)}: cannot resolve @import "${specifier}".\n` +
        `  Bare specifiers resolve against the project's node_modules. If this is a\n` +
        `  relative file, write it as "./${specifier}".`,
    );
  }
}

async function readCss(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new StylesheetError(`stylesheet not found: ${path}`);
  }
  return file.text();
}

function rel(path: string, projectDir: string): string {
  const r = path.startsWith(projectDir) ? path.slice(projectDir.length + 1) : path;
  return r.replaceAll("\\", "/");
}

/**
 * Runs the project's Tailwind over a sheet.
 *
 * The two halves of the split, concretely: `compile()` and `Scanner` come from
 * dziri's dependencies, and everything the sheet *imports* comes from the project,
 * because `base` is the sheet's own directory.
 *
 * `sources` is what the sheet's `@source` rules resolved to; handing them straight
 * to the scanner is what makes `source(none)` mean what it says. Without it
 * Tailwind scans the whole project, finds class-shaped strings in unrelated
 * TypeScript, and emits utilities no page uses — which inflates the sheet and makes
 * any coverage number from it meaningless.
 */
async function runTailwind(path: string, text: string, projectDir: string): Promise<string> {
  let compile: typeof import("@tailwindcss/node").compile;
  let Scanner: typeof import("@tailwindcss/oxide").Scanner;

  try {
    ({ compile } = await import("@tailwindcss/node"));
    ({ Scanner } = await import("@tailwindcss/oxide"));
  } catch (cause) {
    throw new StylesheetError(
      `${rel(path, projectDir)} uses Tailwind, but dziri's Tailwind support is not installed.\n` +
        `  This should not happen in a normal install — @tailwindcss/node and\n` +
        `  @tailwindcss/oxide are dziri's own dependencies. Try reinstalling.\n` +
        `  Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const compiler = await compile(text, {
    base: dirname(path),
    from: path,
    // Watch mode is not built yet. The callback is required, and collecting the
    // paths now is what that will read when it is.
    onDependency: () => {},
  }).catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/cannot resolve|could not resolve|not found/i.test(message)) {
      throw new StylesheetError(
        `${rel(path, projectDir)}: Tailwind could not resolve one of its imports.\n` +
          `  \`tailwindcss\` is the project's dependency, not dziri's, so that\n` +
          `  \`@import "tailwindcss"\` resolves against your node_modules.\n` +
          `    bun add -d tailwindcss\n\n` +
          `  Tailwind said: ${message}`,
      );
    }
    throw new StylesheetError(`${rel(path, projectDir)}: Tailwind failed.\n\n  ${message}`);
  });

  const scanner = new Scanner({ sources: compiler.sources });
  return compiler.build(scanner.scan());
}

/**
 * Loads one stylesheet: read it, resolve what it pulls in, return flat CSS.
 *
 * Tailwind's own `compile()` already resolves `@import`, so the two paths are
 * exclusive rather than layered — running our resolver first would inline
 * `tailwindcss/index.css` as text and hand Tailwind a sheet whose `@import` it can
 * no longer see.
 */
export async function loadStylesheet(path: string, projectDir: string): Promise<CssSource> {
  const raw = await readCss(path);

  const text = usesTailwind(raw)
    ? await runTailwind(path, raw, projectDir)
    : await inlineImports(path, raw, new Set([path]), projectDir);

  return { path, text };
}

/**
 * Every sheet a window uses, concatenated, plus the map back to which file a byte
 * came from.
 *
 * Concatenation *is* the cascade order. `parseCss` numbers rules by position in the
 * string it is given, and the CSS cascade breaks ties by source order, so splicing
 * the sources together in the order the author's imports evaluated gets author
 * order for free — no ordering pass, no per-rule provenance to thread through the
 * compiler.
 *
 * The map exists because that trick costs error messages: a `CssError` carries an
 * offset into the concatenated text, and reporting it against a 21 KB sheet the
 * author never wrote is not a diagnostic. {@link SheetMap.locate} turns the offset
 * back into a file and a local offset, which is what `formatCssError` needs.
 */
export class SheetMap {
  private readonly spans: { path: string; start: number; end: number }[] = [];
  readonly text: string;

  constructor(sources: readonly CssSource[]) {
    let text = "";
    for (const source of sources) {
      const start = text.length;
      // A newline between sheets, so a file that does not end in one cannot join
      // its last selector to the next file's first.
      text += source.text.endsWith("\n") ? source.text : source.text + "\n";
      this.spans.push({ path: source.path, start, end: text.length });
    }
    this.text = text;
  }

  /** Which file an offset into {@link text} fell in, and where in that file. */
  locate(offset: number): { path: string; offset: number } | null {
    for (const span of this.spans) {
      if (offset >= span.start && offset < span.end) {
        return { path: span.path, offset: offset - span.start };
      }
    }
    return null;
  }

  /** The files that went in, in cascade order. For `dziri compile`'s report. */
  get paths(): string[] {
    return this.spans.map((s) => s.path);
  }

  /**
   * Renders a parse failure against the file it actually came from.
   *
   * The offset the parser recorded is into the concatenation, so reporting it
   * as-is would point at a line number in a file nobody wrote — and for a Tailwind
   * sheet, at generated output rather than at the source. Rebasing first is what
   * makes the caret land in the author's own stylesheet.
   */
  formatError(err: CssError, label: (path: string) => string): string {
    const at = this.locate(err.offset);
    if (at === null) return `  error: ${err.message}`;

    const span = this.spans.find((s) => s.path === at.path);
    if (span === undefined) return `  error: ${err.message}`;

    return formatCssError(
      new CssError(err.message, at.offset),
      this.text.slice(span.start, span.end),
      label(at.path),
    );
  }
}
