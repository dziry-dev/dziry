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
import type { HotPayload } from "../hot.ts";

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
  /**
   * A state dump, in answer to `{ t: "dump_state" }` — hot reload moving the
   * app's signals and route to its replacement worker. Values are plain data
   * (structured-clone-safe); anything else was skipped at the source.
   */
  | { t: "state"; values: Record<string, unknown>; route: string | null }
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
  | { t: "error"; message: string }
  /** Open the native OS file picker for `input[type="file"]` on the given node. */
  | { t: "file_dialog"; node: number; accept?: string; multiple?: boolean };

export type ToWorker =
  /**
   * Start up, with the command line.
   *
   * Sent rather than read, because **a Bun Worker does not inherit
   * `process.argv`** — it sees its own entry, not the parent's flags. Reading it
   * over there silently lost `--route`, `--patch` and `--window`, which the golden
   * harness caught as twelve scenarios rendering the default route.
   */
  | { t: "init"; argv: string[]; restored?: { values: Record<string, unknown>; route: string | null } }
  /** Where the tables are, plus the lock. Sent once, after the engine is created. */
  | { t: "engine"; spans: Span[]; channel: SharedArrayBuffer }
  /** Where the tables are *now*. Sent after every grow. */
  | { t: "rebound"; spans: Span[] }
  | { t: "events"; events: EngineEvent[] }
  | { t: "quit" }
  /**
   * Hot reload asking for the app's state before this worker is replaced: the
   * module-level signals' current values by export name, and the current route.
   * The answer rides back as `{ t: "state" }`.
   */
  | { t: "dump_state" }
  /** Result of a file dialog opened via `{ t: "file_dialog" }`. */
  | { t: "file_dialog_result"; node: number; paths: string[] }
  /**
   * Hot reload (ROADMAP D1, stage 1): a watched recompile whose structural
   * fingerprint matched, so only style *values* moved. The worker writes them
   * into the live tables and republishes; state, focus and scroll survive.
   * Arrives via the CLI's IPC channel, forwarded by the engine thread.
   */
  | { t: "hot"; payload: HotPayload };
