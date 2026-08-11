/**
 * What the engine thread and the app thread say to each other.
 *
 * Deliberately small. The *data* path is shared memory — the Worker writes the
 * engine's tables through views over its own pointers, so a style patch or a list
 * relink crosses no boundary at all. These messages are only for the things that
 * genuinely cannot be a memory write:
 *
 *   - **the descriptor**, because addresses have to be learned before they can be
 *     used, and again whenever `grow` moves them
 *   - **events**, because only the thread that owns the window can drain them
 *   - **growth**, because it takes the engine handle, and the handle is pinned to
 *     the thread that created it — SDL pins its window and event pump there
 *
 * Everything here happens a handful of times a second at most, which is why a
 * `postMessage` is affordable for all three and would not have been for the
 * tables.
 */
import type { Span } from "../engine/bind.ts";
import type { EngineEvent } from "../engine/host.ts";
import type { Capacities } from "../engine/upload.ts";

/** What the app thread needs before the engine exists. */
export type WindowRequest = {
  capacities: Capacities;
  width: number;
  height: number;
  title: string | undefined;
  root: number;
  /** For the opening log line. */
  summary: string;
};

export type ToMain =
  /** The app is loaded and the engine can be sized. Sent once. */
  | { t: "ready"; window: WindowRequest }
  /** A batch has been staged. The `DIRTY` flag says the same thing; this wakes the loop. */
  | { t: "published" }
  /** The IR outgrew the tables. The engine thread must grow and re-describe. */
  | { t: "grow"; capacities: Capacities }
  /** Headless overrides and Escape, which reach the engine through its handle. */
  | { t: "input"; hovered: number; pressed: number; focused: number }
  /**
   * `alert()` — show the platform's modal box.
   *
   * A message rather than a call, because SDL will only show one from the thread that
   * initialised video. Fire and forget: the app thread does not wait, and could not — the
   * thread that would have to answer is the one blocked by the dialog.
   */
  | { t: "alert"; message: string; title: string; level: 0 | 1 | 2 }
  /** An unhandled failure on the app thread. The window should say so, not vanish. */
  | { t: "error"; message: string };

export type ToWorker =
  /**
   * Start up, with the command line.
   *
   * Sent rather than read, because **a Bun Worker does not inherit
   * `process.argv`** — it sees its own entry, not the parent's flags. Reading it
   * over there silently lost `--route`, `--patch` and `--window`, which the golden
   * harness caught as twelve scenarios rendering the default route.
   */
  | { t: "init"; argv: string[] }
  /** Where the tables are, plus the lock. Sent once, after the engine is created. */
  | { t: "engine"; spans: Span[]; channel: SharedArrayBuffer }
  /** Where the tables are *now*. Sent after every grow. */
  | { t: "rebound"; spans: Span[] }
  | { t: "events"; events: EngineEvent[] }
  | { t: "quit" };
