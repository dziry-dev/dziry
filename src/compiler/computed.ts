/**
 * Declarations in, a style row out — the second half of the cascade.
 *
 * `matcher.ts` answers which declarations reach a node and hands over a
 * `Map<property, value>` of CSS strings. This turns that into a `ComputedStyle`: the
 * shorthands expanded, `var()` substituted, inheritance applied, the two computed-value
 * rules that cannot be decided per-declaration decided, and the row interned.
 *
 * Transitions and `@keyframes` are in here rather than beside the emitter, and that is
 * the one real decision in this module's shape. A style row *has* `transition` and
 * `animation` fields, and each is an index into a side table — so resolving them is
 * not a step after computing a style, it is part of producing one. Four comments in
 * the old file argued the same boundary from the other side, apologising for rules
 * that had to live with the caller rather than in `expandDeclaration`:
 *
 *   * `coerceOverflow` depends on *both* axes' final values, so it cannot be answered
 *     from one declaration
 *   * `display` interacts with `flex-direction`, so `display: flex` alone means ROW
 *     while no `display` at all behaves like COLUMN
 *   * a `@keyframes` block resolves into style rows — each being the element's own
 *     finished style with the keyframe's declarations on top
 *   * a transition's answer is an index into a side table, which a per-declaration
 *     expander has no way to mint
 *
 * All four are now in the module that owns computed values, so none of them is an
 * exception any more.
 *
 * Nothing here knows about the node tree, routing, or the emitter, and it does not
 * reach for the interners either: {@link AnimContext} takes them as parameters, so the
 * caller owns the tables and this owns what goes in them. That already being true is
 * why this needed no dependency inversion to become a module — the seam was a
 * parameter list that had been there all along.
 */
import {
  Direction,
  Display,
  Overflow,
  INITIAL_STYLE,
  INHERITED_FIELDS,
  STYLE_FIELDS,
  type ComputedStyle,
  type StyleField,
} from "../ir.ts";
import {
  animationFrom,
  EMPTY_VARS,
  expandDeclaration,
  parseEasing,
  substituteVars,
  transitionFrom,
  transitionMask,
  type AnimationSpec,
  type Curve,
  type KeyframeBlock,
  type RegisteredProperty,
  type TransitionSpec,
  type VarEnv,
} from "./css.ts";

const DISPLAY_VALUES: Record<string, number> = {
  flex: Display.FLEX,
  grid: Display.GRID,
  block: Display.BLOCK,
  none: Display.NONE,
};

export function inheritFrom(parent: ComputedStyle): ComputedStyle {
  const style = { ...INITIAL_STYLE };
  for (const field of INHERITED_FIELDS) style[field] = parent[field];
  return style;
}

export function applyDecls(
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
export function textStyle(parent: ComputedStyle): ComputedStyle {
  return inheritFrom(parent);
}

// ---------------------------------------------------------------------------
// Style table
// ---------------------------------------------------------------------------

export class StyleInterner {
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
export class TweenInterner {
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
export type AnimContext = {
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
