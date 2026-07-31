/**
 * Measures the two ways to compile dynamic styling.
 *
 *   A. Precomputed combinations — one complete style-id array per setting of every
 *      toggle. Simple to apply, but `nodes × 2^toggles` in size.
 *   B. Per-toggle write lists — for each toggle alone, the nodes it changes and
 *      what they become. Linear in size, but sequencing two lists only reproduces
 *      the cascade where they do not touch the same node.
 *
 * The point of measuring rather than reasoning: (B) is only viable if real
 * stylesheets keep the *colliding* subset small, and that is an empirical
 * question about how people write CSS.
 *
 * Everything here runs at build time against the unmodified compiler.
 */
import {
  LAYOUT_FIELDS,
  STYLE_FIELDS,
  type ComputedStyle,
  type StyleField,
} from "../ir.ts";
import { compileTree, type CompileResult } from "./compile.ts";
import type { Element, Node } from "./html.ts";

export type ToggleSpec = { name: string; target: string; class: string };

export type ToggleDelta = {
  name: string;
  /** Nodes whose computed style changes when this toggle alone is on. */
  nodes: Int32Array;
  on: Uint16Array;
  off: Uint16Array;
  /** True if any changed field can move geometry, so a relayout is required. */
  affectsLayout: boolean;
  /** Fields that actually changed, for reporting. */
  fields: StyleField[];
};

export type Collision = { toggles: string[]; nodes: number[] };

export type VariantAnalysis = {
  nodeCount: number;
  baselineStyles: number;
  /** Unique computed styles across every combination. */
  globalStyles: number;
  /** Base style ids per combination, in mask order. */
  combos: Uint16Array[];
  /** All three roles per combination — base, hover, active. */
  comboRoles: RoleStyles[];
  /** Indexed by the ids in `combos` and `comboRoles`. */
  globalStyleList: ComputedStyle[];
  deltas: ToggleDelta[];
  collisions: Collision[];
  compileMs: number;
};

// ---------------------------------------------------------------------------
// Injecting toggle classes into a parsed tree
// ---------------------------------------------------------------------------

function cloneTree(node: Node): Node {
  if (node.type === "text") return { type: "text", value: node.value };
  if (node.type === "dyntext") return { type: "dyntext", parts: [...node.parts] };
  if (node.type === "dynlist") return { ...node, template: cloneTree(node.template) };
  // Spread rather than field-by-field, so a new `Element` field survives a clone
  // without needing a line here.
  return {
    ...node,
    classes: [...node.classes],
    children: node.children.map(cloneTree),
  };
}

/** Simple selector support: `tag`, `.class`, `#id`, or a combination of them. */
function parseTarget(target: string): { tag: string | null; id: string | null; classes: string[] } {
  const tokens = target.match(/[#.]?[A-Za-z0-9_-]+/g) ?? [];
  const out = { tag: null as string | null, id: null as string | null, classes: [] as string[] };

  for (const t of tokens) {
    if (t.startsWith("#")) out.id = t.slice(1);
    else if (t.startsWith(".")) out.classes.push(t.slice(1));
    else out.tag = t.toLowerCase();
  }
  return out;
}

function inject(root: Element, specs: ToggleSpec[]): number {
  let hits = 0;

  const visit = (el: Element): void => {
    for (const spec of specs) {
      const t = parseTarget(spec.target);
      if (t.tag !== null && t.tag !== el.tag) continue;
      if (t.id !== null && t.id !== el.id) continue;
      if (!t.classes.every((c) => el.classes.includes(c))) continue;
      if (!el.classes.includes(spec.class)) el.classes.push(spec.class);
      hits++;
    }
    for (const child of el.children) {
      if (child.type === "element") visit(child);
    }
  };

  visit(root);
  return hits;
}

// ---------------------------------------------------------------------------
// A style space shared across compiles
// ---------------------------------------------------------------------------

/**
 * Each `compileTree` call interns styles independently, so ids from two compiles
 * are not comparable. This re-interns every result into one global table so a
 * diff between combinations is meaningful.
 */
class GlobalStyles {
  private readonly byKey = new Map<string, number>();
  readonly list: ComputedStyle[] = [];

  intern(style: ComputedStyle): number {
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

/** The style slots a node can wear, as the runtime resolves them. */
export const ROLES = ["base", "hover", "active", "focus"] as const;
export type Role = (typeof ROLES)[number];

export type RoleStyles = Record<Role, Uint16Array>;

/**
 * Node -> global style id per role, for one compiled variant.
 *
 * `hover` and `active` are resolved to their *effective* style here, mirroring
 * `Painter.styleFor`: an absent hover falls back to base, and an absent active
 * falls back to hover. Without that, a toggle that introduces a hover rule where
 * there was none would look like a structural change rather than a value change.
 */
function globalize(result: CompileResult, global: GlobalStyles): RoleStyles {
  const n = result.nodes.length;
  const base = new Uint16Array(n);
  const hover = new Uint16Array(n);
  const active = new Uint16Array(n);
  const focus = new Uint16Array(n);

  for (let i = 0; i < n; i++) {
    const node = result.nodes[i]!;
    base[i] = global.intern(result.styles[node.style]!);
    hover[i] = node.hover >= 0 ? global.intern(result.styles[node.hover]!) : base[i]!;
    active[i] = node.active >= 0 ? global.intern(result.styles[node.active]!) : hover[i]!;
    focus[i] = node.focus >= 0 ? global.intern(result.styles[node.focus]!) : base[i]!;
  }

  return { base, hover, active, focus };
}

function changedFields(a: ComputedStyle, b: ComputedStyle): StyleField[] {
  const fields: StyleField[] = [];
  for (const [field] of STYLE_FIELDS) {
    const x = a[field];
    const y = b[field];
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (x !== y) fields.push(field);
  }
  return fields;
}

// ---------------------------------------------------------------------------

export function analyzeVariants(
  doc: Element,
  css: string,
  toggles: ToggleSpec[],
): VariantAnalysis {
  if (toggles.length > 16) throw new Error("refusing to enumerate more than 16 toggles");

  const started = performance.now();
  const global = new GlobalStyles();

  /** Compiles the document with the given subset of toggles applied. */
  const compileWith = (specs: ToggleSpec[]): { roles: RoleStyles; result: CompileResult } => {
    const tree = cloneTree(doc) as Element;
    if (specs.length > 0) inject(tree, specs);
    const result = compileTree(tree, css);
    return { roles: globalize(result, global), result };
  };

  const baseline = compileWith([]);
  const nodeCount = baseline.result.nodes.length;

  // (A) every combination, in mask order
  const combos: Uint16Array[] = [];
  const comboRoles: RoleStyles[] = [];
  for (let mask = 0; mask < 1 << toggles.length; mask++) {
    if (mask === 0) {
      combos.push(baseline.roles.base);
      comboRoles.push(baseline.roles);
      continue;
    }
    const specs = toggles.filter((_, i) => mask & (1 << i));
    const { roles, result } = compileWith(specs);
    if (result.nodes.length !== nodeCount) {
      throw new Error(`toggle combination ${mask} changed the node count — not comparable`);
    }
    combos.push(roles.base);
    comboRoles.push(roles);
  }

  // (B) one write list per toggle, taken from its single-toggle combination
  const deltas: ToggleDelta[] = toggles.map((toggle, i) => {
    const alone = combos[1 << i]!;
    const nodes: number[] = [];
    const on: number[] = [];
    const off: number[] = [];
    const fields = new Set<StyleField>();

    const base = baseline.roles.base;
    for (let n = 0; n < nodeCount; n++) {
      if (alone[n] === base[n]) continue;
      nodes.push(n);
      on.push(alone[n]!);
      off.push(base[n]!);
      for (const f of changedFields(global.list[base[n]!]!, global.list[alone[n]!]!)) {
        fields.add(f);
      }
    }

    const fieldList = [...fields];
    return {
      name: toggle.name,
      nodes: new Int32Array(nodes),
      on: new Uint16Array(on),
      off: new Uint16Array(off),
      affectsLayout: fieldList.some((f) => LAYOUT_FIELDS.includes(f)),
      fields: fieldList,
    };
  });

  // Where two toggles write the same node, applying their lists in sequence does
  // not reproduce the cascade, so those subsets need a combined entry.
  const collisions: Collision[] = [];
  for (let a = 0; a < deltas.length; a++) {
    for (let b = a + 1; b < deltas.length; b++) {
      const setA = new Set(deltas[a]!.nodes);
      const shared = [...deltas[b]!.nodes].filter((n) => setA.has(n));
      if (shared.length > 0) {
        collisions.push({ toggles: [deltas[a]!.name, deltas[b]!.name], nodes: shared });
      }
    }
  }

  return {
    nodeCount,
    baselineStyles: baseline.result.styles.length,
    globalStyles: global.list.length,
    combos,
    comboRoles,
    globalStyleList: global.list,
    deltas,
    collisions,
    compileMs: performance.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Strategy C: patch the style table
// ---------------------------------------------------------------------------

/**
 * The insight this measures: collisions in the per-node scheme were an artefact
 * of interning whole styles. Because `ComputedStyle` is interned as a unit, any
 * changed field changes the whole identity, so two toggles touching the same
 * node collided even when they touched disjoint *fields*.
 *
 * So instead: intern styles over the vector of their values across every
 * variant — two nodes share an id only if they agree in all of them — and have
 * a toggle rewrite entries of the style table rather than node style ids.
 * `nodes.style` then never changes, layout and paint read exactly as they do
 * now (no indirection), and two toggles conflict only if they write the same
 * *field* of the same style.
 */
export type FieldPatch = {
  field: StyleField;
  /** Variant-style ids to write. */
  styles: Uint16Array;
  /** Value when the toggle is on, and when it is off. */
  on: Float64Array;
  off: Float64Array;
};

export type TogglePatch = {
  name: string;
  entries: FieldPatch[];
  /** Total individual writes to apply this toggle. */
  writes: number;
  affectsLayout: boolean;
  fields: StyleField[];
};

export type PatchAnalysis = {
  /** Style-table size once interned over variant vectors, across all roles. */
  variantStyles: number;
  /** How many of those exist only because hover/active differ under some toggle. */
  roleSlots: Record<Role, number>;
  /**
   * Nodes whose hover/active pointer had to be materialized because a toggle
   * introduces a state style where the baseline had none. Their interactivity can
   * no longer be inferred from `hover >= 0`.
   */
  materializedStates: number;
  patches: TogglePatch[];
  /** Toggles writing the same field of the same style — genuine conflicts. */
  fieldCollisions: { toggles: string[]; conflicts: number }[];
  bytes: number;
};

export function analyzePatches(a: VariantAnalysis, toggles: ToggleSpec[]): PatchAnalysis {
  const comboCount = a.combos.length;

  // A variant style is a distinct vector of computed styles across combinations.
  // Slots are interned per (node, role) so hover and active states are covered:
  // a toggle that recolours `.btn:hover` has to patch that style too.
  const byVector = new Map<string, number>();
  /** variant style id -> a (node, role) that has it, for reading values back. */
  const representative: { node: number; role: Role }[] = [];
  const roleSlots: Record<Role, number> = { base: 0, hover: 0, active: 0, focus: 0 };
  let materializedStates = 0;

  const internSlot = (node: number, role: Role): number => {
    let key = role + ":";
    for (let m = 0; m < comboCount; m++) key += a.comboRoles[m]![role][node] + ",";

    let id = byVector.get(key);
    if (id === undefined) {
      id = representative.length;
      byVector.set(key, id);
      representative.push({ node, role });
      roleSlots[role]++;
    }
    return id;
  };

  for (let n = 0; n < a.nodeCount; n++) {
    internSlot(n, "base");

    // A state slot is only needed when it differs from its fallback in *some*
    // combination. Where it does, the node's pointer must be materialized in
    // every combination so `nodes.hover` itself stays immutable — which is
    // exactly why interactivity needs an explicit flag rather than `hover >= 0`.
    let hoverDiffers = false;
    let activeDiffers = false;
    let focusDiffers = false;
    for (let m = 0; m < comboCount; m++) {
      const r = a.comboRoles[m]!;
      if (r.hover[n] !== r.base[n]) hoverDiffers = true;
      if (r.active[n] !== r.hover[n]) activeDiffers = true;
      if (r.focus[n] !== r.base[n]) focusDiffers = true;
    }

    const zero = a.comboRoles[0]!;
    if (hoverDiffers) {
      internSlot(n, "hover");
      if (zero.hover[n] === zero.base[n]) materializedStates++;
    }
    if (activeDiffers) {
      internSlot(n, "active");
      if (zero.active[n] === zero.hover[n]) materializedStates++;
    }
    if (focusDiffers) {
      internSlot(n, "focus");
      if (zero.focus[n] === zero.base[n]) materializedStates++;
    }
  }

  const variantStyles = representative.length;

  /** Computed style of variant-style `v` in combination `mask`. */
  const styleAt = (v: number, mask: number): ComputedStyle => {
    const { node, role } = representative[v]!;
    return a.globalStyleList[a.comboRoles[mask]![role][node]!]!;
  };

  // One patch per toggle, derived from its single-toggle combination.
  const patches: TogglePatch[] = toggles.map((toggle, i) => {
    const mask = 1 << i;
    const perField = new Map<StyleField, { styles: number[]; on: number[]; off: number[] }>();

    for (let v = 0; v < variantStyles; v++) {
      const base = styleAt(v, 0);
      const next = styleAt(v, mask);
      for (const field of changedFields(base, next)) {
        let bucket = perField.get(field);
        if (!bucket) {
          bucket = { styles: [], on: [], off: [] };
          perField.set(field, bucket);
        }
        bucket.styles.push(v);
        bucket.on.push(next[field]);
        bucket.off.push(base[field]);
      }
    }

    const entries: FieldPatch[] = [...perField].map(([field, b]) => ({
      field,
      styles: new Uint16Array(b.styles),
      on: new Float64Array(b.on),
      off: new Float64Array(b.off),
    }));

    const fields = entries.map((e) => e.field);
    return {
      name: toggle.name,
      entries,
      writes: entries.reduce((n, e) => n + e.styles.length, 0),
      affectsLayout: fields.some((f) => LAYOUT_FIELDS.includes(f)),
      fields,
    };
  });

  // Conflicts are per (field, style), not per node.
  const keysOf = (p: TogglePatch): Set<string> => {
    const out = new Set<string>();
    for (const e of p.entries) for (const s of e.styles) out.add(`${e.field}#${s}`);
    return out;
  };

  const fieldCollisions: { toggles: string[]; conflicts: number }[] = [];
  for (let x = 0; x < patches.length; x++) {
    const kx = keysOf(patches[x]!);
    for (let y = x + 1; y < patches.length; y++) {
      let conflicts = 0;
      for (const k of keysOf(patches[y]!)) if (kx.has(k)) conflicts++;
      if (conflicts > 0) {
        fieldCollisions.push({ toggles: [patches[x]!.name, patches[y]!.name], conflicts });
      }
    }
  }

  // What used to be here: an exhaustive proof that sequencing these patches
  // reproduces the compiler's own output for all 2^k combinations. It has moved to
  // `verifyCompose` in `variant-compile.ts`, and this is why.
  //
  // The proof was the strongest test in the project and it validated *this* file's
  // reimplementation rather than `compileVariants`, which is what ships — so a
  // regression in the shipped path passed silently, while a divergence between the
  // two copies looked like a failure of the one nobody runs. It also only ever
  // printed its verdict; nothing exited non-zero.
  //
  // This file stays what it always honestly was: a measurement report comparing
  // three IR strategies by size. Correctness belongs to the compiler it is
  // measuring, asserted in `variant-compile.test.ts`.

  // Style table + immutable node ids (base/hover/active) + patch lists.
  let bytes = variantStyles * STYLE_FIELDS.length * 4 + a.nodeCount * (2 + 2 + 2);
  for (const p of patches) bytes += p.writes * (2 + 4 + 4);

  return {
    variantStyles,
    roleSlots,
    materializedStates,
    patches,
    fieldCollisions,
    bytes,
  };
}

/**
 * Bytes each strategy costs in the emitted module.
 *
 * Combinations: a `Uint16Array` of style ids per combination.
 * Per-toggle: an `Int32Array` of node ids plus two `Uint16Array`s per toggle,
 * and for each colliding pair a combined list over the shared nodes only.
 */
export function strategyBytes(a: VariantAnalysis): {
  combinations: number;
  perToggle: number;
  collisionExtra: number;
} {
  const combinations = a.combos.length * a.nodeCount * 2;

  let perToggle = a.nodeCount * 2; // the base array
  for (const d of a.deltas) perToggle += d.nodes.length * (4 + 2 + 2);

  let collisionExtra = 0;
  for (const c of a.collisions) collisionExtra += c.nodes.length * (4 + 2);

  return { combinations, perToggle, collisionExtra };
}
