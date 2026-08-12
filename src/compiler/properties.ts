/**
 * One CSS property, one row — the table that decides what dziri supports.
 *
 * `PROPERTIES` maps a property name to either a `{ field, parse }` pair or, when the
 * property is a genuine shorthand, a function that writes several fields. Adding
 * support for a property is adding a row here, and that is the whole point of the
 * shape: 54 of the original 96 bodies were the single statement
 * `out.field = parse(value)`, which is what most of CSS is.
 *
 * Split out of `css.ts` because this is the part that grows. The rest of that file is
 * a front-end that changes when the *grammar* does — new selector syntax, a new
 * at-rule, a new value function — while this changes whenever the supported surface
 * does, which is far more often and for unrelated reasons. Keeping them in one 4,000
 * line file meant every property added touched the same file as every parser fix.
 *
 * The dependency runs one way, which is why the split needed nothing rearranged:
 * everything here consumes the value parsers (`parseLength`, `parseColor`,
 * `parseAngle`, `lengthPercent`) and nothing in the front-end consumes a row from
 * here. `expandDeclaration` is the only way in.
 *
 * `handledByCaller` is why `display`, `content` and the fifteen timing properties are
 * present and inert. They *are* supported — the caller expands them, because
 * `display` interacts with `flex-direction`, `content` is a string where every style
 * field is a number, and the timing set resolves as a unit into a side table. Present
 * and inert beats absent and reported as unsupported, since the two coverage scripts
 * read `Object.keys(PROPERTIES)` as the supported list.
 */
import {
  Align,
  Appearance,
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
import {
  lengthCalc,
  lengthPercent,
  parseAngle,
  parseColor,
  parseLength,
  splitTopLevel,
  splitTopLevelCommas,
} from "./values.ts";
import { CssError, warnOnce } from "./diagnostics.ts";

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

/** `boxShorthand` over a per-part parser, for the shorthands whose parts are not plain px. */
function boxShorthandWith<T>(raw: string, parse: (part: string) => T): [T, T, T, T] {
  const parts = splitTopLevel(raw).map(parse);
  const [a, b, c, d] = parts;
  if (a === undefined) throw new CssError(`empty box shorthand "${raw}"`);
  if (b === undefined) return [a, a, a, a];
  if (c === undefined) return [a, b, a, b];
  if (d === undefined) return [a, b, c, b];
  return [a, b, c, d];
}

/**
 * A sizing length — `width`, `min-height`, … — which is three channels, and a
 * declaration writes **all three**: px the compiler resolved, a fraction of the
 * containing block, and a fraction of the window on the property's own axis.
 * Writing all three is what keeps the cascade honest — `width: 50%` losing to a
 * later `width: 100px` must clear the fraction, and a patch object only carries
 * the fields the winner wrote.
 *
 * Viewport units on the *other* axis are refused: `width: 50vh` would make a
 * box's width a function of the window's height, and the channel is per-axis
 * because nothing in the measured Tailwind corpus does it.
 */
const sizingLen =
  (pxField: StyleField, pctField: StyleField, vpField: StyleField, axis: "w" | "h"): ExpandRule =>
  (value, out, prop) => {
    const d = lengthCalc(value);
    const cross = axis === "w" ? d.vh : d.vw;
    if (cross !== 0) {
      throw new CssError(
        `${prop}: "${value}" is relative to the viewport's ${axis === "w" ? "height" : "width"}, ` +
          `and a ${axis} cannot be. Use ${axis === "w" ? "vw" : "vh"}.`,
      );
    }
    out[pxField] = d.px;
    out[pctField] = d.pct;
    out[vpField] = axis === "w" ? d.vw : d.vh;
  };

/** A max-* bound, where `none` is the absence of the bound rather than zero. */
const maxLen =
  (pxField: StyleField, pctField: StyleField, vpField: StyleField, axis: "w" | "h"): ExpandRule =>
  (value, out, prop) => {
    if (value.trim().toLowerCase() === "none") {
      out[pxField] = Infinity;
      out[pctField] = 0;
      out[vpField] = 0;
      return;
    }
    sizingLen(pxField, pctField, vpField, axis)(value, out, prop);
  };

/** An inset length: px plus a fraction of the containing block. No viewport channel —
 *  nothing in the measured corpus positions from the window. */
const insetLen =
  (pxField: StyleField, pctField: StyleField): ExpandRule =>
  (value, out, prop) => {
    const d = lengthCalc(value);
    if (d.vw !== 0 || d.vh !== 0) {
      throw new CssError(`${prop}: "${value}" — viewport units are not supported on inset`);
    }
    out[pxField] = d.px;
    out[pctField] = d.pct;
  };

/** `flex-basis`: px or a fraction of the container's main axis. */
const basisLen: ExpandRule = (value, out) => {
  const d = lengthCalc(value);
  if (d.vw !== 0 || d.vh !== 0) {
    throw new CssError(`flex-basis: "${value}" — viewport units are not supported here`);
  }
  out.basis = d.px;
  out.basisPct = d.pct;
};

/** The border sides, in shorthand order (top, right, bottom, left). */
const BORDER_W = ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"] as const;
const BORDER_C = ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"] as const;

/** A `border-*-width` value: a length, or one of the three CSS keywords. */
function borderWidthValue(raw: string): number {
  const v = raw.trim().toLowerCase();
  // Measured initial values: `medium` is 3px, and `thin`/`thick` are 1px and 5px.
  if (v === "thin") return 1;
  if (v === "medium") return 3;
  if (v === "thick") return 5;
  return parseLength(v);
}

/**
 * `border-style` and its per-side forms. There is no style field: a side paints
 * exactly when it has a width and a colour, so `none` (and `hidden`) *is* width
 * 0, and the patterned styles are solid with a warning rather than a lie of
 * omission — a dashed border drawn solid is a note, not a wrong box.
 */
function borderStyle(
  value: string,
  out: Partial<Record<StyleField, number>>,
  widths: readonly StyleField[],
  sides: number,
  prop = "border-style",
): void {
  const parts = splitTopLevel(value);
  if (parts.length > sides) {
    throw new CssError(`${prop} takes at most ${sides} value(s) here, got "${value}"`);
  }
  // The 1-to-N expansion: all four sides, or both ends of one axis.
  const expanded =
    sides === 4
      ? [parts[0]!, parts[1] ?? parts[0]!, parts[2] ?? parts[0]!, parts[3] ?? parts[1] ?? parts[0]!]
      : [parts[0]!, parts[1] ?? parts[0]!];
  for (let i = 0; i < widths.length; i++) {
    const style = expanded[i]!.toLowerCase();
    if (style === "none" || style === "hidden") {
      out[widths[i]!] = 0;
    } else if (style === "solid") {
      // The default: nothing to write.
    } else if (/^(dashed|dotted|double|groove|ridge|inset|outset)$/.test(style)) {
      warnOnce(`${prop}: ${style} is painted solid — patterned lines are not drawn yet`);
    } else {
      throw new CssError(`unsupported ${prop} "${style}"`);
    }
  }
}

/**
 * The `border` shorthand and its per-side forms: `<width> <style> <color>` in
 * any order, each component optional.
 *
 * The one that is *absent* decides the outcome: CSS's initial `border-style` is
 * `none`, so a shorthand that never names a style paints nothing — `border:
 * 2px` is a 2px-wide nothing in a browser, and the compiler says so by zeroing
 * the widths rather than painting a border nobody asked the style of.
 */
function borderShorthand(
  value: string,
  out: Partial<Record<StyleField, number>>,
  widths: readonly StyleField[],
  colors: readonly StyleField[],
): void {
  const parts = splitTopLevel(value);
  let width: number | undefined;
  let color: number | undefined;
  let sawStyle = false;
  let none = false;

  for (const part of parts) {
    const p = part.toLowerCase();
    if (/^(none|hidden)$/.test(p)) {
      sawStyle = true;
      none = true;
      continue;
    }
    if (p === "solid") {
      sawStyle = true;
      continue;
    }
    if (/^(dashed|dotted|double|groove|ridge|inset|outset)$/.test(p)) {
      sawStyle = true;
      warnOnce(`border-style: ${p} is painted solid — patterned borders are not drawn yet`);
      continue;
    }
    if (/^(thin|medium|thick)$/.test(p) || /^-?[\d.]/.test(p) || /^calc\(/.test(p)) {
      if (width !== undefined) throw new CssError(`two widths in border "${value}"`);
      width = borderWidthValue(part);
      continue;
    }
    if (color !== undefined) throw new CssError(`two colors in border "${value}"`);
    color = parseColor(part);
  }

  // The shorthand resets what it does not name, and `border-style`'s initial is
  // `none` — so a shorthand with no style keyword is a width 0 however wide the
  // width part says. `border: 2px` paints nothing in a browser; here too.
  if (none || !sawStyle) {
    for (const f of widths) out[f] = 0;
  } else if (width !== undefined) {
    for (const f of widths) out[f] = width;
  }
  if (color !== undefined) {
    for (const f of colors) out[f] = color;
  }
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

/**
 * One `align-content` value. The keyword set is justify-content's (Taffy's
 * `AlignContent` is the same enum), plus CSS's `normal`, `stretch`, `baseline`
 * and `auto`, which all fold to UNSET so Taffy's per-display default answers.
 */
function alignContentKeyword(value: string): number {
  const v = value.trim().toLowerCase();
  if (v === "normal" || v === "stretch" || v === "baseline" || v === "auto") return UNSET;
  const kw = JUSTIFY_KEYWORDS[v];
  if (kw === undefined) throw new CssError(`unsupported align-content "${value}"`);
  return kw;
}

/** The overflow-alignment prefixes, which bind to the keyword *after* them. */
const OVERFLOW_POSITION = new Set(["safe", "unsafe"]);

/**
 * Splits a `place-*` shorthand into its block-axis and inline-axis halves.
 *
 * Not `split(/\s+/)`, and this is the one thing about these properties that is
 * easy to get wrong in a way no test of the common case would catch. Box Alignment
 * writes each half as `[ safe | unsafe ]? <position>`, so `place-items: safe
 * center` is **one** value — align and justify both become `safe center`. A naive
 * split reads it as align `safe`, justify `center`: the align half becomes a
 * keyword that does not exist, and if it happened to, the two axes would disagree.
 * Tailwind emits exactly this, as `place-items-center-safe`.
 *
 * Whether `safe` is then *supported* is a separate question this does not answer.
 * It is not — `ALIGN_KEYWORDS` has no entry for it, so `align-items: safe center`
 * is refused today and `place-items: safe center` is refused identically, by the
 * caller, naming the property the author wrote. Splitting correctly is what makes
 * that refusal land on the right value instead of on a fragment of one.
 */
function splitAlignPair(value: string, prop: string): [string, string] {
  const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new CssError(`empty ${prop}`);

  const halves: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (OVERFLOW_POSITION.has(words[i]!) && words[i + 1] !== undefined) {
      halves.push(`${words[i]} ${words[i + 1]}`);
      i++;
      continue;
    }
    halves.push(words[i]!);
  }

  if (halves.length > 2) throw new CssError(`${prop}: "${value}" has more than two values`);
  // One value sets both axes, which is what the shorthand is for.
  return [halves[0]!, halves[1] ?? halves[0]!];
}

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

/** A property whose whole definition is a field and a value parser. */
type FieldRule = { field: StyleField; parse: (value: string) => number };

/** A property needing real work: a shorthand, a keyword map, a side-table write. */
type ExpandRule = (value: string, out: Partial<Record<StyleField, number>>, prop: string) => void;

export type PropertyRule = FieldRule | ExpandRule;

/**
 * Every CSS property dziri understands, and what it means.
 *
 * Most of CSS is a field and a parser — `color` is `fg` read as a colour, `padding-top`
 * is `padT` read as a length — so most of this is data, and adding such a property is
 * one row. Only a genuine shorthand, keyword map or side-table write needs a function.
 *
 * This is also the one honest answer to "which properties does dziri support", and a
 * *value* rather than a shape to be recovered from this file's source. `css-coverage`
 * and `tailwind-coverage` used to read it back with `/case\s+"([a-z-]+)":/g`, which
 * matches at any depth: value keywords from nested switches reached them as candidate
 * properties and were filtered out again by a spec lookup. The numbers were right, but
 * the *shape of this function's source* was part of its interface — a comment two
 * screens down still explains that `appearance` is written as ifs rather than a nested
 * switch for no reason other than to keep that regex honest. A table of keys removes
 * the hazard rather than working around it.
 */
/**
 * A four-sided shorthand — `padding`, `margin`, `inset` — as one row.
 *
 * The one/two/three/four expansion lives in `boxShorthand`; all these differ by is
 * which four fields receive it. Written as a helper rather than four near-identical
 * function bodies so that a fifth quad is a row and not a copy.
 */
const quad =
  (t: StyleField, r: StyleField, b: StyleField, l: StyleField): ExpandRule =>
  (value, out) => {
    const [a, bb, c, d] = boxShorthand(value);
    out[t] = a;
    out[r] = bb;
    out[b] = c;
    out[l] = d;
  };

/**
 * One axis of a four-sided shorthand — `padding-inline`, `inset-block`.
 *
 * Takes the first two of `boxShorthand`'s four, which is what `<start> <end>` means
 * once one value has been duplicated across both.
 */
const axis =
  (start: StyleField, end: StyleField): ExpandRule =>
  (value, out) => {
    const [a, b] = boxShorthand(value);
    out[start] = a;
    out[end] = b;
  };

/**
 * A property whose value is one of a fixed set of keywords.
 *
 * The rejected value is named in the error and so is the property — taken from the
 * `prop` argument rather than repeated in each row, which is what stops the message
 * and the row drifting apart.
 */
const keyword =
  (field: StyleField, map: Readonly<Record<string, number>>): ExpandRule =>
  (value, out, prop) => {
    const v = map[value.toLowerCase()];
    if (v === undefined) throw new CssError(`unsupported ${prop} "${value}"`);
    out[field] = v;
  };

/** Both axes of a `place-*` shorthand, split by {@link splitAlignPair}. */
const pairKeyword =
  (blockField: StyleField, inlineField: StyleField, map: Readonly<Record<string, number>>): ExpandRule =>
  (value, out, prop) => {
    const [a, j] = splitAlignPair(value, prop);
    const av = map[a];
    const jv = map[j];
    if (av === undefined || jv === undefined) {
      throw new CssError(`unsupported ${prop} "${value}"`);
    }
    out[blockField] = av;
    out[inlineField] = jv;
  };

/** A bare number, refused rather than allowed through as NaN. */
const finite =
  (prop: string) =>
  (value: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new CssError(`bad ${prop} "${value}"`);
    return n;
  };

/**
 * `scrollbar-width`'s three keywords. Measured — `thick` and `<length>` are not
 * part of the property, whatever MDN's scrollbars guide says.
 */
const SCROLLBAR_WIDTHS: Readonly<Record<string, number>> = {
  auto: ScrollbarWidth.AUTO,
  thin: ScrollbarWidth.THIN,
  none: ScrollbarWidth.NONE,
};

/** `auto | <color>`, where `auto` is alpha 0 — "nothing was said here". */
const colorOrAuto = (value: string): number =>
  value.toLowerCase() === "auto" ? 0x00000000 : parseColor(value);

/**
 * A property the *caller* expands, listed so the table stays the honest manifest.
 *
 * `display` interacts with `flex-direction`; `content` is a string where every style
 * field is a number; the timing properties resolve as a set into a side table. None
 * can be a rule here, and all are things dziri supports — so they are present and
 * do nothing rather than absent and reported as unsupported.
 */
const handledByCaller: ExpandRule = () => {};

/** `gap` and its `grid-gap` spelling: one value for both axes, or `<row> <column>`. */
const gapShorthand: ExpandRule = (value, out) => {
  const parts = splitTopLevel(value);
  out.gapRow = parseLength(parts[0]!);
  out.gapCol = parts[1] ? parseLength(parts[1]) : out.gapRow;
};

/** One parsed `box-shadow` layer, in list order — earlier layers paint on top. */
type ShadowLayer = {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: number;
};

/**
 * One `box-shadow` layer: `inset? && <length>{2,4} && <color>?`.
 *
 * `inset` and the colour may sit anywhere in the layer — CSS says so, and Tailwind puts
 * `inset` first while a hand-written sheet often puts the colour there. The lengths are
 * positional: `<x> <y> <blur>? <spread>?`.
 */
function parseShadowLayer(layer: string): ShadowLayer {
  let inset = false;
  let color: number | null = null;
  const lengths: number[] = [];

  for (const token of splitTopLevel(layer)) {
    if (/^inset$/i.test(token)) {
      if (inset) throw new CssError(`two "inset" keywords in one box-shadow layer ("${layer}")`);
      inset = true;
      continue;
    }
    // A length starts with a digit, a sign or a dot; `calc(...)` is a length too, and by
    // this point it is the only function a length can be — `var()` was substituted long
    // before the expander saw the value.
    if (/^[-+.\d]/.test(token) || /^calc\(/i.test(token)) {
      lengths.push(parseLength(token));
      continue;
    }
    if (color !== null) throw new CssError(`two colors in one box-shadow layer ("${layer}")`);
    color = parseColor(token);
  }

  if (lengths.length < 2 || lengths.length > 4) {
    throw new CssError(
      `box-shadow layer "${layer}" has ${lengths.length} lengths; CSS allows 2 to 4 ` +
        `(<x> <y> <blur>? <spread>?)`,
    );
  }

  return {
    inset,
    x: lengths[0]!,
    y: lengths[1]!,
    blur: lengths[2] ?? 0,
    spread: lengths[3] ?? 0,
    // CSS's omitted shadow colour is `currentcolor`, and the cascade has already
    // substituted that keyword by the time this runs — so an omitted colour here means
    // the sheet said nothing a colour could come from, and nothing is drawn.
    color: color ?? 0x00000000,
  };
}

/**
 * `box-shadow`, reduced to the concentric bands a fixed style row can hold.
 *
 * # Why a subset, and why *this* subset
 *
 * A style row is a struct of fixed fields; a shadow list is a list. The part that fits is
 * the part with **no offset and no blur** — a spread in a solid colour, which paints an
 * even band around the border box. That is not an arbitrary line: it is exactly what
 * Tailwind's `ring-*`, `inset-ring-*` and `ring-offset-*` utilities compile to. Measured
 * against Tailwind v4.3.3 through dziri's own `var()`/`@property` machinery —
 * `ring-2 ring-sky-400 ring-offset-2 ring-offset-black` arrives here as
 *
 *   `0 0 #0000, 0 0 #0000, 0 0 0 2px #000, 0 0 0 calc(2px + 2px) #38bdf8, 0 0 #0000`
 *
 * — recorded in BROWSER-FACTS.md. The transparent placeholders are the four unset
 * `--tw-*-shadow` variables reaching their `@property` initial values.
 *
 * # How layers become bands
 *
 * Earlier layers paint **over** later ones. A zero-offset zero-blur outset layer of spread
 * S covers the region from the border box out to +S, so two of them compose into two
 * concentric bands: the widest gives the outer edge, and a *narrower one written earlier*
 * paints over its inner part. A narrower one written *later* is behind the wider one and
 * therefore invisible, which is why it is dropped rather than stored.
 *
 * That is a ring offset, exactly. `ring-offset-2` is the narrower layer and it is emitted
 * before `--tw-ring-shadow` in the list.
 *
 * # What is refused
 *
 * Blur and offsets are **warned about and dropped**, not thrown on: `shadow-md` is
 * ordinary Tailwind and a build that fails on it would be unusable, while a drop-shadow
 * silently rendered as a ring would be worse than nothing. A malformed layer — three
 * colours, five lengths — does throw, because that is a mistake rather than a feature gap.
 */
function parseBoxShadow(value: string, out: Partial<Record<StyleField, number>>): void {
  const reset = () => {
    out.ringOuterWidth = 0;
    out.ringOuterColor = 0;
    out.ringInnerWidth = 0;
    out.ringInnerColor = 0;
    out.ringInsetWidth = 0;
    out.ringInsetColor = 0;
  };

  // A shorthand always resets, so `box-shadow: none` after a ring removes it rather than
  // leaving the ring standing.
  reset();
  if (/^none$/i.test(value.trim())) return;

  const layers = splitTopLevelCommas(value).map(parseShadowLayer);

  const bands: ShadowLayer[] = [];
  for (const layer of layers) {
    // Fully transparent paints nothing. This is the common case, not an edge one: four of
    // Tailwind's five layers are `0 0 #0000` on any element that wears one ring.
    if (layer.color >>> 24 === 0) continue;
    if (layer.x !== 0 || layer.y !== 0 || layer.blur !== 0) {
      warnOnce(
        `ignoring a box-shadow layer with an offset or blur ("${layer.x}px ${layer.y}px ` +
          `${layer.blur}px"). Only ring-style shadows — no offset, no blur, a solid ` +
          `spread — reach the engine.`,
      );
      continue;
    }
    // No spread and no offset is a shadow exactly the size of the box, hidden behind it.
    if (layer.spread <= 0) continue;
    bands.push(layer);
  }

  const inset = bands.filter((b) => b.inset);
  const outset = bands.filter((b) => !b.inset);

  if (inset.length > 1) {
    warnOnce(
      `${inset.length} inset box-shadow bands, and a style row holds one. Keeping the ` +
        `first, which is the one painted on top.`,
    );
  }
  if (inset[0]) {
    out.ringInsetWidth = inset[0].spread;
    out.ringInsetColor = inset[0].color;
  }

  if (outset.length === 0) return;

  // The widest band sets the outer edge. `reduce` rather than a sort so ties keep the
  // earlier layer, which is the one painted on top and therefore the visible colour.
  let outerAt = 0;
  for (let i = 1; i < outset.length; i++) {
    if (outset[i]!.spread > outset[outerAt]!.spread) outerAt = i;
  }
  const outer = outset[outerAt]!;
  out.ringOuterWidth = outer.spread;
  out.ringOuterColor = outer.color;

  // The inner band is the widest of the layers painted *over* the outer one — those before
  // it in the list. Anything after it is behind it and invisible.
  let innerAt = -1;
  for (let i = 0; i < outerAt; i++) {
    if (innerAt === -1 || outset[i]!.spread > outset[innerAt]!.spread) innerAt = i;
  }
  if (innerAt !== -1) {
    out.ringInnerWidth = outset[innerAt]!.spread;
    out.ringInnerColor = outset[innerAt]!.color;
  }

  if (outerAt > 1) {
    warnOnce(
      `${outerAt + 1} outset box-shadow bands, and a style row holds two. Keeping the ` +
        `widest and the widest of the ones drawn over it.`,
    );
  }
}

/** `text-decoration-line`'s keywords, ORed into the bit set. */
function decorationLines(value: string): number {
  let bits = 0;
  for (const part of splitTopLevel(value.toLowerCase())) {
    if (part === "none") return 0;
    const bit = part === "underline" ? 1 : part === "overline" ? 2 : part === "line-through" ? 4 : 0;
    if (bit === 0) throw new CssError(`unsupported text-decoration-line "${part}"`);
    bits |= bit;
  }
  return bits;
}

/** `text-decoration-style`'s five keywords, in the schema's order. */
function decorationStyleValue(value: string): number {
  const v = value.trim().toLowerCase();
  const map: Record<string, number> = { solid: 0, double: 1, dotted: 2, dashed: 3, wavy: 4 };
  const style = map[v];
  if (style === undefined) throw new CssError(`unsupported text-decoration-style "${value}"`);
  return style;
}

/** `grid-column` / `grid-row`: a start line and a span, from {@link parsePlacement}. */
const placement =
  (startField: StyleField, spanField: StyleField): ExpandRule =>
  (value, out) => {
    const [start, span] = parsePlacement(value);
    out[startField] = start;
    out[spanField] = span;
  };

/**
 * `filter` / `backdrop-filter`: `none`, or a space-separated list of filter
 * functions. Stored as presence only (0/1) — the engine has no filter pipeline
 * yet — but the list is validated so a typo is a diagnostic, not a silent drop.
 *
 * Tailwind emits the value as a chain of `var(--tw-blur,)` references with empty
 * fallbacks, which resolve to runs of whitespace between the functions — so
 * whitespace-only segments are skipped rather than rejected.
 */
function filterValue(value: string): number {
  const v = value.trim().toLowerCase();
  if (v === "none") return 0;
  let any = false;
  for (const fn of value.matchAll(/([a-z-]+)\s*\([^()]*\)/gi)) {
    const name = fn[1]!.toLowerCase();
    const known = [
      "blur", "brightness", "contrast", "drop-shadow", "grayscale",
      "hue-rotate", "invert", "opacity", "saturate", "sepia",
    ];
    if (!known.includes(name)) {
      throw new CssError(`filter function "${name}()" is not one dziri accepts`);
    }
    any = true;
  }
  // Anything left after stripping the functions must be whitespace — an
  // unrecognised token (a bare keyword, a bad function) is an error.
  const rest = value.replace(/([a-z-]+)\s*\([^()]*\)/gi, "").trim();
  if (rest.length > 0) {
    throw new CssError(`filter: "${value}" contains "${rest}", which is not a filter function`);
  }
  return any ? 1 : 0;
}

/** One `<blend-mode>` keyword, in the schema's BlendMode order. */
function blendModeValue(value: string): number {
  const map: Record<string, number> = {
    normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5,
    "color-dodge": 6, "color-burn": 7, "hard-light": 8, "soft-light": 9,
    difference: 10, exclusion: 11, hue: 12, saturation: 13, color: 14, luminosity: 15,
  };
  const v = map[value.trim().toLowerCase()];
  if (v === undefined) throw new CssError(`unsupported blend mode "${value}"`);
  return v;
}

export const PROPERTIES: Record<string, PropertyRule> = {
  background: { field: "bg", parse: parseColor },
  "background-color": { field: "bg", parse: parseColor },
  color: { field: "fg", parse: parseColor },

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
  "border-radius": (value, out) => {
    if (value.includes("/")) {
      throw new CssError(`elliptical border-radius is not supported ("${value}")`);
    }
    const parts = splitTopLevel(value).map(parseLength);
    const [a, b = a, c = a, d = b] = parts as [number, number?, number?, number?];
    out.radTL = a!;
    out.radTR = b!;
    out.radBR = c!;
    out.radBL = d!;
  },

  "border-top-left-radius": { field: "radTL", parse: (v) => parseLength(splitTopLevel(v)[0]!) },
  "border-top-right-radius": { field: "radTR", parse: (v) => parseLength(splitTopLevel(v)[0]!) },
  "border-bottom-right-radius": { field: "radBR", parse: (v) => parseLength(splitTopLevel(v)[0]!) },
  "border-bottom-left-radius": { field: "radBL", parse: (v) => parseLength(splitTopLevel(v)[0]!) },
  // Logical corner radii, mapped to the physical corners under LTR — the same
  // answer `border-inline-start-width` and friends give throughout this table.
  "border-start-start-radius": { field: "radTL", parse: (v) => parseLength(splitTopLevel(v)[0]!) },
  "border-start-end-radius": { field: "radTR", parse: (v) => parseLength(splitTopLevel(v)[0]!) },
  "border-end-end-radius": { field: "radBR", parse: (v) => parseLength(splitTopLevel(v)[0]!) },
  "border-end-start-radius": { field: "radBL", parse: (v) => parseLength(splitTopLevel(v)[0]!) },

  "border": (value, out) => borderShorthand(value, out, BORDER_W, BORDER_C),
  "border-top": (value, out) => borderShorthand(value, out, ["borderTopWidth"], ["borderTopColor"]),
  "border-right": (value, out) =>
    borderShorthand(value, out, ["borderRightWidth"], ["borderRightColor"]),
  "border-bottom": (value, out) =>
    borderShorthand(value, out, ["borderBottomWidth"], ["borderBottomColor"]),
  "border-left": (value, out) =>
    borderShorthand(value, out, ["borderLeftWidth"], ["borderLeftColor"]),
  "border-inline": (value, out) =>
    borderShorthand(value, out, ["borderLeftWidth", "borderRightWidth"], ["borderLeftColor", "borderRightColor"]),
  "border-block": (value, out) =>
    borderShorthand(value, out, ["borderTopWidth", "borderBottomWidth"], ["borderTopColor", "borderBottomColor"]),

  "border-width": (value, out) => {
    const parts = boxShorthandWith(value, borderWidthValue);
    for (let i = 0; i < 4; i++) out[BORDER_W[i]!] = parts[i]!;
  },
  "border-top-width": { field: "borderTopWidth", parse: borderWidthValue },
  "border-right-width": { field: "borderRightWidth", parse: borderWidthValue },
  "border-bottom-width": { field: "borderBottomWidth", parse: borderWidthValue },
  "border-left-width": { field: "borderLeftWidth", parse: borderWidthValue },
  "border-inline-width": axis("borderLeftWidth", "borderRightWidth"),
  "border-block-width": axis("borderTopWidth", "borderBottomWidth"),
  "border-inline-start-width": { field: "borderLeftWidth", parse: borderWidthValue },
  "border-inline-end-width": { field: "borderRightWidth", parse: borderWidthValue },
  "border-block-start-width": { field: "borderTopWidth", parse: borderWidthValue },
  "border-block-end-width": { field: "borderBottomWidth", parse: borderWidthValue },

  "border-color": (value, out) => {
    const parts = splitTopLevel(value);
    if (parts.length > 4) throw new CssError(`border-color takes 1 to 4 values, got "${value}"`);
    const colors = parts.map(parseColor);
    const [a, b = a, c = a, d = b] = colors as [number, number?, number?, number?];
    out.borderTopColor = a!;
    out.borderRightColor = b!;
    out.borderBottomColor = c!;
    out.borderLeftColor = d!;
  },
  "border-top-color": { field: "borderTopColor", parse: parseColor },
  "border-right-color": { field: "borderRightColor", parse: parseColor },
  "border-bottom-color": { field: "borderBottomColor", parse: parseColor },
  "border-left-color": { field: "borderLeftColor", parse: parseColor },
  "border-inline-color": (value, out) => {
    const c = parseColor(value);
    out.borderLeftColor = c;
    out.borderRightColor = c;
  },
  "border-block-color": (value, out) => {
    const c = parseColor(value);
    out.borderTopColor = c;
    out.borderBottomColor = c;
  },
  "border-inline-start-color": { field: "borderLeftColor", parse: parseColor },
  "border-inline-end-color": { field: "borderRightColor", parse: parseColor },
  "border-block-start-color": { field: "borderTopColor", parse: parseColor },
  "border-block-end-color": { field: "borderBottomColor", parse: parseColor },

  // Style has no field: a side is drawn exactly when it has both a width and a
  // colour, so `none` is width 0 and every other keyword is the absence of a
  // change. The patterned styles paint solid with a warning — a dashed border
  // rendered solid is a fidelity note, not a wrong box.
  "border-style": (value, out) => borderStyle(value, out, BORDER_W, 4),
  "border-top-style": (value, out) => borderStyle(value, out, ["borderTopWidth"], 1),
  "border-right-style": (value, out) => borderStyle(value, out, ["borderRightWidth"], 1),
  "border-bottom-style": (value, out) => borderStyle(value, out, ["borderBottomWidth"], 1),
  "border-left-style": (value, out) => borderStyle(value, out, ["borderLeftWidth"], 1),
  "border-inline-style": (value, out) =>
    borderStyle(value, out, ["borderLeftWidth", "borderRightWidth"], 2),
  "border-block-style": (value, out) =>
    borderStyle(value, out, ["borderTopWidth", "borderBottomWidth"], 2),

  // `outline` — the same grammar as `border`, one ring instead of four sides,
  // and *no layout*: an outline never moves a box, so all three fields are
  // paint-only. `outline-offset` is signed; a negative one draws inside.
  outline: (value, out) => borderShorthand(value, out, ["outlineWidth"], ["outlineColor"]),
  "outline-color": { field: "outlineColor", parse: parseColor },
  "outline-width": { field: "outlineWidth", parse: borderWidthValue },
  "outline-offset": { field: "outlineOffset", parse: parseLength },
  "outline-style": (value, out) => borderStyle(value, out, ["outlineWidth"], 1, "outline-style"),

  // `text-decoration`. The line is a bit set — `underline overline` is legal
  // CSS and both paint — and the shorthand is the four longhands in any order.
  "text-decoration-line": (value, out) => {
    out.decorationLine = decorationLines(value);
  },
  "text-decoration-color": { field: "decorationColor", parse: parseColor },
  "text-decoration-style": (value, out) => {
    out.decorationStyle = decorationStyleValue(value);
  },
  // `auto` and `from-font` both mean "the font's own metric", which the wire
  // spells 0. A percentage is of the font size, which the compiler knows.
  "text-decoration-thickness": (value, out) => {
    const v = value.trim().toLowerCase();
    if (v === "auto" || v === "from-font") {
      out.decorationThickness = 0;
    } else if (v.endsWith("%")) {
      throw new CssError(
        `text-decoration-thickness: "${value}" — a percentage is of the font size, ` +
          `which this expander cannot see; write the px you mean`,
      );
    } else {
      out.decorationThickness = parseLength(v);
    }
  },
  // `auto` is NaN, the table's "nothing was said" for lengths.
  "text-underline-offset": (value, out) => {
    const v = value.trim().toLowerCase();
    out.underlineOffset = v === "auto" ? NaN : parseLength(v);
  },
  "text-decoration": (value, out) => {
    const v = value.trim().toLowerCase();
    if (v === "none") {
      out.decorationLine = 0;
      return;
    }
    for (const part of splitTopLevel(value)) {
      const p = part.toLowerCase();
      if (/^(underline|overline|line-through)$/.test(p)) {
        out.decorationLine = (out.decorationLine ?? 0) | decorationLines(p);
      } else if (/^(solid|double|dotted|dashed|wavy)$/.test(p)) {
        out.decorationStyle = decorationStyleValue(p);
      } else if (/^-?[\d.]/.test(p) || p.startsWith("calc(")) {
        out.decorationThickness = parseLength(p);
      } else {
        out.decorationColor = parseColor(part);
      }
    }
  },

  "box-shadow": parseBoxShadow,

  padding: quad("padT", "padR", "padB", "padL"),

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
  "padding-inline": axis("padL", "padR"),
  "padding-block": axis("padT", "padB"),
  "padding-inline-start": { field: "padL", parse: parseLength },
  "padding-inline-end": { field: "padR", parse: parseLength },
  "padding-block-start": { field: "padT", parse: parseLength },
  "padding-block-end": { field: "padB", parse: parseLength },

  "margin-inline": axis("marL", "marR"),
  "margin-block": axis("marT", "marB"),
  "margin-inline-start": { field: "marL", parse: parseLength },
  "margin-inline-end": { field: "marR", parse: parseLength },
  "margin-block-start": { field: "marT", parse: parseLength },
  "margin-block-end": { field: "marB", parse: parseLength },

  /**
   * `inset` and its two axis forms, which are shorthands over the four fields
   * the four longhands already write.
   *
   * They were the cheapest thing left in Tailwind's blocker list precisely
   * because there is nothing new underneath: `insetT/R/B/L` exist, both the
   * physical (`top`) and logical (`inset-block-start`) spellings resolve to them,
   * and only the shorthand was unwritten — so `inset-0` failed while `top-0`
   * worked. 125 classes each, and no field, no engine change and no protocol
   * bump between them.
   */
  inset: (value, out) => {
    const parts = boxShorthandWith(value, lengthCalc);
    const sides = [
      ["insetT", "insetTPct"],
      ["insetR", "insetRPct"],
      ["insetB", "insetBPct"],
      ["insetL", "insetLPct"],
    ] as const;
    for (let i = 0; i < 4; i++) {
      const d = parts[i]!;
      if (d.vw !== 0 || d.vh !== 0) {
        throw new CssError(`inset: "${value}" — viewport units are not supported on inset`);
      }
      out[sides[i]![0]] = d.px;
      out[sides[i]![1]] = d.pct;
    }
  },
  "inset-inline": (value, out) => {
    const [a, b] = boxShorthandWith(value, lengthCalc);
    for (const [d, px, pct] of [
      [a, "insetL", "insetLPct"],
      [b, "insetR", "insetRPct"],
    ] as const) {
      if (d.vw !== 0 || d.vh !== 0) {
        throw new CssError(`inset-inline: "${value}" — viewport units are not supported on inset`);
      }
      out[px] = d.px;
      out[pct] = d.pct;
    }
  },
  "inset-block": (value, out) => {
    const [a, b] = boxShorthandWith(value, lengthCalc);
    for (const [d, px, pct] of [
      [a, "insetT", "insetTPct"],
      [b, "insetB", "insetBPct"],
    ] as const) {
      if (d.vw !== 0 || d.vh !== 0) {
        throw new CssError(`inset-block: "${value}" — viewport units are not supported on inset`);
      }
      out[px] = d.px;
      out[pct] = d.pct;
    }
  },
  "inset-inline-start": insetLen("insetL", "insetLPct"),
  "inset-inline-end": insetLen("insetR", "insetRPct"),
  "inset-block-start": insetLen("insetT", "insetTPct"),
  "inset-block-end": insetLen("insetB", "insetBPct"),

  "padding-top": { field: "padT", parse: parseLength },
  "padding-right": { field: "padR", parse: parseLength },
  "padding-bottom": { field: "padB", parse: parseLength },
  "padding-left": { field: "padL", parse: parseLength },

  margin: quad("marT", "marR", "marB", "marL"),
  "margin-top": { field: "marT", parse: parseLength },
  "margin-right": { field: "marR", parse: parseLength },
  "margin-bottom": { field: "marB", parse: parseLength },
  "margin-left": { field: "marL", parse: parseLength },

  "flex-direction": (value, out) => {
    const v = value.toLowerCase();
    if (v !== "row" && v !== "column") {
      throw new CssError(`unsupported flex-direction "${value}"`);
    }
    out.direction = v === "row" ? Direction.ROW : Direction.COLUMN;
  },
  "flex-wrap": keyword("wrap", WRAP_KEYWORDS),
  "justify-content": keyword("justify", JUSTIFY_KEYWORDS),
  "align-items": keyword("align", ALIGN_KEYWORDS),
  "align-self": keyword("alignSelf", SELF_KEYWORDS),
  "justify-items": keyword("justifyItems", ALIGN_KEYWORDS),
  "justify-self": keyword("justifySelf", SELF_KEYWORDS),
  // `align-content` — line distribution in a wrapping container. Same keyword
  // set as justify-content (Taffy's AlignContent); `normal`/`stretch` map to
  // UNSET so Taffy's default answers.
  "align-content": (value, out) => {
    out.alignContent = alignContentKeyword(value);
  },

  /**
   * `place-items`, `place-self` and `place-content`, which set both axes at once.
   *
   * `place-content` is here because `align-content` now exists. Its value space
   * is the justify keyword set plus `stretch`/`baseline` on the align half,
   * which the `align-content` rule itself folds to UNSET.
   *
   * The two halves are split by {@link splitAlignPair}, not by whitespace, and
   * that is the whole subtlety of these properties. See it for why.
   */
  "place-items": pairKeyword("align", "justifyItems", ALIGN_KEYWORDS),
  "place-self": pairKeyword("alignSelf", "justifySelf", SELF_KEYWORDS),
  "place-content": (value, out, prop) => {
    const [a, j] = splitAlignPair(value, prop);
    out.alignContent = alignContentKeyword(a);
    const jv = JUSTIFY_KEYWORDS[j];
    if (jv === undefined) throw new CssError(`unsupported ${prop} "${value}"`);
    out.justify = jv;
  },

  flex: (value, out) => {
    // `flex: <grow> <shrink> <basis>`, plus the two keywords worth having.
    const v = value.toLowerCase();
    if (v === "none") {
      out.grow = 0;
      out.shrink = 0;
      out.basis = AUTO;
      out.basisPct = 0;
      return;
    }
    if (v === "auto") {
      out.grow = 1;
      out.shrink = 1;
      out.basis = AUTO;
      out.basisPct = 0;
      return;
    }

    const parts = splitTopLevel(v);
    const grow = Number(parts[0]);
    if (!Number.isFinite(grow)) throw new CssError(`bad flex "${value}"`);
    out.grow = grow;
    // The grammar is `<grow> <shrink>? <basis>?`, and the basis is a *length* —
    // so a non-numeric second value is the basis, not the shrink: `flex: 1 100px`
    // is grow 1, shrink 1 (the default), basis 100px. Telling them apart by
    // value rather than position was the bug: a length equal to no number string
    // still got skipped for *being* parts[1].
    let shrink = 1;
    let basisPart: string | undefined;
    if (parts.length > 1) {
      if (Number.isFinite(Number(parts[1]))) shrink = Number(parts[1]);
      else basisPart = parts[1];
    }
    if (parts.length > 2) basisPart = parts[2];
    // `flex: 1` means `1 1 0`, not `1 1 auto` — the difference is whether
    // items size from content before growing, and it is visible.
    out.shrink = shrink;
    // Both channels, always: a winning `flex` with no basis part still means
    // `0`, and an earlier declaration's fraction has to be cleared with it.
    if (basisPart) basisLen(basisPart, out, "flex");
    else {
      out.basis = 0;
      out.basisPct = 0;
    }
  },
  "flex-grow": { field: "grow", parse: finite("flex-grow") },
  "flex-shrink": { field: "shrink", parse: finite("flex-shrink") },
  "flex-basis": basisLen,

  order: { field: "order", parse: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new CssError(`bad order "${v}"`);
    return n;
  } },

  gap: gapShorthand,
  // The pre-`gap` spelling, which Tailwind still emits for `gap-*` in some configs.
  "grid-gap": gapShorthand,
  "row-gap": { field: "gapRow", parse: parseLength },
  "column-gap": { field: "gapCol", parse: parseLength },

  "grid-template-columns": { field: "gridCols", parse: parseTracks },
  "grid-template-rows": { field: "gridRows", parse: parseTracks },
  "grid-column": placement("gridColStart", "gridColSpan"),
  "grid-row": placement("gridRowStart", "gridRowSpan"),

  "aspect-ratio": {
    field: "aspectRatio",
    parse: (value) => {
      if (value.toLowerCase() === "auto") return AUTO;
      const ratio = /^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/.exec(value.trim());
      const v = ratio ? Number(ratio[1]) / Number(ratio[2]) : Number(value);
      if (!Number.isFinite(v) || v <= 0) throw new CssError(`bad aspect-ratio "${value}"`);
      return v;
    },
  },

  position: (value, out) => {
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
  },
  top: insetLen("insetT", "insetTPct"),
  right: insetLen("insetR", "insetRPct"),
  bottom: insetLen("insetB", "insetBPct"),
  left: insetLen("insetL", "insetLPct"),

  width: sizingLen("width", "widthPct", "widthVp", "w"),
  height: sizingLen("height", "heightPct", "heightVp", "h"),
  "min-width": sizingLen("minW", "minWPct", "minWVp", "w"),
  "max-width": maxLen("maxW", "maxWPct", "maxWVp", "w"),
  "min-height": sizingLen("minH", "minHPct", "minHVp", "h"),
  "max-height": maxLen("maxH", "maxHPct", "maxHVp", "h"),

  /**
   * The logical sizing properties, which are aliases and not a feature.
   *
   * A writing mode would make them one — `inline-size` is the *cross* dimension
   * in `vertical-rl`, not the width. dziri has no writing mode and no plans for
   * one, so horizontal-tb holds everywhere and the inline axis *is* the
   * horizontal axis. Mapping them straight onto the physical fields is therefore
   * exact rather than approximate.
   *
   * They used to be written out longhand for a reason that has gone away: coverage
   * was recovered by scanning the switch for `case "…":`, so a property aliased any
   * other way was invisible to the number. A key in this table is visible however it
   * got here.
   */
  "inline-size": sizingLen("width", "widthPct", "widthVp", "w"),
  "block-size": sizingLen("height", "heightPct", "heightVp", "h"),
  "min-inline-size": sizingLen("minW", "minWPct", "minWVp", "w"),
  "max-inline-size": maxLen("maxW", "maxWPct", "maxWVp", "w"),
  "min-block-size": sizingLen("minH", "minHPct", "minHVp", "h"),
  "max-block-size": maxLen("maxH", "maxHPct", "maxHVp", "h"),

  "font-size": { field: "fontSize", parse: parseLength },

  // `line-height`: a multiplier, a percentage of the font size, or an absolute
  // length. Two channels because the px form folds against the *resolved* font
  // size, which only the engine knows — see the schema note.
  "line-height": (value, out) => {
    const v = value.trim().toLowerCase();
    if (v === "normal") {
      out.lineHeight = 0;
      out.lineHeightPx = NaN;
      return;
    }
    if (v.endsWith("%")) {
      const n = Number(v.slice(0, -1));
      if (!Number.isFinite(n) || n < 0) throw new CssError(`bad line-height "${value}"`);
      out.lineHeight = n / 100;
      out.lineHeightPx = NaN;
      return;
    }
    const n = Number(v);
    if (Number.isFinite(n)) {
      if (n < 0) throw new CssError(`bad line-height "${value}"`);
      out.lineHeight = n;
      out.lineHeightPx = NaN;
      return;
    }
    out.lineHeight = 0;
    out.lineHeightPx = parseLength(v);
  },
  "text-indent": { field: "textIndent", parse: (v) => parseLength(splitTopLevel(v)[0]!) },
  "font-weight": {
    field: "fontWeight",
    parse: (value) => {
      const v = value.toLowerCase();
      if (v === "normal") return 400;
      if (v === "bold") return 700;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new CssError(`bad font-weight "${value}"`);
      return n;
    },
  },

  // A slant flag. `oblique` maps to italic — for a face with no true italic the
  // platform synthesizes a slant either way, and no probe has yet shown a case
  // where the distinction survives to pixels here. `oblique <angle>` is refused:
  // an angle needs a field, and nothing has measured wanting one.
  "font-style": {
    field: "fontStyle",
    parse: (value) => {
      switch (value.trim().toLowerCase()) {
        case "normal":
          return 0;
        case "italic":
        case "oblique":
          return 1;
        default:
          throw new CssError(`unsupported font-style "${value}"`);
      }
    },
  },

  // A *generic* family, never a name. dziri resolves one concrete face per
  // generic at startup (`Measurer::new`), so an author picks a category and the
  // platform picks the font — a font file cannot ride in a style table, and
  // naming faces is @font-face territory, a committed non-goal for now. The
  // list form is honoured by scanning for the first generic present, which is
  // what a browser's fallback walk degenerates to when none of the named faces
  // exist: `font-family: "Fira Code", ui-monospace, monospace` is MONOSPACE.
  // A list with no recognised generic keeps the default face rather than being
  // an error, because that is exactly what a browser does when every name
  // misses — but it is worth a warning, which expandDeclaration cannot issue;
  // the value resolves to the default silently. Measured need may promote it.
  "font-family": {
    field: "fontFamily",
    parse: (value) => {
      for (const part of value.split(",")) {
        const generic = part.trim().toLowerCase().replace(/^["']|["']$/g, "");
        if (generic === "monospace" || generic === "ui-monospace") return 1;
      }
      return 0;
    },
  },

  // `overflow` takes one value for both axes or two as `<x> <y>`, and the two
  // longhands set one axis each. The asymmetric case is the common one — a column
  // that scrolls vertically and must never scroll sideways — so the schema carries
  // an axis each rather than one field that would have to lie about the other.
  overflow: (value, out) => {
    const parts = value.trim().toLowerCase().split(/\s+/);
    if (parts.length > 2) throw new CssError(`overflow takes one or two values, got "${value}"`);
    out.overflowX = overflowKeyword(parts[0]!, value);
    out.overflowY = overflowKeyword(parts[1] ?? parts[0]!, value);
  },
  "overflow-x": { field: "overflowX", parse: (v) => overflowKeyword(v.trim().toLowerCase(), v) },
  "overflow-y": { field: "overflowY", parse: (v) => overflowKeyword(v.trim().toLowerCase(), v) },

  // The two standard scrollbar properties. Both grammars are measured rather than
  // remembered, and one of them refuted its own documentation — MDN's *Scrollbars
  // styling* guide summarises `scrollbar-width` as `auto | thin | thick | <length>`,
  // and Chromium 151 rejects `thick` and a length outright. See BROWSER-FACTS.md,
  // "Which scrollbar declarations the parser keeps".
  //
  // A map rather than a nested switch, and that is not only tidiness: the nested
  // `case "auto"` / `case "thin"` / `case "none"` this replaces were picked up as
  // candidate properties by the coverage scripts, which scraped `case` labels at any
  // depth — harmless only because a spec lookup downstream dropped them again. The
  // same hazard is why `appearance` below is written as ifs.
  "scrollbar-width": (value, out) => {
    const v = value.trim().toLowerCase();
    const width = SCROLLBAR_WIDTHS[v];
    if (width === undefined) {
      throw new CssError(
        `scrollbar-width takes auto, thin or none, got "${value}" ` +
          `(thick and <length> are not part of the property)`,
      );
    }
    out.scrollbarWidth = width;
  },

  "scrollbar-color": (value, out) => {
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
      throw new CssError(`scrollbar-color takes two colours, thumb then track, got "${value}"`);
    }
    out.scrollbarThumb = parseColor(parts[0]!);
    out.scrollbarTrack = parseColor(parts[1]!);
  },

  // The form-control properties. Three of the five ROADMAP C2 lists; `resize`
  // and `field-sizing: content` are committed non-goals there and are refused
  // by the miss branch in `expandDeclaration` like any other unsupported property.
  //
  // Both colours take `auto | <color>`, and `auto` is alpha 0 — the same
  // "nothing was said here" sentinel `border-color` and `scrollbar-color` use.
  // Spelling it as a value rather than a flag is what keeps these ordinary
  // interned fields: the cascade, the variant runs and the patch machinery all
  // work on numbers and never learn that this one has a keyword.
  "accent-color": { field: "accentColor", parse: colorOrAuto },
  "caret-color": { field: "caretColor", parse: colorOrAuto },

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
  appearance: {
    field: "appearance",
    parse: (value) => {
      const v = value.toLowerCase();
      if (v === "none") return Appearance.NONE;
      if (v === "auto" || COMPAT_AUTO.has(v)) return Appearance.AUTO;
      // The opt-in that makes a `<select>` and its `::picker(select)` fully
      // styleable, and the reason this property is worth having at all: it is how
      // an author says "stop drawing the platform control, I am styling the
      // parts". Measured as shipping in Chromium 151, on any element.
      if (v === "base-select") return Appearance.BASE_SELECT;
      throw new CssError(
        `appearance: "${value}" is not a value dziri accepts.\n` +
          `  Supported: none, auto, base-select, and the <compat-auto> keywords ` +
          `(${[...COMPAT_AUTO].join(", ")}), which fold to auto.\n` +
          `  Refused: base (specified, but no browser implements it — Chromium 151 ` +
          `drops the declaration); textfield and menulist-button (real distinct ` +
          `effects on input types and on a select's picker, and dziri has neither yet).`,
      );
    },
  },

  // `cursor` — the SDL system cursor shown on hover. Tailwind's cursor-* classes.
  // Values map to SDL_SystemCursor enum: 0 SDL_SYSTEM_CURSOR_AUTO (default),
  // 1 SDL_SYSTEM_CURSOR_DEFAULT, 2 SDL_SYSTEM_CURSOR_POINTER, 3 SDL_SYSTEM_CURSOR_TEXT, etc.
  cursor: {
    field: "cursor",
    parse: (value) => {
      const v = value.toLowerCase();
      const cursors: Record<string, number> = {
        auto: 0,
        default: 1,
        pointer: 2,
        text: 3,
        grab: 4,
        grabbing: 5,
        wait: 6,
        "not-allowed": 7,
        move: 8,
        "ns-resize": 9,
        "ew-resize": 10,
        "nwse-resize": 11,
        "nesw-resize": 12,
        "col-resize": 13,
        "row-resize": 14,
        "all-scroll": 15,
        "zoom-in": 16,
        "zoom-out": 17,
        help: 18,
        progress: 19,
      };
      // The lookup *is* the test, which is what `noUncheckedIndexedAccess` asks for: `v in
      // cursors` narrows a property access on a known key and not an index into a
      // `Record<string, number>`, so the guarded `cursors[v]` was still `number | undefined`
      // and violated this function's declared return type. Reading once and testing the result
      // needs no assertion and no second lookup.
      const found = cursors[v];
      if (found !== undefined) return found;
      throw new CssError(
        `cursor: "${value}" is not a value dziri accepts.\n` +
          `  Supported: ${Object.keys(cursors).join(", ")}`,
      );
    },
  },

  // `border-spacing` — horizontal and vertical distance between table cell borders.
  // Applied to `<table>` but dziri doesn't render tables; paint-only.
  // Two-value form: h v; single value means both. CSS default is 2px.
  "border-spacing": (value, out) => {
    const parts = value.trim().split(/\s+/);
    if (parts.length < 1 || parts.length > 2) {
      throw new CssError(`border-spacing takes 1 or 2 values, got "${value}"`);
    }
    const h = parseLength(parts[0]!);
    const v = parts[1] === undefined ? h : parseLength(parts[1]);
    if (!Number.isFinite(h) || !Number.isFinite(v)) {
      throw new CssError(`border-spacing: "${value}" — lengths must be numbers, not keywords`);
    }
    out.borderSpacingH = h;
    out.borderSpacingV = v;
  },

  // `scroll-margin` and its per-side variants. Paint-only (no layout effect).
  // Shorthand form expands to four sides like margin/padding.
  "scroll-margin": (value, out) => {
    const parts = value.trim().split(/\s+/).filter(p => p);
    if (parts.length < 1 || parts.length > 4) {
      throw new CssError(`scroll-margin takes 1 to 4 values, got "${value}"`);
    }
    const v = parts.map(parseLength);
    const [t, r, b, l] = v.length === 1 ? [v[0], v[0], v[0], v[0]] 
                         : v.length === 2 ? [v[0], v[1], v[0], v[1]]
                         : v.length === 3 ? [v[0], v[1], v[2], v[1]]
                         : [v[0], v[1], v[2], v[3]];
    out.scrollMarginTop = t;
    out.scrollMarginRight = r;
    out.scrollMarginBottom = b;
    out.scrollMarginLeft = l;
  },

  "scroll-margin-top": {
    field: "scrollMarginTop",
    parse: parseLength,
  },

  "scroll-margin-right": {
    field: "scrollMarginRight",
    parse: parseLength,
  },

  "scroll-margin-bottom": {
    field: "scrollMarginBottom",
    parse: parseLength,
  },

  "scroll-margin-left": {
    field: "scrollMarginLeft",
    parse: parseLength,
  },

  // Logical aliases: scroll-margin-block and scroll-margin-inline expand to top+bottom and left+right
  "scroll-margin-block": (value, out) => {
    const parts = value.trim().split(/\s+/).filter(p => p);
    if (parts.length < 1 || parts.length > 2) {
      throw new CssError(`scroll-margin-block takes 1 or 2 values, got "${value}"`);
    }
    const v = parts.map(parseLength);
    const [block, inlineStart, inlineEnd] = v.length === 1 
      ? [v[0], 0, 0] 
      : [v[0], 0, 0]; // block-start and block-end both set to v[0] or v[1]
    // Actually: block-start is v[0], block-end is v[1]
    out.scrollMarginTop = v[0];
    out.scrollMarginBottom = v.length === 2 ? v[1] : v[0];
  },

  "scroll-margin-block-start": {
    field: "scrollMarginTop",
    parse: parseLength,
  },

  "scroll-margin-block-end": {
    field: "scrollMarginBottom",
    parse: parseLength,
  },

  "scroll-margin-inline": (value, out) => {
    const parts = value.trim().split(/\s+/).filter(p => p);
    if (parts.length < 1 || parts.length > 2) {
      throw new CssError(`scroll-margin-inline takes 1 or 2 values, got "${value}"`);
    }
    const v = parts.map(parseLength);
    out.scrollMarginLeft = v[0];
    out.scrollMarginRight = v.length === 2 ? v[1] : v[0];
  },

  "scroll-margin-inline-start": {
    field: "scrollMarginLeft",
    parse: parseLength,
  },

  "scroll-margin-inline-end": {
    field: "scrollMarginRight",
    parse: parseLength,
  },

  "scroll-padding": (value, out) => {
    const parts = splitTopLevel(value).map(parseLength);
    const [a, b = a, c = a, d = b] = parts as [number, number?, number?, number?];
    out.scrollPaddingTop = a!;
    out.scrollPaddingRight = b!;
    out.scrollPaddingBottom = c!;
    out.scrollPaddingLeft = d!;
  },

  "scroll-padding-top": {
    field: "scrollPaddingTop",
    parse: parseLength,
  },

  "scroll-padding-right": {
    field: "scrollPaddingRight",
    parse: parseLength,
  },

  "scroll-padding-bottom": {
    field: "scrollPaddingBottom",
    parse: parseLength,
  },

  "scroll-padding-left": {
    field: "scrollPaddingLeft",
    parse: parseLength,
  },

  // Logical aliases: scroll-padding-block and scroll-padding-inline expand to top+bottom and left+right
  "scroll-padding-block": (value, out) => {
    const parts = value.trim().split(/\s+/).filter(p => p);
    if (parts.length < 1 || parts.length > 2) {
      throw new CssError(`scroll-padding-block takes 1 or 2 values, got "${value}"`);
    }
    const v = parts.map(parseLength);
    out.scrollPaddingTop = v[0];
    out.scrollPaddingBottom = v.length === 2 ? v[1] : v[0];
  },

  "scroll-padding-block-start": {
    field: "scrollPaddingTop",
    parse: parseLength,
  },

  "scroll-padding-block-end": {
    field: "scrollPaddingBottom",
    parse: parseLength,
  },

  "scroll-padding-inline": (value, out) => {
    const parts = value.trim().split(/\s+/).filter(p => p);
    if (parts.length < 1 || parts.length > 2) {
      throw new CssError(`scroll-padding-inline takes 1 or 2 values, got "${value}"`);
    }
    const v = parts.map(parseLength);
    out.scrollPaddingLeft = v[0];
    out.scrollPaddingRight = v.length === 2 ? v[1] : v[0];
  },

  "scroll-padding-inline-start": {
    field: "scrollPaddingLeft",
    parse: parseLength,
  },

  "scroll-padding-inline-end": {
    field: "scrollPaddingRight",
    parse: parseLength,
  },

  // Clamped rather than refused out of range: CSS says `opacity` clamps to
  // 0..1, and `opacity: 1.5` is a legal declaration meaning fully opaque.
  opacity: {
    field: "opacity",
    parse: (value) => {
      const v = value.trim();
      // A percentage is legal here and means what it says — `opacity: 50%`.
      const n = v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v);
      if (!Number.isFinite(n)) throw new CssError(`bad opacity "${value}"`);
      return Math.min(1, Math.max(0, n));
    },
  },

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
  translate: (value, out) => {
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
  },

  rotate: (value, out) => {
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
  },

  scale: (value, out) => {
    const v = value.trim().toLowerCase();
    if (v === "none") return;
    const parts = splitTopLevel(v);
    if (parts.length > 2) {
      throw new CssError(`scale: "${value}" — a third value is a Z scale and dziri is 2D.`);
    }
    const sx = scaleNumber(parts[0]!);
    // One value scales both axes, unlike `translate` where it means "and zero".
    const sy = parts[1] === undefined ? sx : scaleNumber(parts[1]);
    out.scaleX = (out.scaleX ?? 1) * sx;
    out.scaleY = (out.scaleY ?? 1) * sy;
  },

  transform: (value, out) => {
    if (value.trim().toLowerCase() === "none") return;
    applyTransformList(value, out);
  },

  // `transform-origin` replaces rather than accumulates — it is one property
  // with one value, and nothing else writes these slots.
  "transform-origin": (value, out) => applyTransformOrigin(value, out),

  // `mask-composite` — how multiple mask layers interact. Paint-only property with keywords.
  "mask-composite": {
    field: "maskComposite",
    parse: (value) => {
      const v = value.toLowerCase();
      const modes: Record<string, number> = {
        add: 0,
        subtract: 1,
        intersect: 2,
        exclude: 3,
      };
      // Read once and test the result — see `cursor` above for why `v in modes` does not
      // narrow this and the guarded index was `number | undefined`.
      const found = modes[v];
      if (found !== undefined) return found;
      throw new CssError(
        `mask-composite: "${value}" is not a value dziri accepts.\n` +
          `  Supported: ${Object.keys(modes).join(", ")}`,
      );
    },
  },

  // `mask-image` — the mask layer list. Paint-only, and stored as a presence
  // enum rather than the layers themselves: the engine has no mask rendering
  // yet, so what the style table records is `none` vs "there is a mask", which
  // is what a paint pass needs to know to skip work. The value is still fully
  // parsed — `none`, `url()`, and the three gradient functions — so a
  // malformed value is a diagnostic, not a silent drop.
  "mask-image": {
    field: "maskImage",
    parse: (value) => {
      const v = value.trim().toLowerCase();
      if (v === "none") return 0;
      // A comma-separated layer list; each layer must be url() or a gradient.
      for (const layer of splitTopLevelCommas(value)) {
        const l = layer.trim().toLowerCase();
        if (
          !l.startsWith("url(") &&
          !l.startsWith("linear-gradient(") &&
          !l.startsWith("radial-gradient(") &&
          !l.startsWith("conic-gradient(") &&
          !l.startsWith("image(") &&
          !l.startsWith("element(") &&
          !l.startsWith("-webkit-") // prefixed gradients, e.g. -webkit-linear-gradient(
        ) {
          throw new CssError(
            `mask-image layer "${layer.trim()}" is not a value dziri accepts.\n` +
              `  Supported: none, url(), linear-gradient(), radial-gradient(), conic-gradient()`,
          );
        }
      }
      return 1;
    },
  },

  // `filter` and `backdrop-filter` — presence only, validated. The engine has no
  // filter pipeline; what is stored is `none` vs "has functions", and a value that
  // is not a filter function is refused by name rather than dropped.
  filter: { field: "filter", parse: filterValue },
  "-webkit-backdrop-filter": { field: "backdropFilter", parse: filterValue },
  "backdrop-filter": { field: "backdropFilter", parse: filterValue },

  // `z-index` — stacking order. `auto` is the i32::MIN sentinel; an integer is
  // stored as-is. The engine paints in tree order and does not sort, so the
  // value is recorded but never read.
  "z-index": {
    field: "zIndex",
    parse: (value) => {
      const v = value.trim().toLowerCase();
      if (v === "auto") return -2147483648;
      const n = Number(v);
      if (!Number.isInteger(n)) throw new CssError(`z-index: "${value}" is not an integer or auto`);
      return n;
    },
  },

  // `letter-spacing` — extra px between glyphs. `normal` is 0. The engine's
  // measurer does not read it yet; stored so utilities compile.
  "letter-spacing": {
    field: "letterSpacing",
    parse: (value) => {
      const v = value.trim().toLowerCase();
      if (v === "normal") return 0;
      return parseLength(value);
    },
  },

  // The blend-mode pair. One keyword set, two fields; the engine composites
  // everything SrcOver today and reads neither.
  "mix-blend-mode": { field: "mixBlendMode", parse: blendModeValue },
  "background-blend-mode": { field: "backgroundBlendMode", parse: blendModeValue },

  // `columns` — a count, a width, or both (`columns: 3 20rem`). Either half may
  // be `auto`. dziri has no column layout; parsed and stored.
  columns: (value, out, prop) => {
    let count = 0;
    let width = NaN;
    for (const part of splitTopLevel(value)) {
      const p = part.toLowerCase();
      if (p === "auto") continue;
      const n = Number(p);
      if (Number.isInteger(n) && n > 0) {
        if (count !== 0) throw new CssError(`${prop}: two counts in "${value}"`);
        count = n;
        continue;
      }
      const w = parseLength(part);
      if (!Number.isNaN(width)) throw new CssError(`${prop}: two widths in "${value}"`);
      width = w;
    }
    if (count === 0 && Number.isNaN(width)) {
      throw new CssError(`${prop}: "${value}" — expected a column count or width`);
    }
    out.columnCount = count;
    out.columnWidth = width;
  },
  "column-count": { field: "columnCount", parse: (v) => (v.trim().toLowerCase() === "auto" ? 0 : Number(v)) },
  "column-width": {
    field: "columnWidth",
    parse: (v) => (v.trim().toLowerCase() === "auto" ? NaN : parseLength(v)),
  },

  // `zoom` — a multiplier or percentage. Parsed and stored; the engine ignores it.
  zoom: {
    field: "zoom",
    parse: (value) => {
      const v = value.trim().toLowerCase();
      if (v === "normal") return 1;
      if (v.endsWith("%")) {
        const n = Number(v.slice(0, -1));
        if (!Number.isFinite(n)) throw new CssError(`zoom: bad percentage "${value}"`);
        return n / 100;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) throw new CssError(`zoom: "${value}" is not a number, percentage or normal`);
      return n;
    },
  },

  // `touch-action` — a gesture bitmask. `none` is 0; `auto` and `manipulation`
  // are the full set (manipulation = pan-x pan-y pinch-zoom, which is what the
  // bits already say).
  "touch-action": (value, out, prop) => {
    const v = value.trim().toLowerCase();
    if (v === "none") { out.touchAction = 0; return; }
    if (v === "auto" || v === "manipulation") { out.touchAction = 7; return; }
    let bits = 0;
    for (const part of v.split(/\s+/)) {
      if (part === "pan-x") bits |= 1;
      else if (part === "pan-y") bits |= 2;
      else if (part === "pinch-zoom") bits |= 4;
      else throw new CssError(`${prop}: unsupported gesture "${part}" in "${value}"`);
    }
    if (bits === 0) throw new CssError(`${prop}: "${value}" names no gestures`);
    out.touchAction = bits;
  },

  // `white-space` — wrapping and space collapsing. The engine honours `nowrap`;
  // the pre variants are stored so the class compiles, with a warning that the
  // collapsing rules are not implemented.
  "white-space": (value, out, prop) => {
    const map: Record<string, number> = {
      normal: 0,
      nowrap: 1,
      pre: 2,
      "pre-line": 3,
      "pre-wrap": 4,
      "break-spaces": 5,
    };
    const kw = map[value.trim().toLowerCase()];
    if (kw === undefined) throw new CssError(`unsupported ${prop} "${value}"`);
    out.whiteSpace = kw;
  },

  // `font-stretch` — a percentage or one of the nine step keywords. Stored as a
  // percentage of normal; the measurer does not read it yet.
  "font-stretch": {
    field: "fontStretch",
    parse: (value) => {
      const v = value.trim().toLowerCase();
      const steps: Record<string, number> = {
        "ultra-condensed": 50, "extra-condensed": 62.5, condensed: 75,
        "semi-condensed": 87.5, normal: 100, "semi-expanded": 112.5,
        expanded: 125, "extra-expanded": 150, "ultra-expanded": 200,
      };
      if (v in steps) return steps[v]!;
      if (v.endsWith("%")) {
        const n = Number(v.slice(0, -1));
        if (Number.isFinite(n)) return n;
      }
      throw new CssError(`font-stretch: "${value}" is not a percentage or step keyword`);
    },
  },

  // `mask-position` — validated, stored as "set" beside `maskImage`. Keywords
  // (left/center/right/top/bottom) and lengths are accepted; the engine has no
  // mask rendering to position.
  "mask-position": (value, out, prop) => {
    const keywords = new Set(["left", "center", "right", "top", "bottom"]);
    for (const part of splitTopLevel(value)) {
      const p = part.toLowerCase();
      if (keywords.has(p)) continue;
      parseLength(part); // throws on a value that is neither keyword nor length
    }
    out.maskPosition = 1;
  },

  // SVG paint properties. dziri draws no SVG, so the engine never reads these;
  // they exist so Tailwind's icon utilities compile rather than error.
  fill: { field: "fill", parse: parseColor },
  stroke: { field: "stroke", parse: parseColor },
  "stroke-width": { field: "strokeWidth", parse: parseLength },

  // Handled by the caller, like `display`, and for a stronger reason: its value
  // is a *string*, and every style field is a number. It never reaches the style
  // table at all — the compiler turns it into an emitted TEXT node.
  content: handledByCaller,
  display: handledByCaller,

  /**
   * Transitions and animations, also handled by the caller — and listed here for
   * the same reason `display` is: so this table stays the one honest answer to
   * "which CSS properties does dziri support".
   *
   * They cannot be expanded here because neither is a value. `transition-property`
   * is a comma-separated *list* where every style field is one number, and the
   * timing has to be resolved as a unit across six declarations and then
   * interned — so the answer is an index into a side table, which a rule here has
   * no way to mint. `animation` is worse: it names a `@keyframes` block, whose
   * style rows are the *element's own computed style* with the keyframe's
   * declarations over it, and that is not knowable until the cascade has finished.
   *
   * So `resolveTiming` in the compiler does both, from the merged declaration map
   * where the whole set is visible at once. See `applyDecls`.
   */
  transition: handledByCaller,
  "transition-property": handledByCaller,
  "transition-duration": handledByCaller,
  "transition-delay": handledByCaller,
  "transition-timing-function": handledByCaller,
  "transition-behavior": handledByCaller,
  animation: handledByCaller,
  "animation-name": handledByCaller,
  "animation-duration": handledByCaller,
  "animation-delay": handledByCaller,
  "animation-timing-function": handledByCaller,
  "animation-iteration-count": handledByCaller,
  "animation-direction": handledByCaller,
  "animation-fill-mode": handledByCaller,
  "animation-play-state": handledByCaller,
};

/**
 * Expands one declaration into computed longhand fields.
 *
 * A lookup in {@link PROPERTIES}, which is all this is now. It used to be a `switch`
 * over 112 labels, and that made the *shape of this function's source* part of its
 * interface — two coverage scripts recovered the supported-property list by running a
 * regex over it.
 *
 * `display`, `content` and the timing properties are in the table as no-ops rather
 * than absent, because they *are* supported; the caller expands them. See
 * {@link handledByCaller}.
 */
export function expandDeclaration(
  prop: string,
  raw: string,
  out: Partial<Record<StyleField, number>>,
): void {
  const rule = PROPERTIES[prop];
  if (rule === undefined) {
    warnOnce(`ignoring unsupported property "${prop}"`);
    return;
  }

  const value = raw.trim();
  if (typeof rule === "function") {
    rule(value, out, prop);
    return;
  }

  out[rule.field] = rule.parse(value);
}

/**
 * Which style fields a property writes — for `inherit`, which must copy the
 * parent's computed value for exactly those fields and no others.
 *
 * Discovered by probing: the property's own rule is expanded over a list of
 * candidate values until one parses, into a scratch patch whose keys are the
 * answer. Probe rather than a hand-written table because a table would be a
 * second list to keep in step with PROPERTIES — the failure mode this whole
 * file exists to remove. The probe list covers the shapes in the table
 * (lengths, colours, keywords, numbers); a property none of them parses is one
 * `inherit` cannot support, and says so rather than copying nothing.
 */
const INHERIT_PROBES = ["0", "none", "0px", "#000000", "normal", "auto", "1", "solid", "visible"];

export function fieldsForProperty(prop: string): StyleField[] {
  const rule = PROPERTIES[prop];
  if (rule === undefined) throw new CssError(`unknown property "${prop}"`);
  if (typeof rule !== "function") return [rule.field];
  for (const probe of INHERIT_PROBES) {
    const scratch: Partial<Record<StyleField, number>> = {};
    try {
      rule(probe, scratch, prop);
    } catch {
      continue;
    }
    return Object.keys(scratch) as StyleField[];
  }
  throw new CssError(`inherit: "${prop}" is not a property dziri can inherit`);
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
