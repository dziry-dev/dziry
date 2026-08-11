/**
 * Audits dziri's computed-style defaults against the CSS spec.
 *
 *   bun run spec-audit            # report, exit 1 on a real disagreement
 *   bun run spec-audit --all      # include fields deliberately not spec-shaped
 *
 * `INITIAL_STYLE` is a spec artifact: it is meant to be the CSS *initial value*
 * of each property. A wrong initial value or a wrong inheritance flag produces a
 * wrong-looking frame with nothing to blame — the same silent class as a wrong
 * byte offset — and nothing in the repo checks it.
 *
 * The oracle is `mdn-data`, which is the data MDN's own "Formal definition"
 * tables are generated from. Pinned in package.json, offline, no scraping.
 *
 * Judgement lives in DELIBERATE below. Several of dziri's defaults differ from
 * CSS on purpose and the reasoning is recorded in `src/ir.ts`; those are listed
 * with their justification rather than silently skipped, so that a *new*
 * divergence cannot hide among the known ones.
 */
import cssProperties from "mdn-data/css/properties.json";
import { INITIAL_STYLE, INHERITED_FIELDS, STYLE_FIELDS } from "../src/ir.ts";

const argv = process.argv.slice(2);
const ALL = argv.includes("--all");

type Spec = { initial: string | string[]; inherited: boolean; status: string };
const SPEC = cssProperties as unknown as Record<string, Spec>;

/** dziri field -> the CSS longhand it is meant to be. */
const PROPERTY: Record<string, string> = {
  bg: "background-color",
  fg: "color",
  borderTopColor: "border-top-color",
  borderRightColor: "border-right-color",
  borderBottomColor: "border-bottom-color",
  borderLeftColor: "border-left-color",
  borderTopWidth: "border-top-width",
  borderRightWidth: "border-right-width",
  borderBottomWidth: "border-bottom-width",
  borderLeftWidth: "border-left-width",
  radius: "border-top-left-radius",
  padT: "padding-top",
  padR: "padding-right",
  padB: "padding-bottom",
  padL: "padding-left",
  marT: "margin-top",
  marR: "margin-right",
  marB: "margin-bottom",
  marL: "margin-left",
  display: "display",
  direction: "flex-direction",
  wrap: "flex-wrap",
  justify: "justify-content",
  align: "align-items",
  alignSelf: "align-self",
  grow: "flex-grow",
  shrink: "flex-shrink",
  basis: "flex-basis",
  gapRow: "row-gap",
  gapCol: "column-gap",
  gridCols: "grid-template-columns",
  gridRows: "grid-template-rows",
  gridColStart: "grid-column-start",
  gridColSpan: "grid-column-end",
  gridRowStart: "grid-row-start",
  gridRowSpan: "grid-row-end",
  justifyItems: "justify-items",
  justifySelf: "justify-self",
  width: "width",
  height: "height",
  minW: "min-width",
  maxW: "max-width",
  minH: "min-height",
  maxH: "max-height",
  aspectRatio: "aspect-ratio",
  position: "position",
  insetT: "top",
  insetR: "right",
  insetB: "bottom",
  insetL: "left",
  fontSize: "font-size",
  fontWeight: "font-weight",
  overflowX: "overflow-x",
  overflowY: "overflow-y",
  accentColor: "accent-color",
  caretColor: "caret-color",
  outlineColor: "outline-color",
  outlineWidth: "outline-width",
  outlineOffset: "outline-offset",
  decorationLine: "text-decoration-line",
  decorationColor: "text-decoration-color",
  decorationStyle: "text-decoration-style",
  decorationThickness: "text-decoration-thickness",
  underlineOffset: "text-underline-offset",
  appearance: "appearance",
  opacity: "opacity",
  // The decomposed transform. Only the fields that correspond to a whole CSS
  // property are mapped; `skewX`, the percentage halves and the px origin have
  // no 1:1 property and are listed as unmapped, like `radTL`.
  translateX: "translate",
  translateY: "translate",
  rotate: "rotate",
  scaleX: "scale",
  scaleY: "scale",
  originPctX: "transform-origin",
  originPctY: "transform-origin",
};

/** Shared by the four border width fields — see DELIBERATE. */
const BORDER_WIDTH_REASON =
  "spec `medium` (3px); dziri 0 — with no `border-style` field, style is always `none`, " +
  "and a none-border computes to width 0. Revisit if border-style lands.";

/** Shared by the four border colour fields — see DELIBERATE. */
const BORDER_COLOR_REASON =
  "spec `currentcolor`; dziri alpha-0 — the table-wide convention for \"nothing was said\" " +
  "(scrollbar-color, accent-color and caret-color spell auto the same way). The live " +
  "currentcolor fallback is unimplemented, and BROWSER-FACTS.md (\"An omitted border colour " +
  "is currentcolor, not transparent\") records what implementing it would have to do.";

/**
 * Divergences that are decisions, each with where the reasoning lives. Listed
 * rather than skipped: the point of an audit is that a *new* divergence cannot
 * hide among the known ones.
 */
const DELIBERATE: Record<string, string> = {
  display: "spec `inline`; dziri FLEX — there is no inline layout, so every box is a flex container",
  direction: "spec `row`; dziri COLUMN — HTML's block default stacks vertically (ir.ts)",
  align: "spec `normal`; dziri UNSET — lets the engine use Taffy's per-display-mode default (ir.ts)",
  alignSelf: "spec `auto`; dziri UNSET — a per-item override must not shadow the parent (ir.ts)",
  justifyItems: "spec `legacy`; dziri UNSET — same reason as align",
  justifySelf: "spec `auto`; dziri UNSET — same reason as alignSelf",
  position: "spec `static`; dziri RELATIVE — there is no static/relative distinction without inline flow",
  fg: "spec `canvastext` (system colour); dziri black — no system colour support",
  fontSize: "spec `medium`; dziri 16 — `medium` is 16px at the default zoom",
  gridColSpan: "not grid-column-end; dziri stores a span, not a line",
  gridRowSpan: "not grid-row-end; dziri stores a span, not a line",
  gridCols: "0 means no explicit tracks; the spec's `none` has no numeric equivalent",
  gridRows: "0 means no explicit tracks; the spec's `none` has no numeric equivalent",
  borderTopWidth: BORDER_WIDTH_REASON,
  borderRightWidth: BORDER_WIDTH_REASON,
  borderBottomWidth: BORDER_WIDTH_REASON,
  borderLeftWidth: BORDER_WIDTH_REASON,
  borderTopColor: BORDER_COLOR_REASON,
  borderRightColor: BORDER_COLOR_REASON,
  borderBottomColor: BORDER_COLOR_REASON,
  borderLeftColor: BORDER_COLOR_REASON,
  outlineColor:
    "spec `invert` (Chrome computes `currentcolor`); dziri alpha-0 — the \"nothing was said\" " +
    "convention, and the live currentcolor fallback is the same unimplemented piece the " +
    "border colours record",
  outlineWidth:
    "spec `medium` (3px); dziri 0 — no `outline-style` field, so style is always `none` " +
    "and a none-outline computes to width 0, as with the border widths",
  decorationColor:
    "spec `currentcolor`; dziri alpha-0 — and unlike the border colours this one *is* " +
    "implemented: paint resolves alpha-0 to the run's own fg",
  decorationLine:
    "spec says NOT inherited; dziri inherits — CSS propagates decorations to inline " +
    "descendants and dziri's text runs are separate nodes, so inheritance is how " +
    "`underline` reaches the text. It also crosses block boundaries, which CSS stops at",
  decorationStyle: "spec `solid`; dziri 0 — 0 *is* solid in the schema's encoding",
  decorationThickness: "spec `auto`; dziri 0 — 0 means auto (the font's own metric)",
  underlineOffset: "spec `auto`; dziri NaN — the table's \"nothing was said\" for lengths",
  // The transform is stored decomposed, so its initial `none` has to be spelled
  // as whatever each component's *identity* is — and for a scale that is 1, not
  // 0. A literal reading of the spec value here would mean every untransformed
  // node collapsed to a point.
  scaleX: "spec `none`; dziri 1 — decomposed storage, and the identity scale is 1 (ir.ts)",
  scaleY: "spec `none`; dziri 1 — same",
  // Likewise the origin: the spec's initial is the percentage pair `50% 50%`,
  // which this stores as the fraction 0.5 per axis.
  originPctX: "spec `50% 50%`; dziri 0.5 — stored as a fraction, and per axis",
  originPctY: "spec `50% 50%`; dziri 0.5 — same",
};

/**
 * Inheritance flags that differ from the spec on purpose, with why.
 *
 * `DELIBERATE` covers initial values only; it cannot excuse an inheritance flag,
 * and the decoration fields needed one — the spec's "not inherited" is paired
 * with *propagation to inline descendants*, and dziri's text runs are separate
 * nodes, so inheritance is the mechanism that reaches them.
 */
const DELIBERATE_INHERIT: Record<string, string> = {
  decorationLine: "propagates to inlines per spec; dziri's text runs are separate nodes",
  decorationColor: "same — the colour follows the line",
  decorationStyle: "same",
  decorationThickness: "same",
  underlineOffset: "same",
};

/**
 * Spec keywords that dziri encodes as a specific number, per field.
 *
 * Field-scoped rather than global because the same keyword means different
 * numbers in different places: `normal` is 400 for font-weight and 0 for a gap.
 * A global table would have made one of those a silent false pass.
 */
const KEYWORD: Record<string, Record<string, number>> = {
  wrap: { nowrap: 0 }, // FlexWrap.NO_WRAP
  fontWeight: { normal: 400 },
  gapRow: { normal: 0 },
  gapCol: { normal: 0 },
};

/** Does dziri's numeric/sentinel default plausibly encode the spec's keyword? */
function agrees(field: string, dziri: unknown, spec: string): boolean {
  const v = dziri as number;
  const s = spec.trim();

  const mapped = KEYWORD[field]?.[s];
  if (mapped !== undefined) return v === mapped;

  if (Number.isNaN(v)) return s === "auto" || s === "none" || s === "0";
  if (v === Infinity) return s === "none";

  switch (s) {
    case "0":
    case "0px":
      return v === 0;
    case "auto":
      return Number.isNaN(v) || v === 0 || !Number.isFinite(v);
    case "none":
      return v === 0 || !Number.isFinite(v);
    case "normal":
      return v === 0; // row-gap/column-gap: `normal` computes to 0 outside multi-col
    case "transparent":
    case "rgba(0, 0, 0, 0)":
      return v === 0;
    case "1":
      return v === 1;
    case "400":
    case "normal ":
      return v === 400;
    case "visible":
      return v === 0; // Overflow.VISIBLE
    default:
      return String(v) === s;
  }
}

const okList: string[] = [];
const known: string[] = [];
const problems: string[] = [];
const unmapped: string[] = [];

for (const [field] of STYLE_FIELDS as unknown as [string][]) {
  const prop = PROPERTY[field];
  if (!prop) {
    unmapped.push(field);
    continue;
  }
  const spec = SPEC[prop];
  if (!spec) {
    unmapped.push(`${field} -> ${prop} (not in mdn-data)`);
    continue;
  }

  const dziriInitial = (INITIAL_STYLE as unknown as Record<string, unknown>)[field];
  const specInitial = Array.isArray(spec.initial) ? `[shorthand: ${spec.initial.length} longhands]` : spec.initial;

  const dziriInherits = (INHERITED_FIELDS as string[]).includes(field);
  const inheritOk = dziriInherits === spec.inherited;

  const initialOk = Array.isArray(spec.initial) ? true : agrees(field, dziriInitial, spec.initial);

  if (!inheritOk) {
    const why = DELIBERATE_INHERIT[field];
    if (why) {
      known.push(`${field.padEnd(14)} inheritance: spec ${spec.inherited}, dziri ${dziriInherits} — ${why}`);
    } else {
      problems.push(
        `${field.padEnd(14)} ${prop.padEnd(22)} inheritance: spec says ${spec.inherited}, dziri says ${dziriInherits}`,
      );
    }
    continue;
  }
  if (initialOk) {
    okList.push(`${field.padEnd(14)} ${prop.padEnd(22)} initial ${specInitial}`);
  } else if (DELIBERATE[field]) {
    known.push(`${field.padEnd(14)} ${DELIBERATE[field]}`);
  } else {
    problems.push(
      `${field.padEnd(14)} ${prop.padEnd(22)} initial: spec ${JSON.stringify(specInitial)}, dziri ${JSON.stringify(dziriInitial)}`,
    );
  }
}

console.log(`spec-audit  ${STYLE_FIELDS.length} style fields vs mdn-data (${Object.keys(SPEC).length} properties)`);
console.log(
  `  ${okList.length} agree · ${known.length} deliberate · ${problems.length} to explain · ${unmapped.length} unmapped`,
);

if (ALL && okList.length) {
  console.log("\nagree");
  for (const l of okList) console.log(`  ${l}`);
}

if (known.length) {
  console.log("\ndeliberate divergences (reasoning in src/ir.ts)");
  for (const l of known) console.log(`  ${l}`);
}

if (unmapped.length) {
  console.log("\nunmapped — no CSS longhand, or dziri-specific");
  for (const l of unmapped) console.log(`  ${l}`);
}

if (problems.length) {
  console.log("\nTO EXPLAIN — either a bug, or a divergence that belongs in DELIBERATE");
  for (const l of problems) console.log(`  ${l}`);
  process.exit(1);
}
console.log("\nno unexplained divergence from the spec");
