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
  CssError,
  lengthPercent,
  parseAngle,
  parseColor,
  parseLength,
  splitTopLevel,
  splitTopLevelCommas,
  warnOnce,
} from "./css.ts";

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

/** A max-* length, where `none` is the absence of a bound rather than zero. */
const lengthOrNone = (value: string): number =>
  value.toLowerCase() === "none" ? Infinity : parseLength(value);

/** `gap` and its `grid-gap` spelling: one value for both axes, or `<row> <column>`. */
const gapShorthand: ExpandRule = (value, out) => {
  const parts = splitTopLevel(value);
  out.gapRow = parseLength(parts[0]!);
  out.gapCol = parts[1] ? parseLength(parts[1]) : out.gapRow;
};

/** `grid-column` / `grid-row`: a start line and a span, from {@link parsePlacement}. */
const placement =
  (startField: StyleField, spanField: StyleField): ExpandRule =>
  (value, out) => {
    const [start, span] = parsePlacement(value);
    out[startField] = start;
    out[spanField] = span;
  };

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

  "border": (value, out) => {
    // `<width> <style> <color>`, in any order, style ignored.
    const parts = splitTopLevel(value);
    for (const part of parts) {
      if (/^(none|solid|dashed|dotted)$/i.test(part)) continue;
      if (/^-?[\d.]/.test(part)) out.borderWidth = parseLength(part);
      else out.borderColor = parseColor(part);
    }
    if (/^none$/i.test(value)) out.borderWidth = 0;
  },
  "border-width": { field: "borderWidth", parse: parseLength },
  "border-color": { field: "borderColor", parse: parseColor },

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
  inset: quad("insetT", "insetR", "insetB", "insetL"),
  "inset-inline": axis("insetL", "insetR"),
  "inset-block": axis("insetT", "insetB"),
  "inset-inline-start": { field: "insetL", parse: parseLength },
  "inset-inline-end": { field: "insetR", parse: parseLength },
  "inset-block-start": { field: "insetT", parse: parseLength },
  "inset-block-end": { field: "insetB", parse: parseLength },

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

  /**
   * `place-items` and `place-self`, which set both axes at once.
   *
   * `place-content` is deliberately not here even though it looks like the third
   * of a set: it needs `align-content`, which dziri does not have. Adding it
   * would mean writing `justify-content` and dropping the other half, so a
   * `place-content-center` would centre one axis and silently leave the other —
   * worse than the current honest refusal.
   *
   * The two halves are split by {@link splitAlignPair}, not by whitespace, and
   * that is the whole subtlety of these two properties. See it for why.
   */
  "place-items": pairKeyword("align", "justifyItems", ALIGN_KEYWORDS),
  "place-self": pairKeyword("alignSelf", "justifySelf", SELF_KEYWORDS),

  flex: (value, out) => {
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
  },
  "flex-grow": { field: "grow", parse: finite("flex-grow") },
  "flex-shrink": { field: "shrink", parse: finite("flex-shrink") },
  "flex-basis": { field: "basis", parse: (v) => (v.toLowerCase() === "auto" ? AUTO : parseLength(v)) },

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
  top: { field: "insetT", parse: parseLength },
  right: { field: "insetR", parse: parseLength },
  bottom: { field: "insetB", parse: parseLength },
  left: { field: "insetL", parse: parseLength },

  width: { field: "width", parse: parseLength },
  height: { field: "height", parse: parseLength },
  "min-width": { field: "minW", parse: parseLength },
  "max-width": { field: "maxW", parse: lengthOrNone },
  "min-height": { field: "minH", parse: parseLength },
  "max-height": { field: "maxH", parse: lengthOrNone },

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
  "inline-size": { field: "width", parse: parseLength },
  "block-size": { field: "height", parse: parseLength },
  "min-inline-size": { field: "minW", parse: parseLength },
  "max-inline-size": { field: "maxW", parse: lengthOrNone },
  "min-block-size": { field: "minH", parse: parseLength },
  "max-block-size": { field: "maxH", parse: lengthOrNone },

  "font-size": { field: "fontSize", parse: parseLength },
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
