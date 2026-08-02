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
  Direction,
  Display,
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
  compareCascade,
  expandDeclaration,
  extendVarEnv,
  parseCss,
  Origin,
  parseInlineStyle,
  substituteVars,
  type OriginValue,
  type MediaCond,
  type Pseudo,
  type Rule,
  type Selector,
  type VarEnv,
} from "./css.ts";
import { UA_SHEET } from "./ua-sheet.ts";

/** The environment at the root, before any `--*` declaration has been seen. */
const EMPTY_VARS: VarEnv = new Map<string, string>();

// ---------------------------------------------------------------------------
// Selector matching
// ---------------------------------------------------------------------------

function matchCompound(el: Element, c: { tag: string | null; id: string | null; classes: string[] }): boolean {
  if (c.tag !== null && c.tag !== el.tag) return false;
  if (c.id !== null && c.id !== el.id) return false;
  for (const cls of c.classes) {
    if (!el.classes.includes(cls)) return false;
  }
  return true;
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
): Map<string, string> {
  const candidates: Candidate[] = [];

  for (const rule of rules) {
    // A conditional rule contributes nothing unless *every* condition it carries
    // is live in this combination. `@media` has no effect on specificity — a rule
    // inside one cascades exactly as it would outside — so this is a filter and
    // not a weighting.
    if (rule.media && !rule.media.every((c) => (live & media.bitFor(c)) !== 0)) continue;

    for (const sel of rule.selectors) {
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
function mediaMaskFor(rules: Rule[], path: Element[], media: MediaBits): number {
  let mask = 0;
  for (const rule of rules) {
    if (!rule.media) continue;
    if (!rule.selectors.some((sel) => matches(sel, path))) continue;
    for (const cond of rule.media) mask |= media.bitFor(cond);
  }
  return mask;
}

/** Whether any rule targeting this node uses the given pseudo-class. */
function hasPseudoRule(rules: Rule[], path: Element[], pseudo: Pseudo): boolean {
  for (const rule of rules) {
    for (const sel of rule.selectors) {
      if (sel.pseudo === pseudo && matches(sel, path)) return true;
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
): ComputedStyle {
  const patch: Partial<Record<StyleField, number>> = {};

  for (const [prop, value] of decls) {
    // A custom property is a value carrier, not a style field. It has already
    // been folded into `vars` by the caller; expanding it here would be an error
    // about a property nothing implements.
    if (prop.startsWith("--")) continue;

    // Substituted before the expander sees it, which is what lets `var()` supply
    // part of a value — `padding: var(--y) 4px` — rather than only whole ones.
    const resolved = value.includes("var(") ? substituteVars(value, vars) : value;
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

  return coerceOverflow({ ...base, ...patch });
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
  const rules = [...parseCss(UA_SHEET, Origin.UA), ...parseCss(css)];

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
    const base = withInline(collectDecls(rules, path, ["none"], media), el);
    // Custom properties inherit, so the environment is the parent's with this
    // node's own laid over it — and it is built from the *cascaded* declarations,
    // so `--x` obeys specificity like everything else.
    const vars = extendVarEnv(parentVars, base);
    const style = applyDecls(inherited, base, where, vars);

    // Precomputed variants: the compiler emits finished styles and the runtime
    // only picks an index. Each state is resolved as a full cascade from
    // scratch, not as a patch over the base — see collectDecls.
    const styleId = styles.intern(style);

    // Which predicates this node's styling actually reads. Input state and media
    // conditions share one mask deliberately: they are the same kind of thing to
    // everything downstream, and a node styled by both `:hover` and a breakpoint
    // gets the combination resolved for both rather than one of them.
    let mask = mediaMaskFor(rules, path, media);
    for (const [bit, pseudo] of PREDICATE_PSEUDO) {
      if (hasPseudoRule(rules, path, pseudo)) mask |= bit;
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
      let label = where;
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
      const stateDecls = withInline(collectDecls(rules, path, states, media, live), el);
      const resolved = applyDecls(
        inherited,
        stateDecls,
        label,
        extendVarEnv(parentVars, stateDecls),
      );
      run[combo] = styles.intern(resolved);
    }

    const self = nodes.length;
    nodes.push({
      kind: KIND_BY_TAG[el.tag] ?? NodeKind.BOX,
      style: styleId,
      mask,
      run,
      text: -1,
      parent,
      children: [],
    });
    opts.nodeOf?.set(el, self);

    if (el.onClick) handlers.push({ node: self, ref: el.onClick, name: "" });
    if (el.bindValue) editables.push({ node: self, ref: el.bindValue, name: "" });

    // A button whose content is a single static text run keeps the label on the
    // button itself, so paint can centre it without a child node to lay out.
    // A *dynamic* label stays a child node, since the binding addresses a node.
    const kids = el.children;
    const onlyText =
      kids.length === 1 && kids[0]!.type === "text" ? (kids[0] as { value: string }).value : null;

    if (nodes[self]!.kind === NodeKind.BUTTON && onlyText !== null) {
      nodes[self]!.text = internString(onlyText);
      return self;
    }

    for (const child of kids) {
      const childIndex = walkChild(child, path, style, self, vars);
      if (childIndex !== -1) nodes[self]!.children.push(childIndex);
    }

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
    warnings,
  };
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
    // Either source counts: the baseline mask for a node styled by `:hover`
    // directly, the variant mask for one that only gains a state while a toggle
    // is on. The second used to be missed, which emitted a correct hover style
    // onto a node that could never be hovered.
    const stateful = n.mask !== 0 || (variants !== undefined && (variants.masks[i] ?? 0) !== 0);

    if (n.kind === NodeKind.BUTTON || stateful || withHandler.has(i)) out.push(i);
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
    },
    variants: {
      count: variants.node.length,
      node: new Int32Array(variants.node),
      mask: new Uint32Array(variants.mask),
      runStart: new Int32Array(variants.runStart),
      slots: new Uint16Array(variants.slots),
    },
    interactive: new Int32Array(buildInteractive(result.nodes, result.handlers, result.lists)),
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
    root: result.root,
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
import type { HandlerBinding, ListTable, MediaTable, NodeTable, StyleTable, TextBinding, VariantTable${routing ? ", RouteNodes, WindowConfig" : ""} } from "${typesFrom}/ir.ts";
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
