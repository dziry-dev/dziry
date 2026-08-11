/**
 * The engine thread: the window, the frame loop, and nothing else.
 *
 * No signals, no handlers, no artifact — this module never imports the app. It
 * owns the engine handle, which the registry pins to whichever thread called
 * `create` because SDL pins its window and event pump there, and it spends its
 * life doing the one thing that must not be delayed: servicing the OS.
 *
 * # The loop, and the one decision in it
 *
 *     if (tryAcquire())  tick()   // commit what the app staged, lay out, paint
 *     else               pump()   // input, resize, scroll, repaint — no commit
 *
 * That `else` is the whole feature. Before this split there was one thread, so a
 * handler that ran for 400 ms was 400 ms in which `tick()` was not called, which
 * is 400 ms without `SDL_PumpEvents` — and both Windows and macOS notice: the
 * window stops redrawing, stops resizing, and the OS paints it as hung. Now the
 * app thread being busy costs the *content* freshness and nothing else. The
 * window still drags, still resizes, still scrolls.
 *
 * # What is deliberately not here
 *
 * The event watcher (`window.rs`) still exists and still matters. It covers the
 * case no threading model can: while the user drags a window edge, the OS runs a
 * nested modal loop *inside* the pump, so this loop does not get another turn
 * until the drag ends. Being called by SDL from inside that loop is the only way
 * to draw during it. The two are complementary — the watcher handles "the OS took
 * the thread", this handles "the app took the thread".
 */
import { Engine } from "../engine/host.ts";
import { EventKind } from "../protocol/generated.ts";
import { alive, createChannel, DIRTY, stop, takeDirty, tryAcquire, release } from "./channel.ts";
import type { ToMain, ToWorker, WindowRequest } from "./messages.ts";
import { applyMinSize, sizeFrom } from "./registry.ts";

export type MainOptions = {
  /** The app thread's entry. A URL in dev; an extracted path in a packaged build. */
  worker: string;
  /**
   * Modules the app thread loads before its own.
   *
   * This is how the reactive rewrite reaches the Worker, and it has to be said
   * explicitly: **a Bun Worker does not inherit the parent's loader plugins.** A
   * `bunfig.toml` preload and a `--preload` flag both register with the process
   * that read them, so the Worker imported `state.ts` unrewritten and died on
   * `todos.filter is not a function` — `filter` being a method on a signal object,
   * which does not exist.
   *
   * Ignored in a packaged build. There the rewrite already happened, at bundle
   * time, and the specifier would not resolve inside the executable anyway.
   */
  preload?: readonly string[];
  argv?: readonly string[];
};

/** How long a frame waits when nothing is happening. */
const IDLE_MS = 8;

/** Where the app thread's bundle is, when a packaged build already knows. */
let workerOverride: string | null = null;

/**
 * Names the app thread's bundle, ahead of what the generated entry computed.
 *
 * A standalone build cannot use `new URL("./worker.gen.ts", import.meta.url)`:
 * that resolves inside Bun's virtual filesystem, where the TypeScript source is
 * not present and would not be transpiled if it were — measured, the runtime
 * loads an embedded `.ts` verbatim and dies on the first `const`. So `dziri build`
 * bundles the app thread to JavaScript, embeds *that*, and calls this with the
 * path before the entry runs.
 */
export function useWorkerBundle(path: string): void {
  workerOverride = path;
}

/**
 * Whether this process is a `bun build --compile` executable.
 *
 * The marker is Bun's own virtual filesystem: in a standalone build every module,
 * `Bun.main` included, lives under `B:/~BUN/root/` (Windows) or `/$bunfs/root/`.
 * Nothing in an ordinary run has a path shaped like that.
 */
function standalone(): boolean {
  const main = Bun.main.replaceAll("\\", "/");
  return main.includes("/~BUN/") || main.startsWith("/$bunfs/");
}

export async function runMain(options: MainOptions): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);

  const showStats = argv.includes("--stats");
  const shotIndex = argv.indexOf("--screenshot");
  const screenshotPath = shotIndex !== -1 ? (argv[shotIndex + 1] ?? null) : null;

  const numberFlag = (name: string): number => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : -1;
  };

  const preload = standalone() ? undefined : options.preload;
  const worker = new Worker(workerOverride ?? options.worker, { preload } as WorkerOptions);
  const send = (message: ToWorker) => worker.postMessage(message);

  /**
   * The app thread reports what the window needs before the engine exists.
   *
   * This order is why the engine thread never imports the artifact: capacities,
   * size and title all come out of the compiled IR, and the IR is loaded over
   * there. One round trip at startup buys a main thread whose module graph is the
   * engine and this file.
   */
  const request = await new Promise<WindowRequest>((resolve, reject) => {
    const onMessage = (event: MessageEvent<ToMain>) => {
      if (event.data.t === "ready") {
        worker.removeEventListener("message", onMessage as EventListener);
        resolve(event.data.window);
      } else if (event.data.t === "error") {
        reject(new Error(event.data.message));
      }
    };
    worker.addEventListener("message", onMessage as EventListener);
    worker.addEventListener("error", (e) => reject(asError(e)));

    /* The command line, because a Worker does not inherit `process.argv`. The
       app thread's whole startup depends on it — which route, which window,
       which conditional classes — so nothing over there runs until this lands. */
    send({ t: "init", argv: [...argv] });
  });

  applyMinSize(argv);
  const [width, height] = sizeFrom(argv, { width: request.width, height: request.height });

  const engine = Engine.open({
    ...request.capacities,
    width,
    height,
    title: request.title,
    root: request.root,
    windowed: screenshotPath === null,
  });

  const channel = createChannel();
  const flags = new Int32Array(channel);

  /** Resolves the first time the app thread has staged something. */
  let onFirstPublish: (() => void) | null = null;
  const published = new Promise<void>((resolve) => {
    onFirstPublish = resolve;
  });

  let failure: Error | null = null;
  let running = true;

  worker.addEventListener("message", (event: MessageEvent<ToMain>) => {
    const message = event.data;

    switch (message.t) {
      case "published":
        onFirstPublish?.();
        onFirstPublish = null;
        break;

      case "grow":
        /* The one thing the app thread cannot do for itself. It has abandoned its
           batch and is waiting; growing reallocates every table, so the reply
           carries the new addresses and the far side re-uploads everything. */
        engine.grow(message.capacities);
        send({ t: "rebound", spans: engine.describe() });
        break;

      case "input":
        engine.setInputState(message.hovered, message.pressed, message.focused);
        break;

      /* The dialog runs *here*, on the thread that initialised video, because SDL will not
         show one anywhere else. It blocks this loop until the user dismisses it, so the
         window stops repainting — which is what a modal is, and what a browser's `alert()`
         does to a page. The app thread carried on the moment it posted. */
      case "alert":
        engine.alert(message.message, message.title, message.level);
        break;

      case "error":
        failure = new Error(message.message);
        running = false;
        break;

      case "ready":
        break;
    }
  });

  worker.addEventListener("error", (event) => {
    failure = asError(event);
    running = false;
  });

  send({ t: "engine", spans: engine.describe(), channel });

  await published;

  // --- headless ------------------------------------------------------------------
  if (screenshotPath) {
    /**
     * `--advance 0.15` renders a frame that far into whatever is animating.
     *
     * Two frames, and the split is the mechanism. The first runs with the page's
     * resting input state and a frame length of **zero**, which lets the engine record
     * every node's resting style row without moving anything. Then `--hover` is applied
     * and one frame of exactly the given length runs: the retarget inside
     * `advance_animations` starts the tween and the same call advances it, so the
     * picture is the animation at an exact `t`.
     *
     * `setTimeStep` is what makes it a picture at all rather than a picture of a race.
     * `tick()` normally reads the wall clock, so a screenshot of an animating page is a
     * different fraction of the way through on every run — measured, not feared: the
     * first version of this took three renders of the same scenario and got three
     * different files.
     *
     * A `@keyframes` animation needs no `--hover`, because it runs on the clock rather
     * than on a predicate: the first frame creates it at t=0 and the second samples it.
     * That is also why `--advance 0` is not a no-op — it is the only way to get a
     * *reproducible* t=0.
     */
    const advanceIndex = argv.indexOf("--advance");
    const advance = advanceIndex !== -1 ? Number(argv[advanceIndex + 1]) : null;
    if (advance !== null && !Number.isFinite(advance)) {
      throw new Error(`--advance takes seconds, got "${argv[advanceIndex + 1]}"`);
    }

    /* Committing here rather than trusting the loop: the app thread has published
       and released, so the lock is free and this cannot be the racing case. */
    const frame = () => {
      if (!tryAcquire(flags)) return;
      takeDirty(flags);
      try {
        engine.tick();
      } finally {
        release(flags);
      }
    };

    if (advance !== null) {
      engine.setTimeStep(0);
      engine.setInputState(-1, -1, -1);
      frame();
      engine.setTimeStep(advance);
    }

    /**
     * `--click <node>…` — press and release each node in turn before the shot.
     *
     * Distinct from `--hover` in kind rather than in degree, which is why it is a
     * separate flag rather than another argument to that one: `--hover` *declares* an
     * input state, while this **runs the press**. Hit-testing, a disabled control
     * swallowing the press, a label forwarding to the box beside it and the activation
     * behaviour itself all happen, and none of them can be reached by asserting the
     * state a click would have left.
     *
     * It needs a laid-out frame to aim at — the node's box comes from the layout table
     * — so it goes after the `--advance` priming frame and before the shot.
     *
     * Repeatable, and the order is the order given, because "click A then B" is a
     * different picture from "click B then A" for a radio group.
     */
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== "--click") continue;
      const node = Number(argv[i + 1]);
      if (!Number.isInteger(node) || node < 0) {
        throw new Error(`--click takes a node id, got "${argv[i + 1]}"`);
      }
      frame();
      engine.clickNode(node);
    }

    /**
     * `--drag <node>:<from>:<to>` — select by dragging across a field, in width fractions.
     *
     * A selection cannot be reached any other way from out here. `--focus` declares a state
     * and `--click` runs a press and a release; a *range* needs the motion between them,
     * because the focus follows `mouse_move` while the anchor stays where the press landed.
     * So this is the same argument `--click` makes against `--hover`, one step further along.
     *
     * Fractions rather than pixels, so a scenario keeps pointing at the same characters when
     * the layout above it shifts.
     */
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== "--drag") continue;
      const parts = (argv[i + 1] ?? "").split(":");
      const [node, from, to] = parts.map(Number);
      if (parts.length !== 3 || !Number.isInteger(node) || node! < 0 || !Number.isFinite(from!) || !Number.isFinite(to!)) {
        throw new Error(`--drag takes <node>:<from>:<to> in width fractions, got "${argv[i + 1]}"`);
      }
      frame();
      engine.dragNode(node!, from!, to!);
    }

    /** `--double <node>` / `--triple <node>` — a word, or the whole value. */
    for (let i = 0; i < argv.length; i++) {
      const clicks = argv[i] === "--double" ? 2 : argv[i] === "--triple" ? 3 : 0;
      if (clicks === 0) continue;
      const node = Number(argv[i + 1]);
      if (!Number.isInteger(node) || node < 0) {
        throw new Error(`${argv[i]} takes a node id, got "${argv[i + 1]}"`);
      }
      frame();
      engine.clickNodeTimes(node, clicks);
    }

    /**
     * `--scroll <dy>` — scroll the page down by `dy` pixels before anything else.
     *
     * Before the gestures, deliberately: `--click` and `--open` aim at a node's laid-out box
     * in *window* coordinates, so they have to run against the scroll position the shot will
     * be taken at.
     *
     * This flag exists because its absence hid a bug rather than merely being inconvenient.
     * Every scenario renders into a viewport taller than its content needs, so **nothing in
     * the golden suite had ever scrolled** — and the `<select>` picker, which is drawn by a
     * paint pass that starts at the picker rather than at the tree root, inherited none of
     * the scroll its ancestors had applied. Every frame looked right and the real 1040x700
     * demo drew the picker a screenful away from its select.
     *
     * Aimed at the middle of the window, which is the page for every route here. A scenario
     * that needs to scroll something nested would want a node id instead.
     */
    let pageScroll = 0;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== "--scroll") continue;
      const dy = Number(argv[i + 1]);
      if (!Number.isFinite(dy)) {
        throw new Error(`--scroll takes a pixel amount, got "${argv[i + 1]}"`);
      }
      frame();
      const [w, h] = engine.surfaceInfo();
      // How far the page actually went, which is not necessarily what was asked: a scroll is
      // clamped to what the content can give. Read back rather than assumed, because every
      // gesture below aims in *window* coordinates while `bounds` are unscrolled — so an
      // error here becomes a press that lands somewhere else. See `aimAt`.
      pageScroll = engine.scroll(w / 2, h / 2, 0, dy)[1];
      frame();
    }

    /**
     * The window coordinates of a node's centre, which is where a pointer would be.
     *
     * `bounds` are **unscrolled**, so on a scrolled page they are not where the node is
     * drawn — and a press aimed at them lands somewhere else entirely, or off-screen. That
     * is not hypothetical: `--open 318` on a page scrolled 560px aimed at y≈959 while the
     * button was drawn at 384, hit nothing, and produced a frame with no picker in it that
     * looked exactly like a broken picker.
     *
     * Only the page's own scroll is subtracted. A node inside a *nested* scroller would need
     * its ancestors' offsets accumulated, which nothing here has yet — so the flags that
     * cannot do it refuse to combine with `--scroll` rather than quietly missing.
     */
    const aimAt = (node: number): [number, number] => {
      const [x, y, w, h] = engine.bounds(node);
      return [x + w / 2, y + h / 2 - pageScroll];
    };

    if (pageScroll !== 0) {
      const unscrollable = ["--click", "--drag", "--double", "--triple"].filter((f) =>
        argv.includes(f),
      );
      if (unscrollable.length > 0) {
        throw new Error(
          `${unscrollable.join(", ")} cannot be combined with --scroll yet.\n` +
            `  Those aim through Engine's own node-centre helpers, which read unscrolled\n` +
            `  bounds — so the press would land ${pageScroll}px away from the node and hit\n` +
            `  nothing. Refused rather than silently missing, which is how the picker's\n` +
            `  scroll bug produced a plausible-looking empty frame.`,
        );
      }
    }

    /**
     * `--open <node>` — press a `<select>` so its picker is showing in the shot.
     *
     * A press and not a click, deliberately, and it is the one gesture where that
     * distinction is visible from out here: a picker opens on `mouse_down` and the release
     * has nothing to do with it. Measured — the press alone opened it before any release,
     * which is the opposite of a checkbox. `--click` would work too, since the release
     * lands on the button and a select declines activation, but it would be spelling the
     * gesture wrong and would quietly start passing if the trigger point ever moved.
     *
     * The highlight in the picture is the engine's own: opening focuses the committed
     * option, and `option:focus` is what draws it. So this needs no `--focus`, and would be
     * *made wrong* by one.
     */
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== "--open") continue;
      const node = Number(argv[i + 1]);
      if (!Number.isInteger(node) || node < 0) {
        throw new Error(`--open takes a node id, got "${argv[i + 1]}"`);
      }
      frame();
      engine.mouseDown(...aimAt(node));
    }

    /**
     * The declared input state, and **only when something declared one.**
     *
     * This used to run unconditionally, which quietly undid every gesture above it: with
     * no flags it is `setInputState(-1, -1, -1)`, so the focus a `--click` had just
     * acquired was reset before the shot and a clicked field rendered with no focus ring.
     * `controls-caret`'s comment recorded that as the harness rather than the engine and
     * said it was worth fixing when `--click` and `--focus` next needed to compose.
     *
     * They do now. A picker's highlight *is* `state.focused` on an `<option>` — that is the
     * whole reason it costs no extra state — so a shot of an open picker cannot survive its
     * focus being cleared, and there is no `--focus` value to pass instead: the option the
     * engine chose is the thing under test.
     *
     * Skipping it changes one existing picture, `controls-caret`, which now shows the focus
     * ring a clicked field really has. That golden was wrong in a way its own comment
     * described.
     */
    if (argv.includes("--hover") || argv.includes("--focus")) {
      engine.setInputState(numberFlag("--hover"), -1, numberFlag("--focus"));
    }
    frame();

    await Bun.write(screenshotPath, engine.readPng());

    const [w, h] = engine.surfaceInfo();
    console.log(
      `${request.summary}, font ${engine.fontFamily()}\n` +
        `  frame ${engine.lastFrameMs().toFixed(3)}ms at ${w}x${h}\n` +
        `  wrote ${screenshotPath}`,
    );

    stop(flags);
    send({ t: "quit" });
    engine.close();
    worker.terminate();
    process.exit(0);
  }

  // --- the loop --------------------------------------------------------------------
  console.log(
    `${request.summary}\n` +
      `  font: ${engine.fontFamily()} — hover and click; close the window to exit.\n` +
      `  app code runs in a Worker; the window stays live while it is busy.`,
  );

  let frames = 0;
  let stalled = 0;

  /**
   * `--run-ms <n>` — run for a fixed time, then report and exit.
   *
   * The other half of `--block`. Together they turn "the window stayed
   * responsive" into a number: frames rendered while the app thread was wedged.
   */
  const runFor = (() => {
    const i = argv.indexOf("--run-ms");
    const ms = i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : 0;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  })();
  const startedAt = performance.now();

  while (running) {
    if (runFor > 0 && performance.now() - startedAt >= runFor) {
      console.log(`frames=${frames} pumped=${stalled} over ${runFor}ms`);
      break;
    }

    if (tryAcquire(flags)) {
      takeDirty(flags);
      try {
        engine.tick();
      } finally {
        release(flags);
      }
    } else {
      /* The app thread is mid-batch. Service the window; leave its memory alone. */
      engine.pump();
      stalled++;
    }

    frames++;

    if (showStats && frames % 60 === 0) {
      console.log(
        `frame ${engine.lastFrameMs().toFixed(3)}ms` +
          (stalled > 0 ? ` — ${stalled}/60 pumped while the app thread was writing` : ""),
      );
      stalled = 0;
    }

    const events = engine.drainEvents();
    if (events.length > 0) {
      const quit = events.some((e) => e.kind === EventKind.QUIT);
      /* Forwarded whole, including the quit, so a handler on the far side still
         sees the events that arrived alongside it. */
      send({ t: "events", events });
      if (quit) running = false;
    }

    await Bun.sleep(IDLE_MS);
  }

  stop(flags);
  send({ t: "quit" });
  engine.close();
  worker.terminate();

  if (failure !== null) throw failure;
}

function asError(event: unknown): Error {
  const e = event as { message?: string; error?: unknown };
  if (e.error instanceof Error) return e.error;
  return new Error(e.message ?? "the app thread failed with no message");
}
