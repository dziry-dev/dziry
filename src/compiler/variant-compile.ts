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
  compactBits,
  LAYOUT_FIELDS,
  maskBits,
  STYLE_FIELDS,
  type ComputedStyle,
  type StyleField,
} from "../ir.ts";
import { compileTree, type CompileResult } from "./compile.ts";
import type { BuiltKeyframe, BuiltTween } from "./computed.ts";
import type { Element, Node } from "./html.ts";
import { isRecorder } from "./item-path.ts";
import type { VariantRunResult } from "./variant-worker.ts";

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
  /**
   * The expression to emit instead of the name, for a signal with no name.
   *
   * `router.matches("layout")` is created inside a component and cannot be an
   * export, so the artifact contains the comparison rather than an import of it.
   * `exportName` still names the route signal the expression reads.
   */
  exportExpression?: string;
};

export type VariantCompiled = {
  /** Baseline style table, slot-major per field. */
  table: Record<StyleField, number[]>;
  slotCount: number;
  /** Per node: the slot its base style resolved to. */
  base: number[];
  /** Predicate bits each node reads, unioned across every variant. */
  masks: number[];
  /** Per node, one interned slot per predicate combination. */
  runs: number[][];
  patches: TogglePatch[];
  /**
   * Interned transition and animation rows, carried through unchanged.
   *
   * Unchanged because a tween row holds no style index — only a mask, a timing and
   * a curve — so nothing in it needs renumbering. It is here rather than left on the
   * baseline so `emit` reads the tables from one place, which is what stopped the
   * two from disagreeing.
   */
  tweens: BuiltTween[];
  /**
   * Keyframe rows with their `style` **remapped into slot space**.
   *
   * The remap is the whole reason these are here, and its absence was a bug that
   * compiled cleanly and rendered the wrong colours. A keyframe's style is an
   * ordinary interned row in the *baseline* numbering, and this function replaces
   * that numbering entirely: a slot is a vector of styles across every variant, so
   * baseline row 54 and slot 54 are unrelated. Every animated box on the page drew
   * some other element's fill, because the indices were left pointing at a table
   * that no longer existed.
   *
   * Interned through the same `internSlot` as everything else, over the keyframe's
   * style *in each variant* — so a conditional class that recolours something a
   * keyframe mentions patches the segment row too, and the animation follows the
   * theme instead of freezing at the baseline's colour.
   */
  keyframes: BuiltKeyframe[];
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
        // A recorded item path is not a toggle: `cn({ done: t.done })` is per-row
        // state, compiled as `Predicate.ROW` in the node's own mask — a toggle
        // here would style every replica at once, the exact failure the predicate
        // exists to avoid.
        if (isRecorder(source)) continue;
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
  // Equal values take a single comparison; the NaN check only pays when unequal.
  return a === b || (a !== a && b !== b);
}

/** One toggle's compile, reduced to the fields `compileVariants` reads. */
function compileToggle(doc: Element, css: string, toggle: Toggle): VariantRunResult {
  const tree = cloneTree(doc) as Element;
  applyToggle(tree, toggle);
  const result = compileTree(tree, css);
  return {
    nodes: result.nodes.map((n) => ({ mask: n.mask, run: n.run })),
    styles: result.styles,
    tweens: result.tweens,
    keyframes: result.keyframes,
  };
}

/**
 * A deep clone that crosses the worker boundary. The document tree references
 * live signals (a dyntext's parts, a dynlist's source, a classWhen's) and
 * handlers, none of which structured-clone — and none of which the cascade
 * reads: matching looks at tags, classes, attributes and structure, and of the
 * result only the style rows are consumed. They cross as `undefined`; the
 * toggle sites are annotated as indices before the crossing, so nothing
 * semantic is lost.
 */
function transportClone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "function") return undefined as T;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(transportClone) as T;
  // Structured clone owns these — a Map is how an element's attrs travel.
  if (value instanceof Map) {
    return new Map([...value].map(([k, v]) => [k, transportClone(v)])) as T;
  }
  if (value instanceof Set) return new Set([...value].map(transportClone)) as T;
  if (ArrayBuffer.isView(value) || value instanceof Date) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = transportClone(v);
  return out as T;
}

/**
 * A toggle site as it crosses to a worker: the class name and the index of the
 * toggle that owns it. `applyToggle` matches sites by signal *identity*, and
 * identity is exactly what a structured clone cannot carry — so before the tree
 * is transported, every `classWhen` entry is rewritten as one of these on the
 * transported element, and the worker applies a toggle by index instead.
 */
export type ToggleSite = [className: string, toggle: number];

/**
 * Rewrites toggle sites as indices onto the transported tree, walking it in
 * lockstep with the live one — same shape by construction, `transportClone`
 * preserves structure and only erases what cannot cross.
 */
function annotateToggleSites(
  live: Element,
  transported: Element,
  indexOf: Map<unknown, number>,
): void {
  if (live.classWhen) {
    const sites: ToggleSite[] = [];
    const rowClasses: string[] = [];
    for (const [className, source] of Object.entries(live.classWhen)) {
      // A recorder-valued entry is per-row state, not a toggle — but the worker's
      // cascade still has to compile it, and the recorder proxy cannot cross. It
      // crosses as a plain name instead; `resolveVariants` accepts either form.
      if (isRecorder(source)) {
        rowClasses.push(className);
        continue;
      }
      const i = indexOf.get(source);
      if (i !== undefined) sites.push([className, i]);
    }
    (transported as Element & { toggleSites?: ToggleSite[] }).toggleSites = sites;
    if (rowClasses.length > 0) transported.rowClasses = rowClasses;
  }
  for (let c = 0; c < live.children.length; c++) {
    const child = live.children[c]!;
    const other = transported.children[c]!;
    if (child.type === "element") {
      annotateToggleSites(child, other as Element, indexOf);
    } else if (child.type === "dynlist" && child.template.type === "element") {
      // Item templates are part of the document for styling purposes.
      annotateToggleSites(
        child.template,
        (other as { template: Element }).template,
        indexOf,
      );
    }
  }
}

/**
 * Idle compiler workers, kept warm across compiles.
 *
 * A worker's real cost is startup: it cold-imports the whole compiler graph
 * (measured: that is why 8 workers lose to 4 — the extra lanes never pay for
 * the extra imports). In `dziri dev` the compiles run inside the warm compile
 * server, one process for the whole session, so the pool outlives a compile the
 * same way the server's own module graph does — and it is exactly as stale,
 * since the server never re-imports compiler code either.
 *
 * Idle workers are `unref`ed so a one-shot compile (the CLI, a test, `bun run
 * window`) still exits when its main thread is done; `ref` is restored while a
 * job is in flight so the event loop cannot drain under an awaited reply.
 */
const idleWorkers: Worker[] = [];

type Refable = Worker & { ref?: () => void; unref?: () => void };

function acquireWorker(): Worker {
  const worker = idleWorkers.pop();
  if (worker !== undefined) {
    worker.onerror = null;
    (worker as Refable).ref?.();
    return worker;
  }
  return new Worker(new URL("./variant-worker.ts", import.meta.url).href);
}

/**
 * Only for a worker whose last reply has been awaited — releasing one mid-job
 * would hand its late response to the next compile's first listener.
 */
function releaseWorker(worker: Worker): void {
  worker.onmessage = null;
  // An idle worker that dies must not be handed out later as if healthy.
  worker.onerror = () => {
    const at = idleWorkers.indexOf(worker);
    if (at > -1) idleWorkers.splice(at, 1);
    worker.terminate();
  };
  (worker as Refable).unref?.();
  idleWorkers.push(worker);
}

/**
 * The toggle compiles, on a worker pool. Each is a full cascade and they share
 * nothing, so they distribute exactly; the pool is sized to the smaller of the
 * toggle count and the machine, and its members are returned to `idleWorkers`
 * rather than torn down — the next compile re-inits them with a fresh tree and
 * skips the startup entirely (measured: ~25% off a warm-server recompile).
 *
 * The document crosses **once per worker**, not once per toggle. It used to be
 * cloned three times per toggle — `cloneTree`, `transportClone`, and the
 * structured clone inside `postMessage` — and a CPU profile of the demo compile
 * showed that transport at ~52% of the whole compile, more than the cascades it
 * was feeding. Now a job is just a toggle index; the worker holds the tree and
 * clones locally, which also moves that cloning off this thread.
 */
async function compileTogglesParallel(
  doc: Element,
  css: string,
  toggles: Toggle[],
): Promise<VariantRunResult[]> {
  // Capped well below the core count on purpose: 16 concurrent compiler workers
  // segfaulted Bun 1.3.14 on Windows (workers_spawned/terminated churn — a
  // runtime bug, not ours), and past ~6 the toggle compiles are memory-bound
  // anyway. Four is the stability/speed knee — re-measured on Bun 1.4.0 with the
  // init-once transport: 8 workers is ~10% slower, because each worker cold-
  // imports the whole compiler graph and the startup outweighs the extra lanes.
  const size = Math.min(toggles.length, 4);
  const indexOf = new Map(toggles.map((t, i) => [t.source, i]));
  const transport = transportClone(doc);
  annotateToggleSites(doc, transport, indexOf);

  const queue = toggles.map((_, i) => i);
  const out: VariantRunResult[] = new Array(toggles.length);

  await Promise.all(
    Array.from({ length: size }, async () => {
      const worker = acquireWorker();
      try {
        // The init message has no reply; the first job's response is the first
        // message back, so per-job listeners below cannot race with it.
        worker.postMessage({ tree: transport, css });
        while (queue.length > 0) {
          const toggle = queue.shift()!;
          out[toggle] = await new Promise<VariantRunResult>((resolve, reject) => {
            worker.onmessage = (
              event: MessageEvent<{ ok: true; result: VariantRunResult } | { ok: false; error: string }>,
            ) =>
              event.data.ok
                ? resolve(event.data.result)
                : reject(new Error(`a variant compile failed in its worker:\n${event.data.error}`));
            worker.onerror = (e) =>
              reject(e instanceof Error ? e : new Error("message" in e ? String(e.message) : String(e)));
            worker.postMessage({ toggle });
          });
        }
      } catch (e) {
        // The failed lane's worker may still be mid-job; a terminated worker
        // cannot leak a late reply into the next compile the way a pooled one
        // could. The healthy lanes still release theirs in the line below.
        worker.terminate();
        throw e;
      }
      releaseWorker(worker);
    }),
  );
  return out;
}
/**
 * `STYLE_FIELDS` flattened once. `changedFields` runs slots × toggles times —
 * ~1.7M field compares on the demo — and re-destructuring the tuple per field
 * per call was visible in a CPU profile.
 */
const FIELD_LIST: StyleField[] = STYLE_FIELDS.map(([field]) => field);

function changedFields(a: ComputedStyle, b: ComputedStyle): StyleField[] {
  const out: StyleField[] = [];
  for (let i = 0; i < FIELD_LIST.length; i++) {
    const field = FIELD_LIST[i]!;
    if (!sameValue(a[field], b[field])) out.push(field);
  }
  return out;
}

/**
 * One variant's predicate mask and its resolved style per combination.
 *
 * This replaced a fixed `(base, hover, active, focus)` record with a fallback
 * chain — absent hover falling back to base, absent active to hover. The chain
 * was an approximation of what the runtime then did, which was *pick* one role;
 * and picking is the bug. With both `:hover` and `:focus` matching, CSS merges
 * them per property, so a node that is hovered and focused needs a style resolved
 * with **both** states active, not whichever role ranked higher.
 *
 * `walk` already resolves every combination as a full cascade, so this just reads
 * what the node was compiled with.
 */
type Run = { mask: number; run: number[] };

function runOf(result: VariantRunResult, node: number): Run {
  return result.nodes[node]!;
}

/**
 * A run re-indexed against a wider mask — the style *row id* for a combination.
 *
 * The masks are not the same across variants: a toggle can *introduce* a state
 * the baseline lacks (`body.light .todo:hover`), so the node's real mask is the
 * union, and each variant has to answer for combinations it does not itself read.
 * It answers by ignoring the bits it has no rules for — which is exactly what
 * intersecting with its own mask does.
 */
function expand(run: Run, combo: number, unionBits: number[]): number {
  let live = 0;
  for (let b = 0; b < unionBits.length; b++) {
    if ((combo & (1 << b)) !== 0) live |= unionBits[b]!;
  }
  return run.run[compactBits(live & run.mask, run.mask)] ?? run.run[0]!;
}

// ---------------------------------------------------------------------------

/**
 * `baseline` must be the result of compiling `doc` unchanged — it is passed in
 * rather than recompiled so node ids are guaranteed to match.
 */
export async function compileVariants(
  doc: Element,
  css: string,
  baseline: CompileResult,
  toggles: Toggle[],
): Promise<VariantCompiled> {
  const t0 = performance.now();
  const nodeCount = baseline.nodes.length;
  const warnings: string[] = [];

  // One compile per toggle. Only k+1 compiles, not 2^k: patches are per-toggle,
  // and combinations are only needed where two toggles collide.
  //
  // Independent, so parallel: past a couple of toggles the compiles go to a
  // worker pool (each is a full cascade, and they were the whole compile time —
  // measured: 18 toggles took 10.4s of an 11.4s compile). Under three, the
  // pool's startup costs more than it saves.
  const variants: VariantRunResult[] = [baseline];
  if (toggles.length < 3 || process.env.DZIRI_VARIANTS === "seq") {
    // `seq` is a debugging escape hatch: the pool is the shipping path, and when
    // one diverges you want the other to diff against.
    for (const toggle of toggles) {
      variants.push(compileToggle(doc, css, toggle));
    }
  } else {
    variants.push(...(await compileTogglesParallel(doc, css, toggles)));
  }
  const compiledAt = performance.now();
  if (process.env.DZIRI_TIMING) {
    console.error(`  [timing] variants toggle compiles: ${(compiledAt - t0).toFixed(0)}ms`);
  }
  for (const v of variants) {
    if (v.nodes.length !== nodeCount) {
      throw new Error(
        `applying a conditional class changed the node count — conditional classes must not ` +
          `alter structure`,
      );
    }
  }

  // A slot is a distinct vector of computed styles across all variants.
  //
  // Interned over the vector of style *row ids*, not field values. Within one
  // compile the interner dedupes by content, so a row id is a content identity
  // *for that compile* — and two id-vectors are equal iff their styles are equal
  // in every variant, which is exactly slot equality. This replaces spelling 149
  // fields × k variants into a string per node per state combination: measured,
  // that string building (and the hashing that briefly replaced it) was the
  // largest single block of compile time on the demo — about half of the variant
  // pass. An integer vector is exact and cheap.
  //
  // Each entry is packed `v * rowSpace + row`: a keyframe can fall back to the
  // baseline's table when its variant lacks the row, so the variant index is
  // part of the identity, not implied by position.
  const rowSpace = Math.max(...variants.map((v) => v.styles.length)) + 1;
  const slotByKey = new Map<string, number>();
  const slotStyles: ComputedStyle[][] = []; // [slot][variant]

  const internSlot = (packed: number[]): number => {
    const key = packed.join(",");
    const existing = slotByKey.get(key);
    if (existing !== undefined) return existing;

    const id = slotStyles.length;
    slotByKey.set(key, id);
    slotStyles.push(
      packed.map((code) => variants[Math.floor(code / rowSpace)]!.styles[code % rowSpace]!),
    );
    return id;
  };

  const base = new Array<number>(nodeCount).fill(-1);
  const masks = new Array<number>(nodeCount).fill(0);
  const runs: number[][] = new Array(nodeCount);

  for (let n = 0; n < nodeCount; n++) {
    const perVariant = variants.map((v) => runOf(v, n));

    // The union, because a toggle can introduce a state the baseline lacks. The
    // node then reads that predicate in *every* variant, which is what keeps the
    // run's shape — and so `nodes.style` — immutable across a toggle.
    const mask = perVariant.reduce((m, r) => m | r.mask, 0);
    const unionBits = maskBits(mask);
    masks[n] = mask;

    const run: number[] = new Array(1 << unionBits.length);
    for (let combo = 0; combo < run.length; combo++) {
      // Interned over the vector across variants, exactly as before — two nodes
      // share a slot only if they agree in every variant. That is what lets a
      // toggle rewrite the style *table* instead of node pointers.
      run[combo] = internSlot(
        perVariant.map((r, v) => v * rowSpace + expand(r, combo, unionBits)),
      );
    }

    base[n] = run[0]!;
    runs[n] = run;
  }

  /**
   * Keyframe style rows, renumbered into slot space.
   *
   * **Before `slotCount` is taken**, because interning a keyframe's style can mint a
   * new slot: a keyframe row is usually a style no node wears — `spin`'s `to` is the
   * element rotated 360°, and nothing is ever painted that way at rest.
   *
   * A variant whose keyframe table has a different shape is refused rather than
   * approximated. It means a conditional class changed which animation runs, and
   * silently taking the baseline's rows would animate the wrong thing on toggle —
   * one of the two ways to be wrong that leaves nothing on screen to blame.
   */
  const shapeMismatch = variants.find(
    (v) => v.keyframes.length !== baseline.keyframes.length || v.tweens.length !== baseline.tweens.length,
  );
  if (shapeMismatch !== undefined) {
    warnings.push(
      "a conditional class changed which transitions or animations exist; the baseline's " +
        "are used in every state. Declare the same `transition`/`animation` in both.",
    );
  }

  const keyframes: BuiltKeyframe[] = baseline.keyframes.map((row, k) => ({
    ...row,
    style: internSlot(
      variants.map((v, vi) => {
        const inVariant = v.keyframes[k];
        // A variant that lacks this row (shape mismatch, warned above) answers
        // with the baseline's — pinned to variant 0, since row ids are only
        // content identities within their own compile.
        return inVariant === undefined ? row.style : vi * rowSpace + inVariant.style;
      }),
    ),
  }));

  const slotCount = slotStyles.length;

  // Baseline table: variant 0 of each slot.
  const table = {} as Record<StyleField, number[]>;
  for (const field of FIELD_LIST) {
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
      const detail: string[] = [];
      for (const e of patches[b]!.entries) {
        for (let k = 0; k < e.slots.length; k++) {
          const s = e.slots[k]!;
          if (keys.has(`${e.field}#${s}`)) {
            conflicts++;
            const ea = patches[a]!.entries.find((x) => x.field === e.field)!;
            const ka = ea.slots.indexOf(s);
            detail.push(
              `${e.field}#${s}: a(on=${ea.on[ka]},off=${ea.off[ka]}) b(on=${e.on[k]},off=${e.off[k]})`,
            );
          }
        }
      }
      if (conflicts > 0) {
        warnings.push(
          `.${patches[a]!.className} and .${patches[b]!.className} both write ${conflicts} ` +
            `style field(s) in common; with both active the cascade may resolve differently ` +
            `than sequencing their patches [${detail.join(" | ")}]`,
        );
      }
    }
  }

  return {
    table,
    slotCount,
    base,
    masks,
    runs,
    patches,
    tweens: baseline.tweens,
    keyframes,
    warnings,
  };
}

/** Whether a node is conditionally styled at all. */
export function hasState(v: VariantCompiled, node: number): boolean {
  return v.masks[node]! !== 0;
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

/** One node whose style, under one toggle combination, is not what the compiler says. */
export type ComposeMismatch = {
  /** Bit i is set when `toggles[i]` is on. */
  combination: number;
  classNames: string[];
  node: number;
  /** Live predicate bits (hover/active/focus) under which the styles differ. */
  predicates: number;
  field: StyleField;
  /** What sequencing the patches produced. */
  patched: number;
  /** What compiling the same document with those classes applied produces. */
  compiled: number;
};

/**
 * Does sequencing per-toggle patches reproduce the compiler's own output for
 * *every* combination of toggles?
 *
 * This is the load-bearing claim of the whole variant design. `compileVariants`
 * compiles k+1 times, not 2^k, and ships one patch per toggle on the assumption
 * that applying two patches in order lands where a real cascade with both classes
 * would. Where two toggles write the same `(field, slot)` that assumption can be
 * false, which is why `compileVariants` warns about the overlap — and warning is
 * not verifying.
 *
 * The check existed already, in `src/compiler/variants.ts`, and pointed at a
 * *second copy* of the algorithm while only printing its result. So the strongest
 * test in the project guarded code nothing shipped. This is the same proof aimed
 * at `compileVariants`, returning mismatches so a test can assert on them.
 *
 * Truth is a fresh `compileTree` of the document with the combination's classes
 * applied — the real cascade, no patches involved. Comparison happens per node and
 * per live predicate combination rather than per slot, because the slot is an
 * implementation detail while "what style does this node wear" is the promise.
 * Masks differ between variants (a toggle can introduce `:hover` where the
 * baseline had none), so both sides are indexed by live predicate *bits* and
 * compacted through their own mask, which is the one space they share.
 *
 * Cost is 2^k compiles, so this belongs in a test rather than in a build.
 */
export async function verifyCompose(
  doc: Element,
  css: string,
  baseline: CompileResult,
  toggles: Toggle[],
): Promise<ComposeMismatch[]> {
  const compiled = await compileVariants(doc, css, baseline, toggles);
  const mismatches: ComposeMismatch[] = [];

  if (toggles.length === 0 || toggles.length > 12) {
    // 2^12 compiles is already minutes; past that the caller wants a subset.
    return mismatches;
  }

  const nodeCount = baseline.nodes.length;

  for (let combination = 1; combination < 1 << toggles.length; combination++) {
    // The patched table: baseline values, then every active toggle's writes in
    // declaration order — exactly what the runtime does.
    const table: Record<string, number[]> = {};
    for (const [field] of STYLE_FIELDS) table[field] = [...compiled.table[field]];

    for (let i = 0; i < toggles.length; i++) {
      if ((combination & (1 << i)) === 0) continue;
      for (const entry of compiled.patches[i]!.entries) {
        const column = table[entry.field]!;
        for (let s = 0; s < entry.slots.length; s++) {
          column[entry.slots[s]!] = entry.on[s]!;
        }
      }
    }

    // Truth: compile the document with those classes really applied.
    const tree = cloneTree(doc) as Element;
    const classNames: string[] = [];
    for (let i = 0; i < toggles.length; i++) {
      if ((combination & (1 << i)) === 0) continue;
      applyToggle(tree, toggles[i]!);
      classNames.push(toggles[i]!.className);
    }
    const truth = compileTree(tree, css);

    for (let node = 0; node < nodeCount; node++) {
      const truthNode = truth.nodes[node];
      if (truthNode === undefined) continue;

      const mask = compiled.masks[node]! | truthNode.mask;
      for (const predicates of subsetsOf(mask)) {
        const mine = compiled.runs[node]![
          compactBits(predicates & compiled.masks[node]!, compiled.masks[node]!)
        ]!;
        const theirs =
          truthNode.run[compactBits(predicates & truthNode.mask, truthNode.mask)] ??
          truthNode.style;
        const want = truth.styles[theirs]!;

        for (const [field] of STYLE_FIELDS) {
          const patched = table[field]![mine]!;
          const expected = want[field];
          if (Number.isNaN(patched) && Number.isNaN(expected)) continue;
          if (patched === expected) continue;
          mismatches.push({
            combination,
            classNames,
            node,
            predicates,
            field,
            patched,
            compiled: expected,
          });
        }
      }
    }
  }

  return mismatches;
}

/** Every combination of the set bits in `mask`, including none of them. */
function subsetsOf(mask: number): number[] {
  const bits = maskBits(mask);
  const out: number[] = [];
  for (let i = 0; i < 1 << bits.length; i++) {
    let live = 0;
    for (let b = 0; b < bits.length; b++) if (i & (1 << b)) live |= bits[b]!;
    out.push(live);
  }
  return out;
}
