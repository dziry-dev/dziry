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
  applyRangeChange,
  applyTextBindings,
  Dirty,
  subscribeBindings,
  dispatch,
  dispatchChange,
  formSubmittedByPress,
  revalidate,
  stepNumber,
  submitForm,
  submitFrom,
  typeInto,
  writeRangeValue,
} from "../runtime/bindings.ts";
import { setAlertSink, type AlertRequest } from "../runtime/alert.ts";
import { applyFieldChange } from "../runtime/forms.ts";
import { isRangeControl } from "../runtime/numerics.ts";
import { applyStylePatches, subscribeStylePatches } from "../runtime/patches.ts";
import { applyDisabled, subscribeDisabled } from "../runtime/controls.ts";
import type { Signal } from "../runtime/signal.ts";
import {
  updateLists,
  subscribeLists,
  dispatchItem,
  dispatchItemChange,
  typeIntoRow,
  applyRowValidity,
} from "../runtime/list-runtime.ts";
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
/**
 * Enter, and it is `13` here for the same reason the three around it are unmasked: it is
 * an ASCII control character, so SDL sends the character code rather than a scancode.
 *
 * The engine sees this key first and activates the focused control with it — a button, a
 * link — and forwards it regardless, which is what lets implicit submission live here.
 * That forwarding is measured behaviour rather than a convenience: a browser fires
 * `keydown` *and* the synthesised click, and does not swallow one for the other.
 */
const KEY_RETURN = 13;
const KEY_ESCAPE = 27;
const KEY_DELETE = 127;
// SDL scancodes with the keycode mask, matching `keys` in engine.rs: the engine
// forwards them to the host un-translated, and the host answers the two it owns.
const KEY_ARROW_UP = (1 << 30) | 82;
const KEY_ARROW_DOWN = (1 << 30) | 81;

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

  const { stylePatches, listBindings, editables, disabledBindings } = generated;
  const { routeNodes, initialRoute, windowConfig, windowId } = generated;

  /**
   * `alert()` reaches the engine thread from here, and nowhere else.
   *
   * The window's own title is the default, so a box with nothing said about it is still
   * labelled the way the rest of the app is — the alternative is SDL's empty title bar, which
   * looks like a bug rather than a default.
   */
  /**
   * Queued, not posted — and that queue is the whole of a fix worth explaining.
   *
   * `alert()` is called from inside app code, which for a form means inside the `batch()` that
   * `submitForm` wraps its validation in. At that instant the error cells have been *written*
   * and nothing has reacted to them: a batch defers its subscribers to the end, so no text
   * binding has been recomputed, no style patch applied, and nothing staged. Posting from here
   * therefore raced the frame it was about — and the engine thread, which is where the dialog
   * has to run, blocks the moment it arrives. The box went up over the *pre-submit* picture:
   * every complaint listed inside it, and not one of them visible behind it.
   *
   * So the request waits for the commit that the same interaction is already going to cause.
   * `flush` posts it afterwards, and the engine thread paints once more before it blocks —
   * which makes the rule "a modal shows the frame that caused it".
   */
  const pendingAlerts: AlertRequest[] = [];
  setAlertSink((request) => {
    pendingAlerts.push(request);
    schedule();
  });

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
  // Before the first upload, so a control authored `disabled={sig}` with the signal
  // already true is disabled in the first frame rather than one frame later.
  applyDisabled(ui, disabledBindings);
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
  /**
   * A control's flags changed, so the *controls* table has to go up with the next batch.
   *
   * Tracked separately because `flush` deliberately does not upload every table: styles,
   * variants, lists, nodes and strings are the ones a signal could move, and controls were
   * not among them until `disabled` could follow a signal. Uploading it unconditionally
   * would put a table write on the path of every keystroke to buy nothing.
   */
  let controlsDirty = false;
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

  subscribeDisabled(disabledBindings, () => {
    if (applyDisabled(ui, disabledBindings) === Dirty.NONE) return;
    controlsDirty = true;
    dirty = true;
    schedule();
  });

  // A bound slider's other direction: the app writes the signal (a reset button,
  // a preset), and the thumb follows. Per-signal because the set of bound sliders
  // is the small one, and the write lands in the controls table — which is why it
  // marks `controlsDirty`, the same path `disabled={signal}` takes.
  for (const e of editables) {
    if (!isRangeControl(ui, e.node)) continue;
    e.signal.subscribe(() => {
      const v = Number(e.signal.value);
      if (writeRangeValue(ui, e.node, v) === Dirty.NONE) return;
      controlsDirty = true;
      dirty = true;
      schedule();
    });
  }

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
   * What a validation may have moved, beyond the cells that publish themselves.
   *
   * A wrapper's error and message are signals, so writing them wakes the ordinary binding
   * subscription. A **row's** message is not: it lives in a plain box the list's slot refresh
   * reads, because there is one message per row and signals are per binding. So the refresh has
   * to be asked for, and this is the one place that knows both halves — `runtime/forms.ts`
   * writes the box and has no access to the list table, which is the host's.
   */
  const validated = (moved: boolean): void => {
    if (!moved) return;
    updateLists(ui, listBindings);
    // `:invalid` on a row's own input, which needs both halves of the join: the form knows
    // *which field of row 3* was rejected, and only the list knows which replica is rendering
    // row 3. Marking the controls table means the engine has to re-read it, hence
    // `controlsDirty` — the same path `disabled={signal}` takes.
    for (const form of ui.forms) applyRowValidity(ui, listBindings, form.arrays);
    // Unconditional rather than conditional on the two calls above: `applyIssues` has already
    // written `INVALID` for the ordinary fields by the time this runs, and its return value
    // says "something moved" without saying which table.
    controlsDirty = true;
    dirty = true;
  };

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

  /**
   * Posts whatever `alert()` asked for, after the tables have been published.
   *
   * Deliberately *not* inside the `dirty` guard: an alert from a handler that changed nothing
   * still has to reach the engine thread, or a plain `alert("hello")` would hang in the queue
   * until something unrelated moved.
   */
  function drainAlerts(): void {
    for (const request of pendingAlerts.splice(0)) {
      post({
        t: "alert",
        message: request.message,
        // The window's own title, so a box with nothing said about it is still labelled the way
        // the rest of the app is — SDL's empty title bar looks like a bug rather than a default.
        title: request.title || windowConfig.title,
        level: request.level,
      });
    }
  }

  function flush(): void {
    scheduled = false;
    if (!dirty || uploader === null || flags === null || growing) {
      // Nothing to commit, so there is nothing for an alert to wait behind.
      if (!growing) drainAlerts();
      return;
    }

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
      // Only when a `disabled` signal actually moved. The engine re-reads DISABLED from
      // this table on every rescan, so one upload is the whole delivery mechanism.
      if (controlsDirty) {
        uploader.uploadControls();
        controlsDirty = false;
      }
      changedNodes.length = 0;
      publish(flags);
    } finally {
      release(flags);
    }

    dirty = false;
    post({ t: "published" });
    // After the publish, so the engine has the frame the box is about before it blocks on it.
    drainAlerts();
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
              if (!dispatchItem(ui, listBindings, e.node)) {
                // A press on a submit button submits its form — the ordinary way a form is
                // submitted, and more common than Enter. `submitForm` runs the button's own
                // click handler as part of it, so this must not also `dispatch`, or a
                // button with an `onClick` would fire it twice.
                const form = formSubmittedByPress(ui, e.node);
                if (form >= 0) validated(submitForm(ui, form, e.node));
                else dispatch(ui, e.node);
              }
              break;

            case EventKind.FOCUS_IN:
              // Rows first, for the same reason a click checks them first: a handler
              // inside a template is lifted out of `ui.handlers` into the list, so the
              // plain lookup cannot find it.
              if (!dispatchItem(ui, listBindings, e.node, "focus")) dispatch(ui, e.node, "focus");
              break;

            // Emitted before the FOCUS_IN of whatever took the focus, measured, so a pair
            // of handlers that hand something between them sees them in that order here
            // too — the queue preserves it and this loop drains in order.
            case EventKind.FOCUS_OUT:
              if (!dispatchItem(ui, listBindings, e.node, "blur")) dispatch(ui, e.node, "blur");
              // `validateOn="blur"` — the trigger a browser has no equivalent of, and the one
              // that suits a field whose rule is expensive to check on every keystroke.
              validated(revalidate(ui, e.node, "blur"));
              break;

            case EventKind.CHANGE:
              // The queue the engine has been filling since v13 and nobody drained. A
              // checkbox has been flipping its own bit and telling the app nothing, which
              // is why `onChange` could not exist: the event was there, the subscriber
              // was not.
              // A row checkbox reached nothing at all before this line: its handler is
              // lifted into the list table, so `dispatchChange` looked where it was not.
              // `e.selected` is empty for every control but a list box, whose answer is a
              // set and so cannot be `e.a`. It was read on the engine thread, beside the
              // drain, because this side has no engine handle to ask with.
              // Before the handler, and unconditionally: a form's payload has to be current
              // by the time *anything* app-side runs, including an `onChange` that submits
              // the form it is in. The engine owns checkedness and the chosen option, so
              // this event is the only place Bun can learn either.
              applyFieldChange(ui, e.node, e.a, e.selected);
              // A bound slider: the drag writes its signal, the same two-way
              // street a text field has. Unbound, this is a no-op and the engine
              // remains the only owner of the thumb.
              if (applyRangeChange(ui, editables, e.node, e.a)) dirty = true;
              if (!dispatchItemChange(ui, listBindings, e.node, e.a)) {
                dispatchChange(ui, e.node, e.a, e.selected);
              }
              // After the cell is written and the handler has run, so a validator sees the
              // value the user just chose. Does nothing unless the form asked for it or a
              // submit has already failed.
              validated(revalidate(ui, e.node, "change"));
              break;

            case EventKind.TEXT_INPUT:
              // `b` is the caret, which the engine owns. Without it this could only append,
              // so clicking into the middle of a field and typing put the text at the end.
              //
              // A row's field first, and it has to be first for the same reason a row's
              // handler does: the node is in an arena, so it appears in no `editables` table
              // and the ordinary path would decline it. `typeIntoRow` returns false for
              // anything that is not one of its rows, so the fall-through is exact.
              if (typeIntoRow(ui, listBindings, e.node, { text: e.text, caret: e.b, anchor: e.c })) {
                dirty = true;
                validated(revalidate(ui, e.node, "change"));
              } else if (typeInto(editables, e.node, { text: e.text, caret: e.b, anchor: e.c })) {
                dirty = true;
                // A keystroke *is* a change for a text field — the engine sends `CHANGE` for
                // controls whose state it owns, and a field's value is Bun's. So the trigger
                // has to be fired from here as well or `validateOn="change"` would work for a
                // checkbox and not for the field it is next to.
                validated(revalidate(ui, e.node, "change"));
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
                const key = { text: null, erase, caret: e.b, anchor: e.c } as const;
                if (typeIntoRow(ui, listBindings, e.node, key)) {
                  dirty = true;
                  validated(revalidate(ui, e.node, "change"));
                } else if (typeInto(editables, e.node, key)) {
                  dirty = true;
                  // Erasing is a change too, and it is the one that matters most for a
                  // `required` rule: clearing a field is exactly when its error should
                  // come back.
                  validated(revalidate(ui, e.node, "change"));
                }
              } else if (e.a === KEY_RETURN) {
                // Implicit submission. The engine has already activated the focused node
                // if its kind takes Enter — a button, a link — and forwarded the key
                // anyway, so both can happen from one press, which is what a browser does.
                //
                // Nothing is checked here about *whether* Enter should submit: the
                // compiler resolved the button, the disabled test and the field count, and
                // `submitFrom` is left with the two questions that depend on where focus
                // is. See BROWSER-FACTS, "Implicit submission".
                validated(submitFrom(ui, e.node));
              } else if (e.a === KEY_ARROW_UP || e.a === KEY_ARROW_DOWN) {
                // A number field's stepping. The engine forwards the two keys —
                // they are not caret moves on a single-line field — and the
                // answer is arithmetic on a signal, which is Bun's half of the
                // numeric bridge. A slider never reaches this: its arrows are
                // the engine's, consumed in `group_key`.
                const dir = e.a === KEY_ARROW_UP ? 1 : -1;
                if (stepNumber(ui, editables, e.node, dir)) {
                  dirty = true;
                  validated(revalidate(ui, e.node, "change"));
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
