/**
 * The computed half of the cascade, through its own interface.
 *
 * `matcher.test.ts` drives the first half — which declarations reach a node — and
 * these drive the second: `applyDecls` turning a `Map<property, value>` into a
 * `ComputedStyle`, with `var()` substitution, `inherit`, `currentcolor`, the two
 * computed-value rules (`display`/`flex-direction`, overflow axis coercion), and
 * timing resolved against a stub `AnimContext`.
 *
 * No HTML parse, no UA sheet, no `@property` merge, no tree walk, no typed arrays.
 * `AnimContext` takes the interners as parameters, so a stub is two constructors
 * and an array for the warnings — the seam was a parameter list all along.
 *
 * `cascade.test.ts` stays as it is: it covers that this seam is *wired up*, which
 * nothing here can.
 */
import { expect, test } from "bun:test";
import {
  Direction,
  Display,
  INHERITED_FIELDS,
  INITIAL_STYLE,
  Overflow,
  STYLE_FIELDS,
  type ComputedStyle,
} from "../ir.ts";
import { parseColor, type VarEnv, type RegisteredProperty } from "./values.ts";
import type { KeyframeBlock } from "./css.ts";
import {
  applyDecls,
  coerceViewportOverflow,
  inheritFrom,
  textStyle,
  StyleInterner,
  TweenInterner,
  type AnimContext,
} from "./computed.ts";

const WHERE = "computed.test.ts";

function decls(pairs: Array<[string, string]>): Map<string, string> {
  return new Map(pairs);
}

function apply(
  pairs: Array<[string, string]>,
  base: ComputedStyle = INITIAL_STYLE,
  vars?: VarEnv,
  registered?: ReadonlyMap<string, RegisteredProperty>,
  anim?: AnimContext,
): ComputedStyle {
  return applyDecls(base, decls(pairs), WHERE, vars, registered, anim);
}

/** A stub AnimContext: real interners, a plain map of keyframes, warnings in an array. */
function animCtx(keyframes: Record<string, KeyframeBlock[]> = {}) {
  const warnings: Array<[string, string]> = [];
  const ctx: AnimContext = {
    keyframes: new Map(Object.entries(keyframes)),
    styles: new StyleInterner(),
    tweens: new TweenInterner(),
    warn: (message, where) => warnings.push([message, where]),
  };
  return { ctx, warnings };
}

// ---------------------------------------------------------------------------
// inheritFrom / textStyle
// ---------------------------------------------------------------------------

test("inheritFrom copies exactly the inherited fields and resets the rest", () => {
  // Every field set to a value no initial uses, so a copy is distinguishable from
  // a reset on all of them at once — including the NaN (`auto`) and Infinity ones.
  const parent = { ...INITIAL_STYLE };
  for (const [field] of STYLE_FIELDS) parent[field] = 7;

  const child = inheritFrom(parent);
  const inherited = new Set(INHERITED_FIELDS);
  for (const [field] of STYLE_FIELDS) {
    const want = inherited.has(field) ? 7 : INITIAL_STYLE[field];
    expect(Object.is(child[field], want)).toBe(true);
  }
});

test("textStyle is the inherited slice of its parent", () => {
  const parent = { ...INITIAL_STYLE, fg: parseColor("red"), fontSize: 20, padL: 12 };
  const style = textStyle(parent);
  expect(style.fg).toBe(parseColor("red"));
  expect(style.fontSize).toBe(20);
  expect(style.padL).toBe(0); // padding does not inherit
});

// ---------------------------------------------------------------------------
// applyDecls — declarations to fields
// ---------------------------------------------------------------------------

test("a declaration writes its field and leaves the base untouched", () => {
  const base = { ...INITIAL_STYLE };
  const style = apply([["color", "red"]], base);
  expect(style.fg).toBe(parseColor("red"));
  expect(base.fg).toBe(INITIAL_STYLE.fg);
});

test("a shorthand expands to its longhands", () => {
  const style = apply([["padding", "4px 8px"]]);
  expect(style.padT).toBe(4);
  expect(style.padR).toBe(8);
  expect(style.padB).toBe(4);
  expect(style.padL).toBe(8);
});

test("an unparseable value throws with the site and the property named", () => {
  expect(() => apply([["color", "notacolor"]])).toThrow(WHERE);
  expect(() => apply([["color", "notacolor"]])).toThrow("color");
});

test("a custom property is a value carrier, not a style field", () => {
  const style = apply([["--x", "10px"]]);
  expect(style).toEqual(INITIAL_STYLE);
});

// ---------------------------------------------------------------------------
// var()
// ---------------------------------------------------------------------------

test("var() substitutes from the environment", () => {
  const style = apply([["padding-left", "var(--pad)"]], INITIAL_STYLE, new Map([["--pad", "12px"]]));
  expect(style.padL).toBe(12);
});

test("var() may supply part of a value", () => {
  const style = apply([["padding", "var(--y) 4px"]], INITIAL_STYLE, new Map([["--y", "8px"]]));
  expect(style.padT).toBe(8);
  expect(style.padR).toBe(4);
});

test("an unresolvable var() drops the declaration, silently", () => {
  const style = apply([["color", "var(--missing)"]]);
  expect(style.fg).toBe(INITIAL_STYLE.fg);
});

test("var() falls back when the variable is unset", () => {
  const style = apply([["color", "var(--missing, red)"]]);
  expect(style.fg).toBe(parseColor("red"));
});

test("a registered property supplies its initial value to var()", () => {
  const registered = new Map([["--tw-pad", { initial: "6px", inherits: false }]]);
  const style = apply([["padding-left", "var(--tw-pad)"]], INITIAL_STYLE, undefined, registered);
  expect(style.padL).toBe(6);
});

// ---------------------------------------------------------------------------
// currentcolor
// ---------------------------------------------------------------------------

test("currentcolor reads the element's own color regardless of declaration order", () => {
  const style = apply([
    ["background-color", "currentcolor"],
    ["color", "red"],
  ]);
  expect(style.bg).toBe(parseColor("red"));
});

test("currentcolor on color itself resolves against the parent", () => {
  const base = { ...INITIAL_STYLE, fg: parseColor("blue") };
  const style = apply([["color", "currentcolor"]], base);
  expect(style.fg).toBe(parseColor("blue"));
});

test("currentcolor reaches through a var() fallback", () => {
  // Tailwind's rings spell it exactly this way; the keyword never appears in the
  // authored text.
  const style = apply([
    ["background-color", "var(--tw-ring-color, currentcolor)"],
    ["color", "red"],
  ]);
  expect(style.bg).toBe(parseColor("red"));
});

// ---------------------------------------------------------------------------
// inherit
// ---------------------------------------------------------------------------

test("inherit copies the parent's computed value for the property's own fields", () => {
  const base = { ...INITIAL_STYLE, padL: 9, padR: 3 };
  const style = apply([["padding-left", "inherit"]], base);
  expect(style.padL).toBe(9);
});

test("inherit is refused by name where it cannot be honoured", () => {
  expect(() => apply([["display", "inherit"]])).toThrow('inherit is not supported for "display"');
  expect(() => apply([["transition", "inherit"]])).toThrow("inherit is not supported");
});

// ---------------------------------------------------------------------------
// display and flex-direction
// ---------------------------------------------------------------------------

test("no display at all behaves like a column", () => {
  const style = apply([]);
  expect(style.display).toBe(Display.FLEX);
  expect(style.direction).toBe(Direction.COLUMN);
});

test("display: flex alone means row, as CSS says", () => {
  const style = apply([["display", "flex"]]);
  expect(style.display).toBe(Display.FLEX);
  expect(style.direction).toBe(Direction.ROW);
});

test("an explicit flex-direction beats the display: flex default", () => {
  const style = apply([
    ["display", "flex"],
    ["flex-direction", "column"],
  ]);
  expect(style.direction).toBe(Direction.COLUMN);
});

test("display: grid does not touch the direction", () => {
  const style = apply([["display", "grid"]]);
  expect(style.display).toBe(Display.GRID);
  expect(style.direction).toBe(INITIAL_STYLE.direction);
});

test("an unsupported display is refused by name", () => {
  expect(() => apply([["display", "inline-flex"]])).toThrow('unsupported display "inline-flex"');
});

// ---------------------------------------------------------------------------
// Overflow axis coercion — the two-axis computed-value rule
// ---------------------------------------------------------------------------

test("a scrolling axis coerces the other axis's visible to auto", () => {
  const style = apply([["overflow-y", "auto"]]);
  expect(style.overflowY).toBe(Overflow.SCROLL);
  expect(style.overflowX).toBe(Overflow.SCROLL);
});

test("the coercion applies even to an explicit visible", () => {
  const style = apply([
    ["overflow-x", "visible"],
    ["overflow-y", "auto"],
  ]);
  expect(style.overflowX).toBe(Overflow.SCROLL);
});

test("hidden is a scroll container and coerces too", () => {
  const style = apply([["overflow-x", "hidden"]]);
  expect(style.overflowY).toBe(Overflow.SCROLL);
});

test("clip is not a scroll container and leaves the other axis alone", () => {
  const style = apply([["overflow-y", "clip"]]);
  expect(style.overflowY).toBe(Overflow.CLIP);
  expect(style.overflowX).toBe(Overflow.VISIBLE);
});

// ---------------------------------------------------------------------------
// coerceViewportOverflow — the root rule
// ---------------------------------------------------------------------------

test("visible on the window root means auto", () => {
  const style = coerceViewportOverflow(INITIAL_STYLE);
  expect(style.overflowX).toBe(Overflow.SCROLL);
  expect(style.overflowY).toBe(Overflow.SCROLL);
});

test("only the visible axis is coerced at the root", () => {
  const style = coerceViewportOverflow({ ...INITIAL_STYLE, overflowX: Overflow.HIDDEN });
  expect(style.overflowX).toBe(Overflow.HIDDEN);
  expect(style.overflowY).toBe(Overflow.SCROLL);
});

test("hidden and clip at the root mean no page scroll and are left alone", () => {
  const style = {
    ...INITIAL_STYLE,
    overflowX: Overflow.CLIP,
    overflowY: Overflow.HIDDEN,
  };
  expect(coerceViewportOverflow(style)).toBe(style);
});

// ---------------------------------------------------------------------------
// StyleInterner
// ---------------------------------------------------------------------------

test("identical styles intern to one id", () => {
  const interner = new StyleInterner();
  const a = interner.intern({ ...INITIAL_STYLE });
  const b = interner.intern({ ...INITIAL_STYLE });
  expect(a).toBe(b);
  expect(interner.list).toHaveLength(1);
});

test("a differing field is a new row", () => {
  const interner = new StyleInterner();
  const a = interner.intern({ ...INITIAL_STYLE });
  const b = interner.intern({ ...INITIAL_STYLE, padL: 1 });
  expect(b).toBe(a + 1);
});

test("NaN is a value, not a JSON accident", () => {
  // `width: auto` is NaN; JSON.stringify would fold it into null and collide with
  // a genuine 0. The interner's key must keep them apart and NaN equal to itself.
  const interner = new StyleInterner();
  const auto = interner.intern({ ...INITIAL_STYLE, width: NaN });
  const zero = interner.intern({ ...INITIAL_STYLE, width: 0 });
  const autoAgain = interner.intern({ ...INITIAL_STYLE, width: NaN });
  expect(auto).not.toBe(zero);
  expect(autoAgain).toBe(auto);
});

// ---------------------------------------------------------------------------
// Transitions — resolveTiming through applyDecls' anim parameter
// ---------------------------------------------------------------------------

test("a transition interns one tween row and points the style at it", () => {
  const { ctx } = animCtx();
  const style = apply([["transition", "opacity 150ms"]], INITIAL_STYLE, undefined, undefined, ctx);

  expect(style.transition).toBe(1); // row 0, stored +1 so 0 stays "none"
  expect(ctx.tweens.tweens).toHaveLength(1);
  const row = ctx.tweens.tweens[0]!;
  expect(row.duration).toBeCloseTo(0.15); // parseTime works in seconds
  expect(row.iterations).toBe(1); // a transition runs exactly once
  expect(row.firstSegment).toBe(-1); // no keyframes
  expect(row.segmentCount).toBe(0);
  expect(row.mask).not.toBe(0);
});

test("without an AnimContext, timing is not resolved at all", () => {
  const style = apply([["transition", "opacity 150ms"]]);
  expect(style.transition).toBe(0);
});

test("a transition with no duration emits nothing", () => {
  const { ctx } = animCtx();
  const style = apply([["transition-property", "opacity"]], INITIAL_STYLE, undefined, undefined, ctx);
  expect(style.transition).toBe(0);
  expect(ctx.tweens.tweens).toHaveLength(0);
});

test("a transition over nothing interpolable is refused with a warning, not a row", () => {
  const { ctx, warnings } = animCtx();
  const style = apply([["transition", "width 150ms"]], INITIAL_STYLE, undefined, undefined, ctx);
  expect(style.transition).toBe(0);
  expect(ctx.tweens.tweens).toHaveLength(0);
  expect(warnings.some(([m]) => m.includes("width"))).toBe(true);
  expect(warnings[0]?.[1]).toBe(WHERE);
});

test("the same transition on two nodes is one tween row", () => {
  const { ctx } = animCtx();
  const a = apply([["transition", "opacity 150ms"]], INITIAL_STYLE, undefined, undefined, ctx);
  const b = apply(
    [
      ["transition", "opacity 150ms"],
      ["color", "red"],
    ],
    INITIAL_STYLE,
    undefined,
    undefined,
    ctx,
  );
  expect(a.transition).toBe(b.transition);
  expect(ctx.tweens.tweens).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Animations
// ---------------------------------------------------------------------------

const FADE: KeyframeBlock[] = [{ offsets: [0.5], decls: new Map([["opacity", "0.5"]]) }];

test("an animation resolves keyframes into style rows and synthesises both endpoints", () => {
  const { ctx } = animCtx({ fade: FADE });
  const style = apply([["animation", "fade 1s"]], INITIAL_STYLE, undefined, undefined, ctx);

  expect(style.animation).toBe(1);
  const row = ctx.tweens.tweens[0]!;
  expect(row.duration).toBe(1);
  expect(row.firstSegment).toBe(0);
  expect(row.segmentCount).toBe(3); // synthesised 0%, authored 50%, synthesised 100%

  const [start, mid, end] = ctx.tweens.keyframes;
  expect(start!.offset).toBe(0);
  expect(mid!.offset).toBe(0.5);
  expect(end!.offset).toBe(1);

  // The missing endpoints are the element's own style, no value invented.
  expect(ctx.styles.list[start!.style]!.opacity).toBe(1);
  expect(ctx.styles.list[mid!.style]!.opacity).toBe(0.5);
  expect(end!.style).toBe(start!.style);
});

test("a keyframe row is a value, never a state: it carries no animation of its own", () => {
  const { ctx } = animCtx({ fade: FADE });
  const style = apply([["animation", "fade 1s"]], INITIAL_STYLE, undefined, undefined, ctx);
  expect(style.animation).not.toBe(0);
  for (const frame of ctx.tweens.keyframes) {
    expect(ctx.styles.list[frame.style]!.animation).toBe(0);
  }
});

test("a multi-offset selector is duplicated, one row per offset", () => {
  const blink: KeyframeBlock[] = [{ offsets: [0.75, 1], decls: new Map([["opacity", "0"]]) }];
  const { ctx } = animCtx({ blink });
  apply([["animation", "blink 1s"]], INITIAL_STYLE, undefined, undefined, ctx);

  const offsets = ctx.tweens.keyframes.map((k) => k.offset);
  expect(offsets).toEqual([0, 0.75, 1]);
  // Two rows from one block share one style; only the offset differs.
  expect(ctx.tweens.keyframes[1]!.style).toBe(ctx.tweens.keyframes[2]!.style);
});

test("an animation-name matching no @keyframes runs nothing, and says so once", () => {
  const { ctx, warnings } = animCtx();
  const style = apply([["animation", "missing 1s"]], INITIAL_STYLE, undefined, undefined, ctx);
  expect(style.animation).toBe(0);
  expect(warnings.some(([m]) => m.includes('"missing"'))).toBe(true);
});

test("a named animation with no duration is the ordinary not-started case, no warning", () => {
  const { ctx, warnings } = animCtx({ fade: FADE });
  const style = apply([["animation-name", "fade"]], INITIAL_STYLE, undefined, undefined, ctx);
  expect(style.animation).toBe(0);
  expect(warnings).toHaveLength(0);
});

test("infinite is the iterations column, shared with transitions' 1", () => {
  const { ctx } = animCtx({ fade: FADE });
  apply([["animation", "fade 1s infinite"]], INITIAL_STYLE, undefined, undefined, ctx);
  expect(ctx.tweens.tweens[0]!.iterations).toBe(Infinity);
});

test("what the engine cannot express is refused by name, not approximated", () => {
  const { ctx, warnings } = animCtx({ fade: FADE });
  const style = apply([["animation", "fade 1s alternate"]], INITIAL_STYLE, undefined, undefined, ctx);
  // Runs forwards rather than silently playing a direction nobody implemented.
  expect(style.animation).not.toBe(0);
  expect(warnings.some(([m]) => m.includes("animation-direction"))).toBe(true);
});
