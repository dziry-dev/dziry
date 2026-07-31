/**
 * A small CSS parser covering the subset the prototype supports.
 *
 * Hand-written rather than pulled from a library because the interesting part —
 * specificity, cascade, inheritance, computed values — has to be written either
 * way, and the tokenizer for this subset is short. Swappable for css-tree if the
 * subset grows; it is a compile-time dependency either way and never ships to
 * the runtime.
 *
 * Supported selectors: type, `.class`, `#id`, descendant combinator, and the
 * `:hover` / `:active` pseudo-classes (which become precompiled variants).
 */
import {
  Align,
  AUTO,
  Direction,
  Display,
  FlexWrap,
  Justify,
  Overflow,
  Position,
  UNSET,
  type StyleField,
} from "../ir.ts";

export type Pseudo = "none" | "hover" | "active" | "focus";

/** Pseudo-classes compiled into precomputed style variants. */
const SUPPORTED_PSEUDO = new Set<string>(["hover", "active", "focus"]);

export type Compound = { tag: string | null; id: string | null; classes: string[] };

export type Selector = {
  /** Left-to-right; the last entry is the subject of the selector. */
  compounds: Compound[];
  pseudo: Pseudo;
  /** [ids, classes+pseudos, types] */
  specificity: [number, number, number];
};

export type Rule = {
  selectors: Selector[];
  decls: Map<string, string>;
  /** Source order, for breaking specificity ties. */
  order: number;
};

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

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

/**
 * Blanks comments **in place** rather than removing them.
 *
 * Every offset the parser records is reported to the author, so the stripped
 * text and the source have to agree on where things are. Deleting the bytes
 * would shift every later position by the length of the comments before it —
 * and a stylesheet with a comment at the top would point at the wrong line for
 * the whole file, which is worse than no position at all. Newlines survive so
 * line numbers do too.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

export function parseCss(src: string): Rule[] {
  const text = stripComments(src);
  const rules: Rule[] = [];
  let i = 0;
  let order = 0;

  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;

    const raw = text.slice(i, open);
    const prelude = raw.trim();
    const preludeAt = i + raw.length - raw.trimStart().length;
    const close = text.indexOf("}", open);
    if (close === -1) {
      throw new CssError(`unclosed rule for selector "${prelude}"`, open);
    }

    const body = text.slice(open + 1, close);
    i = close + 1;

    if (prelude.startsWith("@")) {
      // At-rules (media queries, font-face) are an explicit non-goal.
      console.warn(`  warn: ignoring at-rule "${prelude.split(/\s+/)[0]}"`);
      continue;
    }
    if (prelude === "") continue;

    // Selectors are split on commas rather than parsed as a list, so the offset
    // of each one is the running length of everything before it.
    const selectors: Selector[] = [];
    let at = preludeAt;
    for (const part of prelude.split(",")) {
      const lead = part.length - part.trimStart().length;
      selectors.push(parseSelector(part.trim(), at + lead));
      at += part.length + 1; // the comma
    }

    rules.push({ selectors, decls: parseDeclarations(body, open + 1), order: order++ });
  }

  return rules;
}

function parseDeclarations(body: string, at: number): Map<string, string> {
  const decls = new Map<string, string>();
  let cursor = at;
  for (const part of body.split(";")) {
    const chunk = part.trim();
    const start = cursor + (part.length - part.trimStart().length);
    cursor += part.length + 1; // the semicolon
    if (!chunk) continue;
    const colon = chunk.indexOf(":");
    if (colon === -1) {
      throw new CssError(`declaration without a colon: "${chunk}"`, start);
    }
    // Later duplicates win, matching CSS.
    decls.set(chunk.slice(0, colon).trim().toLowerCase(), chunk.slice(colon + 1).trim());
  }
  return decls;
}

export function parseSelector(src: string, at = -1): Selector {
  if (!src) throw new CssError("empty selector", at);
  if (/[>+~]/.test(src)) {
    throw new CssError(`only the descendant combinator is supported, got "${src}"`, at);
  }

  const compounds: Compound[] = [];
  let pseudo: Pseudo = "none";
  const spec: [number, number, number] = [0, 0, 0];

  const parts = src.split(/\s+/).filter(Boolean);
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]!;
    // Where this compound starts in the source, so the caret lands on the
    // offending compound rather than on the whole selector.
    const partAt = at < 0 ? -1 : at + src.indexOf(part);
    const compound: Compound = { tag: null, id: null, classes: [] };

    // Split on the punctuation while keeping it: "div.a#b:hover" -> tokens.
    const tokens = part.match(/[#.:]?[A-Za-z0-9_-]+/g);
    if (!tokens) throw new CssError(`could not parse compound selector "${part}"`, partAt);

    // The tokens must *cover* the input, not merely be found in it.
    //
    // `match` skips anything it does not recognise, so an unsupported selector
    // did not fail — it quietly became a different, plausible one.
    // `input[type="text"]` yielded the tokens `input`, `type`, `text`, each
    // overwriting `tag` in turn, leaving the selector `text`: it matched nothing,
    // or worse, something else. `div > span` became `div span`, silently widening
    // a child combinator into a descendant one.
    //
    // Attribute selectors are on the critical path for A1 (`data-[state=open]:`
    // is used throughout shadcn); until they are implemented, refusing them is
    // the only honest answer.
    if (tokens.join("") !== part) {
      throw new CssError(
        `unsupported selector syntax in "${part}".\n` +
          `  Supported: type, .class, #id, the descendant combinator, and ` +
          `:hover/:active/:focus on the subject.\n` +
          `  Not yet supported: attribute selectors, child (>) and sibling (+ ~) ` +
          `combinators, and *.`,
        partAt,
      );
    }

    for (const token of tokens) {
      if (token.startsWith("#")) {
        compound.id = token.slice(1);
        spec[0]++;
      } else if (token.startsWith(".")) {
        compound.classes.push(token.slice(1));
        spec[1]++;
      } else if (token.startsWith(":")) {
        const name = token.slice(1).toLowerCase();
        if (!SUPPORTED_PSEUDO.has(name)) {
          // `:focus-within` is deliberately absent: it propagates to ancestors,
          // which is the descendant-selector problem again.
          throw new CssError(`unsupported pseudo-class ":${name}"`, partAt);
        }
        if (p !== parts.length - 1) {
          throw new CssError(
            `":${name}" is only supported on the subject of a selector`,
            partAt,
          );
        }
        pseudo = name as Pseudo;
        spec[1]++;
      } else {
        compound.tag = token.toLowerCase();
        spec[2]++;
      }
    }

    compounds.push(compound);
  }

  return { compounds, pseudo, specificity: spec };
}

/** CSS cascade order: specificity, then source order. */
export function compareCascade(
  a: { specificity: [number, number, number]; order: number },
  b: { specificity: [number, number, number]; order: number },
): number {
  for (let k = 0; k < 3; k++) {
    if (a.specificity[k] !== b.specificity[k]) return a.specificity[k]! - b.specificity[k]!;
  }
  return a.order - b.order;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const NAMED_COLORS: Record<string, number> = {
  transparent: 0x00000000,
  black: 0xff000000,
  white: 0xffffffff,
  red: 0xffff0000,
  green: 0xff008000,
  blue: 0xff0000ff,
  gray: 0xff808080,
  grey: 0xff808080,
  silver: 0xffc0c0c0,
  orange: 0xffffa500,
};

/** Parses a color to 0xAARRGGBB, which is what `sk_color_t` wants. */
export function parseColor(raw: string): number {
  const v = raw.trim().toLowerCase();

  if (v in NAMED_COLORS) return NAMED_COLORS[v]!;

  if (v.startsWith("#")) {
    const hex = v.slice(1);
    const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
    if (hex.length === 3 || hex.length === 4) {
      const r = expand(hex[0]!);
      const g = expand(hex[1]!);
      const b = expand(hex[2]!);
      const a = hex.length === 4 ? expand(hex[3]!) : 255;
      return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
      return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
    }
    throw new CssError(`bad hex color "${raw}"`);
  }

  const fn = v.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const nums = fn[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
    const [r, g, b, a] = nums;
    if (r === undefined || g === undefined || b === undefined) {
      throw new CssError(`bad rgb() color "${raw}"`);
    }
    // The 4th component is 0..1 per CSS, unlike the others.
    const alpha = a === undefined ? 255 : Math.round(Math.max(0, Math.min(1, a)) * 255);
    return ((alpha << 24) | (r << 16) | (g << 8) | b) >>> 0;
  }

  throw new CssError(`unsupported color "${raw}"`);
}

/** Parses a length to px. `auto` becomes NaN; percentages are unsupported. */
export function parseLength(raw: string): number {
  const v = raw.trim().toLowerCase();
  if (v === "auto") return AUTO;
  if (v === "0") return 0;
  if (v.endsWith("%")) throw new CssError(`percentage lengths are not supported ("${raw}")`);

  const m = v.match(/^(-?[\d.]+)(px|pt|rem|em)?$/);
  if (!m) throw new CssError(`bad length "${raw}"`);

  const n = Number(m[1]);
  switch (m[2]) {
    case undefined:
    case "px":
      return n;
    case "pt":
      return n * (96 / 72);
    // rem/em resolve against the root's 16px default; nested em is out of scope.
    case "rem":
    case "em":
      return n * 16;
    default:
      throw new CssError(`bad length unit in "${raw}"`);
  }
}

/** Splits a 1-to-4-value box shorthand into [top, right, bottom, left]. */
/**
 * One `overflow` keyword, for either axis.
 *
 * CSS has five and the engine has three. `clip` collapses into `hidden` because they
 * differ only in whether script may scroll the box, and nothing scrolls
 * programmatically yet. `auto` and `scroll` both become `SCROLL` because the engine
 * draws a scrollbar only when the content actually overflows — which *is* `auto`, so
 * `scroll` is the approximated one, and erring toward "no scrollbar on content that
 * fits" is the harmless direction.
 */
function overflowKeyword(keyword: string, whole: string): number {
  switch (keyword) {
    case "visible":
      return Overflow.VISIBLE;
    case "hidden":
      return Overflow.HIDDEN;
    // Not folded into `hidden`, though it was until a probe showed why it cannot be:
    // `hidden` makes the box a scroll container, which coerces a `visible` axis to
    // `auto`, and `clip` does not. Measured on Chromium 151; see BROWSER-FACTS.md.
    case "clip":
      return Overflow.CLIP;
    case "auto":
    case "scroll":
      return Overflow.SCROLL;
    default:
      throw new CssError(`unsupported overflow "${whole}"`);
  }
}

function boxShorthand(raw: string): [number, number, number, number] {
  const parts = raw.trim().split(/\s+/).map(parseLength);
  const [a, b, c, d] = parts;
  if (a === undefined) throw new CssError(`empty box shorthand "${raw}"`);
  if (b === undefined) return [a, a, a, a];
  if (c === undefined) return [a, b, a, b];
  if (d === undefined) return [a, b, c, b];
  return [a, b, c, d];
}

const JUSTIFY_KEYWORDS: Record<string, number> = {
  "flex-start": Justify.START,
  start: Justify.START,
  left: Justify.START,
  center: Justify.CENTER,
  "flex-end": Justify.END,
  end: Justify.END,
  right: Justify.END,
  "space-between": Justify.SPACE_BETWEEN,
  "space-around": Justify.SPACE_AROUND,
  "space-evenly": Justify.SPACE_EVENLY,
};

const ALIGN_KEYWORDS: Record<string, number> = {
  "flex-start": Align.START,
  start: Align.START,
  center: Align.CENTER,
  "flex-end": Align.END,
  end: Align.END,
  stretch: Align.STRETCH,
  baseline: Align.BASELINE,
};

/** `align-self: auto` means "defer to the parent", which is what UNSET encodes. */
const SELF_KEYWORDS: Record<string, number> = { ...ALIGN_KEYWORDS, auto: UNSET };

const DISPLAY_KEYWORDS: Record<string, number> = {
  flex: Display.FLEX,
  grid: Display.GRID,
  block: Display.BLOCK,
  none: Display.NONE,
};

const WRAP_KEYWORDS: Record<string, number> = {
  nowrap: FlexWrap.NO_WRAP,
  wrap: FlexWrap.WRAP,
  "wrap-reverse": FlexWrap.WRAP_REVERSE,
};

/**
 * Grid track lists, narrowed to what Taffy is verified to do.
 *
 * Accepts `repeat(N, minmax(0, 1fr))`, `repeat(N, 1fr)` and a plain list of
 * equal `1fr` tracks — which between them cover Tailwind's `grid-cols-{n}`. What
 * it rejects, loudly: `auto-fit`/`auto-fill`, which need intrinsic sizing that is
 * **unverified in Taffy**, and mixed track sizes, which the IR cannot express in
 * one integer. Rejecting is the point — a silently approximated grid is worse
 * than a compile error.
 */
function parseTracks(value: string): number {
  const v = value.trim().toLowerCase();

  const repeat = /^repeat\(\s*([a-z0-9-]+)\s*,(.+)\)$/.exec(v);
  if (repeat) {
    const count = repeat[1]!;
    if (count === "auto-fit" || count === "auto-fill") {
      throw new CssError(
        `repeat(${count}, …) needs intrinsic track sizing, which is not supported yet. ` +
          `Use an explicit track count.`,
      );
    }
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) throw new CssError(`bad repeat count "${count}"`);

    const track = repeat[2]!.trim().replace(/\s+/g, "");
    if (track !== "1fr" && track !== "minmax(0,1fr)") {
      throw new CssError(
        `only equal \`1fr\` tracks are supported, got "${repeat[2]!.trim()}"`,
      );
    }
    return n;
  }

  const tracks = v.split(/\s+/).filter(Boolean);
  if (tracks.length > 0 && tracks.every((t) => t === "1fr")) return tracks.length;

  throw new CssError(
    `unsupported track list "${value}" — use \`repeat(N, 1fr)\` or N equal \`1fr\` tracks`,
  );
}

/**
 * One axis of grid placement: `3`, `span 2`, or `2 / span 3`.
 *
 * Returns `[start, span]`, both 0 when unplaced. Named lines and negative
 * indices are out of scope; a name has nothing to resolve against without a
 * template-areas model.
 */
function parsePlacement(value: string): [number, number] {
  let start = 0;
  let span = 0;

  for (const part of value.split("/")) {
    const p = part.trim().toLowerCase();
    if (!p || p === "auto") continue;

    const spanMatch = /^span\s+(\d+)$/.exec(p);
    if (spanMatch) {
      span = Number(spanMatch[1]);
      continue;
    }

    const n = Number(p);
    if (!Number.isInteger(n) || n === 0) {
      throw new CssError(`unsupported grid placement "${part.trim()}"`);
    }
    if (start === 0) start = n;
    else span = Math.max(1, n - start); // `2 / 5` is start 2, spanning 3
  }

  return [start, span];
}

/**
 * Parses an inline `style="…"` attribute into declarations.
 *
 * Same grammar as a rule body, minus the braces. Nothing here is dynamic, so an
 * inline style costs the runtime exactly nothing — it resolves into the node's
 * computed style and disappears.
 */
export function parseInlineStyle(source: string): Map<string, string> {
  const decls = new Map<string, string>();

  for (const chunk of source.split(";")) {
    const text = chunk.trim();
    if (!text) continue;

    const colon = text.indexOf(":");
    if (colon === -1) {
      throw new CssError(`inline style: expected \`property: value\`, got "${text}"`);
    }

    const prop = text.slice(0, colon).trim().toLowerCase();
    const value = text.slice(colon + 1).trim();
    if (!prop || !value) {
      throw new CssError(`inline style: incomplete declaration "${text}"`);
    }
    decls.set(prop, value);
  }

  return decls;
}

/**
 * Expands one declaration into computed longhand fields.
 *
 * `display` is handled by the caller because it interacts with
 * `flex-direction`: HTML's block default stacks children vertically, so a box
 * with no `display` behaves like COLUMN, while `display: flex` alone means ROW.
 */
export function expandDeclaration(
  prop: string,
  raw: string,
  out: Partial<Record<StyleField, number>>,
): void {
  const value = raw.trim();

  switch (prop) {
    case "background":
    case "background-color":
      out.bg = parseColor(value);
      return;
    case "color":
      out.fg = parseColor(value);
      return;
    case "border-radius":
      // Per-corner radii are out of scope; the first value wins.
      out.radius = parseLength(value.split(/\s+/)[0]!);
      return;

    case "border": {
      // `<width> <style> <color>`, in any order, style ignored.
      const parts = value.split(/\s+/);
      for (const part of parts) {
        if (/^(none|solid|dashed|dotted)$/i.test(part)) continue;
        if (/^-?[\d.]/.test(part)) out.borderWidth = parseLength(part);
        else out.borderColor = parseColor(part);
      }
      if (/^none$/i.test(value)) out.borderWidth = 0;
      return;
    }
    case "border-width":
      out.borderWidth = parseLength(value);
      return;
    case "border-color":
      out.borderColor = parseColor(value);
      return;

    case "padding": {
      const [t, r, b, l] = boxShorthand(value);
      out.padT = t;
      out.padR = r;
      out.padB = b;
      out.padL = l;
      return;
    }
    case "padding-top":
      out.padT = parseLength(value);
      return;
    case "padding-right":
      out.padR = parseLength(value);
      return;
    case "padding-bottom":
      out.padB = parseLength(value);
      return;
    case "padding-left":
      out.padL = parseLength(value);
      return;

    case "margin": {
      const [t, r, b, l] = boxShorthand(value);
      out.marT = t;
      out.marR = r;
      out.marB = b;
      out.marL = l;
      return;
    }
    case "margin-top":
      out.marT = parseLength(value);
      return;
    case "margin-right":
      out.marR = parseLength(value);
      return;
    case "margin-bottom":
      out.marB = parseLength(value);
      return;
    case "margin-left":
      out.marL = parseLength(value);
      return;

    case "flex-direction": {
      const v = value.toLowerCase();
      if (v !== "row" && v !== "column") {
        throw new CssError(`unsupported flex-direction "${value}"`);
      }
      out.direction = v === "row" ? Direction.ROW : Direction.COLUMN;
      return;
    }
    case "flex-wrap": {
      const v = WRAP_KEYWORDS[value.toLowerCase()];
      if (v === undefined) throw new CssError(`unsupported flex-wrap "${value}"`);
      out.wrap = v;
      return;
    }
    case "justify-content": {
      const v = JUSTIFY_KEYWORDS[value.toLowerCase()];
      if (v === undefined) throw new CssError(`unsupported justify-content "${value}"`);
      out.justify = v;
      return;
    }
    case "align-items": {
      const v = ALIGN_KEYWORDS[value.toLowerCase()];
      if (v === undefined) throw new CssError(`unsupported align-items "${value}"`);
      out.align = v;
      return;
    }
    case "align-self": {
      const v = SELF_KEYWORDS[value.toLowerCase()];
      if (v === undefined) throw new CssError(`unsupported align-self "${value}"`);
      out.alignSelf = v;
      return;
    }
    case "justify-items": {
      const v = ALIGN_KEYWORDS[value.toLowerCase()];
      if (v === undefined) throw new CssError(`unsupported justify-items "${value}"`);
      out.justifyItems = v;
      return;
    }
    case "justify-self": {
      const v = SELF_KEYWORDS[value.toLowerCase()];
      if (v === undefined) throw new CssError(`unsupported justify-self "${value}"`);
      out.justifySelf = v;
      return;
    }

    case "flex": {
      // `flex: <grow> <shrink> <basis>`, plus the two keywords worth having.
      const v = value.toLowerCase();
      if (v === "none") {
        out.grow = 0;
        out.shrink = 0;
        out.basis = AUTO;
        return;
      }
      if (v === "auto") {
        out.grow = 1;
        out.shrink = 1;
        out.basis = AUTO;
        return;
      }

      const parts = v.split(/\s+/);
      const grow = Number(parts[0]);
      if (!Number.isFinite(grow)) throw new CssError(`bad flex "${value}"`);
      out.grow = grow;
      // `flex: 1` means `1 1 0`, not `1 1 auto` — the difference is whether
      // items size from content before growing, and it is visible.
      out.shrink = parts.length > 1 && Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 1;
      const basis = parts.find((p) => /^-?[\d.]+(px)?$/.test(p) && p !== parts[0] && p !== parts[1]);
      out.basis = basis ? parseLength(basis) : 0;
      return;
    }
    case "flex-grow":
      out.grow = Number(value);
      if (!Number.isFinite(out.grow)) throw new CssError(`bad flex-grow "${value}"`);
      return;
    case "flex-shrink":
      out.shrink = Number(value);
      if (!Number.isFinite(out.shrink)) throw new CssError(`bad flex-shrink "${value}"`);
      return;
    case "flex-basis":
      out.basis = value.toLowerCase() === "auto" ? AUTO : parseLength(value);
      return;

    case "gap":
    case "grid-gap": {
      // One value sets both axes; two are `<row> <column>`, as in CSS.
      const parts = value.split(/\s+/);
      out.gapRow = parseLength(parts[0]!);
      out.gapCol = parts[1] ? parseLength(parts[1]) : out.gapRow;
      return;
    }
    case "row-gap":
      out.gapRow = parseLength(value);
      return;
    case "column-gap":
      out.gapCol = parseLength(value);
      return;

    case "grid-template-columns":
      out.gridCols = parseTracks(value);
      return;
    case "grid-template-rows":
      out.gridRows = parseTracks(value);
      return;
    case "grid-column": {
      const [start, span] = parsePlacement(value);
      out.gridColStart = start;
      out.gridColSpan = span;
      return;
    }
    case "grid-row": {
      const [start, span] = parsePlacement(value);
      out.gridRowStart = start;
      out.gridRowSpan = span;
      return;
    }

    case "aspect-ratio": {
      if (value.toLowerCase() === "auto") {
        out.aspectRatio = AUTO;
        return;
      }
      const ratio = /^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/.exec(value.trim());
      const v = ratio ? Number(ratio[1]) / Number(ratio[2]) : Number(value);
      if (!Number.isFinite(v) || v <= 0) throw new CssError(`bad aspect-ratio "${value}"`);
      out.aspectRatio = v;
      return;
    }

    case "position": {
      const v = value.toLowerCase();
      if (v === "relative" || v === "static") {
        out.position = Position.RELATIVE;
        return;
      }
      if (v === "absolute") {
        out.position = Position.ABSOLUTE;
        return;
      }
      // `fixed` and `sticky` are viewport- and scroll-relative; neither has a
      // meaning yet, and approximating them as `absolute` would be a lie.
      throw new CssError(`unsupported position "${value}"`);
    }
    case "top":
      out.insetT = parseLength(value);
      return;
    case "right":
      out.insetR = parseLength(value);
      return;
    case "bottom":
      out.insetB = parseLength(value);
      return;
    case "left":
      out.insetL = parseLength(value);
      return;

    case "width":
      out.width = parseLength(value);
      return;
    case "height":
      out.height = parseLength(value);
      return;
    case "min-width":
      out.minW = parseLength(value);
      return;
    case "max-width":
      out.maxW = value.toLowerCase() === "none" ? Infinity : parseLength(value);
      return;
    case "min-height":
      out.minH = parseLength(value);
      return;
    case "max-height":
      out.maxH = value.toLowerCase() === "none" ? Infinity : parseLength(value);
      return;

    case "font-size":
      out.fontSize = parseLength(value);
      return;
    case "font-weight": {
      const v = value.toLowerCase();
      if (v === "normal") out.fontWeight = 400;
      else if (v === "bold") out.fontWeight = 700;
      else {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new CssError(`bad font-weight "${value}"`);
        out.fontWeight = n;
      }
      return;
    }

    // `overflow` takes one value for both axes or two as `<x> <y>`, and the two
    // longhands set one axis each. The asymmetric case is the common one — a column
    // that scrolls vertically and must never scroll sideways — so the schema carries
    // an axis each rather than one field that would have to lie about the other.
    case "overflow": {
      const parts = value.trim().toLowerCase().split(/\s+/);
      if (parts.length > 2) throw new CssError(`overflow takes one or two values, got "${value}"`);
      out.overflowX = overflowKeyword(parts[0]!, value);
      out.overflowY = overflowKeyword(parts[1] ?? parts[0]!, value);
      return;
    }
    case "overflow-x":
      out.overflowX = overflowKeyword(value.trim().toLowerCase(), value);
      return;
    case "overflow-y":
      out.overflowY = overflowKeyword(value.trim().toLowerCase(), value);
      return;

    case "display":
      return; // handled by the caller

    default:
      console.warn(`  warn: ignoring unsupported property "${prop}"`);
  }
}
