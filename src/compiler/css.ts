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
 * `:hover` / `:active` / `:focus` / `:checked` / `:disabled` pseudo-classes
 * (which become precompiled variants).
 */
import {
  Align,
  Appearance,
  AUTO,
  Direction,
  Display,
  Easing,
  FlexWrap,
  Justify,
  Overflow,
  Position,
  ScrollbarWidth,
  StepPosition,
  UNSET,
  type StyleField,
} from "../ir.ts";
import { ANIM_ALL, ANIM_BIT, type AnimatableField } from "../protocol/generated.ts";

export type Pseudo = "none" | "hover" | "active" | "focus" | "checked" | "disabled";

/**
 * Pseudo-classes compiled into precomputed style variants.
 *
 * `:checked` and `:disabled` join the original three rather than needing anything
 * new, and that is the whole argument for them: each is an enumerable boolean, so
 * it is one more predicate bit, one more style id and an int write — the same
 * shape as `:hover`. What makes them *form-control* pseudo-classes is only who
 * supplies the answer, and that question lives on the engine's side of the
 * boundary. See ROADMAP C2.
 *
 * `:indeterminate` is the third of the trio ROADMAP names and is deliberately not
 * here. It is the same shape and would cost the same, but nothing can author it
 * until there is a control to be indeterminate — adding it now would mean
 * supporting a selector that provably cannot match.
 */
const SUPPORTED_PSEUDO = new Set<string>([
  "hover",
  "active",
  "focus",
  "checked",
  "disabled",
]);

/**
 * `<compat-auto>` — `appearance` keywords that are all synonyms for `auto`.
 *
 * Taken from `mdn-data`'s syntax rather than MDN's prose, which lists three more
 * (`push-button`, `square-button`, `slider-horizontal`) that Chromium 151 rejects
 * outright. Measured; see BROWSER-FACTS.md.
 */
const COMPAT_AUTO = new Set([
  "searchfield",
  "textarea",
  "checkbox",
  "radio",
  "menulist",
  "listbox",
  "meter",
  "progress-bar",
  "button",
]);

/**
 * Pseudo-elements, which generate a box rather than select an existing one.
 *
 * This is the mechanism dziri uses *instead of* a shadow tree. Servo draws every
 * form control with zero lines of widget paint code by building its internals out
 * of UA CSS and pseudo-elements; a checkbox's tick is `content: "✓"` on a
 * generated box, not Skia geometry. Here the generated box is an ordinary emitted
 * node, so it lays out in Taffy, paints in the normal pass, and has a hit region
 * — none of which a shadow tree or a synthesised paint-time rect would give.
 *
 * `::before` and `::after` first because they are the general case. The
 * control-specific ones (`::picker(select)`, `::picker-icon`, `::checkmark`,
 * `::placeholder`, `::marker`) are the same machinery with a different trigger,
 * and land once there are controls to hang them on.
 */
export type PseudoElement = "before" | "after";

const SUPPORTED_PSEUDO_ELEMENT = new Set<string>(["before", "after"]);

/**
 * One `[attr]` / `[attr op "value"]` test.
 *
 * The full Selectors Level 4 operator set, because it is small and leaving any
 * of it out means a stylesheet that silently selects nothing. `i` is the
 * ASCII-case-insensitive flag; HTML attribute *values* are case-sensitive by
 * default, which is why it has to be asked for.
 */
export type AttrOp = "exists" | "=" | "~=" | "|=" | "^=" | "$=" | "*=";

export type AttrSel = {
  name: string;
  op: AttrOp;
  value: string;
  /** The `i` flag: `[type="CHECKBOX" i]`. */
  ci?: true;
};

export type Compound = {
  tag: string | null;
  id: string | null;
  classes: string[];
  /**
   * Attribute tests on this compound.
   *
   * The reason form controls need them: twenty-two `input` types are one tag, so
   * `input[type=checkbox]` is the only way a UA stylesheet can say which control
   * it is describing. Until this existed, `input` meant all of them at once.
   */
  attrs?: AttrSel[];
};

export type Selector = {
  /** Left-to-right; the last entry is the subject of the selector. */
  compounds: Compound[];
  pseudo: Pseudo;
  /**
   * The pseudo-element this rule styles, or `null` for the element itself.
   *
   * A separate axis from `pseudo`, not a wider version of it, because the two
   * compose: `.btn:hover::before` styles a generated box *while its originating
   * element is hovered*. Folding them into one field would make that unsayable,
   * which is the same mistake the old named-role triple made about `:hover` and
   * `:focus`.
   */
  element: PseudoElement | null;
  /** [ids, classes+pseudo-classes, types+pseudo-elements] */
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

/**
 * One `@property` registration: what a custom property is worth when nobody has
 * set it, and whether it reaches a child.
 */
export type RegisteredProperty = { initial: string; inherits: boolean };

/**
 * One block inside a `@keyframes`, with its selector already turned into offsets.
 *
 * `offsets` is a list because `75%, 100% { … }` is legal and Tailwind's `ping` uses
 * it. Measured: it is simply two keyframes with the same declarations — a keyframe
 * list built from `{ 0% {opacity:0} 75%, 100% {opacity:1} }` reads 0.5 at t=0.375,
 * halfway to *75%* rather than to 100%. So expanding one block into two rows is not
 * an approximation, it is what the browser does.
 *
 * `from` and `to` are folded to 0 and 1 here, because nothing downstream benefits
 * from knowing which spelling the author used.
 */
export type KeyframeBlock = { offsets: number[]; decls: Map<string, string> };

/**
 * What `parseCss` returns: the rules, plus the `@property` registrations and
 * `@keyframes` blocks found alongside them.
 *
 * Hung off the array rather than changing the return type, because every caller
 * but one uses this as a plain `Rule[]` and neither of the two extras is a rule —
 * a registration has no selector, and a keyframe's declarations apply to no
 * element until something names the animation. The compiler reads `.properties`
 * and `.keyframes`; the tests carry on indexing.
 */
export type RuleList = Rule[] & {
  properties: Map<string, RegisteredProperty>;
  /** Animation name (case-preserved, as CSS identifiers are) to its blocks. */
  keyframes: Map<string, KeyframeBlock[]>;
};

export function parseCss(src: string, origin: OriginValue = Origin.AUTHOR): RuleList {
  const text = stripComments(src);
  const rules: Rule[] = [];
  const registered = new Map<string, RegisteredProperty>();
  const keyframes = new Map<string, KeyframeBlock[]>();
  const order = { n: 0 };
  parseRuleList(text, 0, text.length, rules, order, registered, keyframes);
  // Stamped after the walk rather than threaded through it: `order` is per-call,
  // so UA and author rules can share numbers, and only origin keeps them apart.
  if (origin !== Origin.AUTHOR) for (const r of rules) r.origin = origin;

  const out = rules as RuleList;
  out.properties = registered;
  out.keyframes = keyframes;
  return out;
}

/**
 * A `@keyframes` block's selector as a list of offsets, or `null` if unreadable.
 *
 * `from` is 0 and `to` is 1 — CSS says so, and the alternative of carrying the
 * keyword to the engine would be two spellings of one number crossing the
 * boundary. Percentages outside 0–100 are dropped rather than clamped: CSS says an
 * out-of-range keyframe selector makes the *whole block* invalid, and clamping
 * would silently move a keyframe somebody wrote at 150% onto the end of the
 * animation.
 */
function parseKeyframeSelector(src: string): number[] | null {
  const out: number[] = [];
  for (const raw of src.split(",")) {
    const part = raw.trim().toLowerCase();
    if (part === "from") out.push(0);
    else if (part === "to") out.push(1);
    else if (part.endsWith("%")) {
      const pct = Number(part.slice(0, -1));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
      out.push(pct / 100);
    } else return null;
  }
  return out.length > 0 ? out : null;
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
/**
 * Media features that always hold here, and therefore need no predicate bit.
 *
 * A pointer that can hover *is* the target: an SDL window on a desktop. Modelling
 * these as conditions would spend a mask bit on something that can never be false,
 * and skipping them silently loses every rule inside — which is what happened to
 * Tailwind's entire `hover:` family.
 *
 * `hover: none` and `pointer: coarse` are deliberately **not** listed. They are the
 * negations, they are false here, and a block guarded by one should be dropped —
 * which is what the skip path already does.
 */
const ALWAYS_TRUE_MEDIA = new Set([
  "hover:hover",
  "any-hover:hover",
  "pointer:fine",
  "any-pointer:fine",
]);

/**
 * True when every condition in the prelude is one that always holds.
 *
 * All of them, not any: `(hover: hover) and (min-width: 40rem)` still has a real
 * condition in it and has to go through the normal path, or the width would be
 * asserted rather than evaluated.
 */
function alwaysTrueMedia(prelude: string): boolean {
  const parts = prelude
    .split(/\band\b/)
    .map((p) => p.trim().replace(/^\(|\)$/g, "").replace(/\s+/g, "").toLowerCase())
    .filter(Boolean);

  return parts.length > 0 && parts.every((p) => ALWAYS_TRUE_MEDIA.has(p));
}

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
  registered: Map<string, RegisteredProperty>,
  keyframes: Map<string, KeyframeBlock[]>,
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
        parseRuleList(text, bodyFrom, bodyTo, rules, order, registered, keyframes);
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

      if (keyword === "@media" && alwaysTrueMedia(prelude.slice("@media".length))) {
        // Conditions that are simply *true* for a native desktop window, so the
        // block is unwrapped rather than skipped.
        //
        // This is not a nicety: Tailwind v4 wraps every `hover:` utility in
        // `@media (hover: hover)`, and skipping it dropped all of them. Hover
        // appeared not to work at all, while the compiler reported one line about a
        // media query — a symptom nowhere near its cause. dziri renders into an SDL
        // window with a mouse; `(hover: hover)` and `(pointer: fine)` hold, and
        // pretending otherwise is the wrong answer to a question we can answer.
        parseRuleList(text, bodyFrom, bodyTo, rules, order, registered, keyframes);
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
          warnOnce(`ignoring media query "${prelude.trim()}"`);
          continue;
        }
        const inner: Rule[] = [];
        parseRuleList(text, bodyFrom, bodyTo, inner, order, registered, keyframes);
        for (const rule of inner) {
          // Nested `@media` intersects: the inner block's conditions are added to
          // whatever the outer one already required.
          rule.media = [...conds, ...(rule.media ?? [])];
          rules.push(rule);
        }
        continue;
      }

      // `@property` is a *declaration* about a custom property, not a rule, and
      // ignoring it broke Tailwind's transforms outright.
      //
      // `translate-x-4` compiles to `--tw-translate-x: …; translate:
      // var(--tw-translate-x) var(--tw-translate-y)` — and nothing sets
      // `--tw-translate-y`. Its value comes from `@property { initial-value: 0 }`.
      // With the at-rule skipped the `var()` did not resolve, CSS says a
      // declaration with an unresolvable `var()` is dropped, and so the whole
      // `translate` disappeared. The page compiled cleanly and rendered nothing
      // moved, which is why this was found by looking at a screenshot rather than
      // by a failing build.
      if (keyword === "@property") {
        const name = prelude.slice("@property".length).trim().toLowerCase();
        if (name.startsWith("--")) {
          const body = parseDeclarations(text.slice(bodyFrom, bodyTo), bodyFrom);
          const initial = body.get("initial-value");
          if (initial !== undefined) {
            registered.set(name, {
              initial: initial.trim(),
              // The default is `false`, and it is the answer that matters:
              // Tailwind relies on it so a translated parent does not translate
              // its children through an inherited `--tw-translate-x`.
              inherits: body.get("inherits")?.trim().toLowerCase() === "true",
            });
          }
        }
        continue;
      }

      /**
       * `@keyframes` is a *list of styles at offsets*, not a rule either.
       *
       * Its blocks have keyframe selectors rather than element selectors, so they
       * cannot go in `rules` — nothing they say applies to any element until an
       * `animation` names them. They are collected here and resolved per use site,
       * because a keyframe's style is "the element's own computed style with these
       * declarations on top", which depends on which element is animating.
       *
       * Nested blocks are parsed with the same brace matcher the rest of this
       * function uses, so a `@keyframes` containing an unbalanced brace fails the
       * same way a rule does rather than swallowing the sheet after it.
       */
      if (keyword === "@keyframes") {
        const name = prelude.slice("@keyframes".length).trim();
        if (name !== "") {
          const blocks: KeyframeBlock[] = [];
          let j = bodyFrom;
          while (j < bodyTo) {
            const blockOpen = text.indexOf("{", j);
            if (blockOpen === -1 || blockOpen >= bodyTo) break;
            const blockClose = matchingBrace(text, blockOpen);
            if (blockClose === -1 || blockClose > bodyTo) {
              throw new CssError(`unclosed keyframe block in @keyframes ${name}`, blockOpen);
            }
            const offsets = parseKeyframeSelector(text.slice(j, blockOpen));
            if (offsets === null) {
              // CSS invalidates the whole block on a bad selector, and so does
              // this — a keyframe at an unreadable offset has no place to go.
              warnOnce(`ignoring keyframe "${text.slice(j, blockOpen).trim()}" in @keyframes ${name}`);
            } else {
              blocks.push({
                offsets,
                decls: parseDeclarations(text.slice(blockOpen + 1, blockClose), blockOpen + 1),
              });
            }
            j = blockClose + 1;
          }
          // Last definition wins, as CSS says of two `@keyframes` sharing a name.
          if (blocks.length > 0) keyframes.set(name, blocks);
        }
        continue;
      }

      // Everything else — `@font-face`, `@supports` — is skipped, but skipped
      // *correctly*: the whole block goes, and the sheet after it still parses.
      warnOnce(`ignoring at-rule "${keyword}"`);
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

/**
 * The selector with every `[…]` test blanked out, for scans that must not see
 * inside one — the combinator check being the only caller today. Escapes and
 * quotes are respected so `.content-\[x\]` and `[title="a]b"]` both survive.
 */
function withoutAttrs(src: string): string {
  let out = "";
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      if (depth === 0) out += ch + (src[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      depth++;
      continue;
    }
    if (ch === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Splits a complex selector into compounds on descendant whitespace.
 *
 * `src.split(/\s+/)` was right until attribute selectors existed and is wrong
 * now: `[title="a b"]` and `[type = checkbox]` both contain spaces that are not
 * combinators, and splitting on them turns one compound into two that match
 * nothing. So whitespace only separates when it is outside brackets and outside
 * a string — the same reason `splitTopLevel` exists for parenthesised values.
 */
function splitCompounds(src: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;

    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += src[i + 1] ?? "";
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }

    // A backslash escape makes the next character a literal ident character,
    // bracket or not. Tailwind writes `content-['x']` as the class
    // `.content-\[\'x\'\]`, so without this every arbitrary-value utility looks
    // like an unterminated attribute selector.
    if (ch === "\\") {
      current += ch + (src[i + 1] ?? "");
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") depth = Math.max(0, depth - 1);

    if (depth === 0 && /\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  if (current) out.push(current);
  return out;
}

/**
 * Pulls every `[…]` test out of one compound, returning the rest for tokenizing.
 *
 * Scanned rather than matched with a regex, because a value may contain a `]`:
 * `[title="a]b"]` is one test, and `/\[[^\]]*\]/` would cut it in half and leave
 * a stray `b"]` that the coverage check would then blame on the author.
 */
function extractAttrs(part: string, at: number): { rest: string; attrs: AttrSel[] } {
  const attrs: AttrSel[] = [];
  let rest = "";

  for (let i = 0; i < part.length; i++) {
    // An escaped bracket is an ident character, not the start of a test. Tailwind
    // writes `content-['x']` as `.content-\[\'x\'\]`, so without this every
    // arbitrary-value utility reads as an unterminated attribute selector.
    if (part[i] === "\\") {
      rest += part[i]! + (part[i + 1] ?? "");
      i++;
      continue;
    }
    if (part[i] !== "[") {
      rest += part[i];
      continue;
    }

    let body = "";
    let quote: string | null = null;
    let closed = false;
    i++;
    for (; i < part.length; i++) {
      const ch = part[i]!;
      if (quote) {
        body += ch;
        if (ch === "\\") {
          body += part[i + 1] ?? "";
          i++;
        } else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        body += ch;
        continue;
      }
      if (ch === "]") {
        closed = true;
        break;
      }
      body += ch;
    }
    if (!closed) throw new CssError(`unterminated attribute selector in "${part}"`, at);
    attrs.push(parseAttrSel(body, part, at));
  }

  return { rest, attrs };
}

/** `type=checkbox`, `class~="a"`, `data-x`, `title="A" i` — the inside of one `[…]`. */
function parseAttrSel(body: string, part: string, at: number): AttrSel {
  const m = /^\s*([-\w\\]+)\s*(?:([~|^$*]?=)\s*(.*?)\s*)?$/s.exec(body);
  if (!m) throw new CssError(`could not parse attribute selector "[${body}]"`, at);

  const name = unescapeIdent(m[1]!).toLowerCase();
  if (m[2] === undefined) return { name, op: "exists", value: "" };

  let raw = m[3] ?? "";
  let ci: true | undefined;
  // The `i` / `s` flag sits after the value. `s` is the default in HTML for
  // attribute values, so it parses and does nothing rather than being refused.
  const flag = /\s+([is])$/i.exec(raw);
  if (flag) {
    if (flag[1]!.toLowerCase() === "i") ci = true;
    raw = raw.slice(0, flag.index);
  }

  let value = raw.trim();
  if (
    value.length >= 2 &&
    (value[0] === '"' || value[0] === "'") &&
    value[value.length - 1] === value[0]
  ) {
    value = value.slice(1, -1).replace(/\\(.)/g, "$1");
  }

  if (value === "") {
    // `[attr=""]` is valid and matches an empty value; `[attr=]` is not. The
    // difference is whether quotes were there, and it is worth keeping because
    // `[type=]` is far more likely a typo than an intent.
    if (!/=\s*(""|'')\s*[is]?\s*$/i.test(body)) {
      throw new CssError(`attribute selector "[${body}]" in "${part}" has no value`, at);
    }
  }

  return ci ? { name, op: m[2] as AttrOp, value, ci } : { name, op: m[2] as AttrOp, value };
}

export function parseSelector(src: string, at = -1): Selector {
  if (!src) throw new CssError("empty selector", at);
  // Combinators are looked for *outside* attribute tests. `[data-tags~="beta"]`
  // contains a `~` that is an operator, not a sibling combinator, and testing the
  // raw string refused the selector outright.
  if (/[>+~]/.test(withoutAttrs(src))) {
    throw new CssError(`only the descendant combinator is supported, got "${src}"`, at);
  }

  // `:root` on its own, which is the only form of it that means anything here.
  // Specificity is a pseudo-class's (0,1,0), as the spec says.
  if (src.trim() === ":root") {
    return { compounds: [], pseudo: "none", element: null, specificity: [0, 1, 0], root: true };
  }

  // `:host` matches the shadow host from inside a shadow tree. dziri has no
  // shadow DOM, so it matches nothing — which is the correct answer, not a
  // limitation. It is accepted rather than refused because Tailwind writes
  // `:root, :host` for its theme block, and refusing half of a selector list
  // would throw away the `:root` half with it.
  if (src.trim() === ":host") {
    return { compounds: [], pseudo: "none", element: null, specificity: [0, 1, 0], never: true };
  }

  const compounds: Compound[] = [];
  let pseudo: Pseudo = "none";
  let element: PseudoElement | null = null;
  const spec: [number, number, number] = [0, 0, 0];

  const parts = splitCompounds(src);
  for (let p = 0; p < parts.length; p++) {
    const whole = parts[p]!;
    // Where this compound starts in the source, so the caret lands on the
    // offending compound rather than on the whole selector.
    const partAt = at < 0 ? -1 : at + src.indexOf(whole);
    const compound: Compound = { tag: null, id: null, classes: [] };

    // Attribute tests come out first, and the rest is tokenized as before.
    //
    // They have to: `[` and `]` are not ident characters, so leaving them in
    // would fail the coverage check below and refuse the whole selector — which
    // is exactly what `input[type=checkbox]` used to do.
    const { rest: part, attrs } = extractAttrs(whole, partAt);
    if (attrs.length) {
      compound.attrs = attrs;
      // An attribute selector weighs the same as a class, per the spec.
      spec[1] += attrs.length;
    }
    // `[type=checkbox]` on its own is a whole compound; there is nothing left to
    // tokenize and that is legal CSS, not a parse failure.
    if (part === "") {
      compounds.push(compound);
      continue;
    }

    // Split on the punctuation while keeping it: "div.a#b:hover" -> tokens.
    //
    // `\\.` is in the character set because a CSS identifier may escape any
    // character with a backslash, and Tailwind's variants rely on it: `md:flex-row`
    // is a *class name containing a colon*, written `.md\:flex-row` in a selector.
    // Without this the token scan stopped at the backslash, the coverage check
    // below rejected the whole selector, and every responsive, hover or dark
    // variant in a Tailwind sheet failed to parse.
    // `::` is its own alternative rather than a third member of the character
    // class, because a class matches one character: `::before` would tokenize as
    // a bare `:` that matches nothing followed by `:before`, the join would not
    // cover the input, and the whole selector would be refused as unsupported
    // syntax. Which is exactly what happened before pseudo-elements existed here.
    //
    // `[^\x00-\x7f]` because a CSS identifier may contain any code point from
    // U+0080 up, unescaped — CSS Syntax calls them "non-ASCII ident code points".
    // Found by real Tailwind output: `before:content-['a_·_b']` puts a raw U+00B7
    // in the class name, the scanner stopped at it, the coverage check below saw
    // an uncovered input and refused the whole selector. Every arbitrary value
    // containing a non-ASCII character would have done the same. Combinators and
    // the rest of selector syntax are all ASCII, so widening this masks nothing.
    const tokens = part.match(/(?:::|[#.:])?(?:\\.|[A-Za-z0-9_-]|[^\x00-\x7f])+/g);
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
          `  Supported: type, .class, #id, the descendant combinator, ` +
          `:hover/:active/:focus/:checked/:disabled and ::before/::after ` +
          `on the subject.\n` +
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
        // `::before` and the CSS2 spelling `:before` are the same thing — MDN:
        // "Browsers also accept single-colon notation". Distinguishing them would
        // refuse valid stylesheets to make a point about a notation change from
        // Selectors Level 3.
        const doubled = token.startsWith("::");
        const name = token.slice(doubled ? 2 : 1).toLowerCase();

        if (doubled || SUPPORTED_PSEUDO_ELEMENT.has(name)) {
          if (!SUPPORTED_PSEUDO_ELEMENT.has(name)) {
            throw new CssError(
              `unsupported pseudo-element "::${name}".\n` +
                `  Supported: ::before, ::after.\n` +
                `  The control-specific ones (::picker(select), ::picker-icon, ` +
                `::checkmark, ::placeholder, ::marker) are the same machinery and ` +
                `land with the controls they belong to.`,
              partAt,
            );
          }
          if (p !== parts.length - 1) {
            throw new CssError(
              `"::${name}" is only supported on the subject of a selector`,
              partAt,
            );
          }
          if (element !== null) {
            throw new CssError(`a selector may carry only one pseudo-element`, partAt);
          }
          element = name as PseudoElement;
          // A pseudo-element counts in the type column, not the class column.
          spec[2]++;
          continue;
        }

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
        // CSS orders a compound as `…:pseudo-class::pseudo-element`, and only a
        // short allowlist may follow the pseudo-element. None of that list is
        // supported yet, so anything after it is refused rather than silently
        // reordered into something that happens to work.
        if (element !== null) {
          throw new CssError(
            `":${name}" must come before "::${element}" — a pseudo-class after a ` +
              `pseudo-element selects the generated box, which dziri does not support yet`,
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

  return { compounds, pseudo, element, specificity: spec };
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

  // Greedy `(.*)`, not `([^)]+)`: the arguments contain their own parens —
  // `color-mix(in oklab, oklch(63.7% 0.237 25.331) 50%, transparent)`.
  const mixArgs = v.match(/^color-mix\((.*)\)$/);
  if (mixArgs) return parseColorMix(mixArgs[1]!, raw);

  throw new CssError(`unsupported color "${raw}"`);
}

/** Paren-aware split on top-level commas. `splitTopLevel` does whitespace; `color-mix()` needs commas. */
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === ",") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** One `<color> <percentage>?` argument of `color-mix()`; the percentage may precede the colour. */
function parseMixComponent(part: string, raw: string): { color: string; weight: number | null } {
  let weight: number | null = null;
  const colors: string[] = [];
  for (const tok of splitTopLevel(part)) {
    // `oklch(63.7% 0.237 25.331)` also contains a `%`, but it ends with `)`.
    if (tok.endsWith("%")) {
      if (weight !== null) throw new CssError(`two percentages in one color-mix() argument ("${raw}")`);
      const n = Number(tok.slice(0, -1));
      if (!Number.isFinite(n)) throw new CssError(`bad color-mix() percentage "${tok}" in "${raw}"`);
      weight = n / 100;
    } else colors.push(tok);
  }
  if (colors.length !== 1) throw new CssError(`expected one color per color-mix() argument, got "${part}"`);
  return { color: colors[0]!, weight };
}

/**
 * `color-mix(in <space>, <color> <pct>?, <color> <pct>?)` folded to a packed sRGB
 * value — but only the one form that folds *exactly*.
 *
 * Mixing against `transparent` is the whole reason this exists: it is how
 * Tailwind v4 spells every opacity modifier, so `bg-red-500/50` arrives here as
 * `color-mix(in oklab, oklch(63.7% 0.237 25.331) 50%, transparent)`.
 *
 * That form needs no colour-space conversion at all. CSS interpolates
 * premultiplied, and `transparent` is `rgb(0 0 0 / 0)`, whose premultiplied
 * components are all zero — so it contributes nothing but its weight, and the
 * result is the other colour with its alpha scaled. The interpolation space
 * cancels out, which is why `in oklab` and `in srgb` fold identically here and
 * why this needs none of the OKLab machinery `parseOklch` carries. Tailwind
 * emits both spellings (srgb as the `@supports` fallback), and they must agree.
 *
 * Every other mix is a real interpolation between two visible colours. Those are
 * left unsupported rather than approximated: a wrong colour that renders is
 * worse than one that refuses to compile, because nothing downstream flags it.
 */
function parseColorMix(args: string, raw: string): number {
  const parts = splitTopLevelCommas(args);
  if (parts.length !== 3) {
    throw new CssError(`color-mix() takes an interpolation space and two colors ("${raw}")`);
  }
  if (!/^in\s+\S/.test(parts[0]!)) {
    throw new CssError(`bad color-mix() interpolation space "${parts[0]}" in "${raw}"`);
  }

  const a = parseMixComponent(parts[1]!, raw);
  const b = parseMixComponent(parts[2]!, raw);

  // CSS Color 5's weight rules: one omitted percentage is `100% - other`, both
  // omitted is 50/50, and whatever is left is normalised to sum to 1.
  let wa = a.weight;
  let wb = b.weight;
  if (wa === null && wb === null) [wa, wb] = [0.5, 0.5];
  else if (wa === null) wa = 1 - wb!;
  else if (wb === null) wb = 1 - wa;
  if (wa! < 0 || wb! < 0) throw new CssError(`negative color-mix() percentage in "${raw}"`);
  const sum = wa! + wb!;
  if (sum === 0) throw new CssError(`color-mix() percentages sum to zero in "${raw}"`);
  wa = wa! / sum;
  wb = wb! / sum;

  const ca = parseColor(a.color);
  const cb = parseColor(b.color);
  const withAlpha = (c: number, alpha: number) =>
    ((Math.round(Math.max(0, Math.min(255, alpha))) << 24) | (c & 0x00ffffff)) >>> 0;

  // Any zero-alpha colour is premultiplied-invisible, not just the `transparent`
  // keyword — `rgb(255 0 0 / 0)` contributes exactly as little.
  if (cb >>> 24 === 0) return withAlpha(ca, (ca >>> 24) * wa);
  if (ca >>> 24 === 0) return withAlpha(cb, (cb >>> 24) * wb);

  throw new CssError(`color-mix() is only supported against a transparent color ("${raw}")`);
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
export function substituteVars(
  value: string,
  env: VarEnv,
  depth = 0,
  registered: ReadonlyMap<string, RegisteredProperty> = NO_PROPERTIES,
): string | null {
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
    resolved = substituteVars(env.get(name)!, env, depth + 1, registered);
  } else if (registered.has(name)) {
    // A registered property is never *unset*: its initial value is its computed
    // value when nobody assigned one. So this comes before the `var()` fallback
    // rather than after it — the fallback arm is for properties that really have
    // no value, and a registration means there always is one.
    resolved = substituteVars(registered.get(name)!.initial, env, depth + 1, registered);
  } else if (fallback !== null) {
    resolved = substituteVars(fallback, env, depth + 1, registered);
  } else {
    resolved = null;
  }
  if (resolved === null) return null;

  // Re-run over the whole string: the replacement may itself have introduced a
  // `var()`, and there may be more after this one.
  return substituteVars(
    value.slice(0, start) + resolved + value.slice(cursor),
    env,
    depth + 1,
    registered,
  );
}

/** No `@property` registrations, for the callers that have none. */
const NO_PROPERTIES: ReadonlyMap<string, RegisteredProperty> = new Map();

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
 * The environment a node sees: its parent's, plus its own `--*` declarations,
 * minus any registered property that does not inherit.
 *
 * The declarations arrive already in cascade order, so a later one wins by being
 * written last — the same rule the rest of `collectDecls` runs on. Values are
 * resolved lazily rather than here, because a variable may refer to one declared
 * after it on the same element, which CSS allows.
 *
 * **`inherits: false` is why the subtraction is here** and not only a detail of
 * the spec. Tailwind registers every `--tw-*` transform variable as
 * non-inheriting, and relies on it: a card with `translate-x-4` sets
 * `--tw-translate-x`, and a badge inside it with `translate-y-2` emits
 * `translate: var(--tw-translate-x) var(--tw-translate-y)`. If the parent's value
 * inherited, the badge would silently pick up its parent's horizontal shift.
 */
export function extendVarEnv(
  parent: VarEnv,
  decls: Map<string, string>,
  registered: ReadonlyMap<string, RegisteredProperty> = NO_PROPERTIES,
): VarEnv {
  let own: Map<string, string> | null = null;

  // Only pay for the filtered copy when the parent actually carries a
  // non-inheriting value. Tailwind's theme block puts hundreds of `--color-*` in
  // this map, and copying it at every node to remove nothing would be the
  // expensive way to change no behaviour.
  for (const [name, prop] of registered) {
    if (prop.inherits || !parent.has(name)) continue;
    own ??= new Map(parent);
    own.delete(name);
  }

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
function foldCalc(raw: string, resolve: (token: string) => number = parseLength): number {
  const inner = raw.trim().slice(raw.trim().indexOf("(") + 1, -1);
  const tokens = tokeniseCalc(inner.replace(/\bcalc\(/g, "("));
  const parser = new CalcParser(tokens, raw, resolve);
  const value = parser.expression();
  parser.expectEnd();
  return value;
}

/**
 * Numbers, units, operators, parens and bare identifiers — spaced or not.
 *
 * The identifier alternative comes last so `1px` still tokenises as one dimensioned
 * number rather than as `1` and `px`. It exists for the numeric constants CSS math
 * functions define, and it is not a nicety: Tailwind v4 spells `rounded-full` as
 * `calc(infinity * 1px)`, which this rejected outright with an error naming `calc()`
 * rather than the class. See `MATH_CONSTANTS`.
 */
function tokeniseCalc(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(-?\d*\.?\d+(?:e[-+]?\d+)?[a-z%]*|[()+\-*/]|[a-z][a-z0-9_-]*)/giy;
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
 * The numeric constants a CSS math function may name, per Values 4.
 *
 * Dimensionless, so each multiplies a unit rather than carrying one — which is
 * exactly how `calc(infinity * 1px)` is written and why `infinity` is not a length
 * token. `-infinity` needs no entry: the tokeniser splits the sign off and the
 * atom parser's unary minus does the rest.
 */
const MATH_CONSTANTS: Record<string, number> = {
  infinity: Infinity,
  nan: NaN,
  e: Math.E,
  pi: Math.PI,
};

/**
 * Recursive descent over `+ -` then `* /` then atoms, which is the precedence CSS
 * specifies. Written out rather than reached for from a library because the
 * grammar is four lines and the error messages matter more than the parser does.
 */
class CalcParser {
  #tokens: string[];
  #at = 0;
  #whole: string;
  #resolve: (token: string) => number;

  /**
   * `resolve` turns one dimensioned atom into a number, and it is a parameter
   * because `calc()` appears in more than one kind of value. Tailwind writes
   * every negative utility as a multiplication — `-rotate-12` is
   * `calc(12deg * -1)` — so an angle has to fold here too, and folding it with
   * the length parser reports "bad length" for a perfectly good angle.
   */
  constructor(tokens: string[], whole: string, resolve: (token: string) => number = parseLength) {
    this.#tokens = tokens;
    this.#whole = whole;
    this.#resolve = resolve;
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

    /**
     * The numeric constants CSS math functions define, which are *not* units.
     *
     * `infinity` is not a curiosity: Tailwind v4 spells `rounded-full` as
     * `border-radius: calc(infinity * 1px)`, so without this every fully-rounded
     * utility in the framework fails to parse. Found by rendering a page that used
     * one — the parser had never met the value, and the error named `calc()` rather
     * than the class.
     *
     * `e` and `pi` come along because they are the same clause in the spec and cost
     * one entry each. `NaN` is included and is not a mistake: CSS defines it, and a
     * length of `NaN` is already how dziri spells `auto`, so it lands somewhere
     * meaningful rather than nowhere.
     */
    const constant = MATH_CONSTANTS[tok.toLowerCase()];
    if (constant !== undefined) return constant;

    // A bare number is a scalar (a multiplier); anything else is dimensioned, and
    // the resolver this parser was built with is what decides which units it can
    // answer for.
    return /^-?[\d.]+(e[-+]?\d+)?$/i.test(tok) ? Number(tok) : this.#resolve(tok);
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

/**
 * An angle in degrees.
 *
 * CSS has four units and this keeps all four, because the conversions are exact
 * and the alternative is refusing `0.125turn` — which is how a stylesheet says
 * "an eighth of a turn" without writing 45 and hoping. Measured: Chromium folds
 * `rotate(0.125turn)` to the same matrix as `rotate(45deg)`.
 *
 * A unit is **required**, as CSS requires it, with unitless `0` the one exception
 * the grammar allows. `rotate(45)` is not a slightly-informal 45 degrees; it is an
 * invalid declaration that a browser drops, and accepting it here would render
 * something no browser renders.
 */
export function parseAngle(raw: string): number {
  const v = raw.trim().toLowerCase();
  // Tailwind writes every negative utility as a multiplication, so `-rotate-12`
  // arrives as `calc(12deg * -1)` rather than as `-12deg`. Found by building the
  // demo page, not by reading the grammar.
  if (v.startsWith("calc(")) return foldCalc(v, angleAtom);
  return angleAtom(v);
}

/** One dimensioned angle, with no `calc()` around it. */
function angleAtom(raw: string): number {
  const v = raw.trim().toLowerCase();
  const m = v.match(/^(-?[\d.]+(?:e[-+]?\d+)?)(deg|rad|grad|turn)?$/);
  if (!m) throw new CssError(`bad angle "${raw}"`);

  const n = Number(m[1]);
  if (!Number.isFinite(n)) throw new CssError(`bad angle "${raw}"`);

  switch (m[2]) {
    case "deg":
      return n;
    case "turn":
      return n * 360;
    case "grad":
      return n * 0.9;
    case "rad":
      return (n * 180) / Math.PI;
    case undefined:
      if (n === 0) return 0;
      throw new CssError(
        `angle "${raw}" needs a unit — deg, rad, grad or turn. Only 0 may be bare, ` +
          `and a browser drops the declaration rather than assuming degrees.`,
      );
    default:
      throw new CssError(`bad angle unit in "${raw}"`);
  }
}

/**
 * A `<length-percentage>` split into the two halves dziri stores separately.
 *
 * They cannot be one number: a percentage here is relative to the node's own
 * border box, which layout computes and the compiler does not know. So the px
 * part is folded now and the fraction travels to the engine to be resolved
 * against the laid-out size. See BROWSER-FACTS.md.
 */
function lengthPercent(raw: string): { px: number; pct: number } {
  const v = raw.trim().toLowerCase();

  if (v.endsWith("%") && !v.startsWith("calc(")) {
    const n = Number(v.slice(0, -1));
    if (!Number.isFinite(n)) throw new CssError(`bad percentage "${raw}"`);
    return { px: 0, pct: n / 100 };
  }

  // A `calc()` over percentages folds like any other, as long as *every*
  // dimensioned atom in it is a percentage: `translate-x-1/2` arrives as
  // `calc(1 / 2 * 100%)`, which is 50% and nothing else. Found by building the
  // demo page — the fraction utilities are the reason the percentage half of these
  // fields exists, so refusing this would have left them unreachable.
  //
  // A calc mixing the two genuinely cannot fold here: `foldCalc` returns one
  // number, and these are two fields precisely because one of them is not known
  // until layout. `percentAtom` throwing on a length is what tells the two apart.
  if (v.startsWith("calc(") && v.includes("%")) {
    try {
      return { px: 0, pct: foldCalc(v, percentAtom) / 100 };
    } catch {
      throw new CssError(
        `"${raw}" mixes a length and a percentage in one calc(), which dziri cannot ` +
          `fold: the percentage resolves against the laid-out box and the length does not. ` +
          `Write the two parts as separate transform functions instead.`,
      );
    }
  }

  return { px: parseLength(v), pct: 0 };
}

/** One percentage atom, for a `calc()` that must contain nothing else. */
function percentAtom(raw: string): number {
  const v = raw.trim();
  if (!v.endsWith("%")) throw new CssError(`"${raw}" is not a percentage`);
  const n = Number(v.slice(0, -1));
  if (!Number.isFinite(n)) throw new CssError(`bad percentage "${raw}"`);
  return n;
}

// ---------------------------------------------------------------------------
// Transitions and animations
// ---------------------------------------------------------------------------

/**
 * Seconds, from a CSS `<time>`. `NaN` when the value is not one.
 *
 * `NaN` rather than a throw because the shorthand grammar is order-free: parsing
 * `transition: opacity 1s ease-in` means asking of every token "is this a time?",
 * and two of the three answers are legitimately no.
 *
 * A unitless number is **not** a time in CSS, `0` included — and that matters here
 * rather than being pedantry, because in the `animation` shorthand a bare number is
 * the iteration count. `animation: spin 2 1s` is two iterations, not two seconds.
 */
export function parseTime(raw: string): number {
  const v = raw.trim().toLowerCase();
  if (v.endsWith("ms")) {
    const n = Number(v.slice(0, -2));
    return Number.isFinite(n) ? n / 1000 : NaN;
  }
  if (v.endsWith("s")) {
    const n = Number(v.slice(0, -1));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * An easing curve, in exactly the columns the wire carries.
 *
 * Flat rather than a discriminated union because it is written straight into four
 * `f32` columns and a `u8`, and a union would be converted to this shape at every
 * one of the three places that store one — a transition, an animation, and a
 * keyframe segment.
 */
export type Curve = { easing: number; a: number; b: number; c: number; d: number };

const bezier = (a: number, b: number, c: number, d: number): Curve => ({
  easing: Easing.CUBIC_BEZIER,
  a,
  b,
  c,
  d,
});

/**
 * The keyword curves, with the control points the spec gives them.
 *
 * Keywords do **not** normalise to `cubic-bezier()` in a browser's computed value —
 * `ease` reads back as `ease` — but they do here: a keyword *is* a bezier with
 * fixed points, and keeping the distinction would mean five spellings of one curve
 * crossing the boundary and five arms in the engine's evaluator.
 *
 * The measured progress table in BROWSER-FACTS.md is what these are checked
 * against, and it is a real check rather than a formality: `ease-in` is
 * `(0.42, 0, 1, 1)` and Tailwind's `--ease-in` is `(0.4, 0, 1, 1)`, which are
 * different curves with the same name in two different places.
 */
const EASING_KEYWORDS: Record<string, Curve> = {
  linear: { easing: Easing.LINEAR, a: 0, b: 0, c: 0, d: 0 },
  ease: bezier(0.25, 0.1, 0.25, 1),
  "ease-in": bezier(0.42, 0, 1, 1),
  "ease-out": bezier(0, 0, 0.58, 1),
  "ease-in-out": bezier(0.42, 0, 0.58, 1),
  // Measured: these two are the keywords that *do* normalise, and CSS says to
  // exactly these expansions.
  "step-start": { easing: Easing.STEPS, a: 1, b: StepPosition.JUMP_START, c: 0, d: 0 },
  "step-end": { easing: Easing.STEPS, a: 1, b: StepPosition.JUMP_END, c: 0, d: 0 },
};

/** CSS's initial `transition-timing-function` and `animation-timing-function`. */
export const EASE: Curve = EASING_KEYWORDS["ease"]!;

const STEP_POSITIONS: Record<string, number> = {
  end: StepPosition.JUMP_END,
  "jump-end": StepPosition.JUMP_END,
  start: StepPosition.JUMP_START,
  "jump-start": StepPosition.JUMP_START,
  "jump-both": StepPosition.JUMP_BOTH,
  "jump-none": StepPosition.JUMP_NONE,
};

/**
 * One easing function, or `null` when the value is not one.
 *
 * `null` rather than a throw for the same reason `parseTime` returns `NaN`: this is
 * asked of every token in an order-free shorthand.
 *
 * `linear()` — the multi-stop linear easing from Easing Functions 2 — is
 * deliberately not accepted. It is an arbitrary-length list of stops, which is a
 * side table rather than four control points, and taking the first two stops would
 * be a different curve wearing the same name.
 */
export function parseEasing(raw: string): Curve | null {
  const v = raw.trim().toLowerCase();
  const keyword = EASING_KEYWORDS[v];
  if (keyword) return keyword;

  const cubic = v.match(/^cubic-bezier\(([^)]*)\)$/);
  if (cubic) {
    const parts = splitTopLevelCommas(cubic[1]!).map((p) => Number(p.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [x1, y1, x2, y2] = parts as [number, number, number, number];
    // CSS requires both x coordinates in 0..1 — the curve has to be a function of
    // time — and rejects the declaration otherwise. `y` is unbounded, which is what
    // makes an overshooting "bounce" curve expressible.
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
    return bezier(x1, y1, x2, y2);
  }

  const steps = v.match(/^steps\(([^)]*)\)$/);
  if (steps) {
    const parts = splitTopLevelCommas(steps[1]!).map((p) => p.trim());
    const count = Number(parts[0]);
    if (!Number.isInteger(count) || count < 1) return null;
    const position = parts.length > 1 ? STEP_POSITIONS[parts[1]!] : StepPosition.JUMP_END;
    if (position === undefined) return null;
    // `jump-none` with one step has no output values at all, and CSS says the
    // declaration is invalid rather than the animation being a no-op.
    if (position === StepPosition.JUMP_NONE && count < 2) return null;
    return { easing: Easing.STEPS, a: count, b: position, c: 0, d: 0 };
  }

  return null;
}

/**
 * Which style fields each transitionable CSS property moves.
 *
 * The mapping exists separately from `expandDeclaration` because the two ask
 * opposite questions. The expander is given a property *and a value* and produces
 * numbers; `transition-property` names a property with no value at all, and what it
 * needs is the set of fields that property is spelt with. `transform` is nine
 * fields here and one `case` there.
 *
 * A property absent from this map cannot be transitioned, and the compiler
 * distinguishes two reasons why — see `maskFor`. Deliberately *not* including any
 * layout-affecting property: paint is the only stage that reads an interpolated
 * value, so `transition: width` would ease a colour while the geometry jumped.
 */
export const TRANSITIONABLE: Record<string, AnimatableField[]> = {
  color: ["fg"],
  "background-color": ["bg"],
  background: ["bg"],
  "border-color": ["borderColor"],
  "border-radius": ["radiusTopLeft", "radiusTopRight", "radiusBottomRight", "radiusBottomLeft"],
  "border-top-left-radius": ["radiusTopLeft"],
  "border-top-right-radius": ["radiusTopRight"],
  "border-bottom-right-radius": ["radiusBottomRight"],
  "border-bottom-left-radius": ["radiusBottomLeft"],
  opacity: ["opacity"],
  // The four ways CSS lets a transform be written, and they overlap on purpose:
  // `transition-transform` in Tailwind names `transform, translate, scale, rotate`
  // all four, and a node using the individual properties must transition too.
  transform: [
    "translateX",
    "translateY",
    "translatePercentX",
    "translatePercentY",
    "rotate",
    "scaleX",
    "scaleY",
    "skewX",
    "skewY",
  ],
  translate: ["translateX", "translateY", "translatePercentX", "translatePercentY"],
  rotate: ["rotate"],
  scale: ["scaleX", "scaleY"],
  "transform-origin": [
    "transformOriginPercentX",
    "transformOriginPercentY",
    "transformOriginX",
    "transformOriginY",
  ],
  "accent-color": ["accentColor"],
  "caret-color": ["caretColor"],
  "scrollbar-color": ["scrollbarThumb", "scrollbarTrack"],
};

/**
 * Properties dziri implements but cannot transition, so the refusal can name them.
 *
 * The distinction this draws is the whole reason it exists. `transition: width` is
 * a request dziri understands and declines — worth a warning, because the author
 * will otherwise watch a box jump and have nothing to read. `transition: filter` is
 * a property dziri does not have at all, and warning about it would print a line
 * for six of the twenty-two entries in Tailwind's default `transition` list on
 * every build, burying the one that matters.
 *
 * Derived from `LAYOUT_FIELDS` rather than listed, so a property that becomes
 * paint-only stops appearing here without anyone editing this.
 */
function refusedTransitionReason(prop: string): string | null {
  const fields = LAYOUT_TRANSITIONABLE[prop];
  if (fields === undefined) return null;
  return `it changes layout (${fields.join(", ")}), and only paint reads an interpolated value`;
}

/**
 * The layout-affecting properties worth naming in a refusal.
 *
 * Every entry maps to at least one field in `LAYOUT_FIELDS`, which is what makes
 * them refusable rather than merely unsupported.
 */
const LAYOUT_TRANSITIONABLE: Record<string, StyleField[]> = {
  width: ["width"],
  height: ["height"],
  "min-width": ["minW"],
  "min-height": ["minH"],
  "max-width": ["maxW"],
  "max-height": ["maxH"],
  padding: ["padT", "padR", "padB", "padL"],
  margin: ["marT", "marR", "marB", "marL"],
  "border-width": ["borderWidth"],
  "font-size": ["fontSize"],
  "font-weight": ["fontWeight"],
  gap: ["gapRow", "gapCol"],
  top: ["insetT"],
  right: ["insetR"],
  bottom: ["insetB"],
  left: ["insetL"],
  inset: ["insetT", "insetR", "insetB", "insetL"],
  "flex-grow": ["grow"],
  "flex-shrink": ["shrink"],
  "flex-basis": ["basis"],
};

/**
 * The mask of animatable fields a `transition-property` list asks for.
 *
 * Three outcomes per name, and keeping them apart is what makes the warnings
 * readable. A property in `TRANSITIONABLE` contributes its bits. A property dziri
 * implements but cannot interpolate is **named** in a warning, because the author
 * is about to watch a box jump and needs to know why. Anything else is dropped in
 * silence: Tailwind's default `.transition` names twenty-two properties and dziri
 * has six of them, so warning about the rest would print sixteen lines per build
 * and bury the one that matters.
 *
 * `all` is every animatable field, which is what it means once the properties dziri
 * does not have are taken out of the question.
 */
export function transitionMask(properties: readonly string[], warn: (m: string) => void): number {
  let mask = 0;

  for (const prop of properties) {
    if (prop === "all") {
      mask |= ANIM_ALL;
      continue;
    }
    const fields = TRANSITIONABLE[prop];
    if (fields) {
      for (const field of fields) {
        const bit = ANIM_BIT[field];
        // A field in `TRANSITIONABLE` that has no mask bit means the two lists have
        // drifted — the schema stopped marking it `interp` and this map did not
        // follow. Silence here would be a transition that compiles and never moves.
        if (bit === undefined) {
          throw new CssError(`"${prop}" maps to style field "${field}", which is not animatable`);
        }
        mask |= 1 << bit;
      }
      continue;
    }
    const refused = refusedTransitionReason(prop);
    if (refused) warn(`cannot transition "${prop}": ${refused}. It will change instantly.`);
  }

  return mask >>> 0;
}

/**
 * A transition, as one timing over a set of fields.
 *
 * `properties` holds the author's names rather than the resolved mask, so the
 * caller can warn about each one it drops with the word the author wrote.
 */
export type TransitionSpec = {
  /** Author-written property names, or `["all"]`. Empty means `none`. */
  properties: string[];
  /** Seconds. Zero means nothing animates, which is CSS's initial value. */
  duration: number;
  delay: number;
  easing: Curve;
};

export type AnimationSpec = {
  /** `@keyframes` name, or `""` for `none`. */
  name: string;
  duration: number;
  delay: number;
  /** `Infinity` for `infinite`. */
  iterations: number;
  easing: Curve;
  /** Kept so the compiler can refuse the values it does not implement, by name. */
  direction: string;
  fill: string;
};

const INITIAL_TRANSITION: TransitionSpec = {
  properties: ["all"],
  duration: 0,
  delay: 0,
  easing: EASE,
};

const ANIMATION_DIRECTIONS = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const ANIMATION_FILLS = new Set(["none", "forwards", "backwards", "both"]);
const ANIMATION_PLAY_STATES = new Set(["running", "paused"]);

/**
 * Folds the `transition*` declarations, in cascade order, into one spec.
 *
 * In *order*, which is what makes `transition: opacity 1s` followed by
 * `transition-duration: 300ms` come out at 300ms and the reverse come out at 1s.
 * The shorthand resets all four longhands, so it cannot simply be read first —
 * which is exactly the bug a "read the shorthand, then the longhands" version has,
 * and Tailwind's output triggers it: `.duration-150` sets `--tw-duration` *and*
 * `transition-duration`, and a `.transition` class may cascade either side of it.
 *
 * `null` when nothing here animates, which is the overwhelmingly common answer.
 */
export function transitionFrom(ordered: Array<[string, string]>): TransitionSpec | null {
  let spec: TransitionSpec | null = null;
  const own = () => (spec ??= { ...INITIAL_TRANSITION });

  for (const [prop, raw] of ordered) {
    const value = raw.trim();
    switch (prop) {
      case "transition": {
        const entries = splitTopLevelCommas(value).map((e) => e.trim()).filter(Boolean);
        if (entries.length === 0) break;
        const parsed = entries.map(parseTransitionEntry);
        const first = parsed[0]!;
        const s = own();
        s.duration = first.duration;
        s.delay = first.delay;
        s.easing = first.easing;
        s.properties = parsed.flatMap((p) => p.properties);
        // Measured: CSS really does give each entry its own timing —
        // `transition: opacity 1s, transform 2s` computes to `duration: [1s, 2s]`.
        // dziri carries one timing per node, so a list that asks for two is
        // approximated and said so. Tailwind never emits this shape.
        for (const p of parsed.slice(1)) {
          if (p.duration !== first.duration || p.delay !== first.delay) {
            warnOnce(
              `per-property transition timing is not supported ("${value}"); ` +
                `using ${first.duration}s/${first.delay}s for every property in the list`,
            );
            break;
          }
        }
        break;
      }
      case "transition-property": {
        const list = splitTopLevelCommas(value).map((p) => p.trim().toLowerCase()).filter(Boolean);
        own().properties = list.length === 1 && list[0] === "none" ? [] : list;
        break;
      }
      // Each of these is a *list* parallel to `transition-property`, and dziri
      // takes the first entry — the same one-timing-per-node limitation the
      // shorthand arm warns about, reached from the longhand side.
      case "transition-duration": {
        const t = parseTime(splitTopLevelCommas(value)[0] ?? "");
        if (Number.isFinite(t)) own().duration = t;
        break;
      }
      case "transition-delay": {
        const t = parseTime(splitTopLevelCommas(value)[0] ?? "");
        if (Number.isFinite(t)) own().delay = t;
        break;
      }
      case "transition-timing-function": {
        const curve = parseEasing(splitTopLevelCommas(value)[0] ?? "");
        if (curve) own().easing = curve;
        break;
      }
      // Parsed and ignored: `allow-discrete` only matters for properties dziri
      // refuses to transition anyway, so honouring it would change nothing.
      case "transition-behavior":
        break;
      default:
        break;
    }
  }

  return spec;
}

/** One entry of a `transition` shorthand — order-free, first time wins as duration. */
function parseTransitionEntry(entry: string): TransitionSpec {
  const out: TransitionSpec = { properties: [], duration: 0, delay: 0, easing: EASE };
  let times = 0;

  for (const token of splitTopLevel(entry)) {
    const lower = token.toLowerCase();
    const time = parseTime(token);
    if (Number.isFinite(time)) {
      if (times === 0) out.duration = time;
      else if (times === 1) out.delay = time;
      times++;
      continue;
    }
    const curve = parseEasing(token);
    if (curve) {
      out.easing = curve;
      continue;
    }
    if (lower === "normal" || lower === "allow-discrete") continue;
    if (lower === "none") continue;
    out.properties.push(lower);
  }

  // `transition: 1s` with no property named means `all`, which is the shorthand's
  // initial value for that longhand rather than "nothing".
  if (out.properties.length === 0 && times > 0) out.properties.push("all");
  return out;
}

/** Folds the `animation*` declarations, in cascade order, into one spec. */
export function animationFrom(ordered: Array<[string, string]>): AnimationSpec | null {
  let spec: AnimationSpec | null = null;
  const own = () =>
    (spec ??= {
      name: "",
      duration: 0,
      delay: 0,
      iterations: 1,
      easing: EASE,
      direction: "normal",
      fill: "none",
    });

  for (const [prop, raw] of ordered) {
    const value = raw.trim();
    switch (prop) {
      case "animation": {
        // A comma-separated list is several animations at once. dziri runs one per
        // node, so the first is taken and the rest named in a warning.
        const entries = splitTopLevelCommas(value).map((e) => e.trim()).filter(Boolean);
        if (entries.length === 0) break;
        if (entries.length > 1) {
          warnOnce(`only one animation per element is supported; ignoring all but "${entries[0]}"`);
        }
        const parsed = parseAnimationEntry(entries[0]!);
        const s = own();
        Object.assign(s, parsed);
        break;
      }
      case "animation-name": {
        const first = (splitTopLevelCommas(value)[0] ?? "").trim();
        own().name = first.toLowerCase() === "none" ? "" : first;
        break;
      }
      case "animation-duration": {
        const t = parseTime(splitTopLevelCommas(value)[0] ?? "");
        if (Number.isFinite(t)) own().duration = t;
        break;
      }
      case "animation-delay": {
        const t = parseTime(splitTopLevelCommas(value)[0] ?? "");
        if (Number.isFinite(t)) own().delay = t;
        break;
      }
      case "animation-timing-function": {
        const curve = parseEasing(splitTopLevelCommas(value)[0] ?? "");
        if (curve) own().easing = curve;
        break;
      }
      case "animation-iteration-count": {
        const first = (splitTopLevelCommas(value)[0] ?? "").trim().toLowerCase();
        if (first === "infinite") own().iterations = Infinity;
        else {
          const n = Number(first);
          if (Number.isFinite(n) && n >= 0) own().iterations = n;
        }
        break;
      }
      case "animation-direction":
        own().direction = (splitTopLevelCommas(value)[0] ?? "").trim().toLowerCase();
        break;
      case "animation-fill-mode":
        own().fill = (splitTopLevelCommas(value)[0] ?? "").trim().toLowerCase();
        break;
      default:
        break;
    }
  }

  return spec;
}

/**
 * One entry of an `animation` shorthand.
 *
 * Order-free, and the two ambiguities are resolved the way the grammar says.
 * A bare number is the **iteration count**, never a time — `animation: spin 2 1s`
 * runs twice for one second — which is why `parseTime` refuses a unitless value.
 * And a keyword that could be either a fill mode or the animation's name goes to
 * whichever longhand has not been filled yet, name last.
 */
function parseAnimationEntry(entry: string): AnimationSpec {
  const out: AnimationSpec = {
    name: "",
    duration: 0,
    delay: 0,
    iterations: 1,
    easing: EASE,
    direction: "normal",
    fill: "none",
  };
  let times = 0;
  let sawDirection = false;
  let sawFill = false;

  for (const token of splitTopLevel(entry)) {
    const lower = token.toLowerCase();

    const time = parseTime(token);
    if (Number.isFinite(time)) {
      if (times === 0) out.duration = time;
      else if (times === 1) out.delay = time;
      times++;
      continue;
    }

    if (lower === "infinite") {
      out.iterations = Infinity;
      continue;
    }
    const count = Number(lower);
    if (lower !== "" && Number.isFinite(count) && count >= 0) {
      out.iterations = count;
      continue;
    }

    const curve = parseEasing(token);
    if (curve) {
      out.easing = curve;
      continue;
    }

    if (!sawDirection && ANIMATION_DIRECTIONS.has(lower) && lower !== "normal") {
      out.direction = lower;
      sawDirection = true;
      continue;
    }
    if (!sawFill && ANIMATION_FILLS.has(lower) && lower !== "none") {
      out.fill = lower;
      sawFill = true;
      continue;
    }
    if (ANIMATION_PLAY_STATES.has(lower)) continue;
    if (lower === "normal" || lower === "none") continue;

    // Whatever is left is the name, and it keeps its case: a `@keyframes`
    // identifier is case-sensitive where a property name is not.
    if (out.name === "") out.name = token;
  }

  return out;
}

type Patch = Partial<Record<StyleField, number>>;
type LengthPct = { px: number; pct: number };

/** Adds one translation to whatever is already accumulated. */
function addTranslate(out: Patch, x: LengthPct, y: LengthPct): void {
  out.translateX = (out.translateX ?? 0) + x.px;
  out.translateY = (out.translateY ?? 0) + y.px;
  out.translatePctX = (out.translatePctX ?? 0) + x.pct;
  out.translatePctY = (out.translatePctY ?? 0) + y.pct;
}

/** A scale factor: a bare number, or a percentage of it. */
function scaleNumber(raw: string): number {
  const v = raw.trim();
  const n = v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v);
  if (!Number.isFinite(n)) throw new CssError(`bad scale factor "${raw}"`);
  return n;
}

/**
 * Where each transform function sits in the one order decomposed storage can
 * hold: translate, then rotate, then skew, then scale.
 *
 * A list that runs backwards through this is a different matrix — measured, and
 * not marginally: `rotate(90deg) translateX(100px)` puts the box 100px *below*
 * where `translateX(100px) rotate(90deg)` puts it. So it is refused rather than
 * reordered. Equal ranks are fine and compose, since two translations add and
 * two scales multiply however they are nested.
 */
const TRANSFORM_RANK: Record<string, number> = {
  translate: 0,
  translatex: 0,
  translatey: 0,
  rotate: 1,
  skew: 2,
  skewx: 2,
  skewy: 2,
  scale: 3,
  scalex: 3,
  scaley: 3,
};

/** Transform functions dziri refuses by name, and why each one. */
const TRANSFORM_REFUSED: Record<string, string> = {
  matrix:
    "a matrix would have to be decomposed back into components to be stored, and " +
    "the decomposition is lossy for exactly the cases transitions care about",
  matrix3d: "3D, and dziri is 2D",
  translate3d: "3D, and dziri is 2D",
  translatez: "3D, and dziri is 2D",
  scale3d: "3D, and dziri is 2D",
  scalez: "3D, and dziri is 2D",
  rotate3d: "3D, and dziri is 2D",
  rotatex: "3D, and dziri is 2D",
  rotatey: "3D, and dziri is 2D",
  rotatez: "a Z rotation is `rotate()` in 2D — use that",
  perspective: "3D, and dziri is 2D",
};

/**
 * One `transform` list, accumulated into the decomposed slots.
 *
 * The list is walked left to right and each function's rank must not go
 * backwards; see `TRANSFORM_RANK` for why that is a refusal rather than a
 * reordering.
 */
function applyTransformList(value: string, out: Patch): void {
  let rank = -1;

  for (const fn of splitTopLevel(value)) {
    const m = fn.match(/^([a-zA-Z0-9]+)\((.*)\)$/s);
    if (!m) {
      throw new CssError(
        `transform: "${fn}" is not a function call. The list is space-separated ` +
          `functions, as in "translateX(10px) rotate(45deg)".`,
      );
    }

    const name = m[1]!.toLowerCase();
    const args = splitTopLevelCommas(m[2]!).map((a) => a.trim()).filter((a) => a !== "");

    const why = TRANSFORM_REFUSED[name];
    if (why !== undefined) throw new CssError(`transform: ${name}() is not supported — ${why}.`);

    const r = TRANSFORM_RANK[name];
    if (r === undefined) throw new CssError(`transform: unknown function "${name}()"`);

    if (r < rank) {
      throw new CssError(
        `transform: "${value}" is not in an order dziri can store. Functions must run ` +
          `translate, rotate, skew, scale — "${name}()" comes after something that ` +
          `sorts later.\n` +
          `  This is a refusal rather than a reorder because the two are genuinely ` +
          `different matrices: rotate-then-translate moves the box along the *rotated* ` +
          `axis. Write the functions in canonical order, or pre-compose them yourself.`,
      );
    }
    rank = r;

    const need = (n: number) => {
      if (args.length < 1 || args.length > n) {
        throw new CssError(`transform: ${name}() takes 1 to ${n} arguments, got ${args.length}`);
      }
    };

    switch (name) {
      case "translate": {
        need(2);
        const x = lengthPercent(args[0]!);
        const y = args[1] === undefined ? { px: 0, pct: 0 } : lengthPercent(args[1]);
        addTranslate(out, x, y);
        break;
      }
      case "translatex":
        need(1);
        addTranslate(out, lengthPercent(args[0]!), { px: 0, pct: 0 });
        break;
      case "translatey":
        need(1);
        addTranslate(out, { px: 0, pct: 0 }, lengthPercent(args[0]!));
        break;

      case "rotate":
        need(1);
        out.rotate = (out.rotate ?? 0) + parseAngle(args[0]!);
        break;

      case "skew": {
        need(2);
        out.skewX = (out.skewX ?? 0) + parseAngle(args[0]!);
        // One argument means no Y skew at all, which is not the same as copying X.
        if (args[1] !== undefined) out.skewY = (out.skewY ?? 0) + parseAngle(args[1]);
        break;
      }
      case "skewx":
        need(1);
        out.skewX = (out.skewX ?? 0) + parseAngle(args[0]!);
        break;
      case "skewy":
        need(1);
        out.skewY = (out.skewY ?? 0) + parseAngle(args[0]!);
        break;

      case "scale": {
        need(2);
        const sx = scaleNumber(args[0]!);
        // Unlike translate and skew, one argument scales *both* axes.
        const sy = args[1] === undefined ? sx : scaleNumber(args[1]);
        out.scaleX = (out.scaleX ?? 1) * sx;
        out.scaleY = (out.scaleY ?? 1) * sy;
        break;
      }
      case "scalex":
        need(1);
        out.scaleX = (out.scaleX ?? 1) * scaleNumber(args[0]!);
        break;
      case "scaley":
        need(1);
        out.scaleY = (out.scaleY ?? 1) * scaleNumber(args[0]!);
        break;
    }
  }
}

/** `transform-origin` keywords, as the fraction of the box each names. */
const ORIGIN_KEYWORD: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
/** Which axis a keyword is allowed to name — `center` is either. */
const ORIGIN_AXIS: Record<string, "x" | "y" | "both"> = {
  left: "x",
  right: "x",
  top: "y",
  bottom: "y",
  center: "both",
};

/**
 * `transform-origin`, which is a small grammar with one real trap: the two
 * keyword forms may be written in **either** order, so `top left` and `left top`
 * are the same point, while two *lengths* are always x then y.
 */
function applyTransformOrigin(value: string, out: Patch): void {
  const parts = splitTopLevel(value);
  if (parts.length < 1 || parts.length > 3) {
    throw new CssError(`transform-origin takes 1 to 3 values, got "${value}"`);
  }
  if (parts.length === 3) {
    throw new CssError(
      `transform-origin: "${value}" — the third value is a Z origin and dziri is 2D.`,
    );
  }

  const CENTRE: LengthPct = { px: 0, pct: 0.5 };
  const axisOf = (s: string) => ORIGIN_AXIS[s.trim().toLowerCase()];
  const fracOf = (s: string): LengthPct => ({ px: 0, pct: ORIGIN_KEYWORD[s.trim().toLowerCase()]! });

  let x: LengthPct;
  let y: LengthPct;

  if (parts.length === 1) {
    const only = parts[0]!;
    const axis = axisOf(only);
    // A single value sets X and centres the other axis — except when the keyword
    // names the Y axis, where `transform-origin: top` means `center top`.
    if (axis === "y") {
      x = CENTRE;
      y = fracOf(only);
    } else {
      x = axis === undefined ? lengthPercent(only) : fracOf(only);
      y = CENTRE;
    }
  } else {
    const [a, b] = [parts[0]!, parts[1]!];
    const ka = axisOf(a);
    const kb = axisOf(b);

    if (ka !== undefined && kb !== undefined) {
      // Both keywords, and only then may they be written in either order —
      // `top left` is the same point as `left top`. Measured: both compute to
      // `0px 0px`.
      if (ka !== "both" && kb !== "both" && ka === kb) {
        throw new CssError(`transform-origin: "${value}" names the ${ka.toUpperCase()} axis twice`);
      }
      // The one that names an axis claims it; `center` takes whatever is left.
      const xWord = ka === "x" ? a : kb === "x" ? b : ka === "both" ? a : b;
      const yWord = ka === "y" ? a : kb === "y" ? b : ka === "both" ? b : a;
      x = fracOf(xWord);
      y = fracOf(yWord);
    } else {
      // Anything else is positional: first is X, second is Y. A Y-only keyword in
      // the X slot is invalid CSS rather than a swap, because the reordered form
      // requires *both* components to be keywords.
      if (ka === "y") {
        throw new CssError(
          `transform-origin: "${value}" — "${a.trim()}" names the Y axis but sits in the ` +
            `X position. The two may only be swapped when both are keywords.`,
        );
      }
      if (kb === "x") {
        throw new CssError(
          `transform-origin: "${value}" — "${b.trim()}" names the X axis but sits in the ` +
            `Y position. The two may only be swapped when both are keywords.`,
        );
      }
      x = ka === undefined ? lengthPercent(a) : fracOf(a);
      y = kb === undefined ? lengthPercent(b) : fracOf(b);
    }
  }

  out.originPxX = x.px;
  out.originPxY = y.px;
  out.originPctX = x.pct;
  out.originPctY = y.pct;
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
    /**
     * `border-radius: <all> | <tl-br> <tr-bl> | <tl> <tr-bl> <br> | <tl> <tr> <br> <bl>`
     *
     * The same one/two/three/four expansion `padding` and `margin` use, and for the
     * same reason: it is what CSS says, and guessing "the first value wins" made
     * `border-radius: 8px 0 0 8px` a fully rounded box.
     *
     * The elliptical form — `border-radius: 10px / 20px` — is not supported. Two
     * radii per corner would double the fields for a value almost nobody writes,
     * and the `/` is refused rather than half-read: taking the part before it would
     * silently make an ellipse a circle.
     */
    case "border-radius": {
      if (value.includes("/")) {
        throw new CssError(`elliptical border-radius is not supported ("${value}")`);
      }
      const parts = splitTopLevel(value).map(parseLength);
      const [a, b = a, c = a, d = b] = parts as [number, number?, number?, number?];
      out.radTL = a!;
      out.radTR = b!;
      out.radBR = c!;
      out.radBL = d!;
      return;
    }

    case "border-top-left-radius":
      out.radTL = parseLength(splitTopLevel(value)[0]!);
      return;
    case "border-top-right-radius":
      out.radTR = parseLength(splitTopLevel(value)[0]!);
      return;
    case "border-bottom-right-radius":
      out.radBR = parseLength(splitTopLevel(value)[0]!);
      return;
    case "border-bottom-left-radius":
      out.radBL = parseLength(splitTopLevel(value)[0]!);
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

    // The form-control properties. Three of the five ROADMAP C2 lists; `resize`
    // and `field-sizing: content` are committed non-goals there and are refused
    // by the `default` arm below like any other unsupported property.
    //
    // Both colours take `auto | <color>`, and `auto` is alpha 0 — the same
    // "nothing was said here" sentinel `border-color` and `scrollbar-color` use.
    // Spelling it as a value rather than a flag is what keeps these ordinary
    // interned fields: the cascade, the variant runs and the patch machinery all
    // work on numbers and never learn that this one has a keyword.
    case "accent-color":
      out.accentColor = value.toLowerCase() === "auto" ? 0x00000000 : parseColor(value);
      return;
    case "caret-color":
      out.caretColor = value.toLowerCase() === "auto" ? 0x00000000 : parseColor(value);
      return;

    // `appearance`, whose grammar was measured rather than remembered — and which
    // an earlier pass here got wrong from memory in both directions.
    //
    // `<compat-auto>` is **accepted and folded to `auto`**, because that is what
    // the spec says those keywords do: "the values all behave as `auto`". Refusing
    // them was the earlier mistake. dziri's field stores the *effect*, so nine
    // more enum variants that all mean AUTO would be nine values nothing reads.
    // The cost is a representation divergence — Chrome's computed value is
    // as-specified, so it reports `button` where dziri reports `auto` — and that
    // is recorded as `conformance`'s KNOWN entry rather than hidden.
    //
    // The list is `mdn-data`'s, not the prose's. MDN's `appearance` page also
    // lists `push-button`, `square-button` and `slider-horizontal`, and Chromium
    // 151 rejects all three — the same way its scrollbars guide invented
    // `scrollbar-width: thick`. See BROWSER-FACTS.md.
    //
    // Written as ifs rather than a nested switch so that `css-coverage`, which
    // reads this function's `case` labels to find out what dziri parses, does not
    // count `none` and `auto` as CSS properties.
    case "appearance": {
      const keyword = value.toLowerCase();
      if (keyword === "none") {
        out.appearance = Appearance.NONE;
        return;
      }
      if (keyword === "auto" || COMPAT_AUTO.has(keyword)) {
        out.appearance = Appearance.AUTO;
        return;
      }
      // The opt-in that makes a `<select>` and its `::picker(select)` fully
      // styleable, and the reason this property is worth having at all: it is how
      // an author says "stop drawing the platform control, I am styling the
      // parts". Measured as shipping in Chromium 151, on any element.
      if (keyword === "base-select") {
        out.appearance = Appearance.BASE_SELECT;
        return;
      }
      throw new CssError(
        `appearance: "${value}" is not a value dziri accepts.\n` +
          `  Supported: none, auto, base-select, and the <compat-auto> keywords ` +
          `(${[...COMPAT_AUTO].join(", ")}), which fold to auto.\n` +
          `  Refused: base (specified, but no browser implements it — Chromium 151 ` +
          `drops the declaration); textfield and menulist-button (real distinct ` +
          `effects on input types and on a select's picker, and dziri has neither yet).`,
      );
    }

    // Opacity, and the one transform-adjacent property that is just a number.
    // Clamped rather than refused out of range: CSS says `opacity` clamps to
    // 0..1, and `opacity: 1.5` is a legal declaration meaning fully opaque.
    case "opacity": {
      const v = value.trim();
      // A percentage is legal here and means what it says — `opacity: 50%`.
      const n = v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v);
      if (!Number.isFinite(n)) throw new CssError(`bad opacity "${value}"`);
      out.opacity = Math.min(1, Math.max(0, n));
      return;
    }

    // The three individual transform properties, then the `transform` list.
    //
    // All four **accumulate** into the same decomposed slots rather than
    // overwriting, because CSS composes them: measured, the order is `translate`,
    // `rotate`, `scale`, then `transform`, and it is that order regardless of
    // which was written first in the stylesheet. Accumulation is safe here
    // because the caller applies each property exactly once per element — the
    // cascade has already picked one winning declaration per property, and the
    // patch object it accumulates into starts empty.
    //
    // Composition is by the operation each component takes: translations and
    // angles add, scales multiply.
    case "translate": {
      // `translate: none` is the initial value and contributes nothing.
      if (value.trim().toLowerCase() === "none") return;
      const parts = splitTopLevel(value);
      if (parts.length < 1 || parts.length > 3) {
        throw new CssError(`translate takes 1 to 3 values, got "${value}"`);
      }
      if (parts.length === 3) {
        throw new CssError(
          `translate: "${value}" — the third value is a Z translation, and dziri ` +
            `has no 3D transforms. Drop it.`,
        );
      }
      const x = lengthPercent(parts[0]!);
      // One value means the Y translation is zero, not the same as X.
      const y = parts[1] === undefined ? { px: 0, pct: 0 } : lengthPercent(parts[1]);
      addTranslate(out, x, y);
      return;
    }

    case "rotate": {
      const v = value.trim().toLowerCase();
      if (v === "none") return;
      // The axis forms — `rotate: x 45deg`, `rotate: 1 0 0 45deg` — are 3D.
      if (splitTopLevel(v).length > 1) {
        throw new CssError(
          `rotate: "${value}" — the axis forms are 3D rotations and dziri is 2D. ` +
            `Only a bare angle is supported.`,
        );
      }
      out.rotate = (out.rotate ?? 0) + parseAngle(v);
      return;
    }

    case "scale": {
      const v = value.trim().toLowerCase();
      if (v === "none") return;
      const parts = splitTopLevel(v);
      if (parts.length > 2) {
        throw new CssError(
          `scale: "${value}" — a third value is a Z scale and dziri is 2D.`,
        );
      }
      const sx = scaleNumber(parts[0]!);
      // One value scales both axes, unlike `translate` where it means "and zero".
      const sy = parts[1] === undefined ? sx : scaleNumber(parts[1]);
      out.scaleX = (out.scaleX ?? 1) * sx;
      out.scaleY = (out.scaleY ?? 1) * sy;
      return;
    }

    case "transform":
      if (value.trim().toLowerCase() === "none") return;
      applyTransformList(value, out);
      return;

    // `transform-origin` replaces rather than accumulates — it is one property
    // with one value, and nothing else writes these slots.
    case "transform-origin":
      applyTransformOrigin(value, out);
      return;

    // Handled by the caller, like `display`, and for a stronger reason: its value
    // is a *string*, and every style field is a number. It never reaches the style
    // table at all — the compiler turns it into an emitted TEXT node.
    case "content":
      return;

    case "display":
      return; // handled by the caller

    /**
     * Transitions and animations, also handled by the caller — and here for the
     * same reason `display` is: so this switch stays the one honest answer to "which
     * CSS properties does dziri support", which is what `css-coverage` and
     * `tailwind-coverage` read it as.
     *
     * They cannot be expanded here because neither is a value. `transition-property`
     * is a comma-separated *list* where every style field is one number, and the
     * timing has to be resolved as a unit across six declarations and then
     * interned — so the answer is an index into a side table, which this function
     * has no way to mint. `animation` is worse: it names a `@keyframes` block, whose
     * style rows are the *element's own computed style* with the keyframe's
     * declarations over it, and that is not knowable until the cascade has finished.
     *
     * So `resolveTiming` in the compiler does both, from the merged declaration map
     * where the whole set is visible at once. See `applyDecls`.
     */
    case "transition":
    case "transition-property":
    case "transition-duration":
    case "transition-delay":
    case "transition-timing-function":
    case "transition-behavior":
    case "animation":
    case "animation-name":
    case "animation-duration":
    case "animation-delay":
    case "animation-timing-function":
    case "animation-iteration-count":
    case "animation-direction":
    case "animation-fill-mode":
    case "animation-play-state":
      return;

    default:
      warnOnce(`ignoring unsupported property "${prop}"`);
  }
}

/**
 * `content`, reduced to the text a generated box should hold, or `null` for
 * "no box".
 *
 * `null` is not an error case: CSS says a `::before` whose `content` is absent,
 * invalid, `normal` or `none` **is not rendered at all** — it behaves as
 * `display: none`. So this returning `null` is the ordinary way a pseudo-element
 * rule that exists for its other declarations produces nothing.
 *
 * The supported grammar is a sequence of strings, which is the whole of
 * `<content-list>` that a UA control stylesheet needs: `content: "✓"` is a
 * checkmark and `content: "«" "\A0"` is a quote and a space. Everything else in
 * the real grammar — `counter()`, `attr()`, `url()`, images, and the `/ <string>`
 * alt-text arm — is refused rather than dropped, because each is a *different
 * feature* (counters need tree state, `attr()` needs attributes in the IR, images
 * need A5) and silently rendering nothing for them would look like a bug in the
 * stylesheet.
 */
export function parseContent(raw: string): string | null {
  const value = raw.trim();
  const keyword = value.toLowerCase();
  if (keyword === "none" || keyword === "normal") return null;

  let out = "";
  let i = 0;
  while (i < value.length) {
    if (/\s/.test(value[i]!)) {
      i++;
      continue;
    }
    const quote = value[i];
    if (quote !== '"' && quote !== "'") {
      throw new CssError(
        `content: "${value}" — only strings, none and normal are supported. ` +
          `counter(), attr(), url(), images and the "/ alt-text" arm each need a ` +
          `feature dziri does not have, so they are refused rather than dropped.`,
      );
    }

    i++;
    let text = "";
    let closed = false;
    while (i < value.length) {
      const ch = value[i]!;
      if (ch === "\\") {
        // A CSS escape is either a hex code point (1-6 digits, one optional
        // trailing space that is part of the escape and not content) or a single
        // escaped character. `content: "\201C"` is how a stylesheet writes a
        // curly quote without relying on the file's encoding.
        const hex = /^\\([0-9a-fA-F]{1,6})[ ]?/.exec(value.slice(i));
        if (hex) {
          text += String.fromCodePoint(parseInt(hex[1]!, 16));
          i += hex[0]!.length;
          continue;
        }
        text += value[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) {
        closed = true;
        i++;
        break;
      }
      text += ch;
      i++;
    }
    if (!closed) throw new CssError(`content: unterminated string in "${value}"`);
    out += text;
  }

  return out;
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

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`  warn: ${message}`);
}
