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
    engine.setInputState(numberFlag("--hover"), -1, numberFlag("--focus"));

    /* Committing here rather than trusting the loop: the app thread has published
       and released, so the lock is free and this cannot be the racing case. */
    if (tryAcquire(flags)) {
      takeDirty(flags);
      try {
        engine.tick();
      } finally {
        release(flags);
      }
    }

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
      const quit = events.some((e) => e.kind === 0 /* EventKind.QUIT */);
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
