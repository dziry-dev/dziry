/**
 * The compiler's IR into the engine's tables.
 *
 * The IR and the schema are deliberately not the same shape, and the gap is
 * informative: `src/ir.ts` has the **25** style fields the TypeScript runtime
 * could honour, the schema has **48**. The extra 23 are grid, wrap, position,
 * insets, `flex-*`, `lineClamp` and `overflow` — everything the old engine could
 * not do. So the compiler grows into the schema over time; until it does, this
 * writes the unset values (`NaN` for lengths, `255` for enums) rather than
 * leaving them zero, because zero is a real value in a style table.
 *
 * # Who owns what
 *
 * The IR stays the source of truth on the Bun side, and this uploads it. That
 * keeps `bindings.ts`, `patches.ts` and `list-runtime.ts` — proven, measured, and
 * the bulk of the dynamic-state work — writing the same JS arrays they always
 * have. The alternative, making the staged tables the only copy, would mean
 * rewriting all three plus the arena-growth path for no behaviour gained.
 *
 * The cost is one copy per frame of what changed. `nodes` and `styles` are
 * uploaded wholesale because they are small and contiguous (1215 nodes is ~23 KB
 * of memcpy). **Strings are uploaded incrementally**, because re-encoding every
 * row of a 2000-item list on every keystroke would not be.
 */
import { findRow, INITIAL_STYLE, type CompiledUi, type StyleField } from "../ir.ts";
import { F, NodeFlags, type SharedTables } from "../protocol/generated.ts";
import type { Engine } from "./host.ts";

/**
 * Style fields the compiler emits, paired with where they land in the schema.
 *
 * Names differ (`padT` vs `padTop`) because the schema spells CSS out; the
 * *encodings* were chosen to match, so `direction`, `justify` and `align` need no
 * translation beyond the rename. That was not luck — the schema's enums were
 * written from the IR's.
 */
export const NUMBER_FIELDS: Array<[keyof typeof F.styles, StyleField]> = [
  ["bg", "bg"],
  ["fg", "fg"],
  ["borderColor", "borderColor"],
  ["borderWidth", "borderWidth"],
  ["radius", "radius"],
  ["padTop", "padT"],
  ["padRight", "padR"],
  ["padBottom", "padB"],
  ["padLeft", "padL"],
  ["marginTop", "marT"],
  ["marginRight", "marR"],
  ["marginBottom", "marB"],
  ["marginLeft", "marL"],
  ["display", "display"],
  ["flexDirection", "direction"],
  ["flexWrap", "wrap"],
  ["justifyContent", "justify"],
  ["alignItems", "align"],
  ["alignSelf", "alignSelf"],
  ["justifyItems", "justifyItems"],
  ["justifySelf", "justifySelf"],
  ["flexGrow", "grow"],
  ["flexShrink", "shrink"],
  ["flexBasis", "basis"],
  ["gapRow", "gapRow"],
  ["gapColumn", "gapCol"],
  ["gridColumns", "gridCols"],
  ["gridRows", "gridRows"],
  ["gridColumnStart", "gridColStart"],
  ["gridColumnSpan", "gridColSpan"],
  ["gridRowStart", "gridRowStart"],
  ["gridRowSpan", "gridRowSpan"],
  ["width", "width"],
  ["height", "height"],
  ["minWidth", "minW"],
  ["maxWidth", "maxW"],
  ["minHeight", "minH"],
  ["maxHeight", "maxH"],
  ["aspectRatio", "aspectRatio"],
  ["position", "position"],
  ["insetTop", "insetT"],
  ["insetRight", "insetR"],
  ["insetBottom", "insetB"],
  ["insetLeft", "insetL"],
  ["fontSize", "fontSize"],
  ["fontWeight", "fontWeight"],
  ["overflow", "overflow"],
];

/** How much room to leave beyond what the IR needs right now. */
const NODE_HEADROOM = 1.5;
const STRING_HEADROOM = 2;
const ARENA_HEADROOM = 4;

export type Capacities = {
  nodes: number;
  styles: number;
  variants: number;
  variantSlots: number;
  lists: number;
  strings: number;
  stringBytes: number;
};

/**
 * The string arena's size, rounded up to a power of two.
 *
 * The rounding is what makes typing cheap. An *exact* request changes with every
 * character — the sample's 48 strings ask for 5076 bytes, so one more character
 * asks for 5088 — and satisfying it reallocates all three arenas, re-uploads
 * everything and rebuilds the whole Taffy tree, because `grow` marks the engine
 * `fresh`. Holding a key down did that once per character, and since `grow`
 * never shrinks, deleting the text did not give the memory back.
 *
 * Rounding turns that into O(log n) growth events: the request is stable across
 * thousands of keystrokes and only moves when the arena genuinely doubles.
 */
function arenaBytes(bytes: number): number {
  const want = Math.max(bytes * ARENA_HEADROOM, 4096);
  return 2 ** Math.ceil(Math.log2(want));
}

/** Capacities that hold `ui` with room for a list arena to grow into. */
export function capacitiesFor(ui: CompiledUi): Capacities {
  let bytes = 0;
  for (const s of ui.strings) bytes += s.length * 3; // worst-case UTF-8 per char

  return {
    nodes: Math.ceil(ui.nodes.count * NODE_HEADROOM) + 16,
    // Style slots are fixed by the compiler: interning happens at build time and
    // patches rewrite values in place, never adding slots.
    styles: Math.max(ui.styles.count, 1),
    variants: Math.max(ui.variants.count, 1),
    variantSlots: Math.max(ui.variants.slots.length, 1),
    lists: Math.max(ui.lists.count, 1),
    strings: Math.ceil(ui.strings.length * STRING_HEADROOM) + 16,
    stringBytes: arenaBytes(bytes),
  };
}

export class Uploader {
  #engine: Engine;
  #ui: CompiledUi;
  #tables: SharedTables;
  #encoder = new TextEncoder();

  /**
   * What each string slot last held, so an unchanged slot costs no encode.
   *
   * `undefined` means "never uploaded", which is distinct from `""`.
   */
  #uploaded: Array<string | undefined> = [];
  /** Bump allocator into the UTF-8 arena. */
  #cursor = 0;

  constructor(engine: Engine, ui: CompiledUi) {
    this.#engine = engine;
    this.#ui = ui;
    this.#tables = engine.tables;
  }

  /**
   * Grows the engine's tables if the IR has outgrown them, then re-binds.
   *
   * Returns true when the tables moved, which invalidates every view and forces
   * a full re-upload — the caller must not assume anything survived.
   */
  ensureCapacity(): boolean {
    const want = capacitiesFor(this.#ui);
    const grew = this.#engine.grow(want);
    if (grew) {
      this.#tables = this.#engine.tables;
      this.#uploaded = [];
      this.#cursor = 0;
    }
    return grew;
  }

  /** Everything. Used on the first frame and after the tables are reallocated. */
  uploadAll(): void {
    this.uploadStyles();
    this.uploadVariants();
    this.uploadLists();
    this.uploadNodes();
    this.uploadStrings(true);
  }

  /**
   * Node structure and per-node indices.
   *
   * Uploaded wholesale rather than diffed: the engine's commit already compares
   * span by span and reports what changed, so diffing here would be doing the
   * same work twice with less information.
   */
  uploadNodes(): void {
    const { nodes, interactive } = this.#ui;
    const t = this.#tables.nodes;
    const count = Math.min(nodes.count, t.kind.length);

    t.kind.set(nodes.kind.subarray(0, count));
    t.style.set(nodes.style.subarray(0, count));
    t.text.set(nodes.text.subarray(0, count));
    t.parent.set(nodes.parent.subarray(0, count));
    t.firstChild.set(nodes.firstChild.subarray(0, count));
    t.nextSibling.set(nodes.nextSibling.subarray(0, count));
    t.list.set(nodes.list.subarray(0, count));
    t.hidden.set(nodes.hidden.subarray(0, count));

    // Nodes past the IR's count are spare capacity: unreachable from the root,
    // but they must not claim to be anyone's child.
    t.firstChild.fill(-1, count);
    t.nextSibling.fill(-1, count);
    t.parent.fill(-1, count);
    t.text.fill(-1, count);
    t.flags.fill(0, count);

    // Flags the old runtime kept in two side tables. `interactive` is emitted by
    // the compiler rather than inferred — inferring it from `hover >= 0` silently
    // excluded clickable list rows with no `:hover` rule.
    for (let i = 0; i < count; i++) {
      let flags = 0;
      if (findRow(interactive, i) >= 0) flags |= NodeFlags.INTERACTIVE;
      // Anything with text needs measuring; that is exactly what the old measure
      // pass did, for TEXT nodes and for button labels alike.
      if (nodes.text[i]! >= 0) flags |= NodeFlags.MEASURABLE;
      t.flags[i] = flags;
    }
  }

  /**
   * The style table, including the 23 fields the compiler does not emit.
   *
   * Those get their *unset* values, not zero. A zeroed `flexBasis` is
   * `flex-basis: 0`, which collapses a flex item; a zeroed `alignSelf` is
   * `flex-start`, which overrides the parent's `align-items`. Both are silent.
   */
  uploadStyles(): void {
    const src = this.#ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
    const dst = this.#tables.styles as unknown as Record<string, { [i: number]: number }>;
    const count = Math.min(this.#ui.styles.count, this.#tables.styles.bg.length);

    for (const [schemaField, irField] of NUMBER_FIELDS) {
      const column = src[irField];
      const out = dst[schemaField]!;
      for (let i = 0; i < count; i++) out[i] = column[i]!;
    }

    // Spare slots past the IR's count get the *initial* style, field by field
    // through the same mapping table.
    //
    // This used to name three fields by hand — `width`, `height`, `alignSelf` —
    // which left the other 43 reading as zero: `maxWidth: 0` (nothing may exceed
    // nothing), `flexBasis: 0` (a collapsed flex item), `flexShrink: 0`,
    // `fontSize: 0`. The same argument that justified those three covers all of
    // them, and `INITIAL_STYLE` already states every answer, so deriving beats
    // listing — a new field is unset here the moment it is added to the IR,
    // rather than the day somebody notices.
    const capacity = this.#tables.styles.bg.length;
    for (const [schemaField, irField] of NUMBER_FIELDS) {
      const initial = INITIAL_STYLE[irField];
      const out = dst[schemaField]!;
      for (let i = count; i < capacity; i++) out[i] = initial;
    }

    // `lineClamp` is in the schema but not in the IR: the engine does not clamp
    // paragraphs yet, and zero is the honest value for "no clamp". `overflow` used
    // to be in the same sentence and is now a real field.
  }

  uploadVariants(): void {
    const { variants } = this.#ui;
    const t = this.#tables.variants;
    const count = Math.min(variants.count, t.node.length);
    t.node.set(variants.node.subarray(0, count));
    t.mask.set(variants.mask.subarray(0, count));
    t.runStart.set(variants.runStart.subarray(0, count));

    // Spare rows must not answer a binary search for node 0.
    t.node.fill(-1, count);

    const slots = this.#tables.variantSlots.style;
    slots.set(variants.slots.subarray(0, Math.min(variants.slots.length, slots.length)));
  }

  uploadLists(): void {
    const { lists } = this.#ui;
    const t = this.#tables.lists;
    const count = Math.min(lists.count, t.container.length);
    t.container.set(lists.container.subarray(0, count));
    t.anchorPrev.set(lists.anchorPrev.subarray(0, count));
    t.anchorNext.set(lists.anchorNext.subarray(0, count));
    t.arenaStart.set(lists.arenaStart.subarray(0, count));
    t.stride.set(lists.stride.subarray(0, count));
    t.capacity.set(lists.capacity.subarray(0, count));
    t.active.set(lists.active.subarray(0, count));
  }

  /**
   * Strings, incrementally.
   *
   * A changed string is encoded and **appended** at the cursor, and its slot
   * re-pointed. Slots are variable-length, so rewriting in place would shift
   * everything after; appending costs arena space instead, and the arena is
   * repacked when it fills. Dynamic text mints a new string on every keystroke,
   * so this is the one upload that must not be O(all strings).
   */
  uploadStrings(force = false): void {
    const strings = this.#ui.strings;
    const slots = this.#tables.strings;
    const arena = this.#engine.stringBytes;

    // What the encoded bytes would need if every changed slot is appended.
    let needed = 0;
    for (let i = 0; i < strings.length; i++) {
      if (force || this.#uploaded[i] !== strings[i]) needed += strings[i]!.length * 3;
    }

    if (force || this.#cursor + needed > arena.length) {
      this.#repack();
      return;
    }

    for (let i = 0; i < strings.length && i < slots.offset.length; i++) {
      const text = strings[i]!;
      if (this.#uploaded[i] === text) continue;

      const bytes = this.#encoder.encode(text);
      arena.set(bytes, this.#cursor);
      slots.offset[i] = this.#cursor;
      slots.length[i] = bytes.length;
      this.#cursor += bytes.length;
      this.#uploaded[i] = text;
    }
  }

  /**
   * Rewrites every live string compactly from the start of the arena.
   *
   * Amortised: the arena only fills because appending never reclaims, so a
   * repack recovers all of it at once. If this ever shows up in a profile the
   * answer is a larger `ARENA_HEADROOM`, not a free-list.
   */
  #repack(): void {
    const strings = this.#ui.strings;
    const slots = this.#tables.strings;
    const arena = this.#engine.stringBytes;

    this.#cursor = 0;
    this.#uploaded = new Array(strings.length);

    for (let i = 0; i < strings.length && i < slots.offset.length; i++) {
      const bytes = this.#encoder.encode(strings[i]!);
      if (this.#cursor + bytes.length > arena.length) {
        throw new Error(
          `string arena overflow at slot ${i}: ${this.#cursor} + ${bytes.length} > ` +
            `${arena.length}. Raise ARENA_HEADROOM.`,
        );
      }
      arena.set(bytes, this.#cursor);
      slots.offset[i] = this.#cursor;
      slots.length[i] = bytes.length;
      this.#cursor += bytes.length;
      this.#uploaded[i] = strings[i]!;
    }

    // Slots past the IR's strings point at nothing.
    slots.offset.fill(0, strings.length);
    slots.length.fill(0, strings.length);
  }
}
