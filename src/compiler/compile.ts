/**
 * The compiler: HTML + CSS in, IR out.
 *
 * Everything expensive and static happens here — tokenizing, selector matching,
 * specificity, the cascade, inheritance, shorthand expansion, unit resolution,
 * style deduplication, and `:hover`/`:active` variant generation. What comes out
 * the far side is integers and typed arrays.
 *
 * The runtime that consumes this has no idea CSS exists.
 */
import {
  Align,
  ControlFlags,
  ControlKind,
  Direction,
  Display,
  Easing,
  Justify,
  Overflow,
  INITIAL_STYLE,
  INHERITED_FIELDS,
  MediaKind,
  NodeKind,
  Predicate,
  routeChain,
  STYLE_FIELDS,
  type CompiledUi,
  type ComputedStyle,
  type RouteNodes,
  type StyleField,
  type WindowConfig,
} from "../ir.ts";
import { parseHtml, type DynList, type Element, type Node, type TextPart } from "./html.ts";
import { isItemSentinel, ItemExpressionError } from "./item-path.ts";
import { isParamSentinel, ParamExpressionError } from "./route-args.ts";
import { allLocals } from "./reactive-runtime.ts";
import { hasState, type VariantCompiled } from "./variant-compile.ts";
import {
  animationFrom,
  compareCascade,
  EASE,
  expandDeclaration,
  extendVarEnv,
  parseCss,
  parseEasing,
  Origin,
  parseContent,
  parseInlineStyle,
  substituteVars,
  transitionFrom,
  transitionMask,
  type AnimationSpec,
  type Curve,
  type KeyframeBlock,
  type OriginValue,
  type RegisteredProperty,
  type MediaCond,
  type AttrSel,
  type Compound,
  type Pseudo,
  type PseudoElement,
  type Rule,
  type Selector,
  type TransitionSpec,
  type VarEnv,
} from "./css.ts";
import { UA_SHEET } from "./ua-sheet.ts";
import { uaChildren } from "./ua-structure.ts";

/** The environment at the root, before any `--*` declaration has been seen. */
const EMPTY_VARS: VarEnv = new Map<string, string>();

// ---------------------------------------------------------------------------
// Selector matching
// ---------------------------------------------------------------------------

function matchCompound(el: Element, c: Compound): boolean {
  if (c.tag !== null && c.tag !== el.tag) return false;
  if (c.id !== null && c.id !== el.id) return false;
  for (const cls of c.classes) {
    if (!el.classes.includes(cls)) return false;
  }
  for (const a of c.attrs ?? []) {
    if (!matchAttr(el, a)) return false;
  }
  return true;
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
  const raw = el.attrs.get(a.name);
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

/**
 * Matches right-to-left along the ancestor path. Greedy consumption is correct
 * here because the descendant combinator is transitive — with no child or
 * sibling combinators there is nothing to backtrack for.
 */
function matches(sel: Selector, path: Element[]): boolean {
  if (sel.never) return false;
  // `:root` is the element with no ancestors. `path` is the chain from the tree's
  // top down to the subject, so a length of one *is* "this is the root".
  if (sel.root) return path.length === 1;

  let ci = sel.compounds.length - 1;
  let pi = path.length - 1;

  if (ci < 0 || pi < 0) return false;
  if (!matchCompound(path[pi]!, sel.compounds[ci]!)) return false;
  ci--;
  pi--;

  while (ci >= 0) {
    let found = false;
    while (pi >= 0) {
      const el = path[pi]!;
      pi--;
      if (matchCompound(el, sel.compounds[ci]!)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
    ci--;
  }

  return true;
}

type Candidate = {
  specificity: [number, number, number];
  order: number;
  decls: Map<string, string>;
  /** Carried through so `compareCascade` can rank origin above specificity. */
  origin?: OriginValue;
};

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
function collectDecls(
  rules: Rule[],
  path: Element[],
  states: Pseudo[],
  media: MediaBits,
  live = 0,
  element: PseudoElement | null = null,
): Map<string, string> {
  const candidates: Candidate[] = [];

  for (const rule of rules) {
    // A conditional rule contributes nothing unless *every* condition it carries
    // is live in this combination. `@media` has no effect on specificity — a rule
    // inside one cascades exactly as it would outside — so this is a filter and
    // not a weighting.
    if (rule.media && !rule.media.every((c) => (live & media.bitFor(c)) !== 0)) continue;

    for (const sel of rule.selectors) {
      // A pseudo-element rule is in a *different* cascade from its originating
      // element's. `p::before { color: red }` must not colour the `<p>`, and
      // `p { color: blue }` reaches the generated box only through inheritance —
      // which is why this is an equality test and not a superset one.
      if ((sel.element ?? null) !== element) continue;
      if (!states.includes(sel.pseudo)) continue;
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
class MediaBits {
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
    if (Predicate.FIRST_GLOBAL << index === 0 || index >= 24) {
      throw new Error(
        `too many distinct media conditions (${index + 1}); a predicate mask is a u32 ` +
          `and bits 0-7 are input state, so 24 is the limit`,
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
function mediaMaskFor(
  rules: Rule[],
  path: Element[],
  media: MediaBits,
  element: PseudoElement | null = null,
): number {
  let mask = 0;
  for (const rule of rules) {
    if (!rule.media) continue;
    if (!rule.selectors.some((sel) => (sel.element ?? null) === element && matches(sel, path))) {
      continue;
    }
    for (const cond of rule.media) mask |= media.bitFor(cond);
  }
  return mask;
}

/** Whether any rule targeting this node uses the given pseudo-class. */
function hasPseudoRule(
  rules: Rule[],
  path: Element[],
  pseudo: Pseudo,
  element: PseudoElement | null = null,
): boolean {
  for (const rule of rules) {
    for (const sel of rule.selectors) {
      if ((sel.element ?? null) !== element) continue;
      if (sel.pseudo === pseudo && matches(sel, path)) return true;
    }
  }
  return false;
}

/** Whether any rule at all targets this node's given pseudo-element. */
function hasPseudoElementRule(
  rules: Rule[],
  path: Element[],
  element: PseudoElement,
): boolean {
  for (const rule of rules) {
    for (const sel of rule.selectors) {
      if (sel.element === element && matches(sel, path)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Computing styles
// ---------------------------------------------------------------------------

const DISPLAY_VALUES: Record<string, number> = {
  flex: Display.FLEX,
  grid: Display.GRID,
  block: Display.BLOCK,
  none: Display.NONE,
};

function inheritFrom(parent: ComputedStyle): ComputedStyle {
  const style = { ...INITIAL_STYLE };
  for (const field of INHERITED_FIELDS) style[field] = parent[field];
  return style;
}

function applyDecls(
  base: ComputedStyle,
  decls: Map<string, string>,
  where: string,
  vars: VarEnv = EMPTY_VARS,
  registered: ReadonlyMap<string, RegisteredProperty> = new Map(),
  anim?: AnimContext,
): ComputedStyle {
  const patch: Partial<Record<StyleField, number>> = {};

  for (const [prop, value] of decls) {
    // A custom property is a value carrier, not a style field. It has already
    // been folded into `vars` by the caller; expanding it here would be an error
    // about a property nothing implements.
    if (prop.startsWith("--")) continue;

    // Substituted before the expander sees it, which is what lets `var()` supply
    // part of a value — `padding: var(--y) 4px` — rather than only whole ones.
    const resolved = value.includes("var(")
      ? substituteVars(value, vars, 0, registered)
      : value;
    if (resolved === null) {
      // CSS drops a declaration whose `var()` cannot resolve, rather than taking
      // a partial value. Silent because it is a legitimate authoring pattern:
      // `color: var(--maybe-unset)` is how a theme opts out of setting a colour.
      continue;
    }

    try {
      expandDeclaration(prop, resolved, patch);
    } catch (e) {
      const via = resolved === value ? "" : ` (via ${value})`;
      throw new Error(`${where}: ${prop}: ${resolved}${via} — ${(e as Error).message}`);
    }
  }

  // `display` is resolved here rather than in the expander because it interacts
  // with `flex-direction`: HTML's block default stacks children vertically, so a
  // box with no `display` behaves like a COLUMN, while `display: flex` alone
  // means ROW as CSS says.
  const display = decls.get("display")?.trim().toLowerCase();
  if (display !== undefined) {
    const value = DISPLAY_VALUES[display];
    if (value === undefined) throw new Error(`${where}: unsupported display "${display}"`);
    patch.display = value;

    if (display === "flex" && !decls.has("flex-direction")) {
      patch.direction = Direction.ROW;
    }
  }

  const style = coerceOverflow({ ...base, ...patch });

  // After the style is finished, because both halves need it. A transition's
  // endpoints *are* style rows the cascade produced, and an animation's keyframes
  // resolve against this very style — so neither can be answered from one
  // declaration's value, which is why `expandDeclaration` does not try.
  //
  // Absent for the callers that have no interner: `css.test.ts` exercises the
  // expander directly, and a transition with nowhere to intern is not a transition.
  if (anim) resolveTiming(style, decls, where, (value) => resolveValue(value, vars, registered), anim);

  return style;
}

/**
 * One declaration's value with its `var()`s substituted, or `null` if it drops.
 *
 * The same two lines the expander loop above runs, named because the timing
 * resolution needs them too and needs them *lazily* — it reads six declarations out
 * of a map of forty, and substituting the other thirty-four twice would be the
 * price of sharing the loop instead.
 */
function resolveValue(
  value: string,
  vars: VarEnv,
  registered: ReadonlyMap<string, RegisteredProperty>,
): string | null {
  return value.includes("var(") ? substituteVars(value, vars, 0, registered) : value;
}

/**
 * `visible` on one axis becomes `auto` when the other axis scrolls.
 *
 * Measured, not assumed — Chromium 151, `probes/overflow-axis-coercion.html`, recorded
 * in BROWSER-FACTS.md. Declaring `overflow-y: auto` and nothing else gives a computed
 * `overflow-x: auto`, and it happens *even when the author writes `visible` explicitly*:
 * a box cannot be a scroll container in one axis and let content spill out of the other,
 * because the content that spills would have nowhere to go.
 *
 * This was a real divergence, not a nicety. `app.css` sets only `overflow-y: auto` on the
 * body; dziri computed `overflow-x: visible`, so a window too narrow for its content
 * clipped the right-hand column with **no way to reach it**. The layout matched Chromium
 * exactly; only the reachability was wrong.
 *
 * `clip` is the exception and the reason the schema now has a `CLIP` value distinct from
 * `HIDDEN`: `overflow-y: clip` leaves `overflow-x: visible` alone, because `clip` is not a
 * scroll container and so has nothing for the other axis to co-operate with. Folding it
 * into `HIDDEN` would have made this rule coerce a case that must not coerce.
 *
 * A *computed value* rule, so it belongs here where the cascade finishes rather than in
 * the per-declaration expander: it depends on both axes' final values, and either
 * longhand may arrive after the other.
 */
function coerceOverflow(style: ComputedStyle): ComputedStyle {
  const scrolls = (v: number) =>
    v === Overflow.SCROLL || v === Overflow.HIDDEN || v === Overflow.ELLIPSIS;

  const x = style.overflowX;
  const y = style.overflowY;

  if (x === Overflow.VISIBLE && scrolls(y)) return { ...style, overflowX: Overflow.SCROLL };
  if (y === Overflow.VISIBLE && scrolls(x)) return { ...style, overflowY: Overflow.SCROLL };
  return style;
}

/** Style for a text node: inherited properties only, everything else initial. */
function textStyle(parent: ComputedStyle): ComputedStyle {
  return inheritFrom(parent);
}

// ---------------------------------------------------------------------------
// Style table
// ---------------------------------------------------------------------------

class StyleInterner {
  private readonly byKey = new Map<string, number>();
  readonly list: ComputedStyle[] = [];

  /** Identical computed styles collapse to one id — the point of a style table. */
  intern(style: ComputedStyle): number {
    // Built by hand rather than JSON.stringify because that turns NaN and
    // Infinity — both meaningful here — into null.
    let key = "";
    for (const [field] of STYLE_FIELDS) key += String(style[field]) + "|";

    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;

    const id = this.list.length;
    this.byKey.set(key, id);
    this.list.push(style);
    return id;
  }
}

// ---------------------------------------------------------------------------
// Transitions and animations
// ---------------------------------------------------------------------------

/** One row of the tween table, as the emitter writes it. */
export type BuiltTween = {
  mask: number;
  duration: number;
  delay: number;
  iterations: number;
  firstSegment: number;
  segmentCount: number;
  easing: number;
  easeA: number;
  easeB: number;
  easeC: number;
  easeD: number;
};

/** One row of the keyframe table. */
export type BuiltKeyframe = {
  style: number;
  offset: number;
  easing: number;
  easeA: number;
  easeB: number;
  easeC: number;
  easeD: number;
};

/**
 * Interns tween rows, and owns the keyframe rows they point at.
 *
 * Interned for the same reason styles are: `transition-colors duration-150` is one
 * spec however many nodes wear it, and a page whose forty buttons share a class
 * should cost one row. The saving is not incidental — a tween row is 39 bytes and a
 * style row is 237, so an un-interned tween per style row would be a sixth of the
 * style table again for information that is identical.
 *
 * Keyframe rows are **not** interned, and that asymmetry is deliberate: a segment's
 * identity is its position in a tween's span, so two animations that happen to
 * resolve to the same offsets and rows still need their own contiguous runs.
 * `firstSegment`/`segmentCount` is a slice, and a slice cannot be shared unless the
 * whole run matches — which is a comparison over rows rather than over a key, and
 * worth nothing on a table with a handful of entries.
 */
class TweenInterner {
  private readonly byKey = new Map<string, number>();
  readonly tweens: BuiltTween[] = [];
  readonly keyframes: BuiltKeyframe[] = [];

  intern(row: BuiltTween): number {
    const key = [
      row.mask,
      row.duration,
      row.delay,
      row.iterations,
      row.firstSegment,
      row.segmentCount,
      row.easing,
      row.easeA,
      row.easeB,
      row.easeC,
      row.easeD,
    ].join("|");

    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;

    const id = this.tweens.length;
    this.byKey.set(key, id);
    this.tweens.push(row);
    return id;
  }

  /** Appends a keyframe run and returns where it starts. */
  addSegments(rows: BuiltKeyframe[]): number {
    const start = this.keyframes.length;
    this.keyframes.push(...rows);
    return start;
  }
}

/**
 * What resolving a node's `transition` and `animation` needs beyond its own
 * declarations.
 *
 * `styles` is here because a `@keyframes` block is resolved into *style rows* — one
 * per keyframe, each being this element's own computed style with the keyframe's
 * declarations on top. That is what makes an animation cost the engine nothing new,
 * and it is also why this cannot be done in `expandDeclaration`: the answer depends
 * on the whole finished style, not on one declaration's value.
 */
type AnimContext = {
  keyframes: ReadonlyMap<string, KeyframeBlock[]>;
  styles: StyleInterner;
  tweens: TweenInterner;
  /**
   * Records a diagnostic once per distinct *message*, located at its first site.
   *
   * The two arguments are separate for exactly that reason. A declaration is resolved
   * once per predicate combination, so `transition: width` on a node with a `:hover`
   * rule reaches here twice with `where` differing only by `:hover` — and a dedupe on
   * the finished string reports one mistake as two. Tailwind makes it worse: the same
   * declaration on forty buttons is forty sites for one line of CSS.
   */
  warn: (message: string, where: string) => void;
};

/** The `transition*` and `animation*` declarations, in cascade order, resolved. */
function timingDecls(
  decls: Map<string, string>,
  prefix: "transition" | "animation",
  resolve: (value: string) => string | null,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [prop, value] of decls) {
    if (prop !== prefix && !prop.startsWith(`${prefix}-`)) continue;
    const resolved = resolve(value);
    // A `var()` that does not resolve drops the declaration, exactly as it does
    // for every other property. Tailwind leans on this: `transition-duration:
    // var(--tw-duration, var(--default-transition-duration))` reaches its fallback
    // through `@property`, and before `@property` existed the whole declaration
    // was correctly dropped rather than half-read.
    if (resolved === null) continue;
    out.push([prop, resolved]);
  }
  return out;
}

/**
 * Fills in `style.transition` and `style.animation`, interning what they describe.
 *
 * Called with the *finished* computed style, which is what both halves need. A
 * transition's endpoints are style rows the cascade already produced, so all this
 * has to record is which fields may move and how fast. An animation's endpoints are
 * keyframe rows, and each is this style with the keyframe's declarations applied —
 * so the style has to exist first.
 *
 * Order matters between the two lines at the end, and not for a subtle reason:
 * `style.transition` is set *before* the segments are derived, so a `0%` keyframe
 * with no declarations of its own interns to literally the same row as the element.
 * `style.animation` is set after, so a segment row never carries the animation it
 * is a frame of — a keyframe is a value, not a state that starts anything.
 */
function resolveTiming(
  style: ComputedStyle,
  decls: Map<string, string>,
  where: string,
  resolve: (value: string) => string | null,
  ctx: AnimContext,
): void {
  const warn = (message: string) => ctx.warn(message, where);

  const transition = transitionFrom(timingDecls(decls, "transition", resolve));
  if (transition !== null && transition.duration > 0) {
    const mask = transitionMask(transition.properties, warn);
    // A mask of zero is a transition over nothing — either `transition-property:
    // none`, or a list naming only properties dziri cannot interpolate. Emitting a
    // row for it would cost the engine a per-frame tween that can never move a
    // pixel, so there is nothing to emit.
    if (mask !== 0) {
      style.transition = ctx.tweens.intern(tweenRow(mask, transition)) + 1;
    }
  }

  const animation = animationFrom(timingDecls(decls, "animation", resolve));
  if (animation !== null) {
    const row = animationRow(style, animation, where, resolve, ctx, warn);
    if (row !== null) style.animation = ctx.tweens.intern(row) + 1;
  }
}

function tweenRow(mask: number, spec: TransitionSpec): BuiltTween {
  return {
    mask,
    duration: spec.duration,
    delay: spec.delay,
    // A transition runs exactly once. It is the same column an animation's
    // `infinite` uses, which is the whole point of one table.
    iterations: 1,
    firstSegment: -1,
    segmentCount: 0,
    easing: spec.easing.easing,
    easeA: spec.easing.a,
    easeB: spec.easing.b,
    easeC: spec.easing.c,
    easeD: spec.easing.d,
  };
}

/**
 * One animation as a tween row plus its keyframe run, or `null` for nothing to run.
 *
 * Everything the engine cannot express is refused **by name** here rather than
 * approximated, which is the same call `appearance: base` and a reordered
 * `transform` list already got. An `alternate` animation silently played forwards
 * would be a bug an author cannot see the cause of.
 */
function animationRow(
  style: ComputedStyle,
  spec: AnimationSpec,
  where: string,
  resolve: (value: string) => string | null,
  ctx: AnimContext,
  warn: (message: string) => void,
): BuiltTween | null {
  if (spec.name === "") return null;

  // The duration first, and the order matters. A zero duration is CSS's *initial*
  // value, so `animation-name: spin` with nothing else is the ordinary "named but not
  // started" case and warning about it would be noise on every build. Only once an
  // author has asked for a duration is a name that resolves to nothing a mistake
  // worth a word.
  if (spec.duration <= 0) return null;

  const blocks = ctx.keyframes.get(spec.name);
  if (blocks === undefined) {
    // CSS says an `animation-name` matching no `@keyframes` runs nothing, so this is
    // not an error — but it is almost always a typo or a missing import, and it is
    // otherwise invisible.
    warn(`no @keyframes named "${spec.name}"`);
    return null;
  }

  if (spec.direction !== "normal") {
    warn(`animation-direction: ${spec.direction} is not supported; running forwards`);
  }
  if (spec.fill !== "none" && Number.isFinite(spec.iterations)) {
    warn(`animation-fill-mode: ${spec.fill} is not supported; the element returns to its own style`);
  }

  const segments = resolveKeyframes(style, blocks, spec, resolve, ctx);
  // Two rows are the minimum for a segment to exist at all. `resolveKeyframes`
  // always synthesises both endpoints, so this only trips if a `@keyframes` block
  // list was empty — which the parser already refuses to record.
  if (segments.length < 2) return null;

  const first = ctx.tweens.addSegments(segments);
  return {
    // Which fields an animation may move is not the author's list but the
    // keyframes' own. There is no `animation-property` in CSS for exactly this
    // reason, and there is nothing for one to say.
    mask: maskOfKeyframes(blocks, warn),
    duration: spec.duration,
    delay: spec.delay,
    iterations: spec.iterations,
    firstSegment: first,
    segmentCount: segments.length,
    easing: spec.easing.easing,
    easeA: spec.easing.a,
    easeB: spec.easing.b,
    easeC: spec.easing.c,
    easeD: spec.easing.d,
  };
}

/**
 * The keyframe rows for one animation, ascending, with both endpoints present.
 *
 * Three measured facts are built in here rather than left to the engine.
 *
 * A multi-offset selector is **duplicated**: `75%, 100% { … }` produces two rows.
 * Measured — a list built that way reads halfway to *75%*, not to 100%, a third of
 * the way through.
 *
 * A missing `0%` or `100%` is the element's **own computed style**, which is the row
 * this element already interns to. Tailwind's `ping` has no `0%` at all and reads
 * the element's `opacity: 1` there. So the synthesised endpoint needs no value
 * invented for it.
 *
 * And a keyframe's `animation-timing-function` governs the segment **leaving** it,
 * so it rides on that keyframe's own row and the last row's is never read.
 */
function resolveKeyframes(
  style: ComputedStyle,
  blocks: readonly KeyframeBlock[],
  spec: AnimationSpec,
  resolve: (value: string) => string | null,
  ctx: AnimContext,
): BuiltKeyframe[] {
  // A keyframe row is a value, never a state: it must not carry the animation it
  // is a frame of, or the engine would find a segment that claims to start one.
  const canvas: ComputedStyle = { ...style, animation: 0 };

  const rows: BuiltKeyframe[] = [];
  for (const block of blocks) {
    const patch: Partial<Record<StyleField, number>> = {};
    for (const [prop, value] of block.decls) {
      if (prop.startsWith("--")) continue;
      // `animation-timing-function` inside a keyframe is the segment's easing, not
      // a style field — measured: it never reaches the element's computed style.
      if (prop === "animation-timing-function") continue;
      const resolved = resolve(value);
      if (resolved === null) continue;
      try {
        expandDeclaration(prop, resolved, patch);
      } catch {
        // A keyframe declaring something dziri cannot express is dropped, which is
        // what CSS does with an invalid declaration inside a keyframe too. Silent
        // because `@keyframes` in a Tailwind sheet is boilerplate the author did
        // not write, and the fields that matter are covered by the mask.
      }
    }

    const easing = keyframeEasing(block, resolve, spec.easing);
    const styleId = ctx.styles.intern({ ...canvas, ...patch });
    for (const offset of block.offsets) {
      rows.push({
        style: styleId,
        offset,
        easing: easing.easing,
        easeA: easing.a,
        easeB: easing.b,
        easeC: easing.c,
        easeD: easing.d,
      });
    }
  }

  // Stable, so two keyframes at the same offset keep source order and the later
  // one wins the segment that leaves it — which is what a browser does.
  rows.sort((a, b) => a.offset - b.offset);

  const base = (offset: number): BuiltKeyframe => ({
    style: ctx.styles.intern(canvas),
    offset,
    easing: spec.easing.easing,
    easeA: spec.easing.a,
    easeB: spec.easing.b,
    easeC: spec.easing.c,
    easeD: spec.easing.d,
  });

  if (rows.length === 0 || rows[0]!.offset > 0) rows.unshift(base(0));
  if (rows[rows.length - 1]!.offset < 1) rows.push(base(1));
  return rows;
}

/** A keyframe's own easing, or the animation's when it names none. */
function keyframeEasing(
  block: KeyframeBlock,
  resolve: (value: string) => string | null,
  fallback: Curve,
): Curve {
  const raw = block.decls.get("animation-timing-function");
  if (raw === undefined) return fallback;
  const resolved = resolve(raw);
  if (resolved === null) return fallback;
  return parseEasing(resolved) ?? fallback;
}

/**
 * The fields a `@keyframes` block list may move — the properties it *mentions*.
 *
 * CSS has no `animation-property`, and this is why it needs none: every segment row
 * is the same base row with some keyframe's declarations over it, so the fields the
 * keyframes mention are exactly the fields that can differ. Deriving the mask from
 * the declarations rather than by diffing the resolved rows also means it goes
 * through the same `transitionMask` as a transition — so `transform: none` in a
 * keyframe covers all nine transform fields, and a keyframe animating `width` is
 * refused by the same named warning either syntax gets.
 *
 * A field in the mask whose value happens not to differ costs nothing: it
 * interpolates from a value to itself. A field *outside* it reads the destination
 * row, which for an animation is the base value — which is why over-inclusion is
 * safe here and under-inclusion would freeze a property at a keyframe's value.
 */
function maskOfKeyframes(
  blocks: readonly KeyframeBlock[],
  warn: (message: string) => void,
): number {
  const mentioned = new Set<string>();
  for (const block of blocks) {
    for (const prop of block.decls.keys()) {
      if (prop.startsWith("--") || prop === "animation-timing-function") continue;
      mentioned.add(prop);
    }
  }
  return transitionMask([...mentioned], warn);
}

// ---------------------------------------------------------------------------
// Building the node tree
// ---------------------------------------------------------------------------

type BuiltNode = {
  kind: number;
  style: number;
  /** Predicate bits this node's styling depends on. */
  mask: number;
  /**
   * One style id per combination of the predicates in `mask`, indexed by those
   * bits compacted down. `run[0]` is the base style.
   *
   * Each entry is resolved as a **full cascade with that combination of states
   * active**, which is what makes `:hover` and `:focus` merge per property
   * instead of one winning outright. `collectDecls` already accepted a set of
   * states; nothing else knew to ask it for more than one at a time.
   */
  run: number[];
  text: number;
  parent: number;
  children: number[];
  /**
   * A box generated by `::before` / `::after`.
   *
   * Emitted so the engine can resolve this node's per-node predicates against its
   * *parent*: `.btn:hover::before` is about the button being hovered, and a
   * generated box is never `state.hovered` itself because `hit_test` only returns
   * interactive nodes.
   */
  generated?: true;
  /**
   * The control node a press here operates. Filled by `resolveActivation`.
   *
   * Absent rather than -1 while it is being computed, so "not decided yet" and
   * "decided to be nothing" stay distinguishable during the propagation sweep.
   */
  activates?: number;
  /**
   * This element handles its own press, so a label's target does not reach it.
   *
   * HTML's "interactive content" exclusion, which is what stops a `<button>` inside
   * a label from toggling the checkbox beside it. Recorded during the walk because
   * it is a fact about the *element* and `resolveActivation` works on nodes.
   */
  ownsPress?: true;
};

/**
 * Predicate bit ↔ the pseudo-class that sets it.
 *
 * The one place a per-node predicate is named. Everything downstream — the mask,
 * the run, the patch machinery, the engine — works on bits, so widening the set of
 * states dziri understands is an entry here plus one in `SUPPORTED_PSEUDO`.
 * `:checked` and `:disabled` are the first two added since that became true, and
 * they cost exactly that (ROADMAP C2).
 */
export const PREDICATE_PSEUDO: Array<[number, Pseudo]> = [
  [Predicate.HOVER, "hover"],
  [Predicate.ACTIVE, "active"],
  [Predicate.FOCUS, "focus"],
  [Predicate.CHECKED, "checked"],
  [Predicate.DISABLED, "disabled"],
];

/**
 * The style a node wears with exactly one predicate live, or -1 when that
 * predicate changes nothing for it.
 *
 * Derived from `mask` and `run` rather than stored, which is the point. The IR
 * used to carry a `(hover, active, focus)` triple beside them — the same fact in
 * two shapes, and a third place to edit for every new state. `run` is what ships;
 * this is a view of it, and it is only ever wanted by the tools that report
 * per-role numbers.
 */
export function soleStyle(node: { style: number; mask: number; run: number[] }, bit: number): number {
  if ((node.mask & bit) === 0) return -1;
  const id = node.run[compactBits(bit, node.mask)]!;
  return id === node.style ? -1 : id;
}

/** Gathers the bits of `value` set in `mask` down to a dense index. */
function compactBits(value: number, mask: number): number {
  let out = 0;
  let bit = 0;
  let remaining = mask;

  while (remaining !== 0) {
    const lowest = remaining & -remaining;
    if ((value & lowest) !== 0) out |= 1 << bit;
    bit++;
    remaining &= remaining - 1;
  }
  return out;
}

/** The bits of `mask`, low to high. */
function maskBits(mask: number): number[] {
  const bits: number[] = [];
  let remaining = mask;
  while (remaining !== 0) {
    const lowest = remaining & -remaining;
    bits.push(lowest);
    remaining &= remaining - 1;
  }
  return bits;
}

const KIND_BY_TAG: Record<string, number> = {
  button: NodeKind.BUTTON,
};

/**
 * Compiler-side bindings. `source` holds the signal object as authored; the
 * resolve pass replaces it with `export`, the name the generated module imports.
 */
export type BuiltTextBinding = {
  node: number;
  slot: number;
  parts: TextPart[];
};

export type BuiltHandler = {
  node: number;
  /** As authored: a function in JSX, or a name from an HTML `onclick`. */
  ref: unknown;
  /** Filled in by the resolve pass. */
  name: string;
};

/** A bound text run inside a list item, addressed relative to the item root. */
export type BuiltItemBinding = {
  /** Node offset within the item subtree. */
  offset: number;
  /** String-slot offset within the item's slot block. */
  slotOffset: number;
  parts: TextPart[];
};

/**
 * A click handler inside a list item, addressed by offset within the item.
 *
 * Per-row rather than per-node because every row shares the template: the runtime
 * turns the clicked node back into (slot, offset), then calls the handler with the
 * item that slot is currently rendering.
 */
export type BuiltItemHandler = {
  offset: number;
  ref: unknown;
  name: string;
};

export type BuiltList = {
  /** The node the rows are children of. There is no wrapper. */
  container: number;
  /** Static sibling the rows follow, or -1 for the container's first child. */
  anchorPrev: number;
  /** Static sibling the last row points at, or -1 for end of chain. */
  anchorNext: number;
  source: unknown;
  /** Filled in by the reference-resolution pass. */
  exportName: string;
  arenaStart: number;
  stride: number;
  capacity: number;
  keyPath: (string | number)[];
  bindings: BuiltItemBinding[];
  itemHandlers: BuiltItemHandler[];
  /** First string slot of item 0's block; each item owns `bindings.length` slots. */
  slotStart: number;
};

/** A node that routes keystrokes into a string signal while focused. */
export type BuiltEditable = {
  node: number;
  ref: unknown;
  name: string;
};

/** One row of the controls table: what a press does, and the authored state. */
export type BuiltControl = {
  node: number;
  /** `ControlKind`. */
  kind: number;
  /** Radio group id, or -1. */
  group: number;
  /** `ControlFlags`. */
  flags: number;
};

/**
 * `ControlKind` by tag and `type` attribute.
 *
 * Only the two types whose activation *does* something are here. The other twenty
 * input types are still real elements with real UA styling; they simply have no
 * press behaviour for the engine to run, so giving them a row would be a row that
 * means "nothing happens". `select` is deliberately absent too — opening a picker
 * needs the overlay layer, and a `ControlKind.SELECT` that toggled nothing would be
 * a claim this cannot honour.
 */
function controlKindOf(el: Element): number {
  if (el.tag !== "input") return ControlKind.NONE;
  switch ((el.attrs.get("type") ?? "text").toLowerCase()) {
    case "checkbox":
      return ControlKind.CHECKBOX;
    case "radio":
      return ControlKind.RADIO;
    default:
      return ControlKind.NONE;
  }
}

/**
 * Whether a press on this element is aimed at *it* rather than at a label's
 * control.
 *
 * HTML calls this "interactive content" and excludes it from a label's activation
 * behaviour, which is why a button inside a label does not tick the checkbox beside
 * it. dziri can only produce two kinds of it — a control and a `<button>` — so this
 * is that category narrowed to what is reachable, not a general implementation of
 * it.
 */
function ownsItsPress(el: Element): boolean {
  return el.tag === "button" || el.tag === "a" || controlKindOf(el) !== ControlKind.NONE;
}

export type CompileResult = {
  strings: string[];
  styles: ComputedStyle[];
  nodes: BuiltNode[];
  root: number;
  textBindings: BuiltTextBinding[];
  handlers: BuiltHandler[];
  editables: BuiltEditable[];
  lists: BuiltList[];
  /** One row per distinct media condition, in predicate-bit order. */
  media: BuiltMedia[];
  /** Interned transition and animation specs; a style row points at one by index+1. */
  tweens: BuiltTween[];
  /** Keyframe runs, addressed by a tween's `firstSegment`/`segmentCount`. */
  keyframes: BuiltKeyframe[];
  /** Form controls, ascending by node. */
  controls: BuiltControl[];
  /** Diagnostics worth surfacing but not worth failing over. */
  warnings: string[];
};

/** A media condition as the wire carries it: a bit, an axis+side, a threshold. */
export type BuiltMedia = { bit: number; kind: number; value: number };

/** What the emitter needs to know about a window's routes. */
export type EmittedRouting = {
  /** Folder name — the window's id. */
  window: string;
  config: WindowConfig;
  routes: RouteNodes[];
  /** Index in `routes` of the route showing on the first frame. */
  initial: number;
  /**
   * Export name of the window's route signal, or null when it declared none.
   *
   * A window without one is not broken — it renders its initial route and never
   * changes, which is what every screenshot and golden scenario wants.
   */
  routeSignal: string | null;
};

/**
 * Nodes hidden on the first frame: everything off the initial route's chain.
 *
 * An ancestor of the active route stays visible, because the active route is
 * rendered *inside* it — that is what makes a layout a layout. Everything else is
 * resident and excluded, which is the measured design: 20 routes with 19 hidden
 * cost 1.39 ms against 6.04 ms before the diff carried changed node indices.
 */
function hiddenAtStart(nodeCount: number, routing: EmittedRouting): number[] {
  const hidden = new Array<number>(nodeCount).fill(0);
  const chain = routeChain(routing.routes, routing.initial);

  for (const [i, route] of routing.routes.entries()) {
    if (chain.has(i)) continue;
    for (const node of route.roots) hidden[node] = 1;
  }

  return hidden;
}

export function compile(html: string, css: string): CompileResult {
  return compileTree(parseHtml(html), css);
}

/**
 * Compiles an already-parsed document container. The HTML parser and the JSX
 * runtime both produce this shape, so both authoring front-ends share every
 * downstream stage — cascade, variants, interning, emit.
 */
export function compileTree(
  doc: Element,
  css: string,
  opts: {
    /**
     * Filled in with the node each element became, when a caller needs to find
     * its way back.
     *
     * The router is the caller that does: it splices a page's tree into the
     * window's and then has to know which nodes that page owns, so navigation can
     * hide them. Nothing in the tree carries an identity the IR keeps — node ids
     * are positions — so the mapping has to be handed out while the positions are
     * being assigned or reconstructed by counting afterwards, and counting is the
     * version that breaks the first time a node is dropped.
     */
    nodeOf?: Map<Element, number>;
  } = {},
): CompileResult {
  // UA rules first in the array purely for readability; `Origin.UA` is what
  // actually keeps them below the author's, and it beats specificity.
  const uaSheet = parseCss(UA_SHEET, Origin.UA);
  const authorSheet = parseCss(css);
  const rules = [...uaSheet, ...authorSheet];

  // `@property` registrations from both sheets. Author last, so an app that
  // re-registers one of the UA sheet's properties wins — the same precedence
  // everything else here has.
  const registered = new Map([...uaSheet.properties, ...authorSheet.properties]);

  // `@keyframes` from both sheets, author last for the same reason: two blocks
  // sharing a name means the later one wins, and the author's sheet is later.
  const keyframeBlocks = new Map([...uaSheet.keyframes, ...authorSheet.keyframes]);

  // Assigned as conditions are met during the walk, so bit order is first-use
  // order and a sheet's unused breakpoints cost nothing.
  const media = new MediaBits();

  // `body`, when present, *is* the root container — it receives the window rect,
  // so `body { background: ... }` fills the window as an author expects.
  const elementChildren = doc.children.filter((c): c is Element => c.type === "element");
  const rootEl =
    elementChildren.length === 1 && elementChildren[0]!.tag === "body" ? elementChildren[0]! : doc;

  const styles = new StyleInterner();
  const strings: string[] = [];
  const stringIds = new Map<string, number>();
  const nodes: BuiltNode[] = [];
  const warnings: string[] = [];
  const tweens = new TweenInterner();
  /** Timing diagnostics already reported, so one mistake is one line. */
  const timingWarned = new Set<string>();
  const anim: AnimContext = {
    keyframes: keyframeBlocks,
    styles,
    tweens,
    warn: (message, where) => {
      if (timingWarned.has(message)) return;
      timingWarned.add(message);
      warnings.push(`${where}: ${message}`);
    },
  };
  const textBindings: BuiltTextBinding[] = [];
  const handlers: BuiltHandler[] = [];
  const lists: BuiltList[] = [];
  /**
   * Where each list splices into its container, recorded while walking and
   * resolved once every container's child array is final.
   *
   * `after` is how many static children the container had when the list was
   * reached, so the anchors are `children[after - 1]` and `children[after]`.
   * It cannot be read at the time: the sibling *following* the list has not
   * been compiled yet.
   */
  const pendingAnchors: Array<{ list: number; container: number; after: number }> = [];
  const editables: BuiltEditable[] = [];

  /**
   * Every element that got a node, so the label pass can start from markup.
   *
   * A `for=` label points at an element by id, and that element may not have been
   * compiled yet — so this cannot be resolved while walking, and the pass that does
   * it needs the element tree rather than the node arrays. Filled unconditionally,
   * unlike `opts.nodeOf`, which is a caller's optional hook.
   */
  const nodeOfEl = new Map<Element, number>();
  const controls: BuiltControl[] = [];
  /** Labels in document order, with their node, for the pass below. */
  const labelEls: Array<{ el: Element; node: number }> = [];
  /**
   * Radio group ids, interned per `(form, name)`.
   *
   * Keyed on the form *element* and not just the name, because that is measured:
   * three radios named `plan` were checked at once when two of them sat in their
   * own `<form>` — see BROWSER-FACTS.md, "A radio cannot be unchecked by pointer,
   * and its group is the form". Keying on the name alone would have silently made
   * two independent groups into one, which is the kind of bug that only shows up in
   * a form complicated enough that nobody is watching every radio.
   */
  const groupIds = new Map<string, number>();
  const formIds = new Map<Element, number>();

  /**
   * The group id for a radio, or -1 when it has no `name`.
   *
   * A nameless radio is in no group: it can be checked and never unchecked, and it
   * clears nothing. That is what a browser does, and -1 says it in a way the engine
   * needs no special case for — "clear every other member of group -1" is naturally
   * empty.
   */
  const radioGroup = (el: Element, path: Element[]): number => {
    const name = el.attrs.get("name");
    if (!name) return -1;

    // The *innermost* enclosing form. `path` is the ancestor chain, so the last one
    // wins, and nested forms — invalid HTML, but parseable — resolve the way the DOM
    // would rather than throwing.
    let form: Element | null = null;
    for (const ancestor of path) if (ancestor.tag === "form") form = ancestor;

    let formId = -1;
    if (form !== null) {
      formId = formIds.get(form) ?? formIds.size;
      formIds.set(form, formId);
    }

    const key = `${formId} ${name}`;
    const existing = groupIds.get(key);
    if (existing !== undefined) return existing;
    const id = groupIds.size;
    groupIds.set(key, id);
    return id;
  };

  /**
   * The one place text can enter the IR, and therefore the one place worth
   * checking that it is text an author actually wrote.
   *
   * A stringified recording proxy is the only way a non-authored string reaches
   * here, and it would otherwise intern cleanly and render as a frozen constant
   * in every row — or, for a route parameter, in every navigation.
   */
  const checkAuthored = (s: string): string => {
    if (isItemSentinel(s)) throw new ItemExpressionError(s);
    if (isParamSentinel(s)) throw new ParamExpressionError(s);
    return s;
  };

  const internString = (s: string): number => {
    checkAuthored(s);
    const existing = stringIds.get(s);
    if (existing !== undefined) return existing;
    const id = strings.length;
    strings.push(s);
    stringIds.set(s, id);
    return id;
  };

  /**
   * Dynamic text gets its own string slot, never shared with an interned literal —
   * the runtime overwrites it, and sharing would corrupt unrelated nodes.
   */
  const reserveSlot = (initial: string): number => {
    checkAuthored(initial);
    const id = strings.length;
    strings.push(initial);
    return id;
  };

  const describe = (path: Element[]) =>
    path
      .map((e) => e.tag + (e.id ? `#${e.id}` : "") + e.classes.map((c) => `.${c}`).join(""))
      .join(" > ");

  /**
   * The matched rules for `el`, with its inline declarations layered on top.
   *
   * Inline beats every selector regardless of specificity, which is what a
   * browser does and what an author expects. It applies to the state cascades
   * too: an inline `color` outranks a `:hover` rule's colour, because that is
   * also what CSS says.
   */
  const withInline = (decls: Map<string, string>, el: Element): Map<string, string> => {
    if (!el.style) return decls;
    for (const [prop, value] of parseInlineStyle(el.style)) {
      // Re-inserted for the same reason as in `collectDecls`: an inline
      // `padding: 0` that merely *replaced* a value would still expand at the
      // cascade's position for `padding`, and a longhand from any matched rule
      // would then apply after it and win — the exact opposite of what inline
      // precedence means.
      decls.delete(prop);
      decls.set(prop, value);
    }
    return decls;
  };

  /**
   * One node's finished style plus its variant run, for the element itself or for
   * one of its pseudo-elements.
   *
   * Extracted so a generated box is not a lesser citizen. `.btn:hover::before`
   * has to work — it is how a UA stylesheet lights up a control's tick on hover —
   * and it only works if the pseudo-element gets its own predicate mask and its
   * own per-combination cascade, exactly as the element does. Sharing the code is
   * what makes that true by construction rather than by a second implementation
   * that drifts.
   *
   * `element === null` is the element itself; anything else is its generated box.
   * Inline `style=` is applied only in the first case: it is an attribute on the
   * element, and a browser does not let it reach `::before`.
   */
  function resolveVariants(
    path: Element[],
    el: Element,
    inherited: ComputedStyle,
    parentVars: VarEnv,
    where: string,
    element: PseudoElement | null,
  ): {
    style: ComputedStyle;
    styleId: number;
    mask: number;
    run: number[];
    vars: VarEnv;
    decls: Map<string, string>;
  } {
    const inline = (decls: Map<string, string>) =>
      element === null ? withInline(decls, el) : decls;

    const base = inline(collectDecls(rules, path, ["none"], media, 0, element));
    // Custom properties inherit *unless registered otherwise*, so the environment
    // is the parent's with this node's own laid over it and any non-inheriting
    // registration removed — and it is built from the *cascaded* declarations, so
    // `--x` obeys specificity like everything else.
    const vars = extendVarEnv(parentVars, base, registered);
    const style = applyDecls(inherited, base, where, vars, registered, anim);

    // Precomputed variants: the compiler emits finished styles and the runtime
    // only picks an index. Each state is resolved as a full cascade from
    // scratch, not as a patch over the base — see collectDecls.
    const styleId = styles.intern(style);

    // Which predicates this node's styling actually reads. Input state and media
    // conditions share one mask deliberately: they are the same kind of thing to
    // everything downstream, and a node styled by both `:hover` and a breakpoint
    // gets the combination resolved for both rather than one of them.
    let mask = mediaMaskFor(rules, path, media, element);
    for (const [bit, pseudo] of PREDICATE_PSEUDO) {
      if (hasPseudoRule(rules, path, pseudo, element)) mask |= bit;
    }

    // One entry per *combination*, each resolved as a full cascade with exactly
    // those states active.
    //
    // This is where hover∧focus stops being a precedence question. The old shape
    // resolved three named roles and made the runtime pick one, so a node that
    // was both hovered and focused got whichever role ranked higher and lost the
    // other's declarations entirely. Asking `collectDecls` for `["none", "hover",
    // "focus"]` gets the merge CSS specifies, per property, for free — it always
    // took a *set* of states; nothing ever passed it more than the one.
    //
    // Cost is `2^popcount(mask)` cascades for the handful of interactive nodes,
    // and interning collapses the combinations that resolve identically — which
    // is most of them, since real rules touch disjoint properties.
    const bits = maskBits(mask);
    const run: number[] = new Array(1 << bits.length).fill(styleId);

    for (let combo = 1; combo < 1 << bits.length; combo++) {
      const states: Pseudo[] = ["none"];
      let label = where + (element === null ? "" : `::${element}`);
      // The live set for this combination, as the engine will present it: the
      // actual predicate bits, not the compacted index.
      let live = 0;
      for (let b = 0; b < bits.length; b++) {
        if ((combo & (1 << b)) === 0) continue;
        const bit = bits[b]!;
        live |= bit;
        const pseudo = PREDICATE_PSEUDO.find(([p]) => p === bit)?.[1];
        if (pseudo) {
          states.push(pseudo);
          label += `:${pseudo}`;
        } else {
          label += `@${bit}`;
        }
      }

      // Each combination re-derives its own environment: `:hover { --tone: … }`
      // is a legitimate way to theme a state, and reusing the base environment
      // here would resolve the hover cascade against the resting variables.
      const stateDecls = inline(collectDecls(rules, path, states, media, live, element));
      const resolvedStyle = applyDecls(
        inherited,
        stateDecls,
        label,
        extendVarEnv(parentVars, stateDecls, registered),
        registered,
        anim,
      );
      run[combo] = styles.intern(resolvedStyle);
    }

    return { style, styleId, mask, run, vars, decls: base };
  }

  /**
   * The generated box for one pseudo-element, or -1 for "not rendered".
   *
   * CSS is explicit that an absent, `normal` or `none` `content` means the
   * pseudo-element **is not rendered at all** — it behaves as `display: none`. So
   * the common case here is returning -1, and that is not a failure: a rule like
   * `.btn::before { color: red }` with no `content` legitimately produces nothing.
   *
   * The box is a real TEXT node. That is the whole substitution for a shadow tree:
   * it lays out in Taffy, paints in the ordinary pass, inherits from its
   * originating element, and carries its own variant run — none of which a
   * paint-time synthesised rect would.
   */
  function walkPseudoElement(
    el: Element,
    path: Element[],
    ownStyle: ComputedStyle,
    parentVars: VarEnv,
    where: string,
    parent: number,
    element: PseudoElement,
  ): number {
    if (!hasPseudoElementRule(rules, path, element)) return -1;

    // Whether the box exists is settled *before* any style is interned.
    //
    // Resolving first and bailing afterwards was the obvious order and it leaked:
    // `.plain::before { color: blue }` with no `content` renders nothing, but its
    // cascade had already put a style in the table that no node points at. One
    // wasted entry per no-content rule, in a `u16`-indexed table — cheap to avoid,
    // and the kind of slow leak that is invisible until the table is full.
    //
    /**
     * The text this box would hold with `states` active, or `null` for no box.
     *
     * Resolved all the way to the final string rather than compared as source,
     * because Tailwind puts a variable in between: `before:content-['x']` emits
     * `--tw-content: 'x'; content: var(--tw-content)`, so *every* rule's `content`
     * is the identical text `var(--tw-content)` and comparing declarations would
     * see agreement where the values differ.
     *
     * The environment is the box's own — `::before { --tick: "✓"; content:
     * var(--tick) }` is legitimate, and resolving against the originating
     * element's vars would miss it.
     */
    const contentFor = (states: Pseudo[]): string | null => {
      const decls = collectDecls(rules, path, states, media, 0, element);
      const raw = decls.get("content");
      if (raw === undefined) return null;

      const substituted = raw.includes("var(")
        ? substituteVars(raw, extendVarEnv(parentVars, decls, registered), 0, registered)
        : raw;
      // CSS drops a declaration whose `var()` cannot resolve, and an absent
      // `content` means no box — so the two arrive at the same answer.
      if (substituted === null) return null;

      try {
        return parseContent(substituted);
      } catch (e) {
        throw new Error(`${where}::${element}: ${(e as Error).message}`);
      }
    };

    const text = contentFor(["none"]);
    if (text === null) return -1;

    // `content` must not vary by state, and this refuses rather than picks.
    //
    // `.box:checked::before { content: "✓" }` is the canonical checkbox tick, and
    // taking the resting value for it — which is what reading only the base
    // cascade does — compiles a tick that never appears. Silent, and it looks
    // like a stylesheet bug rather than a missing feature.
    //
    // It is missing because a node's text is one string slot, while a variant run
    // carries style ids only. Making text vary per predicate is a protocol change
    // (a slot per combination), not a compiler one, so the honest answer today is
    // an error that names the workaround: keep `content` constant and toggle a
    // style property, which is the more common spelling anyway.
    for (const [, pseudo] of PREDICATE_PSEUDO) {
      if (!hasPseudoRule(rules, path, pseudo, element)) continue;
      const stateText = contentFor(["none", pseudo]);
      if (stateText !== text) {
        throw new Error(
          `${where}::${element}: \`content\` cannot depend on \`:${pseudo}\` yet — ` +
            `it resolves to ${JSON.stringify(text)} at rest and ` +
            `${JSON.stringify(stateText ?? "(no box)")} when :${pseudo}.\n` +
            `  A node's text is one string slot and a variant run carries style ids, so ` +
            `per-state text needs a protocol change rather than a compiler one.\n` +
            `  Keep \`content\` the same in both and toggle a style property instead — ` +
            `e.g. \`::before { content: "✓"; color: transparent }\` with ` +
            `\`:${pseudo}::before { color: white }\`.`,
        );
      }
    }

    const inherited = inheritFrom(ownStyle);
    const r = resolveVariants(path, el, inherited, parentVars, where, element);

    const self = nodes.length;
    nodes.push({
      kind: NodeKind.TEXT,
      style: r.styleId,
      mask: r.mask,
      run: r.run,
      text: internString(text),
      parent,
      children: [],
      generated: true,
    });
    return self;
  }

  /** Returns the index of the node created for `el`. */
  function walk(
    el: Element,
    path: Element[],
    parentStyle: ComputedStyle,
    parent: number,
    parentVars: VarEnv = EMPTY_VARS,
  ): number {
    const where = describe(path);

    const inherited = inheritFrom(parentStyle);
    const { style, styleId, mask, run, vars } = resolveVariants(
      path,
      el,
      inherited,
      parentVars,
      where,
      null,
    );

    const self = nodes.length;
    nodes.push({
      kind: KIND_BY_TAG[el.tag] ?? NodeKind.BOX,
      style: styleId,
      mask,
      run,
      text: -1,
      parent,
      children: [],
      ...(ownsItsPress(el) ? { ownsPress: true as const } : {}),
    });
    opts.nodeOf?.set(el, self);
    nodeOfEl.set(el, self);

    if (el.onClick) handlers.push({ node: self, ref: el.onClick, name: "" });
    if (el.bindValue) editables.push({ node: self, ref: el.bindValue, name: "" });

    if (el.tag === "label") labelEls.push({ el, node: self });
    const controlKind = controlKindOf(el);
    if (controlKind !== ControlKind.NONE) {
      controls.push({
        node: self,
        kind: controlKind,
        group: controlKind === ControlKind.RADIO ? radioGroup(el, path) : -1,
        // Presence, not value: `<input checked>` and `checked=""` both mean checked,
        // which is what `parseAttributes` already normalises to.
        flags:
          (el.attrs.has("checked") ? ControlFlags.CHECKED : 0) |
          (el.attrs.has("disabled") ? ControlFlags.DISABLED : 0),
      });
    }

    // `::before` is "an immediate child of the originating element", first in
    // order; `::after` is last. Ordinary children in between — so the generated
    // boxes are siblings of the real content, which is exactly what the spec
    // describes and what makes Taffy lay them out with no special case.
    const before = walkPseudoElement(el, path, style, vars, where, self, "before");
    const after = walkPseudoElement(el, path, style, vars, where, self, "after");

    // A button whose content is a single static text run keeps the label on the
    // button itself, so paint can centre it without a child node to lay out.
    // A *dynamic* label stays a child node, since the binding addresses a node.
    //
    // A generated box disqualifies the shortcut: the label would be painted by the
    // button while `::before` was a child node, and the two have no way to sit
    // beside each other. Rare enough to be worth the extra node rather than a
    // second layout path.
    const kids = uaChildren(el);
    const onlyText =
      kids.length === 1 && kids[0]!.type === "text" ? (kids[0] as { value: string }).value : null;

    if (nodes[self]!.kind === NodeKind.BUTTON && onlyText !== null && before === -1 && after === -1) {
      nodes[self]!.text = internString(onlyText);
      return self;
    }

    if (before !== -1) nodes[self]!.children.push(before);
    for (const child of kids) {
      const childIndex = walkChild(child, path, style, self, vars);
      if (childIndex !== -1) nodes[self]!.children.push(childIndex);
    }
    if (after !== -1) nodes[self]!.children.push(after);

    return self;
  }

  /**
   * Compiles a list into a LIST node plus an arena of identical item subtrees.
   *
   * The template is compiled once through the ordinary `walk`, so items get the
   * same cascade, inheritance and variants as anything else — the arena is only a
   * layout of node *slots*. Replication then copies those nodes with their links
   * shifted by one stride, which is what keeps item-internal traversal ordinary.
   */
  function walkList(
    node: DynList,
    path: Element[],
    parentStyle: ComputedStyle,
    parent: number,
    parentVars: VarEnv = EMPTY_VARS,
  ): number {
    // Item 0 is compiled normally; its bindings are captured relative to it.
    // Its parent is the *container*, not a wrapper: rows are ordinary children
    // spliced into the container's chain, so a grid container places each row
    // in its own cell and a `justify-content` has more than one item to work
    // with. See `ListTable.container` for what the wrapper cost.
    const arenaStart = nodes.length;
    const bindingsBefore = textBindings.length;
    const templateRoot = walkChild(node.template, path, parentStyle, parent, parentVars);
    const stride = nodes.length - arenaStart;

    if (templateRoot !== arenaStart) {
      throw new Error("list template did not compile to a contiguous subtree");
    }

    // Handlers inside the template belong to the row, not to a fixed node.
    const itemHandlers: BuiltItemHandler[] = [];
    for (let h = handlers.length - 1; h >= 0; h--) {
      const handler = handlers[h]!;
      if (handler.node < arenaStart || handler.node >= arenaStart + stride) continue;
      itemHandlers.unshift({ offset: handler.node - arenaStart, ref: handler.ref, name: "" });
      handlers.splice(h, 1);
    }

    // Item bindings were recorded as ordinary text bindings; lift them out.
    const raw = textBindings.splice(bindingsBefore);

    // A template that reads nothing from its item is always a mistake.
    //
    // `key` is mandatory precisely because rows have identity, so a keyed list
    // whose rows neither display item data nor handle a per-row event is a row
    // of constants repeated `capacity` times. The usual cause is an expression
    // the recorder cannot see through — the sentinel catches the ones that reach
    // a string, and this catches the rest (a `.filter()`, a destructure, an
    // early return).
    if (raw.length === 0 && itemHandlers.length === 0) {
      throw new Error(
        `list template reads nothing from its item, so every row would render the same\n` +
          `  constants. The callback runs once at build time against a recording proxy: it\n` +
          `  can record a bare property read like \`{t.title}\`, but not a value computed\n` +
          `  from one. If the row genuinely has no dynamic content, use a plain array —\n` +
          `  \`[...items].map(…)\` compiles to literal nodes with no arena.`,
      );
    }
    const slotStart = strings.length;
    const bindings: BuiltItemBinding[] = raw.map((b, i) => ({
      offset: b.node - arenaStart,
      slotOffset: i,
      parts: b.parts,
    }));

    // Re-point item 0's own text slots into its slot block, then reserve blocks
    // for the remaining items so every row has its own mutable strings.
    for (const [i, b] of raw.entries()) {
      nodes[b.node]!.text = reserveSlot(strings[b.slot] ?? "");
      void i;
    }
    for (let item = 1; item < node.capacity; item++) {
      for (let b = 0; b < bindings.length; b++) reserveSlot("");
    }

    // Replicate item 0 into the rest of the arena.
    for (let item = 1; item < node.capacity; item++) {
      const shift = item * stride;
      for (let k = 0; k < stride; k++) {
        const src = nodes[arenaStart + k]!;
        nodes.push({
          kind: src.kind,
          style: src.style,
          mask: src.mask,
          run: [...src.run],
          text: src.text,
          parent: k === 0 ? parent : src.parent + shift,
          children: src.children.map((c) => c + shift),
          ...(src.generated ? { generated: true as const } : {}),
        });
      }
      // Each replica's bound slots live in its own block.
      for (const b of bindings) {
        nodes[arenaStart + shift + b.offset]!.text = slotStart + item * bindings.length + b.slotOffset;
      }
    }

    lists.push({
      container: parent,
      // Resolved after the container's child loop finishes, because the sibling
      // that follows the rows has not been compiled yet. Item 0's subtree is
      // already in `nodes`, so the arena occupies indices the anchors are not
      // allowed to name — which is why these are static children only.
      anchorPrev: -1,
      anchorNext: -1,
      source: node.source,
      exportName: "",
      arenaStart,
      stride,
      capacity: node.capacity,
      keyPath: node.keyPath,
      bindings,
      itemHandlers,
      slotStart,
    });

    // No node of its own. The rows enter the container's chain at run time, so
    // this contributes nothing static and the caller pushes nothing.
    pendingAnchors.push({
      list: lists.length - 1,
      container: parent,
      after: nodes[parent]?.children.length ?? 0,
    });
    return -1;
  }

  function walkChild(
    node: Node,
    path: Element[],
    parentStyle: ComputedStyle,
    parent: number,
    parentVars: VarEnv = EMPTY_VARS,
  ): number {
    if (node.type === "dynlist") return walkList(node, path, parentStyle, parent, parentVars);

    if (node.type === "text" || node.type === "dyntext") {
      const self = nodes.length;

      // Dynamic runs render their literals only until the first `update(state)`.
      const initial =
        node.type === "text"
          ? node.value
          : node.parts.map((p) => ("literal" in p ? p.literal : "")).join("");

      const slot = node.type === "text" ? internString(initial) : reserveSlot(initial);

      const textStyleId = styles.intern(textStyle(parentStyle));
      nodes.push({
        kind: NodeKind.TEXT,
        style: textStyleId,
        mask: 0,
        run: [textStyleId],
        text: slot,
        parent,
        children: [],
      });

      if (node.type === "dyntext") {
        textBindings.push({ node: self, slot, parts: node.parts });
      }
      return self;
    }
    return walk(node, [...path, node], parentStyle, parent, parentVars);
  }

  const rootIndex =
    rootEl.type === "element" && rootEl.tag !== "#root"
      ? walk(rootEl, [rootEl], INITIAL_STYLE, -1)
      : walk(rootEl, [], INITIAL_STYLE, -1);

  if (rootEl.tag === "#root" && elementChildren.length > 1) {
    warnings.push(
      `document has ${elementChildren.length} top-level elements; they were wrapped in a synthetic root`,
    );
  }

  // Every container's child array is final now, so the splice points resolve.
  for (const pending of pendingAnchors) {
    const kids = nodes[pending.container]?.children ?? [];
    const list = lists[pending.list]!;
    list.anchorPrev = kids[pending.after - 1] ?? -1;
    list.anchorNext = kids[pending.after] ?? -1;
  }

  resolveActivation(nodes, nodeOfEl, controls, labelEls, warnings);

  return {
    strings,
    styles: styles.list,
    nodes,
    root: rootIndex,
    textBindings,
    handlers,
    editables,
    lists,
    media: media.rows().map(({ bit, cond }) => ({
      bit,
      kind:
        cond.axis === "width"
          ? cond.side === "min"
            ? MediaKind.MIN_WIDTH
            : MediaKind.MAX_WIDTH
          : cond.side === "min"
            ? MediaKind.MIN_HEIGHT
            : MediaKind.MAX_HEIGHT,
      value: cond.px,
    })),
    tweens: tweens.tweens,
    keyframes: tweens.keyframes,
    controls,
    warnings,
  };
}

/**
 * Fills every node's `activates` — the control a press on it operates.
 *
 * Three steps, and the third is the one worth reading:
 *
 * 1. Each control points at itself.
 * 2. Each `<label>` points at its control: the one named by `for=`, else the first
 *    control in its subtree. Measured, both forms forward — see BROWSER-FACTS.md,
 *    "A label's click is a second, synthetic click on the control".
 * 3. **Every other node inherits from its parent**, in one forward pass. Node ids are
 *    assigned parent-first by `walk`, so a single ascending sweep propagates a
 *    label's target through its whole subtree and a control's through its `::before`
 *    and `::after` boxes — which is what makes clicking a checkbox's *tick* tick it.
 *
 * The sweep stops at anything that owns its own press. A `<button>` inside a label
 * is HTML's "interactive content" exclusion, and without the stop a button in a
 * label would silently toggle the checkbox next to it.
 *
 * A `for=` that names nothing, or names something that is not a control, is a
 * warning rather than an error: it is a typo in markup that renders perfectly, and
 * the label simply stops forwarding. Failing the build over it would be worse than
 * the bug.
 */
function resolveActivation(
  nodes: BuiltNode[],
  nodeOfEl: Map<Element, number>,
  controls: BuiltControl[],
  labels: Array<{ el: Element; node: number }>,
  warnings: string[],
): void {
  if (controls.length === 0) return;

  const controlNodes = new Set(controls.map((c) => c.node));
  for (const control of controls) nodes[control.node]!.activates = control.node;

  const byId = new Map<string, Element>();
  for (const el of nodeOfEl.keys()) {
    const id = el.id;
    if (id !== null && !byId.has(id)) byId.set(id, el);
  }

  /** The first control in `el`'s subtree, in document order. */
  const firstControlIn = (el: Element): number => {
    for (const child of el.children) {
      if (child.type !== "element") continue;
      const node = nodeOfEl.get(child);
      if (node !== undefined && controlNodes.has(node)) return node;
      const deeper = firstControlIn(child);
      if (deeper >= 0) return deeper;
    }
    return -1;
  };

  for (const { el, node } of labels) {
    const target = el.attrs.get("for");
    if (target !== undefined) {
      const named = byId.get(target);
      const namedNode = named === undefined ? undefined : nodeOfEl.get(named);
      if (namedNode === undefined || !controlNodes.has(namedNode)) {
        warnings.push(
          `<label for="${target}"> does not name a form control, so clicking it does nothing`,
        );
        continue;
      }
      nodes[node]!.activates = namedNode;
      continue;
    }

    const wrapped = firstControlIn(el);
    if (wrapped >= 0) nodes[node]!.activates = wrapped;
  }

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.activates !== undefined) continue;
    const parent = n.parent;
    if (parent < 0 || parent >= i) continue;
    if (n.ownsPress) continue;
    const inherited = nodes[parent]!.activates;
    if (inherited !== undefined) n.activates = inherited;
  }
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/**
 * Turns per-node child arrays into first-child / next-sibling links, which is
 * all a tree walk needs and costs two ints per node instead of an array each.
 */
function flattenLinks(nodes: BuiltNode[]): { firstChild: number[]; nextSibling: number[] } {
  const firstChild = new Array<number>(nodes.length).fill(-1);
  const nextSibling = new Array<number>(nodes.length).fill(-1);

  for (let i = 0; i < nodes.length; i++) {
    const kids = nodes[i]!.children;
    if (kids.length > 0) firstChild[i] = kids[0]!;
    for (let k = 0; k < kids.length - 1; k++) nextSibling[kids[k]!] = kids[k + 1]!;
  }

  return { firstChild, nextSibling };
}

const CTORS = {
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int16Array,
  Int32Array,
  Float32Array,
} as const;

/**
 * Collects the nodes that have any interaction-state style.
 *
 * Sparse because it is overwhelmingly empty — on a 300-item todo page, 3 of 1215
 * nodes qualify — and because the runtime only consults it for the at-most-three
 * nodes currently hovered, pressed or focused.
 */
/**
 * The variant table: which predicates each conditional node reads, and its run.
 *
 * Sparse in the same way the old state table was — on the sample, 21 of 126
 * nodes are conditional — but the sparseness now costs nothing to *extend*: a
 * node that reads a media predicate joins this table exactly like a hovered one,
 * with no new column and no protocol change.
 *
 * Runs are deduplicated. Real stylesheets give every button the same
 * `(base, hover, active)` triple, so the 21 conditional nodes on the sample share
 * a handful of distinct runs.
 */
function buildVariants(
  nodes: BuiltNode[],
  runOf: (node: number) => { mask: number; run: number[] },
): { node: number[]; mask: number[]; runStart: number[]; slots: number[] } {
  const out = {
    node: [] as number[],
    mask: [] as number[],
    runStart: [] as number[],
    slots: [] as number[],
  };
  const byRun = new Map<string, number>();

  for (let i = 0; i < nodes.length; i++) {
    const { mask, run } = runOf(i);
    if (mask === 0 || run.length <= 1) continue;

    // A node whose every combination resolves to its base style is not
    // conditional, whatever its selectors said.
    if (run.every((id) => id === run[0])) continue;

    const key = run.join(",");
    let start = byRun.get(key);
    if (start === undefined) {
      start = out.slots.length;
      out.slots.push(...run);
      byRun.set(key, start);
    }

    out.node.push(i);
    out.mask.push(mask);
    out.runStart.push(start);
  }

  return out;
}

/**
 * Nodes that can receive input.
 *
 * Emitted explicitly because inferring it from `hover >= 0` was wrong: a
 * clickable list row with no `:hover` rule would be excluded, and a node whose
 * hover style happens to equal its base collapses to -1.
 *
 * Currently a button, or anything with a state style. Event handlers will join
 * this set once they exist.
 */
/**
 * Nodes that can receive input.
 *
 * `variants` matters and is not optional in the emit path: a toggle can
 * *introduce* a state style the baseline lacks (`body.light .btn:hover`), and the
 * node's real state pointers then live in `variants`, not on the baseline node.
 * Reading only the baseline emitted a correct hover slot attached to a node that
 * could never be hovered — the style existed, the interaction did not.
 */
/**
 * Sorted ids of the `::before` / `::after` boxes.
 *
 * Sorted because the engine binary-searches it, the same contract `interactive`
 * has. Node ids are allocated in tree order and a generated box is pushed when it
 * is created, so `nodes` is already in ascending order here — the sort is a
 * cheap guarantee rather than a fix for a known disorder.
 */
function buildGenerated(nodes: BuiltNode[]): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (nodes[i]!.generated) out.push(i);
  return new Int32Array(out.sort((a, b) => a - b));
}

function buildInteractive(
  nodes: BuiltNode[],
  handlers: BuiltHandler[],
  lists: BuiltList[] = [],
  variants?: VariantCompiled,
): number[] {
  const withHandler = new Set(handlers.map((h) => h.node));

  // Per-row handlers live at an offset inside every replica, so each replica's
  // node has to be interactive — the template's single entry is not enough.
  for (const list of lists) {
    for (const h of list.itemHandlers) {
      for (let item = 0; item < list.capacity; item++) {
        withHandler.add(list.arenaStart + item * list.stride + h.offset);
      }
    }
  }

  const out: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;

    // A generated box is never independently interactive, however many state
    // styles it carries — and it usually carries one, since `:hover::before` is
    // how a control stylesheet is written.
    //
    // Marking it interactive is worse than useless, it is actively wrong.
    // `hit_test` returns the innermost *interactive* node, so the pointer landing
    // on a checkbox's tick would make the tick `state.hovered` and leave the
    // checkbox itself un-hovered — `.check:hover { border-color }` would stop
    // applying exactly when the pointer is over the middle of the control. The
    // box's own state already comes from its parent via `NodeFlags.GENERATED`, so
    // it has nothing to gain and a hover to break.
    if (n.generated) continue;

    // Either source counts: the baseline mask for a node styled by `:hover`
    // directly, the variant mask for one that only gains a state while a toggle
    // is on. The second used to be missed, which emitted a correct hover style
    // onto a node that could never be hovered.
    const stateful = n.mask !== 0 || (variants !== undefined && (variants.masks[i] ?? 0) !== 0);

    // A node that operates a control has to be hittable even with no styling of its
    // own — the `<span>` beside a checkbox is the common case, and `hit_test` only
    // ever returns an `INTERACTIVE` node. Without this the compiler would emit a
    // perfectly correct `activates` that nothing could ever reach, which is the same
    // silent shape as a variant no predicate can select.
    const operates = n.activates !== undefined;

    if (n.kind === NodeKind.BUTTON || stateful || operates || withHandler.has(i)) out.push(i);
  }
  return out;
}

/**
 * Builds the IR in memory, skipping the emit/import round trip. Used by tests
 * and by dev-mode recompilation; the app itself imports the generated module so
 * the shipping path is the one being validated.
 */
export function toCompiledUi(result: CompileResult): CompiledUi {
  const { firstChild, nextSibling } = flattenLinks(result.nodes);

  const styles = { count: result.styles.length } as Record<string, unknown>;
  for (const [field, ctor] of STYLE_FIELDS) {
    styles[field] = new CTORS[ctor](result.styles.map((s) => s[field]));
  }

  const variants = buildVariants(result.nodes, (i) => {
    const n = result.nodes[i]!;
    return { mask: n.mask, run: n.run };
  });

  return {
    strings: result.strings,
    styles: styles as CompiledUi["styles"],
    media: {
      count: result.media.length,
      bit: new Uint32Array(result.media.map((m) => m.bit)),
      kind: new Uint8Array(result.media.map((m) => m.kind)),
      value: new Float32Array(result.media.map((m) => m.value)),
    },
    nodes: {
      count: result.nodes.length,
      kind: new Uint8Array(result.nodes.map((n) => n.kind)),
      style: new Uint16Array(result.nodes.map((n) => n.style)),
      text: new Int32Array(result.nodes.map((n) => n.text)),
      parent: new Int32Array(result.nodes.map((n) => n.parent)),
      firstChild: new Int32Array(firstChild),
      nextSibling: new Int32Array(nextSibling),
      list: new Int16Array(result.nodes.length).fill(-1),
      hidden: new Uint8Array(result.nodes.length),
      activates: activatesOf(result.nodes),
    },
    variants: {
      count: variants.node.length,
      node: new Int32Array(variants.node),
      mask: new Uint32Array(variants.mask),
      runStart: new Int32Array(variants.runStart),
      slots: new Uint16Array(variants.slots),
    },
    interactive: new Int32Array(buildInteractive(result.nodes, result.handlers, result.lists)),
    generated: buildGenerated(result.nodes),
    // Bindings are resolved and emitted only on the generated-module path; the
    // in-memory IR is used by tests and the variant probe, which are static.
    textBindings: [],
    handlers: [],
    // The *table* needs no resolution — it is where each arena is and where it
    // splices in, all of it compile-time. Only the binding refs need a signal,
    // so returning an empty table here made every list invisible to anything
    // using the in-memory IR, and a test that walked one would have read
    // `undefined` and quietly agreed with itself.
    lists: listTable(result.lists),
    tweens: tweenTable(result.tweens),
    keyframes: keyframeTable(result.keyframes),
    controls: controlTable(result.controls),
    root: result.root,
  };
}

/** `activates` as the wire carries it: -1 for "a press here operates nothing". */
function activatesOf(nodes: BuiltNode[]): Int32Array {
  return Int32Array.from(nodes, (n) => n.activates ?? -1);
}

function controlTable(controls: BuiltControl[]): CompiledUi["controls"] {
  return {
    count: controls.length,
    node: Int32Array.from(controls, (c) => c.node),
    kind: Uint8Array.from(controls, (c) => c.kind),
    group: Int32Array.from(controls, (c) => c.group),
    flags: Uint8Array.from(controls, (c) => c.flags),
  };
}

function tweenTable(tweens: BuiltTween[]): CompiledUi["tweens"] {
  const f32 = (pick: (t: BuiltTween) => number) => Float32Array.from(tweens, pick);
  return {
    count: tweens.length,
    mask: Uint32Array.from(tweens, (t) => t.mask),
    duration: f32((t) => t.duration),
    delay: f32((t) => t.delay),
    iterations: f32((t) => t.iterations),
    firstSegment: Int32Array.from(tweens, (t) => t.firstSegment),
    segmentCount: Uint16Array.from(tweens, (t) => t.segmentCount),
    easing: Uint8Array.from(tweens, (t) => t.easing),
    easeA: f32((t) => t.easeA),
    easeB: f32((t) => t.easeB),
    easeC: f32((t) => t.easeC),
    easeD: f32((t) => t.easeD),
  };
}

function keyframeTable(keyframes: BuiltKeyframe[]): CompiledUi["keyframes"] {
  const f32 = (pick: (k: BuiltKeyframe) => number) => Float32Array.from(keyframes, pick);
  return {
    count: keyframes.length,
    style: Uint16Array.from(keyframes, (k) => k.style),
    offset: f32((k) => k.offset),
    easing: Uint8Array.from(keyframes, (k) => k.easing),
    easeA: f32((k) => k.easeA),
    easeB: f32((k) => k.easeB),
    easeC: f32((k) => k.easeC),
    easeD: f32((k) => k.easeD),
  };
}

function listTable(lists: BuiltList[]): CompiledUi["lists"] {
  const column = (pick: (l: BuiltList) => number) => Int32Array.from(lists, pick);
  return {
    count: lists.length,
    container: column((l) => l.container),
    anchorPrev: column((l) => l.anchorPrev),
    anchorNext: column((l) => l.anchorNext),
    arenaStart: column((l) => l.arenaStart),
    stride: column((l) => l.stride),
    capacity: column((l) => l.capacity),
    active: new Int32Array(lists.length),
    dataOffset: new Int32Array(lists.length),
  };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/** JS source for a numeric literal, preserving NaN and Infinity. */
function num(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

/**
 * A typed array as JS source, collapsing a uniform column to `new Ctor(n).fill(v)`.
 *
 * Most style fields are the same in every slot — margins, `flexShrink`, the grid
 * fields, the `min`/`max` sizes — and spelling out 49 identical values is source
 * JSC has to tokenize on every start for no information. `emit` already knew this
 * trick two hundred lines down (`new Int16Array(n).fill(-1)` for the node list
 * column); this just applies it where the values decide rather than where the
 * author remembered.
 *
 * Zero needs no `fill` at all, since every typed array is zero-filled already —
 * but `NaN` does, and it has to be tested with `Number.isNaN` because `NaN !== NaN`
 * would otherwise make every all-`auto` column look non-uniform.
 */
function typedArray(ctor: string, values: number[]): string {
  const first = values[0];
  const uniform =
    values.length > 1 &&
    first !== undefined &&
    (Number.isNaN(first)
      ? values.every(Number.isNaN)
      : values.every((v) => v === first));

  if (uniform) {
    return first === 0
      ? `new ${ctor}(${values.length})`
      : `new ${ctor}(${values.length}).fill(${num(first)})`;
  }

  return `new ${ctor}([${values.map(num).join(",")}])`;
}

/**
 * The package the framework is published as, and the specifier every generated
 * artifact imports its types through.
 *
 * One string, in one place, because it appears in emitted *text*: get it wrong
 * and the failure is a module the author never wrote failing to resolve.
 */
export const PACKAGE = "dziri";

export function emit(
  result: CompileResult,
  source: {
    html: string;
    css: string;
    /**
     * Where the generated module finds the types it claims to satisfy.
     *
     * The alternative was for the consumer to assert the shape — which is what
     * `as unknown as CompiledUi` did, and an `as unknown as` is a promise that
     * the compiler stops checking. This is the one interface in the project
     * `tsc` could not see, in a project whose entire safety story is generated
     * identity.
     *
     * Defaults to {@link PACKAGE}, which is what it should be: a bare specifier
     * resolves the same from `windows/main/ui.gen.ts`, from a scaffolded app
     * three directories deeper, and from the scratch directory `characterize`
     * diverts output to. It used to be a relative path computed from the output
     * location, which meant the emitted text changed with *where* it was written
     * — so the characterization harness compared an artifact against a golden
     * copy that differed in its import lines and nothing else.
     */
    typesFrom?: string;
  },
  /** Import specifier -> names, from the reference-resolution pass. */
  imports: Map<string, Set<string>> = new Map(),
  /**
   * Present when the document has conditional classes. Its slot-interned style
   * table and node pointers replace the baseline ones, so a toggle can patch the
   * table without any node pointer changing.
   */
  variants?: VariantCompiled,
  /**
   * Present when the document is a window with routes.
   *
   * Its effect on the tables is one column: every route off the initial chain
   * starts `hidden`, so frame 1 shows one route rather than all of them. The rest
   * is data the host reads — which nodes each route owns, and what nests in what.
   */
  routing?: EmittedRouting,
): string {
  const { strings, nodes, root } = result;
  const typesFrom = source.typesFrom ?? PACKAGE;

  const { firstChild, nextSibling } = flattenLinks(nodes);

  /**
   * A node's predicate mask and style run, in whichever style space applies.
   *
   * Both paths now produce the same thing. Without toggles it is the run `walk`
   * computed; with toggles it is the run `compileVariants` re-interned over the
   * value vector across every variant. Either way each entry is a full cascade
   * resolved with exactly that combination of states active — so hover∧focus
   * merges per property in both, which is the point.
   */
  const runOf = (i: number): { mask: number; run: number[] } => {
    const n = nodes[i]!;
    if (!variants) return { mask: n.mask, run: n.run };
    return { mask: variants.masks[i]!, run: variants.runs[i]! };
  };

  const variantTable = buildVariants(nodes, runOf);

  const interactive = buildInteractive(nodes, result.handlers, result.lists, variants);
  const styleCount = variants ? variants.slotCount : result.styles.length;
  const nodeStyle = variants ? variants.base : nodes.map((n) => n.style);

  // Signals and handlers are imported by name, so the emitted bindings hold the
  // real objects rather than keys to look up.
  // A patch or binding emitted as an expression builds its own cell, so the artifact
  // needs `computed` — an existing runtime export, so this adds no runtime surface.
  //
  // A binding from the reactive rewrite also contains `$` / `$m`, which unwrap the
  // signals it reads. Named imports here rather than the namespace the transform
  // uses in authored files: this module is generated, so nothing can collide with
  // them.
  const locals = allLocals();

  /**
   * Everything the artifact will contain *as source* rather than as a name.
   *
   * Scanned rather than tracked with flags, because the strings are produced in four
   * places — text bindings, handlers, patches, the locals registry — and a flag set in
   * three of them is an import missing from the fourth.
   */
  const emitted = [
    ...result.textBindings.flatMap((b) => b.parts).map((p) => ("export" in p ? p.export : "")),
    ...result.handlers.map((h) => h.name),
    ...locals.map((l) => `signal(${JSON.stringify(l.initial)})`),
  ].join("\n");

  const needsComputed =
    (variants?.patches ?? []).some((p) => p.exportExpression) || emitted.includes("computed(");
  const runtimeNames = [
    ...(needsComputed ? ["computed"] : []),
    ...(locals.length > 0 ? ["signal"] : []),
    ...(/\$\(/.test(emitted) ? ["$"] : []),
    ...(/\$m\(/.test(emitted) ? ["$m"] : []),
  ];

  const importLines = [
    ...(runtimeNames.length > 0
      ? [`import { ${runtimeNames.sort().join(", ")} } from "${typesFrom}/runtime/signal.ts";`]
      : []),
    ...[...imports].map(
      ([specifier, names]) =>
        `import { ${[...names].sort().join(", ")} } from ${JSON.stringify(specifier)};`,
    ),
  ].join("\n");

  /**
   * Every identifier interpolated into the generated module goes through here.
   *
   * The emitter writes JavaScript source, so an unresolved name does not produce
   * a wrong value — it produces `{ node: 1, fn:  }`, a module that cannot parse,
   * written to disk beside a "compiled" success line. The failure then surfaces
   * as a syntax error in generated code, pointing nowhere near the cause.
   *
   * `partSource` already refused an unresolved text part; handlers, list signals
   * and patch signals did not, which is how the HTML front-end shipped an
   * unparseable artifact for any `onclick`.
   */
  const identifier = (name: string, what: string): string => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(
        `${what} did not resolve to an importable name (got ${JSON.stringify(name)}).\n` +
          `  Signals and handlers must be module-level exports of the entry file or its\n` +
          `  sibling state.ts, because the generated module imports them by name — that is\n` +
          `  the only way a reference survives the compiler/runtime file boundary.`,
      );
    }
    return name;
  };

  /**
   * A resolved reference, which is a name *or* a piece of source the compiler wrote.
   *
   * Three things now have no export name to import and reach the artifact as source
   * instead: a `router.matches()` cell, an expression the reactive rewrite wrapped,
   * and component-local state with its inline handlers. Each is recognised by the
   * shape `resolve-refs` produced rather than by a flag threaded through four types.
   *
   * `identifier` still guards everything else, which is the check that stops an
   * unresolved reference becoming `{ fn:  }` on disk beside a success line.
   */
  const EMITTED = [/^computed\(\(\) => /, /^local_\d+$/, /^\(/];

  const resolved = (text: string, what: string): string =>
    EMITTED.some((shape) => shape.test(text)) ? text : identifier(text, what);

  const partSource = (part: TextPart): string => {
    if ("literal" in part) return `{ literal: ${JSON.stringify(part.literal)} }`;
    if ("export" in part) {
      return `{ signal: ${resolved(part.export, "a text binding")} }`;
    }
    if ("item" in part) return `{ path: ${JSON.stringify(part.item)} }`;
    throw new Error("unresolved text binding — resolveRefs was not run");
  };

  const textBindingSource = result.textBindings
    .map(
      (b) =>
        `  { node: ${b.node}, slot: ${b.slot}, parts: [${b.parts.map(partSource).join(", ")}] },`,
    )
    .join("\n");

  /**
   * Component-local signals, re-created here.
   *
   * The one kind of reference that does not survive the file boundary by being
   * imported. A signal declared inside a component has no export to import, so the
   * artifact declares it — which is why the initial value has to be writable down, and
   * why `local()` refuses one that is not.
   *
   * Not exported: nothing outside this module has a name for these, and exporting them
   * would put them in the runtime surface for no reason.
   */
  const localsSource =
    locals.length === 0
      ? ""
      : `/** Component-local state. Declared here because it has no name to import. */\n` +
        locals
          .map(
            (l, i) =>
              `const local_${i} = signal(${JSON.stringify(l.initial)});   // ${l.name}`,
          )
          .join("\n") +
        `\n\n`;

  const handlerSource = result.handlers
    .map(
      (h) =>
        `  { node: ${h.node}, fn: ${resolved(h.name, `the handler on node ${h.node}`)} },`,
    )
    .join("\n");

  const listBindingSource = result.lists
    .map((l) => {
      const binds = l.bindings
        .map(
          (b) =>
            `      { offset: ${b.offset}, slotOffset: ${b.slotOffset}, ` +
            `parts: [${b.parts.map(partSource).join(", ")}] },`,
        )
        .join("\n");
      const rowHandlers = l.itemHandlers
        .map((h) => `      { offset: ${h.offset}, fn: ${h.name} },`)
        .join("\n");

      return (
        `  {\n` +
        `    list: ${result.lists.indexOf(l)},\n` +
        `    signal: ${identifier(l.exportName, `the list in node ${l.container}`)},\n` +
        `    keyPath: ${JSON.stringify(l.keyPath)},\n` +
        `    slotStart: ${l.slotStart},\n` +
        `    slotsPerItem: ${l.bindings.length},\n` +
        `    bindings: [\n${binds}\n    ],\n` +
        `    itemHandlers: [\n${rowHandlers}\n    ],\n` +
        `  },`
      );
    })
    .join("\n");

  const styleArrays = STYLE_FIELDS.map(([field, ctor]) => {
    const values = variants ? variants.table[field] : result.styles.map((s) => s[field]);
    return `  ${field}: ${typedArray(ctor, values)},`;
  }).join("\n");

  /**
   * The tween and keyframe rows, from whichever pass owns the style numbering.
   *
   * Not `result` when there are conditional classes: `compileVariants` re-interns
   * the whole style table into slot space, so a keyframe's `style` index has to come
   * from the same pass that produced the table it indexes. Reading it from `result`
   * here compiled cleanly and drew every animated box in some other element's colour.
   */
  const tweenRows = variants ? variants.tweens : result.tweens;
  const keyframeRows = variants ? variants.keyframes : result.keyframes;
  // Not re-interned by `compileVariants` — a control row holds node ids and a group,
  // no style index — so `result` is the only source there is.
  const controlRows = result.controls;

  // Patches address (field, slot) pairs. Slot values are written in place, which
  // is why the style table's typed arrays are mutable and node pointers are not.
  const patchSource = (variants?.patches ?? [])
    .map((p) => {
      const entries = p.entries
        .map(
          (e) =>
            `      { field: ${JSON.stringify(e.field)}, slots: ${typedArray("Uint16Array", e.slots)}, ` +
            `on: ${typedArray("Float64Array", e.on)}, off: ${typedArray("Float64Array", e.off)} },`,
        )
        .join("\n");
      return (
        `  {\n` +
        `    className: ${JSON.stringify(p.className)},\n` +
        `    signal: ${p.exportExpression ?? identifier(p.exportName, "a conditional class")},\n` +
        `    affectsLayout: ${p.affectsLayout},\n` +
        `    entries: [\n${entries}\n    ],\n` +
        `  },`
      );
    })
    .join("\n");

  return `// GENERATED by src/compile.ts from ${source.html} + ${source.css}
// Do not edit. No CSS, no selectors, no property names — just indices.
//
// ${nodes.length} nodes, ${styleCount} style slots, ${strings.length} strings,
// ${variantTable.node.length} conditional nodes (${variantTable.slots.length} variant slots), ${interactive.length} interactive,
// ${result.textBindings.length} text bindings, ${result.handlers.length} handlers.
${importLines ? "\n" + importLines + "\n" : ""}
// Types, so this artifact is checked rather than asserted at the far end.
import type { ControlTable, HandlerBinding, KeyframeTable, ListTable, MediaTable, NodeTable, StyleTable, TextBinding, TweenTable, VariantTable${routing ? ", RouteNodes, WindowConfig" : ""} } from "${typesFrom}/ir.ts";
import type { EditableRef } from "${typesFrom}/runtime/bindings.ts";
import type { ListBindingRef } from "${typesFrom}/runtime/list-runtime.ts";
import type { StylePatchRef } from "${typesFrom}/runtime/patches.ts";${routing ? `\nimport type { ReadonlySignal } from "${typesFrom}/runtime/signal.ts";` : ""}

/** Mutable past the static entries: text bindings overwrite their own slots. */
export const strings: string[] = ${JSON.stringify(strings)};

/** Mutable: style patches write field values in place. Node pointers never change. */
export const styles = {
  count: ${styleCount},
${styleArrays}
} satisfies StyleTable;

export const nodes = {
  count: ${nodes.length},
  kind: ${typedArray("Uint8Array", nodes.map((n) => n.kind))},
  style: ${typedArray("Uint16Array", nodeStyle)},
  text: ${typedArray("Int32Array", nodes.map((n) => n.text))},
  parent: ${typedArray("Int32Array", nodes.map((n) => n.parent))},
  firstChild: ${typedArray("Int32Array", firstChild)},
  nextSibling: ${typedArray("Int32Array", nextSibling)},
  list: new Int16Array(${nodes.length}).fill(-1),
  hidden: ${routing ? typedArray("Uint8Array", hiddenAtStart(nodes.length, routing)) : `new Uint8Array(${nodes.length})`},
  activates: ${typedArray("Int32Array", [...activatesOf(nodes)])},
} satisfies NodeTable;

/**
 * Conditional styling, sparse and sorted by node.
 *
 * mask is the predicate bits a node reads; slots[runStart + i] is its style for
 * the combination whose compacted bits equal i. Runs are shared between nodes
 * that resolve identically.
 */
export const variants = {
  count: ${variantTable.node.length},
  node: ${typedArray("Int32Array", variantTable.node)},
  mask: ${typedArray("Uint32Array", variantTable.mask)},
  runStart: ${typedArray("Int32Array", variantTable.runStart)},
  slots: ${typedArray("Uint16Array", variantTable.slots)},
} satisfies VariantTable;

/** Nodes that can receive input, sorted. Emitted, never inferred. */
export const interactive = ${typedArray("Int32Array", interactive)};

/** \`::before\` / \`::after\` boxes, sorted. Their predicates come from the parent. */
export const generated = ${typedArray("Int32Array", [...buildGenerated(nodes)])};

${localsSource}/** Dynamic text runs. Literal chunks interleaved with the signals they read. */
export const textBindings = [
${textBindingSource}
] satisfies TextBinding[];

/** Click handlers, as direct references to the app's exported functions. */
export const handlers = [
${handlerSource}
] satisfies HandlerBinding[];

/** Nodes that route keystrokes into a string signal while focused. */
export const editables = [
${result.editables.map((e) => `  { node: ${e.node}, signal: ${e.name} },`).join("\n")}
] satisfies EditableRef[];

/**
 * Conditional classes, compiled to style-table writes.
 *
 * Each entry writes field values for the slots the class actually changes — no
 * class names, no cascade, and node style pointers untouched. affectsLayout says
 * whether applying it requires a relayout or only a repaint.
 */
export const stylePatches = [
${patchSource}
] satisfies StylePatchRef[];

/**
 * Dynamic lists. Each owns a contiguous arena of identical item subtrees; the
 * runtime rewrites the child chain and the bound slots, never the nodes.
 */
export const lists = {
  count: ${result.lists.length},
  container: ${typedArray("Int32Array", result.lists.map((l) => l.container))},
  anchorPrev: ${typedArray("Int32Array", result.lists.map((l) => l.anchorPrev))},
  anchorNext: ${typedArray("Int32Array", result.lists.map((l) => l.anchorNext))},
  arenaStart: ${typedArray("Int32Array", result.lists.map((l) => l.arenaStart))},
  stride: ${typedArray("Int32Array", result.lists.map((l) => l.stride))},
  capacity: ${typedArray("Int32Array", result.lists.map((l) => l.capacity))},
  active: new Int32Array(${result.lists.length}),
  dataOffset: new Int32Array(${result.lists.length}),
} satisfies ListTable;

/** Per-list: the array signal, key path, and where each item's bound slots live. */
export const listBindings = [
${listBindingSource}
] satisfies ListBindingRef[];

/**
 * Media conditions, one row per distinct threshold, in predicate-bit order.
 *
 * The engine re-evaluates these against the surface between a resize and the
 * relayout. Bun uploads them once and never looks at them again — routing a
 * resize back through Bun would lag a frame and stall whenever Bun is busy.
 */
export const media = {
  count: ${result.media.length},
  bit: ${typedArray("Uint32Array", result.media.map((m) => m.bit))},
  kind: ${typedArray("Uint8Array", result.media.map((m) => m.kind))},
  value: ${typedArray("Float32Array", result.media.map((m) => m.value))},
} satisfies MediaTable;

/**
 * Transitions and animations, interned. One row per distinct spec on the page.
 *
 * A style row points at one of these by index **+ 1**, so zero is "no tween here"
 * and a style table that starts out zeroed says the right thing. A transition and a
 * keyframe animation are rows of this one table, because they are the same
 * mechanism: interpolation between two rows of the style table, differing only in
 * where the two rows come from.
 */
export const tweens = {
  count: ${tweenRows.length},
  mask: ${typedArray("Uint32Array", tweenRows.map((t) => t.mask))},
  duration: ${typedArray("Float32Array", tweenRows.map((t) => t.duration))},
  delay: ${typedArray("Float32Array", tweenRows.map((t) => t.delay))},
  iterations: ${typedArray("Float32Array", tweenRows.map((t) => t.iterations))},
  firstSegment: ${typedArray("Int32Array", tweenRows.map((t) => t.firstSegment))},
  segmentCount: ${typedArray("Uint16Array", tweenRows.map((t) => t.segmentCount))},
  easing: ${typedArray("Uint8Array", tweenRows.map((t) => t.easing))},
  easeA: ${typedArray("Float32Array", tweenRows.map((t) => t.easeA))},
  easeB: ${typedArray("Float32Array", tweenRows.map((t) => t.easeB))},
  easeC: ${typedArray("Float32Array", tweenRows.map((t) => t.easeC))},
  easeD: ${typedArray("Float32Array", tweenRows.map((t) => t.easeD))},
} satisfies TweenTable;

/**
 * Keyframes: an offset and the interned style row it resolves to.
 *
 * Addressed as a slice by a tween's firstSegment/segmentCount. The easing on a row
 * is the curve of the segment *starting* at that keyframe — measured, and the reason
 * Tailwind's bounce needs no second concept.
 */
export const keyframes = {
  count: ${keyframeRows.length},
  style: ${typedArray("Uint16Array", keyframeRows.map((k) => k.style))},
  offset: ${typedArray("Float32Array", keyframeRows.map((k) => k.offset))},
  easing: ${typedArray("Uint8Array", keyframeRows.map((k) => k.easing))},
  easeA: ${typedArray("Float32Array", keyframeRows.map((k) => k.easeA))},
  easeB: ${typedArray("Float32Array", keyframeRows.map((k) => k.easeB))},
  easeC: ${typedArray("Float32Array", keyframeRows.map((k) => k.easeC))},
  easeD: ${typedArray("Float32Array", keyframeRows.map((k) => k.easeD))},
} satisfies KeyframeTable;

/**
 * Form controls, sparse and sorted by node.
 *
 * The flags column is the state each control was *authored* in, and is read exactly
 * once — to seed the engine's own state. The engine owns it after that, so this
 * table stays constant while a checkbox is being ticked and a republish caused by
 * some unrelated signal cannot un-tick it.
 */
export const controls = {
  count: ${controlRows.length},
  node: ${typedArray("Int32Array", controlRows.map((c) => c.node))},
  kind: ${typedArray("Uint8Array", controlRows.map((c) => c.kind))},
  group: ${typedArray("Int32Array", controlRows.map((c) => c.group))},
  flags: ${typedArray("Uint8Array", controlRows.map((c) => c.flags))},
} satisfies ControlTable;

export const root: number = ${root};
${routing ? routingSource(routing) : ""}`;
}

/**
 * The routing half of a window's artifact.
 *
 * Node ids rather than paths, because the host's job at navigation is to write
 * `hidden` — matching a concrete path against the route table is a separate
 * question with a separate table, and eventually the engine's.
 */
function routingSource(routing: EmittedRouting): string {
  const routes = routing.routes
    .map(
      (r) =>
        `  { path: ${JSON.stringify(r.path)}, roots: [${r.roots.join(", ")}],` +
        ` parent: ${r.parent} },`,
    )
    .join("\n");

  const config = Object.entries(routing.config)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`)
    .join("\n");

  return `
/** The window this artifact is, as \`<Window>\` declared it. */
export const windowConfig = {
${config}
} satisfies WindowConfig;

/**
 * Each route's own top-level nodes, in the window's match order.
 *
 * Navigation writes \`hidden\` over the routes leaving the chain and clears it over
 * the ones joining — bounded by route count, not by node count.
 */
export const routeNodes = [
${routes}
] satisfies RouteNodes[];

/** Index in \`routeNodes\` of the route the emitted \`hidden\` column shows. */
export const initialRoute: number = ${routing.initial};

/**
 * The window's route, if it declared one — \`<Window route={…}>\`.
 *
 * Navigation's entire runtime: the host subscribes, resolves the path against
 * \`routeNodes\`, and writes \`hidden\`. Null when the window never navigates.
 */
export const routeSignal: ReadonlySignal<string> | null = ${routing.routeSignal ?? "null"};

/** Folder name of the window, for diagnostics and multi-window dispatch later. */
export const windowId: string = ${JSON.stringify(routing.window)};
`;
}

// ---------------------------------------------------------------------------
// Human-readable dump — M2a's verification artifact
// ---------------------------------------------------------------------------

const KIND_NAMES = ["box", "text", "button"];
const DIRECTION_NAMES = ["row", "column"];
const JUSTIFY_NAMES = ["start", "center", "end", "space-between", "space-around"];
const ALIGN_NAMES = ["start", "center", "end", "stretch"];

function hex(argb: number): string {
  if ((argb >>> 24) === 0) return "transparent";
  const rgb = (argb & 0xffffff).toString(16).padStart(6, "0");
  const a = argb >>> 24;
  return a === 255 ? `#${rgb}` : `#${rgb}@${(a / 255).toFixed(2)}`;
}

/** Only the fields that differ from the initial value, so output stays readable. */
function describeStyle(s: ComputedStyle): string {
  const parts: string[] = [];
  for (const [field] of STYLE_FIELDS) {
    const v = s[field];
    const init = INITIAL_STYLE[field];
    const same = Number.isNaN(v) && Number.isNaN(init) ? true : v === init;
    if (same) continue;

    if (field === "bg" || field === "fg" || field === "borderColor") {
      parts.push(`${field}=${hex(v)}`);
    } else if (field === "direction") {
      parts.push(`${field}=${DIRECTION_NAMES[v]}`);
    } else if (field === "justify") {
      parts.push(`${field}=${JUSTIFY_NAMES[v]}`);
    } else if (field === "align") {
      parts.push(`${field}=${ALIGN_NAMES[v]}`);
    } else {
      parts.push(`${field}=${Number.isNaN(v) ? "auto" : v}`);
    }
  }
  return parts.length ? parts.join(" ") : "(initial)";
}

export function dump(result: CompileResult): string {
  const { nodes, styles, strings, root } = result;
  const lines: string[] = [];

  const walk = (i: number, depth: number): void => {
    const n = nodes[i]!;
    const indent = "  ".repeat(depth);
    const label = n.text >= 0 ? ` ${JSON.stringify(strings[n.text])}` : "";
    // In `PREDICATE_PSEUDO` order, so widening that table extends this line
    // rather than rewriting it — and a node with no such rule prints as before.
    const variants = PREDICATE_PSEUDO.map(([bit, pseudo]) => {
      const id = soleStyle(n, bit);
      return id >= 0 ? `${pseudo}=${id}` : null;
    })
      .filter(Boolean)
      .join(" ");

    lines.push(
      `${indent}#${i} ${KIND_NAMES[n.kind]}${label}  style=${n.style}${variants ? " " + variants : ""}`,
    );
    for (const c of n.children) walk(c, depth + 1);
  };

  lines.push("tree");
  walk(root, 1);

  lines.push("", `styles (${styles.length} unique)`);
  styles.forEach((s, i) => lines.push(`  ${String(i).padStart(3)}  ${describeStyle(s)}`));

  lines.push("", `strings (${strings.length})`);
  strings.forEach((s, i) => lines.push(`  ${String(i).padStart(3)}  ${JSON.stringify(s)}`));

  return lines.join("\n");
}
