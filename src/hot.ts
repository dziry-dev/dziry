/**
 * Hot reload's wire format — the piece of a recompile that may cross into a
 * running window.
 *
 * The ruling (ROADMAP D1, stage 1): a stylesheet change that alters style
 * *values* but not the tree swaps tables and repaints; state, focus and scroll
 * survive. Anything else restarts the app. The compiler decides which by hashing
 * the artifact with the style values blanked (`emit`'s `structural` text): equal
 * fingerprints mean the interned table's rows, slots and wiring are identical and
 * only the numbers below differ.
 *
 * Typed arrays rather than number[] because they cross two structured clones
 * (CLI → host process over IPC, host → worker over postMessage) and neither
 * serialises them down to objects. The counts travel separately so a renumber
 * the blanking would hide still moves the fingerprint comparison.
 */
import type { StyleField } from "./ir.ts";

export type HotPayload = {
  counts: { styles: number; media: number; tweens: number; keyframes: number };
  /** One column per style field, in the interned table's row order. */
  styles: Record<StyleField, ArrayLike<number>>;
  media: { bit: Uint32Array; kind: Uint8Array; value: Float32Array };
  tweens: {
    mask: Uint32Array;
    duration: Float32Array;
    delay: Float32Array;
    iterations: Float32Array;
    firstSegment: Int32Array;
    segmentCount: Uint16Array;
    easing: Uint8Array;
    easeA: Float32Array;
    easeB: Float32Array;
    easeC: Float32Array;
    easeD: Float32Array;
  };
  keyframes: {
    style: Uint16Array;
    offset: Float32Array;
    easing: Uint8Array;
    easeA: Float32Array;
    easeB: Float32Array;
    easeC: Float32Array;
    easeD: Float32Array;
  };
  /**
   * The conditional classes' new on/off values, aligned with `stylePatches` by
   * index — the fingerprint guarantees the wiring (class, fields, slots) is
   * unchanged, so position is identity.
   */
  patches: { on: Float64Array[]; off: Float64Array[] }[];
};

/** One window's entry in the manifest a watched compile writes. */
export type HotManifestEntry = {
  fingerprint: string;
  payload: HotPayload;
};

/**
 * What `compileProject` writes when hot reload is watching: per window, the
 * fingerprint to compare and the payload to send on a match. A file rather than
 * a return value because a watched compile runs in a subprocess — Bun's module
 * cache makes an in-process recompile read the modules it read last time.
 */
export type HotManifest = Record<string, HotManifestEntry>;
