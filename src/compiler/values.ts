/**
 * The CSS *value* grammar: what a declaration's right-hand side means.
 *
 * Colours through `color-mix()` and `oklch()`, `var()` substitution and the `@property`
 * registrations it resolves against, `calc()`, lengths, angles and times — and then
 * easing curves, `transition` and `animation`, which are values too even though they
 * resolve into side tables rather than a number.
 *
 * The leaf of the CSS front-end: it imports nothing from the parser above it. That is
 * what makes the boundary real rather than nominal — `css.ts` needs `parseLength` to
 * read a media query's threshold, and nothing here needs to know what a selector is.
 *
 * `RegisteredProperty` lives here rather than with the parser that builds the map,
 * because this is the side that reads it and a type on the consumer's side keeps the
 * dependency pointing one way.
 */
import { AUTO, Easing, StepPosition, type StyleField } from "../ir.ts";
import { ANIM_ALL, ANIM_BIT, type AnimatableField } from "../protocol/generated.ts";
import { CssError, warnOnce } from "./diagnostics.ts";

/**
 * One `@property` registration: what a custom property is worth when nobody has
 * set it, and whether it reaches a child.
 */
export type RegisteredProperty = { initial: string; inherits: boolean };


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

/**
 * A colour as `#RRGGBBAA`, which {@link parseColor} reads back exactly.
 *
 * Hex rather than `rgba()` because it round-trips without going through a decimal
 * alpha: 0x80 as `0.5019607843137255` is a value neither side can spell in a way
 * the other reproduces byte for byte.
 */
export function formatColor(argb: number): string {
  const hex = (n: number) => (n & 0xff).toString(16).padStart(2, "0");
  return `#${hex(argb >>> 16)}${hex(argb >>> 8)}${hex(argb)}${hex(argb >>> 24)}`;
}

/**
 * Replaces every `currentcolor` keyword in a declaration value with `colour`.
 *
 * Textual, and for the same reason `var()` substitution is: `currentcolor` can appear
 * anywhere a colour can, including inside functions whose grammar nothing here models —
 * `color-mix(in srgb, currentcolor 50%, white)` and, the case that prompted this,
 * `box-shadow: 0 0 0 2px currentcolor`.
 *
 * **`currentcolor` is not dynamic**, which is the only reason this belongs in the
 * compiler. It means "this element's computed `color`", and the cascade resolves `color`
 * per node at build time — so it is a lookup, not a signal. The same observation is
 * recorded in BROWSER-FACTS.md against `border-color`'s initial value.
 *
 * Word-bounded so a longer identifier containing it is left alone. The one value where
 * the keyword could be *text* rather than a colour is `content`, and the caller excludes
 * it.
 */
export function substituteCurrentColor(value: string, colour: number): string {
  if (!/currentcolor/i.test(value)) return value;
  return value.replace(/\bcurrentcolor\b/gi, formatColor(colour));
}

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
 * What does not fold to one number — percentages, which resolve against the
 * containing block, and viewport units, which resolve against the window — is not
 * rejected either: it goes through {@link lengthCalc}, which keeps the components
 * separate so the engine can finish the sum at layout time. This function stays
 * px-only; it serves the fields (border widths, radii, gaps, padding, margins)
 * that have no percentage or viewport channel.
 *
 * Nested `calc()` is unwrapped rather than special-cased: the spec says a nested
 * one is just a parenthesised sub-expression, and that is what stripping the
 * keyword leaves behind.
 */
function foldCalc(raw: string, resolve: (token: string) => number = parseLength): number {
  const inner = raw.trim().slice(raw.trim().indexOf("(") + 1, -1);
  const tokens = tokeniseCalc(inner.replace(/\bcalc\(/g, "("));
  const parser = new CalcParser(tokens, raw, numberArith(resolve));
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
 * The arithmetic a `calc()` is evaluated over.
 *
 * The parser is generic in it because the grammar — precedence, parens, unary
 * minus — is the same whether the answer is one number or the four components of
 * a length layout has to finish. What differs is what the operators *mean*: over
 * numbers they are the four operations; over length components, multiplication
 * and division need a scalar on one side, exactly as CSS specifies.
 */
type CalcArith<N> = {
  /** A bare number. In a length calc this is a scalar, not a length. */
  scalar(n: number): N;
  /** A dimensioned atom — `4px`, `50%`, `100vh`, `12deg` — in the caller's units. */
  atom(tok: string): N;
  add(a: N, b: N, whole: string): N;
  sub(a: N, b: N, whole: string): N;
  mul(a: N, b: N, whole: string): N;
  div(a: N, b: N, whole: string): N;
  neg(a: N): N;
};

/** calc() over plain numbers — px lengths, degrees, percentage atoms. */
function numberArith(resolve: (token: string) => number): CalcArith<number> {
  return {
    scalar: (n) => n,
    atom: resolve,
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    mul: (a, b) => a * b,
    div: (a, b, whole) => {
      if (b === 0) throw new CssError(`division by zero in "${whole}"`);
      return a / b;
    },
    neg: (a) => -a,
  };
}

/**
 * Recursive descent over `+ -` then `* /` then atoms, which is the precedence CSS
 * specifies. Written out rather than reached for from a library because the
 * grammar is four lines and the error messages matter more than the parser does.
 */
class CalcParser<N> {
  #tokens: string[];
  #at = 0;
  #whole: string;
  #arith: CalcArith<N>;

  /**
   * The arithmetic is a parameter because `calc()` appears in more than one kind
   * of value. Tailwind writes every negative utility as a multiplication —
   * `-rotate-12` is `calc(12deg * -1)` — so an angle has to fold here too, and
   * folding it with the length parser reports "bad length" for a perfectly good
   * angle. Lengths that layout has to finish fold over components instead; see
   * `lengthCalc`.
   */
  constructor(tokens: string[], whole: string, arith: CalcArith<N>) {
    this.#tokens = tokens;
    this.#whole = whole;
    this.#arith = arith;
  }

  #peek(): string | undefined {
    return this.#tokens[this.#at];
  }

  expectEnd(): void {
    if (this.#at !== this.#tokens.length) {
      throw new CssError(`trailing "${this.#tokens.slice(this.#at).join(" ")}" in "${this.#whole}"`);
    }
  }

  expression(): N {
    let left = this.term();
    for (;;) {
      const op = this.#peek();
      if (op !== "+" && op !== "-") return left;
      this.#at++;
      const right = this.term();
      left =
        op === "+"
          ? this.#arith.add(left, right, this.#whole)
          : this.#arith.sub(left, right, this.#whole);
    }
  }

  term(): N {
    let left = this.atom();
    for (;;) {
      const op = this.#peek();
      if (op !== "*" && op !== "/") return left;
      this.#at++;
      const right = this.atom();
      left =
        op === "*"
          ? this.#arith.mul(left, right, this.#whole)
          : this.#arith.div(left, right, this.#whole);
    }
  }

  atom(): N {
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
    if (tok === "-") return this.#arith.neg(this.atom());
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
     * length of `NaN` is already how dziry spells `auto`, so it lands somewhere
     * meaningful rather than nowhere.
     */
    const constant = MATH_CONSTANTS[tok.toLowerCase()];
    if (constant !== undefined) return this.#arith.scalar(constant);

    // A bare number is a scalar (a multiplier); anything else is dimensioned, and
    // the arithmetic this parser was built with is what decides which units it can
    // answer for.
    return /^-?[\d.]+(e[-+]?\d+)?$/i.test(tok)
      ? this.#arith.scalar(Number(tok))
      : this.#arith.atom(tok);
  }
}

/** Parses a length to px. `auto` becomes NaN; percentages are unsupported. */
export function parseLength(raw: string): number {
  const v = raw.trim().toLowerCase();
  if (v === "auto") return AUTO;
  if (v === "0") return 0;
  if (v.startsWith("calc(")) return foldCalc(v);
  if (v.endsWith("%")) {
    throw new CssError(
      `percentage lengths are not supported here ("${raw}") — sizing, inset and ` +
        `flex-basis take them; this property does not`,
    );
  }

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
 * A length as the four components the wire carries separately.
 *
 * `px` is resolved now; the other three are fractions of something only the
 * engine knows — `pct` of the containing block, `vw`/`vh` of the window. A
 * length is constant exactly when all three fractions are 0, which is what
 * `calc(var(--spacing) * 4)` folds to and what `w-1/2` does not.
 *
 * The channels never mix in one value: a percentage alongside a px or viewport
 * part is refused, because Taffy takes a percent *or* a length and has no calc
 * to sum them. That is the one shape left unsupported — `calc(100% - 2rem)` —
 * and the error says so rather than approximating it.
 */
export type LengthDims = {
  px: number;
  /** Fraction of the containing block's size on the field's axis. */
  pct: number;
  /** Fraction of the window's width. */
  vw: number;
  /** Fraction of the window's height. */
  vh: number;
};

/**
 * One atom of a length calc: a dimensioned token or a scalar.
 *
 * Scalar and dims are kept apart because the operators treat them differently —
 * `calc(1 / 2 * 100%)` is scalar division then a scalar-dims multiplication, and
 * `calc(4px + 2)` is invalid CSS that a fused representation could not refuse.
 */
type CalcAtom = { scalar: true; n: number } | ({ scalar: false } & LengthDims);

const scalarAtom = (n: number): CalcAtom => ({ scalar: true, n });
// `-0` is a real product of `calc(x * -1)` with a zero part, and it must not
// survive: the interner's key stringifies it as "0" while a deep-equal test sees
// a different number from 0.
const noNegZero = (n: number): number => (n === 0 ? 0 : n);
const dimsAtom = (px: number, pct: number, vw: number, vh: number): { scalar: false } & LengthDims => ({
  scalar: false,
  px: noNegZero(px),
  pct: noNegZero(pct),
  vw: noNegZero(vw),
  vh: noNegZero(vh),
});

/**
 * The viewport's small/large/dynamic variants all fold to the plain unit. A
 * dziry window has no browser chrome that grows or shrinks, so the four sizes
 * are one size — the same collapse SDL3's viewport already makes.
 */
const VIEWPORT_UNITS: Record<string, "vw" | "vh"> = {
  vw: "vw",
  svw: "vw",
  lvw: "vw",
  dvw: "vw",
  vh: "vh",
  svh: "vh",
  lvh: "vh",
  dvh: "vh",
};

/** One dimensioned length atom — `4px`, `50%`, `100vh` — as components. */
function lengthDimsAtom(tok: string): { scalar: false } & LengthDims {
  const m = /^(-?[\d.]+(?:e[-+]?\d+)?)([a-z%]+)$/.exec(tok.toLowerCase());
  if (!m) throw new CssError(`bad length "${tok}"`);
  const n = Number(m[1]);
  const unit = m[2]!;

  if (unit === "%") return dimsAtom(0, n / 100, 0, 0);
  const vp = VIEWPORT_UNITS[unit];
  if (vp === "vw") return dimsAtom(0, 0, n / 100, 0);
  if (vp === "vh") return dimsAtom(0, 0, 0, n / 100);
  if (unit === "vmin" || unit === "vmax") {
    throw new CssError(
      `${unit} picks between the viewport's axes at run time, which no field here can ` +
        `express — write the vw or vh you mean ("${tok}")`,
    );
  }
  switch (unit) {
    case "px":
      return dimsAtom(n, 0, 0, 0);
    case "pt":
      return dimsAtom(n * (96 / 72), 0, 0, 0);
    // rem/em resolve against the root's 16px default, as parseLength's.
    case "rem":
    case "em":
      return dimsAtom(n * 16, 0, 0, 0);
    default:
      throw new CssError(`bad length unit in "${tok}"`);
  }
}

/** calc() over length components — the arithmetic CSS's type rules describe. */
const DIMS_ARITH: CalcArith<CalcAtom> = {
  scalar: scalarAtom,
  atom: lengthDimsAtom,
  add: (a, b, whole) => {
    if (a.scalar && b.scalar) return scalarAtom(a.n + b.n);
    if (a.scalar || b.scalar) {
      throw new CssError(`cannot add a bare number to a length in "${whole}"`);
    }
    return dimsAtom(a.px + b.px, a.pct + b.pct, a.vw + b.vw, a.vh + b.vh);
  },
  sub: (a, b, whole) => {
    if (a.scalar && b.scalar) return scalarAtom(a.n - b.n);
    if (a.scalar || b.scalar) {
      throw new CssError(`cannot subtract a bare number and a length in "${whole}"`);
    }
    return dimsAtom(a.px - b.px, a.pct - b.pct, a.vw - b.vw, a.vh - b.vh);
  },
  mul: (a, b, whole) => {
    if (a.scalar && b.scalar) return scalarAtom(a.n * b.n);
    if (a.scalar && !b.scalar) return dimsAtom(b.px * a.n, b.pct * a.n, b.vw * a.n, b.vh * a.n);
    if (!a.scalar && b.scalar) return dimsAtom(a.px * b.n, a.pct * b.n, a.vw * b.n, a.vh * b.n);
    throw new CssError(`cannot multiply two lengths in "${whole}"`);
  },
  div: (a, b, whole) => {
    if (b.scalar ? b.n === 0 : b.px === 0 && b.pct === 0 && b.vw === 0 && b.vh === 0) {
      throw new CssError(`division by zero in "${whole}"`);
    }
    if (a.scalar && b.scalar) return scalarAtom(a.n / b.n);
    if (!a.scalar && b.scalar) return dimsAtom(a.px / b.n, a.pct / b.n, a.vw / b.n, a.vh / b.n);
    throw new CssError(`cannot divide by a length in "${whole}"`);
  },
  neg: (a) => (a.scalar ? scalarAtom(-a.n) : dimsAtom(-a.px, -a.pct, -a.vw, -a.vh)),
};

/**
 * Parses a length that may be dynamic: a percentage, a viewport unit, or a
 * `calc()` mixing absolute and viewport parts.
 *
 * `parseLength`'s sibling, not its replacement: this is for the fields that carry
 * the percentage and viewport channels — sizing, inset, flex-basis. Everywhere
 * else keeps refusing percentages, because there is nowhere to put the fraction.
 */
export function lengthCalc(raw: string): LengthDims {
  const v = raw.trim().toLowerCase();
  if (v === "auto") return { px: AUTO, pct: 0, vw: 0, vh: 0 };

  const out = (d: LengthDims, whole: string): LengthDims => {
    if (d.pct !== 0 && (d.px !== 0 || d.vw !== 0 || d.vh !== 0)) {
      throw new CssError(
        `"${whole}" mixes a percentage with an absolute or viewport length, which ` +
          `dziry cannot resolve: the percentage is relative to the containing block at ` +
          `layout time and the rest is known now. Write the two parts as separate ` +
          `properties, or pick one unit.`,
      );
    }
    return { px: d.px, pct: d.pct, vw: d.vw, vh: d.vh };
  };

  if (v.startsWith("calc(")) {
    const inner = v.slice(v.indexOf("(") + 1, -1);
    const parser = new CalcParser(tokeniseCalc(inner.replace(/\bcalc\(/g, "(")), raw, DIMS_ARITH);
    const r = parser.expression();
    parser.expectEnd();
    // A dimensionless calc was a px length under parseLength; stay lenient.
    return out(r.scalar ? { px: r.n, pct: 0, vw: 0, vh: 0 } : r, raw);
  }

  // A bare number is a px length, as parseLength has it — `width: 0` is the
  // common case and calc() elsewhere already permits the omission.
  if (/^-?[\d.]+$/.test(v)) return { px: Number(v), pct: 0, vw: 0, vh: 0 };

  return out(lengthDimsAtom(v), raw);
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
 * A `<length-percentage>` split into the two halves dziry stores separately.
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
        `"${raw}" mixes a length and a percentage in one calc(), which dziry cannot ` +
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
  "border-color": ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"],
  "border-top-color": ["borderTopColor"],
  "border-right-color": ["borderRightColor"],
  "border-bottom-color": ["borderBottomColor"],
  "border-left-color": ["borderLeftColor"],
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
  "outline-color": ["outlineColor"],
  "text-decoration-color": ["decorationColor"],
  "scrollbar-color": ["scrollbarThumb", "scrollbarTrack"],
};

/**
 * Properties dziry implements but cannot transition, so the refusal can name them.
 *
 * The distinction this draws is the whole reason it exists. `transition: width` is
 * a request dziry understands and declines — worth a warning, because the author
 * will otherwise watch a box jump and have nothing to read. `transition: filter` is
 * a property dziry does not have at all, and warning about it would print a line
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
  "border-width": ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"],
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
 * readable. A property in `TRANSITIONABLE` contributes its bits. A property dziry
 * implements but cannot interpolate is **named** in a warning, because the author
 * is about to watch a box jump and needs to know why. Anything else is dropped in
 * silence: Tailwind's default `.transition` names twenty-two properties and dziry
 * has six of them, so warning about the rest would print sixteen lines per build
 * and bury the one that matters.
 *
 * `all` is every animatable field, which is what it means once the properties dziry
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
        // dziry carries one timing per node, so a list that asks for two is
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
      // Each of these is a *list* parallel to `transition-property`, and dziry
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
      // Parsed and ignored: `allow-discrete` only matters for properties dziry
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
        // A comma-separated list is several animations at once. dziry runs one per
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

