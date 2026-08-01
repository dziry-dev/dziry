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
  ScrollbarWidth,
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
  /**
   * `:root` — matches only the element at the top of the tree.
   *
   * A flag rather than a compound, because it is a statement about *position*
   * and compounds only describe an element's own tag, id and classes. It exists
   * because Tailwind v4's `@theme` block is where every design token lives, and
   * the natural home for those is the root: custom properties inherit, so one
   * declaration there reaches the whole tree.
   */
  root?: true;
  /**
   * A selector that is understood and matches nothing, as distinct from one that
   * is refused. `:host` is the case: it is meaningful CSS, it simply cannot
   * select anything in a tree with no shadow DOM.
   */
  never?: true;
};

/**
 * One atomic media condition, already resolved to px.
 *
 * `and` is not represented: a block with several conditions produces several of
 * these on the rule, and "all of them hold" is the rule's requirement. That is
 * what lets the existing variant machinery resolve a conjunction without knowing
 * the word `and` — it is just the combination where several bits are live.
 */
export type MediaCond = {
  axis: "width" | "height";
  /** `min` holds at the threshold and above, `max` at it and below, as in CSS. */
  side: "min" | "max";
  px: number;
};

/**
 * Cascade origin. Higher wins, and it outranks specificity — that is what makes
 * it an origin rather than just an earlier stylesheet.
 *
 * Concatenating the UA sheet ahead of the author's and relying on source order
 * would be right almost always, because UA rules use type selectors and lose
 * every specificity contest anyway. "Almost always" is the problem: a UA rule
 * with two type selectors beats an author rule with one, and the author would
 * have no way to win short of raising specificity against a sheet they cannot
 * see. Origin is cheap to carry and removes the class of bug entirely.
 */
export const Origin = { UA: 0, AUTHOR: 1 } as const;
export type OriginValue = (typeof Origin)[keyof typeof Origin];

export type Rule = {
  selectors: Selector[];
  decls: Map<string, string>;
  /** Source order, for breaking specificity ties. */
  order: number;
  /** Which stylesheet this came from. Absent means author. */
  origin?: OriginValue;
  /**
   * Conditions that must *all* hold for this rule to apply. Absent on an
   * unconditional rule, which is the overwhelming majority.
   */
  media?: MediaCond[];
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

/**
 * At-rules whose body is a list of *rules*, not declarations, and which apply
 * unconditionally — so their contents are lifted into the enclosing sheet.
 *
 * `@layer` changes the cascade in a way nothing here models yet: every layer is
 * treated as if it were unlayered, which is right for a single-layer sheet and
 * wrong for a sheet that uses layers to order overrides. Tailwind v4 wraps its
 * output in `@layer theme, base, components, utilities` and relies on that order,
 * so this is a real approximation rather than a free one — recorded here because
 * it will produce a wrong cascade before it produces an error.
 *
 * **`@supports` is deliberately not here.** Its body applies only if its condition
 * holds, and dziri cannot evaluate conditions like
 * `(-webkit-hyphens: none) and (not (margin-trim: inline))` — so inlining it would
 * be asserting the condition is true. Tailwind ships exactly that as a fallback
 * for engines without `@property`, and inlining it exposed a `*, ::before` rule
 * that is not meant for an engine that has the feature. Skipped, like `@media`.
 */
const TRANSPARENT_GROUPS = new Set(["@layer"]);

/**
 * At-rules whose body is a list of *declarations* that behave as though they were
 * written on `:root`.
 *
 * `@theme` is Tailwind v4's: it is where every `--color-*`, `--spacing-*` and
 * `--font-*` is defined, and with it dropped, every `var()` in Tailwind's output
 * resolves to nothing. `:root` is the closest thing dziri already understands.
 */
const ROOT_DECL_GROUPS = new Set(["@theme"]);

export function parseCss(src: string, origin: OriginValue = Origin.AUTHOR): Rule[] {
  const text = stripComments(src);
  const rules: Rule[] = [];
  const order = { n: 0 };
  parseRuleList(text, 0, text.length, rules, order);
  // Stamped after the walk rather than threaded through it: `order` is per-call,
  // so UA and author rules can share numbers, and only origin keeps them apart.
  if (origin !== Origin.AUTHOR) for (const r of rules) r.origin = origin;
  return rules;
}

/**
 * Parses a media query prelude into the conditions this engine can test, or
 * `null` when any part of it is one it cannot.
 *
 * Deliberately all-or-nothing. A query is a conjunction, so understanding half of
 * `(min-width: 40rem) and (orientation: landscape)` and applying it would make the
 * rules inside apply in a case they were written to exclude — which is worse than
 * not applying them at all. `null` means "skip the block", and the caller says so.
 *
 * Two syntaxes, because both are in the wild and Tailwind v4 emits the second:
 *
 *   (min-width: 768px)      the long-standing form
 *   (width >= 48rem)        CSS Media Queries 4 range syntax
 *
 * `only screen`, and a bare `screen`, are accepted and ignored — there is one
 * medium here and it is a screen. `print`, `not`, and comma-separated query lists
 * are not: a comma is an *or*, which cannot be expressed as a set of bits that all
 * have to hold.
 */
export function parseMediaQuery(prelude: string): MediaCond[] | null {
  const src = prelude.trim().toLowerCase();
  if (src.includes(",")) return null;

  const out: MediaCond[] = [];
  // `and` is the only combinator that survives; splitting on it is safe because
  // the features themselves never contain the word.
  for (const rawTerm of src.split(/\band\b/)) {
    const term = rawTerm.trim();
    if (term === "" || term === "screen" || term === "only screen") continue;

    const body = term.startsWith("(") && term.endsWith(")") ? term.slice(1, -1).trim() : null;
    if (body === null) return null;

    // `min-width: 768px`
    const colon = body.match(/^(min|max)-(width|height)\s*:\s*(.+)$/);
    if (colon) {
      const px = safeLength(colon[3]!);
      if (px === null) return null;
      out.push({ axis: colon[2] as "width" | "height", side: colon[1] as "min" | "max", px });
      continue;
    }

    // `width >= 48rem`. `>` and `<` are exclusive bounds and the engine's test is
    // inclusive, so they are refused rather than silently widened by a pixel.
    const range = body.match(/^(width|height)\s*(>=|<=)\s*(.+)$/);
    if (range) {
      const px = safeLength(range[3]!);
      if (px === null) return null;
      out.push({
        axis: range[1] as "width" | "height",
        side: range[2] === ">=" ? "min" : "max",
        px,
      });
      continue;
    }

    return null;
  }

  // `@media screen { … }` parses to no conditions at all, which is unconditional.
  return out;
}

/** `parseLength`, but a value this subset cannot express is `null` not a throw. */
function safeLength(raw: string): number | null {
  try {
    const px = parseLength(raw);
    return Number.isFinite(px) ? px : null;
  } catch {
    return null;
  }
}

/**
 * Finds the `}` matching the `{` at `open`, skipping nested blocks and strings.
 *
 * This used to be `text.indexOf("}", open)`, which is correct only for a flat
 * sheet. Given `@media (…) { .a { … } }` it returned the *inner* brace, so the
 * skip consumed half the at-rule and parsing resumed in the middle of it — which
 * is why a single at-rule anywhere in a sheet also broke the rule after it, not
 * just itself.
 */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

function parseRuleList(
  text: string,
  from: number,
  to: number,
  rules: Rule[],
  order: { n: number },
): void {
  let i = from;

  while (i < to) {
    const open = text.indexOf("{", i);
    if (open === -1 || open >= to) break;

    // A statement at-rule — `@layer properties;`, `@import "…";`, `@charset` —
    // has no block, so scanning to the next `{` runs straight past its semicolon
    // and swallows whatever follows into its prelude. Tailwind v4 opens with
    // `@layer properties;` and the very next rule is the `:root` block holding
    // every design token, so this silently discarded the entire theme: the sheet
    // parsed, and every `var(--color-…)` in it then resolved to nothing.
    const semi = text.indexOf(";", i);
    if (semi !== -1 && semi < open) {
      const statement = text.slice(i, semi).trim();
      if (statement.startsWith("@")) {
        i = semi + 1;
        continue;
      }
    }

    const raw = text.slice(i, open);
    const prelude = raw.trim();
    const preludeAt = i + raw.length - raw.trimStart().length;
    const close = matchingBrace(text, open);
    if (close === -1) {
      throw new CssError(`unclosed rule for selector "${prelude}"`, open);
    }

    const bodyFrom = open + 1;
    const bodyTo = close;
    i = close + 1;

    if (prelude.startsWith("@")) {
      const keyword = prelude.split(/[\s({]/)[0]!.toLowerCase();

      if (TRANSPARENT_GROUPS.has(keyword)) {
        // A prelude with no block of its own — `@layer a, b;` — has already been
        // consumed as an empty body by the scan above; recursing over it is a
        // no-op, which is the right outcome.
        parseRuleList(text, bodyFrom, bodyTo, rules, order);
        continue;
      }

      if (ROOT_DECL_GROUPS.has(keyword)) {
        rules.push({
          selectors: [parseSelector(":root", preludeAt)],
          decls: parseDeclarations(text.slice(bodyFrom, bodyTo), bodyFrom),
          order: order.n++,
        });
        continue;
      }

      if (keyword === "@media") {
        // A query this engine cannot evaluate — `print`, `prefers-color-scheme`,
        // `hover: hover` — is skipped rather than refused. Skipping degrades to
        // "the unconditional styles only", which is exactly the behaviour before
        // media queries existed; refusing would reject whole real stylesheets over
        // a feature that was never going to apply.
        const conds = parseMediaQuery(prelude.slice("@media".length));
        if (conds === null) {
          console.warn(`  warn: ignoring media query "${prelude.trim()}"`);
          continue;
        }
        const inner: Rule[] = [];
        parseRuleList(text, bodyFrom, bodyTo, inner, order);
        for (const rule of inner) {
          // Nested `@media` intersects: the inner block's conditions are added to
          // whatever the outer one already required.
          rule.media = [...conds, ...(rule.media ?? [])];
          rules.push(rule);
        }
        continue;
      }

      // Everything else — `@font-face`, `@keyframes` — is skipped, but skipped
      // *correctly*: the whole block goes, and the sheet after it still parses.
      console.warn(`  warn: ignoring at-rule "${keyword}"`);
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

    rules.push({
      selectors,
      decls: parseDeclarations(text.slice(bodyFrom, bodyTo), bodyFrom),
      order: order.n++,
    });
  }
}

/**
 * Splits a rule body into declarations, skipping any nested block.
 *
 * A rule body is no longer only declarations. CSS nesting is real, and Tailwind
 * v4 emits it heavily — `.container { width: 100%; @media (width >= 40rem) {
 * max-width: 40rem } }` is its ordinary output. Splitting such a body on `;`
 * hands the parser the fragment `}` and it reports "declaration without a colon",
 * pointing at a brace the author never wrote as a declaration.
 *
 * Nested blocks are *skipped*, not applied: a nested `@media` needs the predicate
 * machinery that does not exist yet, and a nested style rule needs `&`. Skipping
 * keeps the surrounding declarations — which are the unconditional ones, and the
 * right answer at the default window size.
 */
function splitDeclarations(body: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let start = 0;
  let i = 0;

  const push = (end: number) => {
    const raw = body.slice(start, end);
    if (raw.trim()) out.push({ text: raw.trim(), at: start + (raw.length - raw.trimStart().length) });
  };

  while (i < body.length) {
    const ch = body[i];
    if (ch === "{") {
      // Everything from the last boundary up to here is the nested rule's
      // prelude, not a declaration, so it is dropped along with the block.
      let depth = 0;
      let j = i;
      for (; j < body.length; j++) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}" && --depth === 0) break;
      }
      i = j + 1;
      start = i;
      continue;
    }
    if (ch === ";") {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(body.length);
  return out;
}

function parseDeclarations(body: string, at: number): Map<string, string> {
  const decls = new Map<string, string>();
  for (const part of splitDeclarations(body)) {
    const chunk = part.text;
    const start = at + part.at;
    const colon = chunk.indexOf(":");
    if (colon === -1) {
      throw new CssError(`declaration without a colon: "${chunk}"`, start);
    }
    // Later duplicates win, matching CSS.
    //
    // Custom property names keep their case. CSS folds ordinary property names to
    // lower case but `--Foo` and `--foo` are two different properties, so
    // lowercasing them would silently merge a theme that distinguishes them.
    const name = chunk.slice(0, colon).trim();
    decls.set(name.startsWith("--") ? name : name.toLowerCase(), chunk.slice(colon + 1).trim());
  }
  return decls;
}

/**
 * Drops the backslashes from an escaped CSS identifier.
 *
 * Only the `\<char>` form, which is the one a class name needs and the only one
 * Tailwind emits. The `\26 ` hex form is not handled: it would need the trailing
 * space rule and nothing in reach produces it.
 */
function unescapeIdent(s: string): string {
  return s.includes("\\") ? s.replace(/\\(.)/g, "$1") : s;
}

export function parseSelector(src: string, at = -1): Selector {
  if (!src) throw new CssError("empty selector", at);
  if (/[>+~]/.test(src)) {
    throw new CssError(`only the descendant combinator is supported, got "${src}"`, at);
  }

  // `:root` on its own, which is the only form of it that means anything here.
  // Specificity is a pseudo-class's (0,1,0), as the spec says.
  if (src.trim() === ":root") {
    return { compounds: [], pseudo: "none", specificity: [0, 1, 0], root: true };
  }

  // `:host` matches the shadow host from inside a shadow tree. dziri has no
  // shadow DOM, so it matches nothing — which is the correct answer, not a
  // limitation. It is accepted rather than refused because Tailwind writes
  // `:root, :host` for its theme block, and refusing half of a selector list
  // would throw away the `:root` half with it.
  if (src.trim() === ":host") {
    return { compounds: [], pseudo: "none", specificity: [0, 1, 0], never: true };
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
    //
    // `\\.` is in the character set because a CSS identifier may escape any
    // character with a backslash, and Tailwind's variants rely on it: `md:flex-row`
    // is a *class name containing a colon*, written `.md\:flex-row` in a selector.
    // Without this the token scan stopped at the backslash, the coverage check
    // below rejected the whole selector, and every responsive, hover or dark
    // variant in a Tailwind sheet failed to parse.
    const tokens = part.match(/[#.:]?(?:\\.|[A-Za-z0-9_-])+/g);
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
        compound.id = unescapeIdent(token.slice(1));
        spec[0]++;
      } else if (token.startsWith(".")) {
        // Unescaped, because the class *attribute* holds the real character:
        // `class="md:flex-row"` is matched by the selector `.md\:flex-row`.
        compound.classes.push(unescapeIdent(token.slice(1)));
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
  a: { specificity: [number, number, number]; order: number; origin?: OriginValue },
  b: { specificity: [number, number, number]; order: number; origin?: OriginValue },
): number {
  // Origin outranks specificity, which is the whole point of it: an author rule
  // beats a UA rule it would lose to on selector weight alone.
  const ao = a.origin ?? Origin.AUTHOR;
  const bo = b.origin ?? Origin.AUTHOR;
  if (ao !== bo) return ao - bo;
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

  const oklchArgs = v.match(/^oklch\(([^)]+)\)$/);
  if (oklchArgs) return parseOklch(oklchArgs[1]!, raw);

  throw new CssError(`unsupported color "${raw}"`);
}

/**
 * `oklch(L C H)` / `oklch(L C H / A)` converted to packed sRGB.
 *
 * Not an optional nicety: **Tailwind v4's entire colour palette is oklch**. Every
 * `--color-*` token it ships is one, so without this every `bg-*`, `text-*` and
 * `border-*` in a Tailwind sheet fails to parse, and the demo renders black.
 *
 * The conversion is OKLCh -> OKLab -> LMS -> linear sRGB -> sRGB, with the matrices
 * from Björn Ottosson's definition, which is what the CSS Color 4 spec references.
 * It is done here, at compile time, because a colour is a constant — the engine
 * receives a packed `u32` and never learns that oklch exists.
 *
 * **Out-of-gamut colours are clipped per channel**, which is the simple choice and
 * not the spec's: CSS Color 4 asks for gamut *mapping*, which preserves hue by
 * reducing chroma. Clipping can shift the hue of a saturated colour. Tailwind's
 * palette is inside sRGB, so this is exact for the case that motivated it —
 * checked against Chrome rather than assumed, see `css.test.ts`.
 */
function parseOklch(args: string, raw: string): number {
  const [coords, alphaPart] = args.split("/");
  const parts = coords!.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) throw new CssError(`bad oklch() color "${raw}"`);

  // Lightness is 0..1, or a percentage of that. Chroma is an absolute number, and
  // a percentage there is relative to 0.4 per the spec. Hue is degrees.
  const pct = (s: string) => s.trim().endsWith("%");

  /**
   * `none` is a *missing component*, not a syntax error — CSS Color 4 §4.2.
   *
   * Outside interpolation a missing component computes to zero, which for hue is
   * what an achromatic colour means. Tailwind 4.3 emits exactly this for the greys:
   * `--color-zinc-50: oklch(98.5% 0 none)`. Rejecting it failed every neutral in
   * the palette — the colours a UI is mostly made of — while the saturated ones
   * parsed, so the failure looked like a bad token rather than a missing feature.
   */
  const num = (s: string) => {
    const t = s.trim().replace("%", "");
    return t === "none" ? 0 : Number(t);
  };

  const L = pct(parts[0]!) ? num(parts[0]!) / 100 : num(parts[0]!);
  const C = pct(parts[1]!) ? (num(parts[1]!) / 100) * 0.4 : num(parts[1]!);
  const H = num(parts[2]!);
  if (!Number.isFinite(L) || !Number.isFinite(C) || !Number.isFinite(H)) {
    throw new CssError(`bad oklch() color "${raw}"`);
  }

  const alpha =
    alphaPart === undefined
      ? 255
      : Math.round(Math.max(0, Math.min(1, pct(alphaPart) ? num(alphaPart) / 100 : num(alphaPart))) * 255);

  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);

  // OKLab -> LMS', cubed to undo the cube root the space is defined with.
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  const channel = (c: number) => {
    // The sRGB transfer function. Negative inputs happen for out-of-gamut
    // colours and are clipped rather than reflected.
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };

  return ((alpha << 24) | (channel(lin[0]!) << 16) | (channel(lin[1]!) << 8) | channel(lin[2]!)) >>> 0;
}

/**
 * Splits on whitespace that is not inside parentheses.
 *
 * `value.split(/\s+/)` is wrong the moment a component can be a function:
 * `scrollbar-color: red rgb(0 128 0)` is two colours, and the naive split makes it
 * four tokens. Modern CSS colour syntax is space-separated inside the parens, so this
 * is not a hypothetical — it is the form `getComputedStyle` hands back.
 */
export function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * The custom properties in scope at one element, resolved.
 *
 * A plain map because that is all inheritance needs: a child's environment is its
 * parent's with its own `--*` declarations laid over the top, which is exactly how
 * custom properties inherit.
 */
export type VarEnv = ReadonlyMap<string, string>;

/** How deep `var()` referring to `var()` may go before it is called a cycle. */
const VAR_DEPTH_LIMIT = 32;

/**
 * Replaces every `var(--name, fallback)` in a value with what it resolves to.
 *
 * Substitution is textual and happens before any property parser sees the value,
 * which is what the spec describes and also what makes this work for properties
 * whose grammar we never taught anything about: `var()` can supply a whole
 * declaration value, part of one, or a piece of a function's arguments.
 *
 * Three details that are easy to get wrong, all of them things Tailwind relies on:
 *
 *  - **The fallback is everything after the first comma**, not the next token.
 *    `var(--a, 1px 2px)` has one fallback of `1px 2px`, and
 *    `var(--a, var(--b, 3px))` nests. Splitting on every comma breaks both.
 *  - **An unset variable with no fallback makes the declaration invalid**, and CSS
 *    says the whole declaration is dropped rather than the property taking a
 *    partial value. That is reported here as `null` so the caller can skip it.
 *  - **A variable's own value may contain `var()`**, so resolution recurses. The
 *    depth limit is what stops `--a: var(--b); --b: var(--a)` from hanging the
 *    compiler; CSS calls that a cycle and treats it as invalid.
 */
export function substituteVars(value: string, env: VarEnv, depth = 0): string | null {
  const start = value.indexOf("var(");
  if (start === -1) return value;
  if (depth >= VAR_DEPTH_LIMIT) return null;

  // Find this `var(`'s matching paren, so a nested one is not mistaken for it.
  let cursor = start + 4;
  let nesting = 1;
  while (cursor < value.length && nesting > 0) {
    if (value[cursor] === "(") nesting++;
    else if (value[cursor] === ")") nesting--;
    cursor++;
  }
  if (nesting > 0) return null; // unclosed `var(`

  const inner = value.slice(start + 4, cursor - 1);
  const comma = topLevelComma(inner);
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();

  let resolved: string | null;
  if (env.has(name)) {
    resolved = substituteVars(env.get(name)!, env, depth + 1);
  } else if (fallback !== null) {
    resolved = substituteVars(fallback, env, depth + 1);
  } else {
    resolved = null;
  }
  if (resolved === null) return null;

  // Re-run over the whole string: the replacement may itself have introduced a
  // `var()`, and there may be more after this one.
  return substituteVars(value.slice(0, start) + resolved + value.slice(cursor), env, depth + 1);
}

/** Index of the first comma not inside parentheses, or -1. */
function topLevelComma(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

/**
 * The environment a node sees: its parent's, plus its own `--*` declarations.
 *
 * The declarations arrive already in cascade order, so a later one wins by being
 * written last — the same rule the rest of `collectDecls` runs on. Values are
 * resolved lazily rather than here, because a variable may refer to one declared
 * after it on the same element, which CSS allows.
 */
export function extendVarEnv(parent: VarEnv, decls: Map<string, string>): VarEnv {
  let own: Map<string, string> | null = null;
  for (const [prop, value] of decls) {
    if (!prop.startsWith("--")) continue;
    own ??= new Map(parent);
    own.set(prop, value);
  }
  return own ?? parent;
}

/**
 * Folds `calc()` down to a single px length, at compile time.
 *
 * This is the compile-time-first principle applied to arithmetic: an expression
 * whose operands are all absolute lengths has one answer, and that answer belongs
 * in the style table rather than in an evaluator the engine carries. Nothing about
 * `calc(1rem + 2px)` needs to survive to run time.
 *
 * What is deliberately *not* folded is anything whose value depends on layout —
 * percentages, `vw`/`vh`, and the other viewport units. Those cannot be a number
 * until the box or the window exists, so they are rejected here with the same
 * message any other unsupported length gets, rather than being guessed at. When
 * they matter they need Taffy's own calc support, which is a different change.
 *
 * Nested `calc()` is unwrapped rather than special-cased: the spec says a nested
 * one is just a parenthesised sub-expression, and that is what stripping the
 * keyword leaves behind.
 */
function foldCalc(raw: string): number {
  const inner = raw.trim().slice(raw.trim().indexOf("(") + 1, -1);
  const tokens = tokeniseCalc(inner.replace(/\bcalc\(/g, "("));
  const parser = new CalcParser(tokens, raw);
  const value = parser.expression();
  parser.expectEnd();
  return value;
}

/** Numbers, units, operators and parens — whitespace-separated or not. */
function tokeniseCalc(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(-?\d*\.?\d+(?:e[-+]?\d+)?[a-z%]*|[()+\-*/])/giy;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < src.length) {
    re.lastIndex = at;
    m = re.exec(src);
    if (!m) break;
    out.push(m[1]!);
    at = re.lastIndex;
  }
  if (src.slice(at).trim()) throw new CssError(`cannot parse calc() near "${src.slice(at).trim()}"`);
  return out;
}

/**
 * Recursive descent over `+ -` then `* /` then atoms, which is the precedence CSS
 * specifies. Written out rather than reached for from a library because the
 * grammar is four lines and the error messages matter more than the parser does.
 */
class CalcParser {
  #tokens: string[];
  #at = 0;
  #whole: string;

  constructor(tokens: string[], whole: string) {
    this.#tokens = tokens;
    this.#whole = whole;
  }

  #peek(): string | undefined {
    return this.#tokens[this.#at];
  }

  expectEnd(): void {
    if (this.#at !== this.#tokens.length) {
      throw new CssError(`trailing "${this.#tokens.slice(this.#at).join(" ")}" in "${this.#whole}"`);
    }
  }

  expression(): number {
    let left = this.term();
    for (;;) {
      const op = this.#peek();
      if (op !== "+" && op !== "-") return left;
      this.#at++;
      const right = this.term();
      left = op === "+" ? left + right : left - right;
    }
  }

  term(): number {
    let left = this.atom();
    for (;;) {
      const op = this.#peek();
      if (op !== "*" && op !== "/") return left;
      this.#at++;
      const right = this.atom();
      if (op === "/" && right === 0) {
        throw new CssError(`division by zero in "${this.#whole}"`);
      }
      left = op === "*" ? left * right : left / right;
    }
  }

  atom(): number {
    const tok = this.#peek();
    if (tok === undefined) throw new CssError(`"${this.#whole}" ends mid-expression`);
    this.#at++;

    if (tok === "(") {
      const value = this.expression();
      if (this.#peek() !== ")") throw new CssError(`unclosed "(" in "${this.#whole}"`);
      this.#at++;
      return value;
    }
    // Unary minus, as in `calc(-1 * var(--x))` once the var has been substituted.
    if (tok === "-") return -this.atom();
    if (tok === "+") return this.atom();
    if (tok === "(" || tok === ")" || tok === "*" || tok === "/") {
      throw new CssError(`unexpected "${tok}" in "${this.#whole}"`);
    }

    // A bare number is a scalar (a multiplier); anything else is a length, and
    // `parseLength` is what decides which units this engine can answer for.
    return /^-?[\d.]+(e[-+]?\d+)?$/i.test(tok) ? Number(tok) : parseLength(tok);
  }
}

/** Parses a length to px. `auto` becomes NaN; percentages are unsupported. */
export function parseLength(raw: string): number {
  const v = raw.trim().toLowerCase();
  if (v === "auto") return AUTO;
  if (v === "0") return 0;
  if (v.startsWith("calc(")) return foldCalc(v);
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
  // `splitTopLevel`, not `split(/\s+/)`: `padding: calc(4px * 2)` is *one* value,
  // and a naive split makes it the three lengths `calc(4px`, `*` and `2)`. The
  // paren-aware split already existed for colour functions; calc() is the same
  // problem arriving from the other direction.
  const parts = splitTopLevel(raw).map(parseLength);
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
      out.radius = parseLength(splitTopLevel(value)[0]!);
      return;

    case "border": {
      // `<width> <style> <color>`, in any order, style ignored.
      const parts = splitTopLevel(value);
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

    /*
     * Logical properties, mapped onto the physical ones.
     *
     * dziri has one writing mode — horizontal, left to right — so `inline` is the
     * horizontal axis and `block` is the vertical one, always. That is an
     * assumption, and it is the same one the rest of the engine already makes:
     * there is no `writing-mode` or `direction` field anywhere in `STYLE_FIELDS`.
     * When one arrives these have to be resolved against it rather than fixed here.
     *
     * Worth the mapping because these are not an edge case in Tailwind — `px-*`
     * and `py-*` are the spacing utilities people actually reach for, and they
     * compile to `padding-inline` and `padding-block`, not to `padding-left`.
     * Without this the demo's chips had no horizontal padding at all.
     */
    case "padding-inline": {
      const [a, b] = boxShorthand(value);
      out.padL = a;
      out.padR = b;
      return;
    }
    case "padding-block": {
      const [a, b] = boxShorthand(value);
      out.padT = a;
      out.padB = b;
      return;
    }
    case "padding-inline-start":
      out.padL = parseLength(value);
      return;
    case "padding-inline-end":
      out.padR = parseLength(value);
      return;
    case "padding-block-start":
      out.padT = parseLength(value);
      return;
    case "padding-block-end":
      out.padB = parseLength(value);
      return;

    case "margin-inline": {
      const [a, b] = boxShorthand(value);
      out.marL = a;
      out.marR = b;
      return;
    }
    case "margin-block": {
      const [a, b] = boxShorthand(value);
      out.marT = a;
      out.marB = b;
      return;
    }
    case "margin-inline-start":
      out.marL = parseLength(value);
      return;
    case "margin-inline-end":
      out.marR = parseLength(value);
      return;
    case "margin-block-start":
      out.marT = parseLength(value);
      return;
    case "margin-block-end":
      out.marB = parseLength(value);
      return;
    case "inset-inline-start":
      out.insetL = parseLength(value);
      return;
    case "inset-inline-end":
      out.insetR = parseLength(value);
      return;
    case "inset-block-start":
      out.insetT = parseLength(value);
      return;
    case "inset-block-end":
      out.insetB = parseLength(value);
      return;
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

      const parts = splitTopLevel(v);
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
      const parts = splitTopLevel(value);
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

    // The two standard scrollbar properties. Both grammars are measured rather than
    // remembered, and one of them refuted its own documentation — MDN's *Scrollbars
    // styling* guide summarises `scrollbar-width` as `auto | thin | thick | <length>`,
    // and Chromium 151 rejects `thick` and a length outright. See BROWSER-FACTS.md,
    // "Which scrollbar declarations the parser keeps".
    case "scrollbar-width": {
      const keyword = value.trim().toLowerCase();
      switch (keyword) {
        case "auto":
          out.scrollbarWidth = ScrollbarWidth.AUTO;
          return;
        case "thin":
          out.scrollbarWidth = ScrollbarWidth.THIN;
          return;
        case "none":
          out.scrollbarWidth = ScrollbarWidth.NONE;
          return;
        default:
          throw new CssError(
            `scrollbar-width takes auto, thin or none, got "${value}" ` +
              `(thick and <length> are not part of the property)`,
          );
      }
    }

    case "scrollbar-color": {
      if (value.trim().toLowerCase() === "auto") {
        out.scrollbarThumb = 0x00000000;
        out.scrollbarTrack = 0x00000000;
        return;
      }
      // Exactly two colours, thumb then track. One colour is not a partial
      // declaration in CSS, it is an invalid one — Chromium drops the whole thing —
      // so this refuses rather than guessing which half was meant.
      const parts = splitTopLevel(value);
      if (parts.length !== 2) {
        throw new CssError(
          `scrollbar-color takes two colours, thumb then track, got "${value}"`,
        );
      }
      out.scrollbarThumb = parseColor(parts[0]!);
      out.scrollbarTrack = parseColor(parts[1]!);
      return;
    }

    case "display":
      return; // handled by the caller

    default:
      console.warn(`  warn: ignoring unsupported property "${prop}"`);
  }
}
