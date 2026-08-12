/**
 * CSS syntax in, rules and selectors out.
 *
 * Hand-written rather than pulled from a library because the interesting part —
 * specificity, cascade, inheritance, computed values — has to be written either
 * way, and the tokenizer for this subset is short. Swappable for css-tree if the
 * subset grows; it is a compile-time dependency either way and never ships to
 * the runtime.
 *
 * Supported selectors: type, `.class`, `#id`, the descendant and child combinators,
 * attribute tests, `:is()` / `:where()` / `:not()`, the structural pseudo-classes,
 * `::before` / `::after`, and the `:hover` / `:active` / `:focus` / `:checked` /
 * `:disabled` pseudo-classes (which become precompiled variants).
 *
 * What a declaration's right-hand side *means* is `values.ts`, and the dependency runs
 * that way only: a media query's threshold needs `parseLength`, while nothing in the
 * value grammar needs to know what a selector is. Which property names exist at all is
 * `properties.ts`, further down again.
 */
import { CssError, warnOnce } from "./diagnostics.ts";
import { parseLength, type RegisteredProperty } from "./values.ts";

export type Pseudo =
  | "none"
  | "hover"
  | "active"
  | "focus"
  | "focus-visible"
  | "checked"
  | "disabled"
  | "open"
  | "invalid";

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
 *
 * `:open` is the newest, and it is closer to `:hover` than to `:checked`: the engine
 * opened the picker, so the engine already knows. What makes it worth a bit of its own
 * rather than a node flag is that the UA sheet's own visibility rule is written with it —
 * `select::picker(select)` is hidden at rest and shown `:open` — so an author reading
 * `:open` reads exactly the condition the picker itself is drawn by.
 *
 * `:closed` is its complement and is absent for the reason `:indeterminate` is not quite:
 * it would match every non-popover element in the document, which is not a variant worth
 * compiling. Write the base rule instead.
 */
const SUPPORTED_PSEUDO = new Set<string>([
  "hover",
  "active",
  "focus",
  "focus-visible",
  "checked",
  "disabled",
  "open",
  /**
   * `:invalid` — the first predicate whose answer comes from *app code* rather than from
   * the engine's own input state. A schema runs, `applyIssues` writes a control flag, and
   * the engine reads it back on the next rescan exactly as it reads `disabled`.
   *
   * `:user-invalid` is deliberately not a second spelling. It differs from `:invalid` only
   * in *when* a browser lets it match, and that timing is already decided here by
   * `validateOn` plus the pristine-field gate — so two names would put one rule in two
   * places.
   */
  "invalid",
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
/**
 * `::placeholder` is here rather than with the other control pseudo-elements because
 * it needs nothing they need. A picker wants an overlay layer and a checkmark wants a
 * control that can be in that state; a placeholder is a box holding text the markup
 * already carries, which is exactly what `::before` is.
 *
 * The one thing it has that `::before` does not is a *condition*: it shows only while
 * the field is empty. That is engine-owned — the emptiness of a value nobody declared —
 * so it is a node flag and a paint branch, not a variant. See `NodeFlags.PLACEHOLDER`.
 */
/**
 * `::selection` is the odd one out: it is **not a box**, and so not a node.
 *
 * The other three occupy space, which is why each becomes an emitted node Taffy lays out.
 * A selection is a range of characters inside a node that already exists — it has nowhere
 * to put a row and nothing to lay out — so its cascade is resolved for two properties only,
 * `background-color` and `color`, and those land on the *originating element's* style row as
 * `selectionBg` / `selectionFg`. See `compile.ts::selectionColors`.
 *
 * A consequence worth stating: everything else in a `::selection` rule is ignored, because
 * there is no box for a padding or a border to apply to. That is also what CSS says — the
 * highlight pseudo-elements accept a short list of properties and nothing else.
 */
/**
 * `::picker(select)` is the first *functional* pseudo-element, and the only spelling.
 *
 * The argument is not decoration and is not optional: the spec defines
 * `::picker(<ident>)` so that a future control can name a picker of its own, and
 * `select` is the one identifier defined today. Accepting a bare `::picker` would invent
 * a shorthand no browser has, which is the kind of divergence that only surfaces when
 * someone copies a stylesheet out of dziri and into a page.
 *
 * Unlike the other four, this one is a **box that contains authored children** rather
 * than a box holding text the compiler supplies. That is what makes it an overlay: the
 * options are laid out inside it, it hangs below its select, and it is painted after the
 * tree. See `compile.ts::walkPicker` and `NodeFlags.OVERLAY`.
 *
 * What it does *not* do is change what the options' own selectors see. `select > option`
 * still matches, because the picker is spliced in at the *node* level and the ancestor
 * path the matcher walks still ends at the select — a browser's picker is a pseudo-element
 * the light-DOM options render into, not a wrapper they become children of, and this keeps
 * that property.
 */
export type PseudoElement = "before" | "after" | "placeholder" | "selection" | "picker" | "marker";

const SUPPORTED_PSEUDO_ELEMENT = new Set<string>([
  "before",
  "after",
  "placeholder",
  "selection",
  // The box `walkMarker` generates for an li: its default content is the
  // compiler's (a bullet, or the item's compile-time ordinal), and this entry is
  // what lets `li::marker { color: … }` restyle it — the promise the old refusal
  // message made ("lands with the parts they draw"), kept.
  "marker",
]);

/**
 * Pseudo-elements that must be written with an argument, and the arguments allowed.
 *
 * Separate from the set above because the two are checked at different points: a bare
 * name is refused there with "did you mean `::picker(select)`", and a functional one is
 * refused in {@link applyFuncPseudo} with the same list. Both messages have to exist,
 * because `::picker` and `::picker(button)` are different mistakes.
 */
const FUNCTIONAL_PSEUDO_ELEMENT = new Map<string, Set<string>>([
  ["picker", new Set(["select"])],
]);

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
  /**
   * The interaction pseudo-classes on the subject — **all** of them, because a
   * compound may name several and the rule then applies only while every one
   * holds. `:checked:disabled` is the case that made this a list: as a single
   * slot it kept whichever was written last, so the UA sheet's greyed-out fill
   * for a disabled *checked* checkbox silently applied to every disabled one,
   * and a disabled unchecked radio grew a dot. Empty means the rule has no state
   * condition and contributes to every variant, which is what `"none"` used to
   * spell.
   */
  pseudos: Pseudo[];
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
    return { compounds: [], pseudos: [], element: null, specificity: [0, 1, 0], root: true };
  }

  // `:host` matches the shadow host from inside a shadow tree. dziri has no
  // shadow DOM, so it matches nothing — which is the correct answer, not a
  // limitation. It is accepted rather than refused because Tailwind writes
  // `:root, :host` for its theme block, and refusing half of a selector list
  // would throw away the `:root` half with it.
  if (src.trim() === ":host") {
    return { compounds: [], pseudos: [], element: null, specificity: [0, 1, 0], never: true };
  }

  const compounds: Compound[] = [];
  const pseudos: Pseudo[] = [];
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

    for (const func of funcs) {
      const named = applyFuncPseudo(compound, func, spec, src);
      if (named === null) continue;
      // The same three checks the bare `::name` path makes, on the same grounds: a
      // pseudo-element names which cascade the *rule* is in, so it cannot be an
      // argument, cannot sit on a non-subject compound, and there cannot be two.
      if (role === "argument") {
        throw new CssError(
          `"::${named}()" cannot be used inside :is(), :where() or :not() — a\n` +
            `  pseudo-element names which cascade the rule is in, which is a property\n` +
            `  of the rule and not of one compound.`,
          partAt,
        );
      }
      if (p !== parts.length - 1) {
        throw new CssError(
          `"::${named}()" is only supported on the subject of a selector`,
          partAt,
        );
      }
      if (element !== null) {
        throw new CssError(`a selector may carry only one pseudo-element`, partAt);
      }
      element = named;
      spec[2]++;
    }

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
            // A functional one written bare is its own mistake, and naming the
            // argument is the whole of the fix — so it gets its own message rather
            // than being swept into "unsupported".
            const args = FUNCTIONAL_PSEUDO_ELEMENT.get(name);
            if (args !== undefined) {
              throw new CssError(
                `"::${name}" needs an argument: write ` +
                  `${[...args].map((a) => `::${name}(${a})`).join(" or ")}.\n` +
                  `  The spec defines ::${name}() as functional so a future control can name ` +
                  `a ${name} of its own, and\n` +
                  `  a bare ::${name} would be a shorthand no browser has.`,
                partAt,
              );
            }
            throw new CssError(
              `unsupported pseudo-element "::${name}".\n` +
                `  Supported: ::before, ::after, ::placeholder, ::selection, ::marker, ` +
                `::picker(select).\n` +
                `  The remaining control-specific ones (::picker-icon, ::checkmark) are ` +
                `the same machinery and\n` +
                `  land with the parts they draw.`,
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
              `  Supported: :hover, :active, :focus, :checked, :disabled, :open, :root,\n` +
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
        // Pushed, not assigned: `:checked:disabled` names two conditions and the
        // rule holds only while both do. Assignment kept the last one written,
        // which turned "grey out the disabled checked box" into "grey out every
        // disabled box" — found by a filled dot on a disabled unchecked radio.
        // The duplicate spelling `:hover:hover` still counts twice in
        // specificity, as the spec says, but needs recording only once.
        if (!pseudos.includes(name as Pseudo)) pseudos.push(name as Pseudo);
        spec[1]++;
      } else {
        compound.tag = token.toLowerCase();
        spec[2]++;
      }
    }

    compounds.push(compound);
  }

  return { compounds, pseudos, element, specificity: spec };
}

/**
 * Folds one `:is()` / `:where()` / `:not()` into the compound it was written on.
 *
 * All three are the same mechanism — "does this element, as the subject, match one
 * of these selectors?" — differing only in whether the answer is negated and in
 * what it contributes to specificity. Which is why they share a representation
 * rather than getting a flag each: the matcher has one recursive case to handle,
 * and the three spellings are all reachable through it.
 *
 * Returns the pseudo-*element* it named, if it named one. `::picker(select)` comes
 * through here because it is written with parentheses and is therefore lifted out by
 * {@link extractFuncPseudos} before tokenizing, but what it produces is not a
 * compound-level fact at all — it names which cascade the rule belongs to. So it is
 * handed back for the caller to apply, where the "only on the subject" and "only one"
 * checks already live and do not need a second copy.
 */
function applyFuncPseudo(
  compound: Compound,
  func: FuncPseudo,
  spec: [number, number, number],
  src: string,
): PseudoElement | null {
  if (func.doubled) {
    const allowed = FUNCTIONAL_PSEUDO_ELEMENT.get(func.name);
    if (allowed !== undefined) {
      const arg = func.args.trim().toLowerCase();
      if (!allowed.has(arg)) {
        throw new CssError(
          `"::${func.name}(${func.args.trim()})" names no picker dziri knows.\n` +
            `  Supported: ${[...allowed].map((a) => `::${func.name}(${a})`).join(", ")}.`,
          func.offset,
        );
      }
      // Counted by the caller along with every other pseudo-element, so the type
      // column is not bumped twice.
      return func.name as PseudoElement;
    }
    throw new CssError(
      `unsupported pseudo-element "::${func.name}()".\n` +
        `  Supported functional: ::picker(select).\n` +
        `  ::picker-icon, ::checkmark and ::marker take no argument and are the same ` +
        `machinery; they land with the parts they draw.`,
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
  if (func.name === "where") return null;
  const most = mostSpecific(parsed);
  for (let k = 0; k < 3; k++) spec[k] = spec[k]! + most[k]!;
  return null;
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
