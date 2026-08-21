/**
 * Which declarations reach a node — selector matching, specificity, the cascade.
 *
 * This is the first half of "what does this element look like", and it answers it
 * without knowing what a style *is*: nothing here imports `ComputedStyle`, touches a
 * style field, mints an index or knows the IR exists. What comes out is a
 * `Map<property, value>` of unparsed CSS strings in cascade order, which is exactly
 * the shape the second half consumes.
 *
 * That split is not invented here — it was already the shape of the data, sitting
 * inside a 3,000-line file where the only way to reach it was to call `compile()`.
 * A test for "specificity 0,2,0 ties, so source order decides" had to drive an HTML
 * parse, the UA sheet, `@property` merging, keyframe resolution, every variant
 * cascade and ten typed-array builds to observe one integer.
 *
 * Seventeen declarations, six of them exported. The eleven private ones are the
 * matcher proper: whether one compound matches, where an element sits among its
 * siblings, how a combinator walks. Callers ask a question about a node and a rule
 * list; they do not get a selector engine to drive.
 */
import { Predicate } from "../ir.ts";
import type { Element } from "./html.ts";
import { listboxOf } from "./ua-structure.ts";
import { warnOnce } from "./diagnostics.ts";
import {
  compareCascade,
  type AttrSel,
  type Compound,
  type MediaCond,
  type OriginValue,
  type Pseudo,
  type PseudoElement,
  type Rule,
  type Selector,
  type Structural,
} from "./css.ts";

/**
 * Where an element sits among its element siblings, as far as the compiler can
 * tell.
 *
 * `unknown` is a third answer rather than a missing one, and it is the honest one:
 * a container holding a dynamic list has a child count that is a runtime value, so
 * "is this the last child" genuinely has no compile-time answer for the rows or for
 * anything after them. See {@link positionOf} for what is done with it.
 */
type SiblingPos = { first: boolean | "unknown"; last: boolean | "unknown" };

const POS_UNKNOWN: SiblingPos = { first: "unknown", last: "unknown" };

function matchCompound(el: Element, c: Compound, path: Element[], subject: number): boolean {
  if (c.tag !== null && c.tag !== el.tag) return false;
  if (c.id !== null && c.id !== el.id) return false;
  for (const cls of c.classes) {
    if (!el.classes.includes(cls)) return false;
  }
  for (const a of c.attrs ?? []) {
    if (!matchAttr(el, a)) return false;
  }
  if (c.structural) {
    const pos = positionOf(path, subject);
    for (const s of c.structural) {
      // Said out loud, because the alternative is a silent 16px. The guess this
      // reports is the one `matchStructural` documents, and an author who sees the
      // line can reach for `gap` — which needs no per-row difference and so has an
      // answer that stays right however long the list gets.
      if (unknownFor(s, pos)) {
        warnOnce(
          `":${s}" on ${describeEl(el)} sits beside a dynamic list, so its position is a ` +
            `runtime value.\n    Treated as not matching, which for a "space-*" utility ` +
            `means one margin too many after the last row. "gap" has no such problem.`,
        );
      }
      if (!matchStructural(s, pos)) return false;
    }
  }
  // `:is()` / `:where()`: within one of these the arguments are alternatives, and
  // between two of them both must hold. Each argument is matched with *this*
  // element as the subject, against the same ancestor path — which is what makes
  // `.x:is(.a .b)` mean "an `.x` that is a `.b` inside an `.a`".
  for (const group of c.anyOf ?? []) {
    if (!group.some((sel) => matchesAt(sel, path, subject))) return false;
  }
  // `:not()`: none may match. Flat, because negation distributes.
  for (const sel of c.noneOf ?? []) {
    if (matchesAt(sel, path, subject)) return false;
  }
  return true;
}

/**
 * One structural pseudo-class against a position that may not be known.
 *
 * An unknown position resolves to *false*, and the direction is deliberate. The
 * shape that reaches this is Tailwind's `space-y-*`, which is
 * `:where(.space-y-4 > :not(:last-child)) { margin-block-end: … }` — so "unknown"
 * becoming false means `:not(:last-child)` holds and the row keeps its margin. The
 * failure is one margin too many after the final row. Resolving it the other way
 * would drop the spacing from every row of every dynamic list, which is the same
 * uncertainty answered with a much worse guess.
 */
function matchStructural(s: Structural, pos: SiblingPos): boolean {
  switch (s) {
    case "first-child":
      return pos.first === true;
    case "last-child":
      return pos.last === true;
    case "only-child":
      return pos.first === true && pos.last === true;
  }
}

/**
 * Whether the guess above was actually reached, as opposed to a position that was
 * merely partly unknown.
 *
 * `:only-child` on an element with a known-false `first` is answered without
 * consulting `last`, so an unknown `last` there changes nothing and warning about
 * it would be noise.
 */
function unknownFor(s: Structural, pos: SiblingPos): boolean {
  switch (s) {
    case "first-child":
      return pos.first === "unknown";
    case "last-child":
      return pos.last === "unknown";
    case "only-child":
      return (
        (pos.first === "unknown" && pos.last !== false) ||
        (pos.last === "unknown" && pos.first !== false)
      );
  }
}

/** `<div class="row">` — enough of an element to find it in the source. */
function describeEl(el: Element): string {
  const id = el.id === null ? "" : ` id="${el.id}"`;
  const cls = el.classes.length === 0 ? "" : ` class="${el.classes.join(" ")}"`;
  return `<${el.tag}${id}${cls}>`;
}

/**
 * An element's position among its parent's element children.
 *
 * All three of the awkward cases here were measured rather than reasoned about —
 * Chromium 151, `probes/structural-pseudo-root.html`, recorded in
 * BROWSER-FACTS.md — because dziry's IR gives a node to two things CSS does not
 * count as children, and getting either wrong is silent:
 *
 *   - Text runs do not count. A container written across several lines has a text
 *     run after its final element, so counting *nodes* would mean nothing is ever
 *     the last child and `space-y-4` would margin every row including the last.
 *   - Generated boxes do not count either, which is why this walks the *element's*
 *     `children` rather than the `children` array `walk` builds: `::before`,
 *     `::after` and a `::picker(select)` are in the latter, with real positions.
 *
 *     Which also means it walks the children **as authored**, before `uaParts`
 *     splices anything in — and that is deliberate rather than incidental. This used
 *     to call `uaChildren`, whose only effect here was to put a `<select>`'s
 *     UA-supplied `<button>` in front of its options and so shift every one of them
 *     by a position: the first `<option>` matched `:first-child` in a browser and
 *     did not here. A part a browser builds in a shadow tree is not one of the
 *     author's siblings, and counting it made a selector about their markup answer a
 *     question about ours.
 *   - The root, which has no parent, matches all three. That is Selectors 4's
 *     "first among its inclusive siblings" rather than Selectors 3's "first child
 *     of some other element", and it is what Chromium does.
 */
function positionOf(path: Element[], subject: number): SiblingPos {
  const el = path[subject];
  if (el === undefined) return POS_UNKNOWN;
  if (subject === 0) return { first: true, last: true };

  const parent = path[subject - 1];
  if (parent === undefined) return POS_UNKNOWN;

  // Walked rather than indexed because the parent's `children` holds text runs and
  // dynamic lists as well as elements, and only the elements count.
  let seenBefore = 0;
  let seenAfter = 0;
  let listBefore = false;
  let listAfter = false;
  let found = false;

  for (const child of parent.children) {
    if (child === el) {
      found = true;
      continue;
    }
    if (child.type === "element") {
      if (found) seenAfter++;
      else seenBefore++;
    } else if (child.type === "dynlist") {
      // A list contributes an unknown number of elements — zero when the signal is
      // empty, `capacity` at most — so it makes the side it is on unknowable
      // rather than adding a count.
      if (found) listAfter = true;
      else listBefore = true;
    }
  }

  // The subject is not in its parent's child list at all: it is a dynamic list's
  // template row, whose real siblings are the other rows and whose position is a
  // runtime value in both directions.
  if (!found) return POS_UNKNOWN;

  return {
    first: seenBefore > 0 ? false : listBefore ? "unknown" : true,
    last: seenAfter > 0 ? false : listAfter ? "unknown" : true,
  };
}

/**
 * The one attribute nobody writes: it is computed, and only the UA sheet asks for it.
 *
 * A list box is `multiple || size > 1` — measured, `probes/select-listbox.html`, where
 * `<select size="4">` with no `multiple` turned out to be a list box too. **CSS cannot say
 * that.** `select[size]` also matches `size="1"`, which is a dropdown, and a selector has
 * no numeric comparison. So the compiler resolves the condition and the matcher answers as
 * if the element carried the result.
 *
 * Computed rather than stamped onto `el.attrs`, and not only because that map is readonly:
 * a stamped attribute is a second copy of a fact `listboxOf` already owns, and the two
 * could disagree if anything ever rewrote `size`. This cannot go stale. It is also
 * invisible to everything that walks attributes — the JSX prop checks, the diagnostics —
 * which is right for something no author wrote.
 *
 * See `select[data-dziry-listbox]` in `ua-sheet.ts` for what it is for: the stacking and
 * clipping that make a list box a list, at UA origin so an author's own rule beats them.
 */
const LISTBOX_ATTR = "data-dziry-listbox";

function listboxMarker(el: Element): string | undefined {
  return listboxOf(el) !== null ? "" : undefined;
}

/**
 * One `[attr op value]` test against an element's attributes.
 *
 * The operators are the spec's, and the two easy ones to get subtly wrong are
 * handled explicitly: `~=` splits on whitespace so it matches a *word* and not a
 * substring, and `|=` matches the value or the value followed by a hyphen, which
 * is what makes `[lang|=en]` match `en-GB`. An empty selector value never
 * matches for the substring operators, per the spec, rather than matching
 * everything — which is the direction that would silently over-apply a rule.
 */
function matchAttr(el: Element, a: AttrSel): boolean {
  const raw = a.name === LISTBOX_ATTR ? listboxMarker(el) : el.attrs.get(a.name);
  if (raw === undefined) return false;
  if (a.op === "exists") return true;

  // HTML attribute values are case-sensitive unless the selector asks otherwise.
  const have = a.ci ? raw.toLowerCase() : raw;
  const want = a.ci ? a.value.toLowerCase() : a.value;

  switch (a.op) {
    case "=":
      return have === want;
    case "~=":
      return want !== "" && !/\s/.test(want) && have.split(/\s+/).includes(want);
    case "|=":
      return have === want || have.startsWith(want + "-");
    case "^=":
      return want !== "" && have.startsWith(want);
    case "$=":
      return want !== "" && have.endsWith(want);
    case "*=":
      return want !== "" && have.includes(want);
  }
}

/** Matches a rule's selector against an ancestor path whose last entry is the subject. */
export function matches(sel: Selector, path: Element[]): boolean {
  return matchesAt(sel, path, path.length - 1);
}

/**
 * Matches a selector with `path[subject]` as its subject.
 *
 * The subject is a parameter rather than always the end of the path because
 * `:is()`, `:where()` and `:not()` need exactly that: `.x:not(.a .b)` asks whether
 * `.a .b` matches *the same element*, part-way up a path whose end may be somewhere
 * else entirely.
 */
function matchesAt(sel: Selector, path: Element[], subject: number): boolean {
  if (sel.never) return false;
  // `:root` is the element with no ancestors. `path` is the chain from the tree's
  // top down, so index zero *is* the root.
  if (sel.root) return subject === 0;
  if (sel.compounds.length === 0 || subject < 0) return false;
  return matchFrom(sel, sel.compounds.length - 1, path, subject);
}

/**
 * Matches right-to-left along the ancestor path, backtracking over descendants.
 *
 * Greedy consumption used to be correct, and the comment that said so named the
 * reason it stopped being: it held only while every combinator was a descendant.
 * With `>` in the language, `.a > .b .c` can need a second try — the first
 * ancestor matching `.b` may not be a child of an `.a`, while a further one is.
 * The recursion is the backtracking; depth is bounded by the selector's compound
 * count, which is single digits.
 */
function matchFrom(sel: Selector, ci: number, path: Element[], pi: number): boolean {
  const el = path[pi];
  if (el === undefined) return false;
  if (!matchCompound(el, sel.compounds[ci]!, path, pi)) return false;
  if (ci === 0) return true;

  if (sel.compounds[ci]!.combinator === "child") {
    return matchFrom(sel, ci - 1, path, pi - 1);
  }
  for (let k = pi - 1; k >= 0; k--) {
    if (matchFrom(sel, ci - 1, path, k)) return true;
  }
  return false;
}

type Candidate = {
  specificity: [number, number, number];
  order: number;
  decls: Map<string, string>;
  /** Carried through so `compareCascade` can rank origin above specificity. */
  origin?: OriginValue;
};

// ---------------------------------------------------------------------------
// The candidate index
// ---------------------------------------------------------------------------

/**
 * A prefilter over the rule list, so a node tests the rules that *could* match
 * it rather than every rule there is.
 *
 * The invariant is bucket-of-one-required-feature: if a selector's subject
 * compound names a class, only an element carrying that class can match — so the
 * (rule, selector) pair goes into that class's bucket, and an element looks up
 * the buckets of its own classes, tag and id, plus the residue bucket of
 * selectors whose subject has none of the three (`[hidden]`, `*`, structural
 * pseudo-classes). Bucketing is a superset filter: a pair may appear under
 * several keys and is still fully matched by `matches` afterwards, so a wrong
 * bucket can cost time but never correctness.
 *
 * Measured against the full scan it replaces: the demo's 340-rule sheet gave
 * every node 340 selector matches per cascade question, and the question is
 * asked once per state combination, per pseudo query, per node — and again per
 * conditional-class variant. The index halved `compileTree` on a 4,501-node
 * tree against that sheet (740 → 250 ms), and it composes with the variant
 * pass's other costs rather than erasing them.
 */
type Indexed = { rule: Rule; sel: Selector };

class RuleIndex {
  #byClass = new Map<string, Indexed[]>();
  #byTag = new Map<string, Indexed[]>();
  #byId = new Map<string, Indexed[]>();
  #other: Indexed[] = [];

  constructor(rules: Rule[]) {
    const put = (map: Map<string, Indexed[]>, key: string, pair: Indexed): void => {
      const bucket = map.get(key);
      if (bucket) bucket.push(pair);
      else map.set(key, [pair]);
    };

    for (const rule of rules) {
      for (const sel of rule.selectors) {
        const pair = { rule, sel };
        const subject = sel.compounds[sel.compounds.length - 1];
        if (subject !== undefined && subject.classes.length > 0) {
          for (const cls of subject.classes) put(this.#byClass, cls, pair);
        } else if (subject?.tag) {
          put(this.#byTag, subject.tag, pair);
        } else if (subject?.id) {
          put(this.#byId, subject.id, pair);
        } else {
          this.#other.push(pair);
        }
      }
    }
  }

  /** Every (rule, selector) pair whose subject compound could match `el`. */
  *candidates(el: Element): Iterable<Indexed> {    for (const cls of el.classes) {
      const bucket = this.#byClass.get(cls);
      if (bucket) yield* bucket;
    }
    const byTag = this.#byTag.get(el.tag);
    if (byTag) yield* byTag;
    if (el.id !== null) {
      const byId = this.#byId.get(el.id);
      if (byId) yield* byId;
    }
    yield* this.#other;
  }
}

/**
 * One index per parsed sheet, built on first ask. Keyed by the rule array's
 * identity, which is also the lifetime boundary: `compileTree` parses the sheet
 * per call, so a stale index cannot outlive the rules it points at.
 */
const indexes = new WeakMap<Rule[], RuleIndex>();

function indexFor(rules: Rule[]): RuleIndex {
  let index = indexes.get(rules);
  if (!index) {
    index = new RuleIndex(rules);
    indexes.set(rules, index);
  }
  return index;
}


/**
 * Declarations applying to `path`'s subject when the given pseudo-class states
 * are active.
 *
 * `states` is a set, not a single value, because CSS puts pseudo-class rules in
 * the *same* cascade as everything else. While hovering, `.btn:hover` (0,2,0)
 * and `.btn.primary` (0,2,0) tie on specificity and source order decides — so
 * hover declarations do not automatically beat base ones. Resolving hover as a
 * patch over the finished base style would get that backwards.
 */
export function collectDecls(
  rules: Rule[],
  path: Element[],
  states: Pseudo[],
  media: MediaBits,
  live = 0,
  element: PseudoElement | null = null,
): Map<string, string> {
  const candidates: Candidate[] = [];
  // An empty path matches nothing — the index is asked only when there is a
  // subject to key it by.
  const subject = path[path.length - 1];
  if (subject === undefined) return new Map();

  for (const { rule, sel } of indexFor(rules).candidates(subject)) {
    // A conditional rule contributes nothing unless *every* condition it carries
    // is live in this combination. `@media` has no effect on specificity — a rule
    // inside one cascades exactly as it would outside — so this is a filter and
    // not a weighting.
    if (rule.media && !rule.media.every((c) => (live & media.bitFor(c)) !== 0)) continue;

    {
      // A pseudo-element rule is in a *different* cascade from its originating
      // element's. `p::before { color: red }` must not colour the `<p>`, and
      // `p { color: blue }` reaches the generated box only through inheritance —
      // which is why this is an equality test and not a superset one.
      if ((sel.element ?? null) !== element) continue;
      // Every named state must be live, not any: `:checked:disabled` is a rule
      // about the intersection. A selector with no pseudo-classes passes
      // vacuously, which is what makes base rules part of every variant's
      // cascade.
      if (!sel.pseudos.every((p) => states.includes(p))) continue;
      if (!matches(sel, path)) continue;
      candidates.push({
        specificity: sel.specificity,
        order: rule.order,
        decls: rule.decls,
        origin: rule.origin,
      });
    }
  }

  candidates.sort(compareCascade);


  // Applied in ascending cascade order, so the winner is written last.
  //
  // `delete` before `set` is load-bearing, not tidiness. `Map.set` on an existing
  // key updates the value but keeps the key's *original* position, and the caller
  // expands this map in iteration order — so a shorthand would expand where it
  // first appeared rather than where it won:
  //
  //   .card      { padding: 14px }      <- `padding` takes position 0
  //   .card      { padding-left: 4px }  <- `padding-left` takes position 1
  //   .x .card   { padding: 2px }       <- updates position 0, does not move
  //
  // Iterating then expands `padding: 2px` first and `padding-left: 4px` second,
  // giving `padL = 4` — even though `.x .card` outranks `.card`. Re-inserting
  // moves the key to the end, so cascade order and expansion order agree.
  const winning = new Map<string, string>();
  for (const c of candidates) {
    for (const [prop, value] of c.decls) {
      winning.delete(prop);
      winning.set(prop, value);
    }
  }
  return winning;
}

/**
 * Assigns one predicate bit per distinct media condition.
 *
 * Bits start at `Predicate.FIRST_GLOBAL`, which the schema reserves for exactly
 * this: everything below it is per-node input state, everything from it up is a
 * condition the engine evaluates once a frame and intersects with every node's
 * mask. Nothing here hardcodes a breakpoint — `md:` and
 * `@media (min-width: 768px)` arrive as the same condition and get the same bit.
 *
 * Deduplicated by value, so a stylesheet that mentions `768px` in twenty places
 * spends one bit on it. That matters: a mask is a `u32` and bits 8..31 are all
 * there are, so 24 distinct thresholds is the ceiling. Overrunning it is an error
 * rather than a silent wrap, because a wrapped bit would collide with another
 * query and produce styling that is wrong only at certain window sizes.
 */
export class MediaBits {
  #bits = new Map<string, number>();
  #order: MediaCond[] = [];

  static key(c: MediaCond): string {
    return `${c.axis}|${c.side}|${c.px}`;
  }

  /** Assigns on first sight; stable thereafter. */
  bitFor(c: MediaCond): number {
    const key = MediaBits.key(c);
    const existing = this.#bits.get(key);
    if (existing !== undefined) return existing;

    const index = this.#order.length;
    if (Predicate.FIRST_GLOBAL << index === 0 || index >= 23) {
      throw new Error(
        `too many distinct media conditions (${index + 1}); a predicate mask is a u32 ` +
          `and bits 0-8 are per-node state, so 23 is the limit`,
      );
    }
    const bit = Predicate.FIRST_GLOBAL << index;
    this.#bits.set(key, bit);
    this.#order.push(c);
    return bit;
  }

  /** In bit order, which is assignment order — what the media table holds. */
  rows(): Array<{ bit: number; cond: MediaCond }> {
    return this.#order.map((cond, i) => ({ bit: Predicate.FIRST_GLOBAL << i, cond }));
  }

  get size(): number {
    return this.#order.length;
  }
}

/** The bits of every media condition on rules that match this node. */
export function mediaMaskFor(
  rules: Rule[],
  path: Element[],
  media: MediaBits,
  element: PseudoElement | null = null,
): number {
  let mask = 0;
  const subject = path[path.length - 1];
  if (subject === undefined) return mask;
  for (const { rule, sel } of indexFor(rules).candidates(subject)) {
    if (!rule.media) continue;
    if ((sel.element ?? null) !== element) continue;
    if (!matches(sel, path)) continue;
    for (const cond of rule.media) mask |= media.bitFor(cond);
  }
  return mask;
}

/** Whether any rule targeting this node uses the given pseudo-class. */
export function hasPseudoRule(
  rules: Rule[],
  path: Element[],
  pseudo: Pseudo,
  element: PseudoElement | null = null,
): boolean {
  const subject = path[path.length - 1];
  if (subject === undefined) return false;
  for (const { sel } of indexFor(rules).candidates(subject)) {
    if ((sel.element ?? null) !== element) continue;
    if (sel.pseudos.includes(pseudo) && matches(sel, path)) return true;
  }
  return false;
}

/** Whether any rule at all targets this node's given pseudo-element. */
export function hasPseudoElementRule(
  rules: Rule[],
  path: Element[],
  element: PseudoElement,
): boolean {
  const subject = path[path.length - 1];
  if (subject === undefined) return false;
  for (const { sel } of indexFor(rules).candidates(subject)) {
    if (sel.element === element && matches(sel, path)) return true;
  }
  return false;
}
