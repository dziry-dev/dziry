/**
 * The app thread: signals, handlers, bindings, and the writes they produce.
 *
 * Everything in a run except the engine. This
 * side never holds the engine handle — the registry pins it to the thread that
 * created it, because SDL pins its window and event pump there — so it cannot
 * tick, cannot drain events and cannot grow. What it *can* do is write the
 * tables, which is the part that matters: they are engine memory wrapped by
 * `toArrayBuffer` over addresses the engine thread sent across, so a style patch
 * and a list relink cost exactly what they cost before.
 *
 * # What this buys
 *
 * A handler that takes 400 ms no longer freezes the window. The engine thread is
 * in its own loop pumping SDL and repainting; this thread is busy; they meet only
 * at the lock. Before, a slow handler meant no `tick()`, which meant no
 * `SDL_PumpEvents`, which meant the OS marked the window unresponsive — the grey
 * overlay on Windows, the spinning beachball on macOS.
 *
 * # The rule this thread must obey
 *
 * **Every write to the tables happens between `acquire` and `release`.** Not for
 * mutual exclusion of two writers — there is only one — but because the engine
 * thread's commit copies staged over live, and a copy taken mid-batch can capture
 * a list splice halfway through and describe a chain that loops. See
 * `channel.ts`.
 */
import { routeChain } from "../ir.ts";
import { bindSpans, type Bound, type Span } from "../engine/bind.ts";
import { Uploader, type TableHost } from "../engine/upload.ts";
import { EventKind } from "../protocol/generated.ts";
import { acquire, publish, release } from "./channel.ts";
import type { ToMain, ToWorker } from "./messages.ts";
import {
  applyTextBindings,
  subscribeBindings,
  dispatch,
  dispatchChange,
  typeInto,
} from "../runtime/bindings.ts";
import { applyStylePatches, subscribeStylePatches } from "../runtime/patches.ts";
import type { Signal } from "../runtime/signal.ts";
import { updateLists, subscribeLists, dispatchItem } from "../runtime/list-runtime.ts";
import { capacitiesFor } from "../engine/upload.ts";
import { pickWindow, type WindowRegistry } from "./registry.ts";
import { buildUi, indexOfRoute, requireRoute, showRoute } from "./window-state.ts";

/**
 * SDL keycodes. A handful of constants is cheaper than binding the whole keysym table.
 *
 * All three are unmasked because all three are ASCII control characters — SDL only sets
 * `1 << 30` on keys that have no character. Delete is the one worth naming: it *looks* like
 * it should be a masked scancode next to the arrows, and it is not.
 * `caret.rs::the_caret_keycodes_are_the_ones_sdl_sends` checks these numbers against
 * `sdl3::keyboard::Keycode` rather than against a recollection.
 */
const KEY_BACKSPACE = 8;
const KEY_ESCAPE = 27;
const KEY_DELETE = 127;

/**
 * The worker global, typed to this channel rather than to the DOM.
 *
 * `globalThis` rather than pulling in the `webworker` lib: that lib redefines a
 * long list of names this project already has from `@types/bun`, and all that is
 * wanted here is two members with the *right* message types on them — which the
 * DOM's `any`-shaped `postMessage` would not have given anyway.
 */
const scope = globalThis as unknown as {
  postMessage(message: ToMain): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

/**
 * `--block <ms>` — wedge the app thread, deliberately.
 *
 * The feature this whole file exists for is not directly observable: "the window
 * did not freeze" leaves no trace. So it is made observable — this blocks the app
 * thread for real, the way a slow handler or a large computation would, and the
 * engine thread's frame counter says what happened during it. Paired with
 * `--run-ms`, that counter is the measurement which justifies the split: 190
 * frames rendered over 3 s with the app thread wedged for 2 s of it, against 62
 * on the single-threaded path this replaced. That baseline is recorded in
 * `ROADMAP.md` rather than reproducible: the single-threaded path has been deleted,
 * because keeping it meant maintaining a second implementation of everything in
 * this file by hand.
 *
 * A blocking `Atomics.wait` rather than a spin loop: a spin would also occupy a
 * core, and the claim being tested is about the *thread* being unavailable, not
 * about CPU contention.
 */
function blockForTesting(argv: readonly string[]): void {
  const i = argv.indexOf("--block");
  const ms = i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : 0;
  if (!Number.isFinite(ms) || ms <= 0) return;

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The tables, as the app thread sees them.
 *
 * A `TableHost` with no handle behind it. `capacities()` comes from the
 * descriptor rather than from the engine, which is the whole reason `Uploader`
 * asks {@link Uploader.needsGrowth} instead of growing: this object physically
 * cannot.
 */
class WorkerTables implements TableHost {
  #bound: Bound;

  constructor(spans: readonly Span[]) {
    this.#bound = bindSpans(spans);
  }

  rebind(spans: readonly Span[]): void {
    this.#bound = bindSpans(spans);
  }

  get tables() {
    return this.#bound.tables;
  }
  get stringBytes() {
    return this.#bound.stringBytes;
  }
  capacities() {
    return this.#bound.capacities;
  }
}

/**
 * Waits for the engine thread to say go, then becomes the application.
 *
 * The wait exists for one reason: the command line. A Worker does not inherit
 * `process.argv`, so `--route`, `--patch` and `--window` have to arrive as a
 * message — which means the setup that depends on them cannot run at import time.
 */
export function runWorker(registry: WindowRegistry): void {
  let next: ((message: ToWorker) => void) | null = null;

  scope.onmessage = (event) => {
    const message = event.data;
    if (message.t === "init") {
      next = start(registry, message.argv);
      return;
    }
    next?.(message);
  };
}

function start(
  registry: WindowRegistry,
  argv: readonly string[],
): (message: ToWorker) => void {
  const post = (message: ToMain) => scope.postMessage(message);

  const generated = pickWindow(registry, argv);
  const ui = buildUi(generated);

  const { stylePatches, listBindings, editables } = generated;
  const { routeNodes, initialRoute, windowConfig, windowId } = generated;

  /** `--route routing`, for starting somewhere other than the initial route. */
  const requested = (() => {
    const i = argv.indexOf("--route");
    const wanted = i !== -1 ? argv[i + 1] : null;
    return wanted ? requireRoute(routeNodes, wanted, windowId) : initialRoute;
  })();

  let active = requested;

  const routeSignal = generated.routeSignal;
  if (routeSignal) (routeSignal as Signal<string>).value = routeNodes[active]!.path;

  /**
   * `--patch light,compact` flips conditional classes on without a mouse.
   *
   * Applied here rather than on the engine thread because it writes *signals*,
   * and signals only exist on this side.
   */
  {
    const i = argv.indexOf("--patch");
    if (i !== -1 && argv[i + 1]) {
      const names = stylePatches.map((p) => p.className);
      for (const wanted of argv[i + 1]!.split(",")) {
        const patch = stylePatches.find((p) => p.className === wanted);
        if (!patch) {
          throw new Error(`no conditional class "${wanted}". Classes are ${names.join(", ")}.`);
        }
        if (!("value" in patch.signal) || Object.isFrozen(patch.signal)) {
          throw new Error(`"${wanted}" is derived and cannot be set directly.`);
        }
        (patch.signal as Signal<boolean>).value = true;
      }
    }
  }

  // Before the engine exists, so it is sized for the tree that actually exists
  // rather than the one the compiler emitted — a list arena can already have
  // grown the node arrays by now.
  const changedNodes: number[] = [];
  applyTextBindings(ui, changedNodes);
  updateLists(ui, listBindings);
  applyStylePatches(ui, stylePatches);
  showRoute(ui, routeNodes, active);

  post({
    t: "ready",
    window: {
      capacities: capacitiesFor(ui),
      width: windowConfig.width ?? 1040,
      height: windowConfig.height ?? 560,
      title: windowConfig.title,
      root: ui.root,
      summary:
        `${windowId} at "${routeNodes[active]!.path}" — ${ui.nodes.count} nodes, ` +
        `${generated.styles.count} styles, ` +
        `${routeNodes.length - routeChain(routeNodes, active).size} of ` +
        `${routeNodes.length} routes hidden`,
    },
  });

  // --- everything below waits for the engine thread to answer --------------------

  let host: WorkerTables | null = null;
  let uploader: Uploader | null = null;
  let flags: Int32Array | null = null;
  let dirty = true;
  /** Set while the engine thread is growing the tables; nothing may be written. */
  let growing = false;

  subscribeBindings(ui, () => {
    applyTextBindings(ui, changedNodes);
    dirty = true;
    schedule();
  });

  subscribeLists(listBindings, () => {
    updateLists(ui, listBindings);
    dirty = true;
    schedule();
  });

  subscribeStylePatches(stylePatches, () => {
    applyStylePatches(ui, stylePatches);
    dirty = true;
    schedule();
  });

  if (routeSignal) {
    routeSignal.subscribe(() => {
      const next = indexOfRoute(routeNodes, routeSignal.value);
      if (next === -1 || next === active) return;
      active = next;
      showRoute(ui, routeNodes, active);
      dirty = true;
      schedule();
    });
  }

  /**
   * Stages the IR's current state, under the lock.
   *
   * Coalescing is deliberate: a click that writes four signals fires four
   * subscriptions, and each one only marks the state dirty and asks for a flush.
   * The flush happens once, on the microtask queue, so one interaction is one
   * batch and therefore one lock acquisition.
   */
  let scheduled = false;
  function schedule(): void {
    if (scheduled || uploader === null || growing) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  function flush(): void {
    scheduled = false;
    if (!dirty || uploader === null || flags === null || growing) return;

    // Asked before the lock, because the answer cannot be acted on here at all:
    // growing takes the engine handle. The batch is abandoned and replayed once
    // the engine thread has rebuilt the tables and sent new addresses.
    const want = uploader.needsGrowth();
    if (want !== null) {
      growing = true;
      post({ t: "grow", capacities: want });
      return;
    }

    acquire(flags);
    try {
      uploader.uploadStyles();
      uploader.uploadVariants();
      uploader.uploadLists();
      uploader.uploadNodes();
      uploader.uploadStrings();
      changedNodes.length = 0;
      publish(flags);
    } finally {
      release(flags);
    }

    dirty = false;
    post({ t: "published" });
  }

  /** A full re-upload under the lock, for the first frame and after every grow. */
  function uploadAll(): void {
    if (uploader === null || flags === null) return;
    acquire(flags);
    try {
      uploader.uploadAll();
      publish(flags);
    } finally {
      release(flags);
    }
    dirty = false;
    post({ t: "published" });
  }

  return (message: ToWorker) => {
    switch (message.t) {
      case "init":
        // Already started. A second `init` would mean the engine thread lost track
        // of which Worker it was talking to.
        break;

      case "engine": {
        flags = new Int32Array(message.channel);
        host = new WorkerTables(message.spans);
        uploader = new Uploader(host, ui);
        uploadAll();
        blockForTesting(argv);
        break;
      }

      case "rebound": {
        host!.rebind(message.spans);
        uploader!.rebind();
        growing = false;
        uploadAll();
        break;
      }

      case "events": {
        for (const e of message.events) {
          switch (e.kind) {
            case EventKind.CLICK:
              // A row's handler is found by decomposing the node into (slot,
              // offset); a plain handler is looked up by node. Both batch, so one
              // click costs one repaint however many signals it writes.
              if (!dispatchItem(ui, listBindings, e.node)) dispatch(ui, e.node);
              break;

            case EventKind.FOCUS_IN:
              dispatch(ui, e.node, "focus");
              break;

            // Emitted before the FOCUS_IN of whatever took the focus, measured, so a pair
            // of handlers that hand something between them sees them in that order here
            // too — the queue preserves it and this loop drains in order.
            case EventKind.FOCUS_OUT:
              dispatch(ui, e.node, "blur");
              break;

            case EventKind.CHANGE:
              // The queue the engine has been filling since v13 and nobody drained. A
              // checkbox has been flipping its own bit and telling the app nothing, which
              // is why `onChange` could not exist: the event was there, the subscriber
              // was not.
              dispatchChange(ui, e.node, e.a);
              break;

            case EventKind.TEXT_INPUT:
              // `b` is the caret, which the engine owns. Without it this could only append,
              // so clicking into the middle of a field and typing put the text at the end.
              if (typeInto(editables, e.node, { text: e.text, caret: e.b, anchor: e.c })) {
                dirty = true;
              }
              break;

            case EventKind.KEY_DOWN:
              if (e.a === KEY_BACKSPACE || e.a === KEY_DELETE) {
                // The arrows never arrive here: the engine consumes them, so a caret move
                // costs a repaint of one rect and no round trip. The two erasing keys do
                // arrive, because they edit the *value* and only Bun owns that.
                //
                // They differ only in direction, and only Backspace moves the caret — the
                // engine has already shifted it by the time this runs, and deliberately
                // does not for Delete.
                const erase = e.a === KEY_BACKSPACE ? "backward" : "forward";
                if (typeInto(editables, e.node, { text: null, erase, caret: e.b, anchor: e.c })) {
                  dirty = true;
                }
              } else if (e.a === KEY_ESCAPE) {
                post({ t: "input", hovered: -1, pressed: -1, focused: -1 });
              }
              break;
          }
        }
        schedule();
        break;
      }

      case "quit":
        process.exit(0);
    }
  };
}
