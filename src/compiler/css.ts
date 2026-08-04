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
import { AUTO, Easing, StepPosition, type StyleField } from "../ir.ts";
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

/**
 * How a compound relates to the compound on its left.
 *
 * Only these two, and the omission is deliberate rather than pending: a
 * descendant or child test is answered by walking the ancestor path the compiler
 * already carries, while `+` and `~` need the subject's *siblings*, which is a
 * different question and a different shape of matcher. Tailwind v4 stopped
 * needing them — `space-y-*` was `> * + *` in v3 and is `> :not(:last-child)`
 * now — so the ones left out no longer cost coverage.
 */
export type Combinator = "descendant" | "child";

/**
 * A pseudo-class about an element's position among its siblings.
 *
 * These are a *third* axis, separate from both {@link Pseudo} and
 * {@link PseudoElement}, and separating them is the whole point. `:hover` is a
 * runtime fact, so it compiles to a style variant and a predicate bit;
 * `:last-child` is a fact about the tree, which the compiler is holding in its
 * hand — so it resolves during matching and costs the runtime nothing at all.
 * Folding them together would have made a free question pay a per-frame price.
 *
 * `:nth-child()` is not here. It is the same kind of question and would resolve
 * the same way, but it needs an An+B parser and nothing in Tailwind's output asks
 * for it, so it is refused by name rather than half-implemented.
 */
export type Structural = "first-child" | "last-child" | "only-child";

const SUPPORTED_STRUCTURAL = new Set<string>(["first-child", "last-child", "only-child"]);

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
  /**
   * How this compound relates to the one before it. Absent on the first, which
   * has nothing to its left.
   */
  combinator?: Combinator;
  /** `:first-child` and friends. Several may sit on one compound. */
  structural?: Structural[];
  /**
   * `:is()` and `:where()` — one entry per functional pseudo-class written on this
   * compound, each holding that one's argument list.
   *
   * Nested as a list of lists because the two levels mean different things: within
   * one `:is()` the arguments are alternatives, but two `:is()` on the same
   * compound both have to hold. Flattening them would turn a conjunction into a
   * disjunction and quietly widen the selector.
   */
  anyOf?: Selector[][];
  /**
   * `:not()` arguments, flattened across every `:not()` on the compound.
   *
   * Flat where {@link anyOf} is nested, because negation distributes: `:not(a, b)`
   * and `:not(a):not(b)` both mean "neither", so there is nothing for a second
   * level to record.
   */
  noneOf?: Selector[];
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

    // Split on the list's *top-level* commas, which is not the same as splitting
    // on commas: `:is(h1, h2) .x` is one selector, and cutting it at the comma
    // hands the parser an unterminated `:is(h1` that it blames on the author.
    const selectors: Selector[] = [];
    for (const part of splitSelectorList(prelude)) {
      selectors.push(parseSelector(part.text, preludeAt + part.offset));
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

/** One compound of a complex selector, with the combinator that introduced it. */
type SelectorPart = {
  text: string;
  /** How it relates to the part before it; meaningless on the first. */
  combinator: Combinator;
  /** Offset of the compound's first character within the selector. */
  offset: number;
};

/**
 * Splits a complex selector into compounds, recording each one's combinator.
 *
 * `src.split(/\s+/)` was right until attribute selectors existed and is wrong
 * now: `[title="a b"]` and `[type = checkbox]` both contain spaces that are not
 * combinators, and splitting on them turns one compound into two that match
 * nothing. So whitespace only separates when it is outside brackets, outside
 * parentheses and outside a string — the same reason `splitTopLevel` exists for
 * parenthesised values.
 *
 * Parens joined brackets on that list when functional pseudo-classes arrived:
 * `:where(.a > .b)` holds a space *and* a combinator that belong to the argument,
 * and splitting on either of them cuts the pseudo-class in half.
 *
 * `+` and `~` are refused here rather than by a scan over the whole selector.
 * That scan could not tell the `~` in `[data-tags~="beta"]` from a sibling
 * combinator without blanking the brackets out first — and once combinators are
 * split for real, the depth counter answers the same question for free.
 */
function splitCompounds(src: string, at: number): SelectorPart[] {
  const out: SelectorPart[] = [];
  let current = "";
  let start = 0;
  let pending: Combinator = "descendant";
  let depth = 0;
  let quote: string | null = null;

  const flush = () => {
    if (current === "") return;
    out.push({ text: current, combinator: pending, offset: start });
    current = "";
    pending = "descendant";
  };

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
    // like an unterminated attribute selector. `space-y-(--gap)` is the same
    // hazard one character over: it is the class `.space-y-\(--gap\)`, whose
    // parens must not open a functional pseudo-class.
    if (ch === "\\") {
      if (current === "") start = i;
      current += ch + (src[i + 1] ?? "");
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);

    if (depth === 0) {
      if (/\s/.test(ch)) {
        flush();
        continue;
      }
      if (ch === ">") {
        flush();
        pending = "child";
        continue;
      }
      if (ch === "+" || ch === "~") {
        throw new CssError(
          `the "${ch}" sibling combinator is not supported, in "${src}".\n` +
            `  Descendant (" ") and child (">") are. A sibling combinator asks about\n` +
            `  the subject's siblings rather than its ancestors, which is a different\n` +
            `  matcher; Tailwind v4 no longer needs one.`,
          at,
        );
      }
    }

    if (current === "") start = i;
    current += ch;
  }

  flush();

  // A trailing combinator has nothing to its right. Caught here because the
  // alternative is a selector list one compound short that matches the wrong
  // element: `.a > ` would compile to plain `.a`.
  if (pending === "child" && out.length > 0) {
    throw new CssError(`selector "${src}" ends in a ">" with nothing after it`, at);
  }

  return out;
}

/** One `:name(…)` written on a compound, with its argument text unparsed. */
type FuncPseudo = { name: string; args: string; doubled: boolean; offset: number };

/** The head of a functional pseudo-class: `:not(`, `::picker(`. */
const FUNC_PSEUDO_HEAD = /^(::?)([A-Za-z][A-Za-z0-9-]*)\(/;

/**
 * Pulls every `:name(…)` out of one compound, returning the rest for tokenizing.
 *
 * Extracted before the attribute tests, not after, because an argument may hold
 * one: `:not([hidden])` is a single functional pseudo-class, and lifting the
 * `[hidden]` out first would leave `:not()` with an empty argument list and
 * silently turn "not hidden" into "not nothing" — a selector that matches
 * everything instead of almost everything.
 *
 * Scanned rather than matched with a regex for the same reason `extractAttrs` is:
 * the argument nests. `:not(:is(.a, .b))` has two closing parens and only the
 * second ends the outer call.
 */
function extractFuncPseudos(part: string, at: number): { rest: string; funcs: FuncPseudo[] } {
  const funcs: FuncPseudo[] = [];
  let rest = "";

  for (let i = 0; i < part.length; i++) {
    // An escaped colon or paren is an ident character, not syntax. Tailwind writes
    // the class `space-y-(--gap)` as `.space-y-\(--gap\)` and the variant
    // `md:flex` as `.md\:flex`, so without this a theme-variable utility reads as
    // an unterminated functional pseudo-class and every variant loses its colon.
    if (part[i] === "\\") {
      rest += part[i]! + (part[i + 1] ?? "");
      i++;
      continue;
    }

    const head = part[i] === ":" ? FUNC_PSEUDO_HEAD.exec(part.slice(i)) : null;
    if (head === null) {
      rest += part[i];
      continue;
    }

    const offset = at < 0 ? -1 : at + i;
    const open = i + head[0].length - 1;
    const close = matchingParen(part, open);
    if (close === -1) {
      throw new CssError(`unterminated ":${head[2]}(" in "${part}"`, offset);
    }

    funcs.push({
      name: head[2]!.toLowerCase(),
      args: part.slice(open + 1, close),
      doubled: head[1] === "::",
      offset,
    });
    i = close;
  }

  return { rest, funcs };
}

/**
 * The index of the `)` closing the `(` at `open`, or -1.
 *
 * Quote- and escape-aware, so `:not([title="a)b"])` and `.w-\(x\)` inside an
 * argument both end where they actually end.
 */
function matchingParen(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Splits a selector list on its top-level commas.
 *
 * `src.split(",")` is what the rule prelude used to do, and it was correct only
 * for as long as no selector could contain a comma. `:is(h1, h2) .x` is one
 * selector, and splitting it naively produces `:is(h1` — an unterminated
 * functional pseudo-class blamed on an author who wrote valid CSS.
 */
export function splitSelectorList(src: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  const push = (end: number) => {
    const raw = src.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    out.push({ text: raw.trim(), offset: start + lead });
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(src.length);

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

/**
 * How a selector is being parsed: as a rule's own selector, or as the argument of
 * an `:is()` / `:where()` / `:not()`.
 *
 * The distinction exists because two of `Selector`'s fields are not about matching
 * at all. `pseudo` says which style *variant* a rule belongs to and `element` says
 * which cascade it is in, and both are properties of the rule — so an argument
 * that carried one would have nowhere to put it. Rather than drop it and match a
 * wider selector than was written, an argument in that position is refused.
 */
type SelectorRole = "rule" | "argument";

export function parseSelector(src: string, at = -1): Selector {
  return parseSelectorIn(src, at, "rule");
}

function parseSelectorIn(src: string, at: number, role: SelectorRole): Selector {
  if (!src) throw new CssError("empty selector", at);

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

  const parts = splitCompounds(src, at);
  if (parts.length === 0) throw new CssError(`empty selector "${src}"`, at);

  for (let p = 0; p < parts.length; p++) {
    const whole = parts[p]!.text;
    // Where this compound starts in the source, so the caret lands on the
    // offending compound rather than on the whole selector.
    const partAt = at < 0 ? -1 : at + parts[p]!.offset;
    const compound: Compound = { tag: null, id: null, classes: [] };
    if (p > 0 && parts[p]!.combinator === "child") compound.combinator = "child";

    // Functional pseudo-classes come out first, then attribute tests, then the
    // rest is tokenized.
    //
    // The order is forced: `:not([hidden])` holds an attribute test that belongs
    // to the argument, so lifting attributes first would leave `:not()` selecting
    // everything. And both have to come out before tokenizing at all, because
    // `(`, `)`, `[` and `]` are not ident characters — leaving either in fails the
    // coverage check below and refuses the whole selector, which is exactly what
    // `input[type=checkbox]` used to do.
    const { rest: afterFuncs, funcs } = extractFuncPseudos(whole, partAt);
    const { rest: part, attrs } = extractAttrs(afterFuncs, partAt);
    if (attrs.length) {
      compound.attrs = attrs;
      // An attribute selector weighs the same as a class, per the spec.
      spec[1] += attrs.length;
    }

    for (const func of funcs) applyFuncPseudo(compound, func, spec, src);

    // `[type=checkbox]` and `:not(:last-child)` are each a whole compound; there
    // is nothing left to tokenize and both are legal CSS, not a parse failure.
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
          if (role === "argument") {
            throw new CssError(
              `"::${name}" cannot be used inside :is(), :where() or :not() — a\n` +
                `  pseudo-element names which cascade the rule is in, which is a property\n` +
                `  of the rule and not of one compound.`,
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

        // A structural pseudo-class is a question about the tree, so it is
        // answered here at match time rather than compiled into a variant, and it
        // is allowed on *any* compound rather than only on the subject. Both
        // follow from the same fact: `.a:last-child .b` needs no runtime support,
        // because the compiler can see whether `.a` was the last child.
        if (SUPPORTED_STRUCTURAL.has(name)) {
          (compound.structural ??= []).push(name as Structural);
          spec[1]++;
          continue;
        }

        if (!SUPPORTED_PSEUDO.has(name)) {
          // `:focus-within` is deliberately absent: it propagates to ancestors,
          // which is the descendant-selector problem again.
          throw new CssError(
            `unsupported pseudo-class ":${name}".\n` +
              `  Supported: :hover, :active, :focus, :checked, :disabled, :root,\n` +
              `  :first-child, :last-child, :only-child, :is(), :where(), :not().`,
            partAt,
          );
        }
        // An interaction pseudo-class inside `:is()`/`:not()` has nowhere to go —
        // it names a style *variant*, which is a property of the rule and not of
        // one compound. See `SelectorRole`.
        if (role === "argument") {
          throw new CssError(
            `":${name}" cannot be used inside :is(), :where() or :not().\n` +
              `  It selects an interaction state, which dziri compiles into a style\n` +
              `  variant for the whole rule — so there is no way to make it hold for\n` +
              `  only part of a selector. Write it on the rule instead.`,
            partAt,
          );
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

/**
 * Folds one `:is()` / `:where()` / `:not()` into the compound it was written on.
 *
 * All three are the same mechanism — "does this element, as the subject, match one
 * of these selectors?" — differing only in whether the answer is negated and in
 * what it contributes to specificity. Which is why they share a representation
 * rather than getting a flag each: the matcher has one recursive case to handle,
 * and the three spellings are all reachable through it.
 */
function applyFuncPseudo(
  compound: Compound,
  func: FuncPseudo,
  spec: [number, number, number],
  src: string,
): void {
  if (func.doubled) {
    throw new CssError(
      `unsupported pseudo-element "::${func.name}()".\n` +
        `  Supported: ::before, ::after.\n` +
        `  The control-specific ones (::picker(select), ::picker-icon) are the same ` +
        `machinery and land with the controls they belong to.`,
      func.offset,
    );
  }

  if (func.name !== "is" && func.name !== "where" && func.name !== "not") {
    // `:nth-child()` and `:nth-of-type()` are the ones worth naming: they are the
    // same *kind* of question as `:first-child`, resolvable straight off the tree,
    // and they are missing only because nothing in reach writes them. Saying so
    // beats "unsupported pseudo-class", which reads as "and never will be".
    const note = /^nth-|-of-type$/.test(func.name)
      ? `\n  :first-child, :last-child and :only-child are supported; the An+B and ` +
        `of-type\n  forms are not yet.`
      : "";
    throw new CssError(`unsupported functional pseudo-class ":${func.name}()"${note}`, func.offset);
  }

  const args = splitSelectorList(func.args);
  if (args.length === 1 && args[0]!.text === "") {
    // `:not()` with nothing in it. Empty is legal in Selectors 4 and means "match
    // nothing to negate", so `:not()` matches everything and `:is()` matches
    // nothing — a distinction subtle enough that writing one is almost certainly a
    // mistake, and a silently-everything selector is the expensive kind.
    throw new CssError(`":${func.name}()" has no arguments, in "${src}"`, func.offset);
  }

  const parsed = args.map((arg) =>
    parseSelectorIn(arg.text, func.offset < 0 ? -1 : func.offset + arg.offset, "argument"),
  );

  if (func.name === "not") {
    (compound.noneOf ??= []).push(...parsed);
  } else {
    (compound.anyOf ??= []).push(parsed);
  }

  // `:where()` contributes nothing, which is its entire reason for existing.
  // `:is()` and `:not()` take the specificity of their most specific argument —
  // the *argument's*, not one class each, which is why this adds a whole triple
  // rather than bumping the class column.
  if (func.name === "where") return;
  const most = mostSpecific(parsed);
  for (let k = 0; k < 3; k++) spec[k] = spec[k]! + most[k]!;
}

/** The largest of several selectors' specificities, compared column by column. */
function mostSpecific(sels: Selector[]): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0];
  for (const sel of sels) {
    for (let k = 0; k < 3; k++) {
      if (sel.specificity[k] === best[k]) continue;
      if (sel.specificity[k]! > best[k]!) best = sel.specificity;
      break;
    }
  }
  return best;
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
export function splitTopLevelCommas(value: string): string[] {
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

/**
 * The environment at the root, before any `--*` declaration has been seen.
 *
 * Here rather than in a compiler module because both of them want it — the cascade
 * takes it as a default and the tree walk passes it as the root's parent environment
 * — and a shared empty value belongs beside the type it is an instance of rather than
 * in whichever caller happened to need it first.
 */
export const EMPTY_VARS: VarEnv = new Map<string, string>();

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
export function lengthPercent(raw: string): { px: number; pct: number } {
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
