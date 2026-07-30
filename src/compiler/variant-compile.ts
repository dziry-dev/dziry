/**
 * Compiles conditional classes into style-table patches.
 *
 * This is the production form of what `variants.ts` measured. The strategy that
 * won there:
 *
 *   - Intern styles over the *vector* of their values across every variant, so two
 *     nodes share a slot only if they agree in all of them.
 *   - A toggle then rewrites entries of the **style table**, not node style ids.
 *     `nodes.style` is immutable, layout and paint are untouched, and there is no
 *     indirection — the style table was already the level of indirection.
 *
 * Measured against precomputing whole combinations on a 1215-node page with four
 * toggles: 32 writes instead of 1215, 9.5 KB instead of 38 KB, and no collisions.
 *
 * Two toggles conflict only if they write the same *field* of the same *slot*.
 * Real toggles touch disjoint properties (a theme writes colours, a density
 * toggle writes padding), so this is rare — but it is detected and reported
 * rather than silently producing the wrong cascade.
 */
import {
  LAYOUT_FIELDS,
  STYLE_FIELDS,
  type ComputedStyle,
  type StyleField,
} from "../ir.ts";
import { compileTree, type CompileResult } from "./compile.ts";
import type { Element, Node } from "./html.ts";

/** A conditional class discovered in the tree. */
export type Toggle = {
  /** The signal object as authored; resolved to an export name later. */
  source: unknown;
  className: string;
  /** How many elements carry this class. */
  sites: number;
};

export type FieldPatch = {
  field: StyleField;
  slots: number[];
  on: number[];
  off: number[];
};

export type TogglePatch = {
  source: unknown;
  className: string;
  entries: FieldPatch[];
  writes: number;
  affectsLayout: boolean;
  /** Filled in by the reference-resolution pass. */
  exportName: string;
};

export type VariantCompiled = {
  /** Baseline style table, slot-major per field. */
  table: Record<StyleField, number[]>;
  slotCount: number;
  /** Per node: slot ids. State roles are -1 when they add nothing. */
  base: number[];
  hover: number[];
  active: number[];
  focus: number[];
  patches: TogglePatch[];
  warnings: string[];
};

// ---------------------------------------------------------------------------

function cloneTree(node: Node): Node {
  if (node.type === "text") return { type: "text", value: node.value };
  if (node.type === "dyntext") return { type: "dyntext", parts: [...node.parts] };
  if (node.type === "dynlist") return { ...node, template: cloneTree(node.template) };
  // Spread rather than field-by-field: a new `Element` field should not need a
  // line here to survive a variant compile.
  return {
    ...node,
    classes: [...node.classes],
    children: node.children.map(cloneTree),
  };
}

/** Collects conditional classes, one toggle per distinct signal object. */
export function findToggles(root: Element): Toggle[] {
  const bySource = new Map<unknown, Toggle>();

  const visit = (el: Element): void => {
    if (el.classWhen) {
      for (const [className, source] of Object.entries(el.classWhen)) {
        const existing = bySource.get(source);
        if (existing) {
          existing.sites++;
          if (existing.className !== className) {
            // One signal driving different class names is legal but the patch is
            // keyed by signal, so both classes ride together. Record the first.
            existing.className += `|${className}`;
          }
        } else {
          bySource.set(source, { source, className, sites: 1 });
        }
      }
    }
    for (const child of el.children) {
      if (child.type === "element") visit(child);
      // Item templates are part of the document for styling purposes.
      else if (child.type === "dynlist" && child.template.type === "element") visit(child.template);
    }
  };

  visit(root);
  return [...bySource.values()];
}

/** Applies a toggle's classes to every element that declared them. */
function applyToggle(root: Element, toggle: Toggle): void {
  const visit = (el: Element): void => {
    if (el.classWhen) {
      for (const [className, source] of Object.entries(el.classWhen)) {
        if (source === toggle.source && !el.classes.includes(className)) {
          el.classes.push(className);
        }
      }
    }
    for (const child of el.children) {
      if (child.type === "element") visit(child);
      // Item templates are part of the document for styling purposes.
      else if (child.type === "dynlist" && child.template.type === "element") visit(child.template);
    }
  };
  visit(root);
}

function sameValue(a: number, b: number): boolean {
  return (Number.isNaN(a) && Number.isNaN(b)) || a === b;
}

function changedFields(a: ComputedStyle, b: ComputedStyle): StyleField[] {
  const out: StyleField[] = [];
  for (const [field] of STYLE_FIELDS) {
    if (!sameValue(a[field], b[field])) out.push(field);
  }
  return out;
}

/**
 * Effective style per role, mirroring how the runtime resolves them: an absent
 * hover falls back to base, an absent active to hover, an absent focus to base.
 * Without that, a toggle *introducing* a state style would look structural.
 */
type Roles = { base: ComputedStyle; hover: ComputedStyle; active: ComputedStyle; focus: ComputedStyle };

function rolesOf(result: CompileResult, node: number): Roles {
  const n = result.nodes[node]!;
  const base = result.styles[n.style]!;
  const hover = n.hover >= 0 ? result.styles[n.hover]! : base;
  const active = n.active >= 0 ? result.styles[n.active]! : hover;
  const focus = n.focus >= 0 ? result.styles[n.focus]! : base;
  return { base, hover, active, focus };
}

const ROLE_NAMES = ["base", "hover", "active", "focus"] as const;
type RoleName = (typeof ROLE_NAMES)[number];

// ---------------------------------------------------------------------------

/**
 * `baseline` must be the result of compiling `doc` unchanged — it is passed in
 * rather than recompiled so node ids are guaranteed to match.
 */
export function compileVariants(
  doc: Element,
  css: string,
  baseline: CompileResult,
  toggles: Toggle[],
): VariantCompiled {
  const nodeCount = baseline.nodes.length;
  const warnings: string[] = [];

  // One compile per toggle. Only k+1 compiles, not 2^k: patches are per-toggle,
  // and combinations are only needed where two toggles collide.
  const variants: CompileResult[] = [baseline];
  for (const toggle of toggles) {
    const tree = cloneTree(doc) as Element;
    applyToggle(tree, toggle);
    const result = compileTree(tree, css);
    if (result.nodes.length !== nodeCount) {
      throw new Error(
        `applying .${toggle.className} changed the node count — conditional classes must not ` +
          `alter structure`,
      );
    }
    variants.push(result);
  }

  // A slot is a distinct vector of computed styles across all variants.
  const slotByKey = new Map<string, number>();
  const slotStyles: ComputedStyle[][] = []; // [slot][variant]

  const internSlot = (perVariant: ComputedStyle[]): number => {
    let key = "";
    for (const style of perVariant) {
      for (const [field] of STYLE_FIELDS) key += style[field] + ",";
      key += "|";
    }

    const existing = slotByKey.get(key);
    if (existing !== undefined) return existing;

    const id = slotStyles.length;
    slotByKey.set(key, id);
    slotStyles.push(perVariant);
    return id;
  };

  const base = new Array<number>(nodeCount).fill(-1);
  const hover = new Array<number>(nodeCount).fill(-1);
  const active = new Array<number>(nodeCount).fill(-1);
  const focus = new Array<number>(nodeCount).fill(-1);
  const pointers = { base, hover, active, focus };

  for (let n = 0; n < nodeCount; n++) {
    const perVariantRoles = variants.map((v) => rolesOf(v, n));

    for (const role of ROLE_NAMES) {
      const styles = perVariantRoles.map((r) => r[role]);

      if (role !== "base") {
        // A state slot is only needed where it differs from its fallback in some
        // variant. Where it does, the pointer must exist in *every* variant so
        // `nodes.hover` itself stays immutable.
        const fallback: RoleName = role === "active" ? "hover" : "base";
        const differs = perVariantRoles.some(
          (r, i) => changedFields(r[fallback], styles[i]!).length > 0,
        );
        if (!differs) continue;
      }

      pointers[role][n] = internSlot(styles);
    }
  }

  const slotCount = slotStyles.length;

  // Baseline table: variant 0 of each slot.
  const table = {} as Record<StyleField, number[]>;
  for (const [field] of STYLE_FIELDS) {
    table[field] = slotStyles.map((s) => s[0]![field]);
  }

  // Per-toggle patches: variant i+1 against variant 0, per slot.
  const patches: TogglePatch[] = toggles.map((toggle, i) => {
    const byField = new Map<StyleField, FieldPatch>();

    for (let slot = 0; slot < slotCount; slot++) {
      const off = slotStyles[slot]![0]!;
      const on = slotStyles[slot]![i + 1]!;
      for (const field of changedFields(off, on)) {
        let entry = byField.get(field);
        if (!entry) {
          entry = { field, slots: [], on: [], off: [] };
          byField.set(field, entry);
        }
        entry.slots.push(slot);
        entry.on.push(on[field]);
        entry.off.push(off[field]);
      }
    }

    const entries = [...byField.values()];
    return {
      source: toggle.source,
      className: toggle.className,
      entries,
      writes: entries.reduce((n, e) => n + e.slots.length, 0),
      affectsLayout: entries.some((e) => LAYOUT_FIELDS.includes(e.field)),
      exportName: "",
    };
  });

  // Conflicts are per (field, slot). Where two toggles overlap, sequencing their
  // patches does not reproduce the cascade.
  for (let a = 0; a < patches.length; a++) {
    const keys = new Set<string>();
    for (const e of patches[a]!.entries) for (const s of e.slots) keys.add(`${e.field}#${s}`);

    for (let b = a + 1; b < patches.length; b++) {
      let conflicts = 0;
      for (const e of patches[b]!.entries) {
        for (const s of e.slots) if (keys.has(`${e.field}#${s}`)) conflicts++;
      }
      if (conflicts > 0) {
        warnings.push(
          `.${patches[a]!.className} and .${patches[b]!.className} both write ${conflicts} ` +
            `style field(s) in common; with both active the cascade may resolve differently ` +
            `than sequencing their patches`,
        );
      }
    }
  }

  return { table, slotCount, base, hover, active, focus, patches, warnings };
}

/** Whether a node needs a row in the sparse state table. */
export function hasState(v: VariantCompiled, node: number): boolean {
  return v.hover[node]! >= 0 || v.active[node]! >= 0 || v.focus[node]! >= 0;
}
