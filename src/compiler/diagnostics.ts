/**
 * How the CSS front-end reports a problem: one that stops the build, and one that
 * does not.
 *
 * Its own module because everything else in the compiler needs it and it needs nothing
 * — which is exactly what was blocking the rest of `css.ts` from being split. The
 * selector front-end reaches down for `parseLength` and `warnOnce`, while seventy-odd
 * uses of `CssError` and the `RegisteredProperty` type reach back up at it. Those two
 * facts made a cycle, and the cycle was entirely these three declarations sitting on
 * the wrong side of it.
 */

/**
 * A stylesheet error, carrying where it happened.
 *
 * Without the offset the author got a raw Bun stack trace pointing into this
 * file — which names the compiler's internals and not one character of their
 * stylesheet. `offset` is an index into the *source* text, which is only
 * meaningful because [`stripComments`] preserves length.
 */
export class CssError extends Error {
  /** Index into the source stylesheet, or `-1` when the site is unknown. */
  readonly offset: number;

  constructor(message: string, offset = -1) {
    super(message);
    this.name = "CssError";
    this.offset = offset;
  }
}

/**
 * Renders a `CssError` against its source: `file:line:col`, the offending line,
 * and a caret. Falls back to the bare message when there is no offset.
 */
export function formatCssError(err: CssError, src: string, file: string): string {
  if (err.offset < 0 || err.offset > src.length) return `${file}: ${err.message}`;

  const before = src.slice(0, err.offset);
  const line = before.split("\n").length;
  const column = err.offset - (before.lastIndexOf("\n") + 1);
  const text = src.split("\n")[line - 1] ?? "";
  const gutter = String(line);

  return (
    `${file}:${line}:${column + 1}  ${err.message}\n` +
    `  ${gutter} | ${text}\n` +
    `  ${" ".repeat(gutter.length)} | ${" ".repeat(column)}^`
  );
}

/**
 * A warning printed once per process, however many nodes hit it.
 *
 * An unsupported property is one *fact* about the stylesheet, but this runs per
 * declaration per node, so Tailwind's `text-*` utilities — which set `line-height`
 * beside every font size — produced 110 identical lines. That is worse than
 * printing nothing: it buries the distinct warnings and pushes the summary the
 * author is waiting for off the top of the terminal.
 *
 * Process-wide rather than per-parse, because the same window is parsed several
 * times over (baseline, then once per conditional-class variant) and the second
 * pass has nothing new to say.
 */
const warned = new Set<string>();

export function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`  warn: ${message}`);
}
