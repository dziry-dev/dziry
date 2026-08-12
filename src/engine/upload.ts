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
import { F, NodeFlags, NUMBER_FIELDS, type SharedTables } from "../protocol/generated.ts";
import type { Engine } from "./host.ts";

/**
 * Style fields the compiler emits, paired with where they land in the schema.
 *
 * Generated from `protocol/schema.ts`, where each row names its IR spelling. This
 * was 73 pairs written by hand, and schema.test.ts existed to assert they matched
 * `ir.ts`'s own list — its header said `nothing but this file makes them agree`.
 * Now one list generates both and that test is gone.
 *
 * Names differ (`padT` vs `padTop`) because the schema spells CSS out; the
 * *encodings* were chosen to match, so `direction`, `justify` and `align` need no
 * translation beyond the rename. That was not luck — the schema's enums were
 * written from the IR's.
 */
export { NUMBER_FIELDS };

/**
 * The `node` a spare controls row claims: none, and larger than any real one.
 *
 * `i32::MAX`. See {@link Uploader.uploadControls} for why it is not `-1`.
 */
export const NO_CONTROL_NODE = 0x7fffffff;

/** How much room to leave beyond what the IR needs right now. */
const NODE_HEADROOM = 1.5;
const STRING_HEADROOM = 2;
const ARENA_HEADROOM = 4;

export type Capacities = {
  nodes: number;
  styles: number;
  variants: number;
  variantSlots: number;
  media: number;
  lists: number;
  tweens: number;
  keyframes: number;
  controls: number;
  images: number;
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
    // Fixed by the compiler like the style table: a media condition is a build-time
    // constant, and nothing at run time can mint another one.
    media: Math.max(ui.media.count, 1),
    lists: Math.max(ui.lists.count, 1),
    // Fixed by the compiler for the same reason the style table is: a tween is an
    // interned build-time constant, and nothing at run time can mint another one.
    // The engine's per-node `t` is not a row.
    tweens: Math.max(ui.tweens.count, 1),
    keyframes: Math.max(ui.keyframes.count, 1),
    // Fixed too: which nodes are controls is markup, and no run-time state can add
    // one. The *checkedness* is what varies, and that is not a row.
    controls: Math.max(ui.controls.count, 1),
    // Fixed like the controls: which nodes are images is markup, and the decode
    // cache survives republishing, so nothing at run time needs a spare row.
    images: Math.max(ui.images.count, 1),
    strings: Math.ceil(ui.strings.length * STRING_HEADROOM) + 16,
    stringBytes: arenaBytes(bytes),
  };
}

/**
 * What the uploader needs from whatever owns the shared tables.
 *
 * Narrower than `Engine` on purpose, and the reason is threading. When app code
 * runs in a Worker, the *tables* are reachable there — they are engine memory
 * wrapped by `toArrayBuffer`, and a pointer is a pointer on any thread — but the
 * engine *handle* is not: the registry pins it to the thread that created it,
 * because SDL pins its window and event pump there. So the Worker has views and
 * no handle, and this is the half of `Engine` that survives the crossing.
 *
 * Growing is deliberately absent. It takes the handle, so off the main thread it
 * is a request rather than a call — see {@link Uploader.needsGrowth}.
 */
export type TableHost = {
  readonly tables: SharedTables;
  readonly stringBytes: Uint8Array;
  /** What the tables can currently hold. */
  capacities(): Capacities;
};

export class Uploader {
  #host: TableHost;
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

  constructor(host: TableHost, ui: CompiledUi) {
    this.#host = host;
    this.#ui = ui;
    this.#tables = host.tables;
  }

  /**
   * The capacities the tables would need to hold the IR, or null if they fit.
   *
   * A question rather than an action, because the answer is acted on differently
   * depending on which thread is asking. On the engine's own thread the caller
   * grows and re-uploads in the same breath; in a Worker it has to ask the main
   * thread and wait for the tables to be rebuilt, so a synchronous
   * `ensureCapacity(): boolean` could not have been honest there.
   */
  needsGrowth(): Capacities | null {
    const want = capacitiesFor(this.#ui);
    const have = this.#host.capacities();

    for (const key of Object.keys(want) as Array<keyof Capacities>) {
      if (want[key] > have[key]) return want;
    }
    return null;
  }

  /**
   * Re-reads the host's views after the tables were reallocated.
   *
   * Everything cached against the old memory is dropped: the views themselves,
   * what each string slot last held, and the arena cursor. The caller must follow
   * with {@link uploadAll} — nothing survived.
   */
  rebind(): void {
    this.#tables = this.#host.tables;
    this.#uploaded = [];
    this.#cursor = 0;
  }

  /** Everything. Used on the first frame and after the tables are reallocated. */
  uploadAll(): void {
    this.uploadStyles();
    this.uploadVariants();
    this.uploadMedia();
    this.uploadTweens();
    this.uploadControls();
    this.uploadImages();
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
    const { nodes, interactive, generated, editableBoxes, placeholders, overlays, tabStops } =
      this.#ui;
    const { autofocus } = this.#ui;
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
    t.activates.set(nodes.activates.subarray(0, count));

    // Nodes past the IR's count are spare capacity: unreachable from the root,
    // but they must not claim to be anyone's child.
    t.firstChild.fill(-1, count);
    t.nextSibling.fill(-1, count);
    t.parent.fill(-1, count);
    t.text.fill(-1, count);
    t.flags.fill(0, count);
    // A spare row that pointed at node 0 would make an unreachable node's press
    // operate a real control, which is why this is a `-1` fill and not left at zero.
    t.activates.fill(-1, count);

    // Flags the old runtime kept in two side tables. `interactive` is emitted by
    // the compiler rather than inferred — inferring it from `hover >= 0` silently
    // excluded clickable list rows with no `:hover` rule.
    for (let i = 0; i < count; i++) {
      let flags = 0;
      if (findRow(interactive, i) >= 0) flags |= NodeFlags.INTERACTIVE;
      if (findRow(generated, i) >= 0) flags |= NodeFlags.GENERATED;
      if (findRow(editableBoxes, i) >= 0) flags |= NodeFlags.EDITABLE;
      if (findRow(placeholders, i) >= 0) flags |= NodeFlags.PLACEHOLDER;
      if (findRow(overlays, i) >= 0) flags |= NodeFlags.OVERLAY;
      if (findRow(tabStops, i) >= 0) flags |= NodeFlags.TAB_STOP;
      // A claim, and possibly one of several — the engine picks the first that is showing.
      // Set on every upload, not only the first: the engine latches the *event*, because
      // that is where "has this document started yet" is known. The uploader runs again on
      // every signal change and cannot tell a fresh document from a counter ticking.
      if (findRow(autofocus, i) >= 0) flags |= NodeFlags.AUTOFOCUS;
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

    // Spare rows must not answer a binary search — and must not break it either.
    //
    // This filled with `-1`, which is wrong in a way that is currently invisible:
    // the column is searched with `binary_search`, so it has to stay sorted
    // ascending, and `[3, 7, -1, -1]` is not. A search for 7 then walks into the
    // `-1` half and reports "absent", so a node that really is conditional
    // silently wears its base style. It has never bitten because `capacitiesFor`
    // asks for exactly `variants.count` rows, so there are no spare ones — but
    // `grow` can raise the capacity without the count following, and then it
    // would. `i32::MAX` sorts last and matches no node.
    t.node.fill(0x7fffffff, count);

    const slots = this.#tables.variantSlots.style;
    slots.set(variants.slots.subarray(0, Math.min(variants.slots.length, slots.length)));
  }

  /**
   * Media thresholds. Uploaded once — they are compile-time constants.
   *
   * Spare rows get bit 0, which no media condition ever owns (bits 0-2 are input
   * state), so a row the compiler did not write can never switch a predicate on.
   */
  uploadMedia(): void {
    const { media } = this.#ui;
    const t = this.#tables.media;
    const count = Math.min(media.count, t.bit.length);
    t.bit.set(media.bit.subarray(0, count));
    t.kind.set(media.kind.subarray(0, count));
    t.value.set(media.value.subarray(0, count));
    t.bit.fill(0, count);
  }

  /**
   * Tween and keyframe rows. Uploaded once — they are compile-time constants.
   *
   * Spare tween rows get `duration = 0`, which is not a filler value but the CSS
   * one: a transition with a zero duration animates nothing. So a row the compiler
   * never wrote can only ever produce an instant jump, which is what a node
   * pointing at it by accident should look like. Spare keyframe rows get
   * `offset = 0` for the same reason — a zero-length segment is skipped rather
   * than divided by.
   *
   * Both together, because a tween's `firstSegment` addresses the other table and
   * uploading one without the other leaves a span pointing into rows that describe
   * a previous build.
   */
  uploadTweens(): void {
    const { tweens, keyframes } = this.#ui;

    const t = this.#tables.tweens;
    const n = Math.min(tweens.count, t.mask.length);
    t.mask.set(tweens.mask.subarray(0, n));
    t.duration.set(tweens.duration.subarray(0, n));
    t.delay.set(tweens.delay.subarray(0, n));
    t.iterations.set(tweens.iterations.subarray(0, n));
    t.firstSegment.set(tweens.firstSegment.subarray(0, n));
    t.segmentCount.set(tweens.segmentCount.subarray(0, n));
    t.easing.set(tweens.easing.subarray(0, n));
    t.easeA.set(tweens.easeA.subarray(0, n));
    t.easeB.set(tweens.easeB.subarray(0, n));
    t.easeC.set(tweens.easeC.subarray(0, n));
    t.easeD.set(tweens.easeD.subarray(0, n));
    t.duration.fill(0, n);
    t.firstSegment.fill(-1, n);
    t.segmentCount.fill(0, n);

    const k = this.#tables.keyframes;
    const m = Math.min(keyframes.count, k.style.length);
    k.style.set(keyframes.style.subarray(0, m));
    k.offset.set(keyframes.offset.subarray(0, m));
    k.easing.set(keyframes.easing.subarray(0, m));
    k.easeA.set(keyframes.easeA.subarray(0, m));
    k.easeB.set(keyframes.easeB.subarray(0, m));
    k.easeC.set(keyframes.easeC.subarray(0, m));
    k.easeD.set(keyframes.easeD.subarray(0, m));
    k.offset.fill(0, m);
  }

  /**
   * The controls table.
   *
   * Spare rows are padded with {@link NO_CONTROL_NODE} rather than with `-1`, and
   * that choice is load-bearing rather than cosmetic. The engine binary-searches this
   * table by node, so the `node` column has to stay **sorted** — and padding at the
   * *end* of a table can only stay sorted with a sentinel that is larger than every
   * real node, not smaller. Left at zero, a spare row would claim node 0 is a
   * checkbox and sort ahead of every real row; filled with `-1` it would sort ahead
   * too, and the search for a real control would miss.
   */
  uploadControls(): void {
    const { controls } = this.#ui;
    const t = this.#tables.controls;
    const n = Math.min(controls.count, t.node.length);

    t.node.set(controls.node.subarray(0, n));
    t.kind.set(controls.kind.subarray(0, n));
    t.group.set(controls.group.subarray(0, n));
    t.flags.set(controls.flags.subarray(0, n));
    t.label.set(controls.label.subarray(0, n));
    t.rows.set(controls.rows.subarray(0, n));

    t.node.fill(NO_CONTROL_NODE, n);
    t.kind.fill(0, n);
    // Not a group anything can be in, so a spare row is never cleared as a
    // group-mate — `-1` is already "no group" for a nameless radio.
    t.group.fill(-1, n);
    t.flags.fill(0, n);
    // A spare row that named node 0 as its label would let a commit repoint a real
    // node's string, so this is a `-1` fill for the reason `activates` is.
    t.label.fill(-1, n);
    // 0 is "not a list box", which is what every non-LISTBOX row carries anyway — so
    // unlike the two above, this fill needs no sentinel of its own.
    t.rows.fill(0, n);
  }

  /**
   * The images table.
   *
   * Same shape and same sentinel as {@link uploadControls}: binary-searched by
   * node, so spare rows pad with `NO_CONTROL_NODE` — "larger than every real
   * node" — and a `-1` src, which points at no string. Images are also
   * *uploaded wholesale on republish*: the table is small, and the engine's
   * decode cache being keyed by `src` is what makes re-uploading it cheap — the
   * rows are rewritten, the bitmaps stay.
   */
  uploadImages(): void {
    const { images } = this.#ui;
    const t = this.#tables.images;
    const n = Math.min(images.count, t.node.length);

    t.node.set(images.node.subarray(0, n));
    t.src.set(images.src.subarray(0, n));

    t.node.fill(NO_CONTROL_NODE, n);
    t.src.fill(-1, n);
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
    const arena = this.#host.stringBytes;

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
    const arena = this.#host.stringBytes;

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
