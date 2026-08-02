/**
 * The host: loads a compiled window, uploads it to the engine, dispatches input.
 *
 *   dziri dev                              # compile, then run
 *   dziri dev -- --route products/new      # start on another route
 *   dziri dev -- --stats                   # frame timings
 *   dziri dev -- --screenshot out.png      # render one frame headlessly and exit
 *   dziri dev -- --size 600x400            # a window of that size, headless or not
 *   dziri dev -- --size 400x600 --min-size none   # ...and let it be dragged narrower
 *
 * Note what is absent. There is no HTML parser, no CSS parser, no selector
 * matching and no cascade — the IR arrives as an imported module of typed arrays.
 * There is no layout, paint, text measurement or windowing either: the engine owns
 * all four. What is left is state and dispatch.
 *
 * And there is no router, in the sense of something that resolves anything. Every
 * route in the window is already in the node table; `showRoute` writes a byte per
 * route root. The loop is:
 *
 *   signals change -> bindings/patches/lists mutate the IR -> upload -> tick
 *                                                                        |
 *                                     handlers <- drain events <---------+
 *
 * # Why this takes the registry rather than importing it
 *
 * `dziri/host` lives in `node_modules`, and a static import of the project's
 * `windows/windows.gen.ts` from there resolves to nothing. So the dependency is
 * inverted: the compiler generates `windows/entry.gen.ts` in the *project*, which
 * imports both and calls {@link run}. The static import survives, and with it the
 * type-checking that is the whole reason the registry is not a dynamic `import(id)`.
 */
import { routeChain, type CompiledUi, type RouteNodes, type WindowConfig } from "./ir.ts";
import { Engine } from "./engine/host.ts";
import { Uploader, capacitiesFor } from "./engine/upload.ts";
import { EventKind } from "./protocol/generated.ts";
import {
  applyTextBindings,
  subscribeBindings,
  dispatch,
  typeInto,
  type EditableRef,
} from "./runtime/bindings.ts";
import {
  applyStylePatches,
  subscribeStylePatches,
  type StylePatchRef,
} from "./runtime/patches.ts";
import type { ReadonlySignal, Signal } from "./runtime/signal.ts";
import {
  updateLists,
  subscribeLists,
  dispatchItem,
  type ListBindingRef,
} from "./runtime/list-runtime.ts";

/** SDL keycodes. Two constants is cheaper than binding the whole keysym table. */
const KEY_BACKSPACE = 8;
const KEY_ESCAPE = 27;

// The artifact and registry shapes live in `host/registry.ts`, because all three
// entry points — this one, the engine thread and the app thread — have to agree
// on them.
export type { WindowArtifact, WindowRegistry } from "./host/registry.ts";
import type { WindowRegistry } from "./host/registry.ts";

export type RunOptions = {
  /** Defaults to this process's. Taken as a parameter so a test can drive it. */
  argv?: readonly string[];
};

export async function run(registry: WindowRegistry, options: RunOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);

  const showStats = argv.includes("--stats");
  const screenshotIndex = argv.indexOf("--screenshot");
  const screenshotPath = screenshotIndex !== -1 ? (argv[screenshotIndex + 1] ?? null) : null;

  /** Headless state overrides, so interaction styles can be verified without a mouse. */
  const numberFlag = (name: string): number => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : -1;
  };

  /**
   * Which window to open. `--window tailwind`, defaulting to the first.
   *
   * One at a time, not one per process by choice: `Window::new` creates an
   * `EventPump` per engine and SDL's queue is process-global, so two windows would
   * fight over events. Opening either from one host is what this needs; opening both
   * at once is an engine refactor.
   */
  const generated = (() => {
    const i = argv.indexOf("--window");
    const wanted = i !== -1 ? argv[i + 1] : null;
    const ids = registry.windowIds;

    if (ids.length === 0) throw new Error("this project has no windows under ./windows");
    if (!wanted) return registry.artifacts[ids[0]!]!;

    const found = registry.artifacts[wanted];
    if (!found) throw new Error(`no window "${wanted}". Windows are ${ids.join(", ")}.`);
    return found;
  })();

  // The generated module *is* the IR — no parsing, no deserialization.
  //
  // And no assertion either. This used to end in `as unknown as CompiledUi`, which
  // is the one place a project built on generated identity stopped checking: the
  // compiler emits the artifact, the runtime consumes it, and the cast told `tsc`
  // to take both on trust. The module declares `satisfies` against these same
  // types, so a field the compiler renames is a compile error in the artifact
  // rather than a `TypeError` in whichever test happens to touch it first.
  const ui: CompiledUi = {
    strings: generated.strings,
    styles: generated.styles,
    nodes: generated.nodes,
    variants: generated.variants,
    interactive: generated.interactive,
    generated: generated.generated,
    textBindings: generated.textBindings,
    handlers: generated.handlers,
    lists: generated.lists,
    media: generated.media,
    root: generated.root,
  };

  const { stylePatches, listBindings, editables } = generated;
  const { routeNodes, initialRoute, windowConfig, windowId } = generated;

  /// The window size, as `WxH`. Defaults to what `<Window>` declared.
  ///
  /// A flag rather than only the prop because the interesting cases are the small
  /// ones: whether the page scrolls, whether a scrollbar appears, whether a narrow
  /// window reflows — none of which can be seen at a size chosen to make everything
  /// fit.
  const [windowWidth, windowHeight] = (() => {
    const i = argv.indexOf("--size");
    const raw = i !== -1 ? argv[i + 1] : null;
    const match = raw?.match(/^(\d+)x(\d+)$/);
    if (raw && !match) throw new Error(`--size takes WxH, got "${raw}"`);
    if (match) return [Number(match[1]), Number(match[2])];
    return [windowConfig.width ?? 1040, windowConfig.height ?? 560];
  })();

  /// `--min-size none` (or `WxH`) lifts the engine's 564x320 floor for this run.
  ///
  /// It has to be set here rather than passed, because it is an environment variable
  /// the engine reads at window creation rather than a field on the config — see
  /// `MIN_WINDOW_ENV` in `window.rs` for why it is not on the wire. Setting it before
  /// the engine is created is the whole requirement; `dlopen` has already happened by
  /// now and does not matter, since the read is in `Window::new`.
  ///
  /// Without this, `--size 400x600` silently gives you a 564-wide window: SDL clamps
  /// up to the minimum, so the flag that exists to *reach* small sizes cannot reach
  /// them. `<Window minWidth>` is emitted but not yet on the wire, so it does not
  /// replace this.
  {
    const i = argv.indexOf("--min-size");
    const raw = i !== -1 ? argv[i + 1] : null;
    if (i !== -1 && !raw) throw new Error(`--min-size takes WxH or "none"`);
    if (raw) process.env.DZIRI_MIN_WINDOW = raw;
  }

  /**
   * Shows one route, hiding the rest.
   *
   * Writes are per route root, so this is bounded by route count and not by node
   * count — a 10,000-node window with twenty routes writes twenty bytes. The same
   * `routeChain` the emitter used decides what stays visible, so the first frame and
   * every frame after it agree.
   *
   * This is `navigate` minus two things: a matcher turning a concrete path like
   * `products/1` into a route index and binding its parameters, and the one-entry
   * history `back()` returns to. The matcher is decided to live in the engine, next
   * to the media-query evaluator, which needs the route table on the wire.
   */
  function showRoute(index: number): void {
    const chain = routeChain(routeNodes, index);
    for (const [i, route] of routeNodes.entries()) {
      const hide = chain.has(i) ? 0 : 1;
      for (const node of route.roots) ui.nodes.hidden[node] = hide;
    }
  }

  /**
   * A path to a route index.
   *
   * Exact paths only. Binding `products/1` to `products/$id` is the matcher's job,
   * and the matcher is decided to live in the engine next to the media-query
   * evaluator — which needs the route table on the wire. Until then a window can
   * navigate between its static routes, which is what the parameter route's own
   * `useRoute` is waiting on rather than something this should guess at.
   */
  function indexOf(path: string): number {
    return routeNodes.findIndex((r) => r.path === path);
  }

  /** `--route routing`, for starting somewhere other than the initial route. */
  const requestedRoute = (): number => {
    const i = argv.indexOf("--route");
    const wanted = i !== -1 ? argv[i + 1] : null;
    if (!wanted) return initialRoute;

    const found = indexOf(wanted);
    if (found === -1) {
      const paths = routeNodes.map((r) => r.path).join(", ");
      throw new Error(`no route "${wanted}" in window ${windowId}. Routes are ${paths}.`);
    }
    return found;
  };

  let active = requestedRoute();

  /**
   * `--route` writes the window's route signal, not just the `hidden` column.
   *
   * Otherwise the two disagree: the frame shows `products/new` while `useRouter()`
   * still reads `/`, so anything derived from the route — an active tab, a breadcrumb
   * — is wrong in exactly the screenshot taken to check it. Written before the
   * subscription is registered, so this costs nothing and no navigation is dispatched
   * for a route that is already showing.
   */
  const routeSignal = generated.routeSignal;
  if (routeSignal) {
    (routeSignal as Signal<string>).value = routeNodes[active]!.path;
  }

  // --- state, before the engine exists -----------------------------------------
  //
  // Bindings, patches and lists all mutate the IR in place, and lists can grow the
  // node arrays. Running them once up front means the engine is sized for the tree
  // that actually exists rather than the one the compiler emitted.
  const changedNodes: number[] = [];
  applyTextBindings(ui, changedNodes);
  updateLists(ui, listBindings);
  applyStylePatches(ui, stylePatches);
  showRoute(active);

  // --- the engine ---------------------------------------------------------------
  const engine = Engine.open({
    ...capacitiesFor(ui),
    width: windowWidth,
    height: windowHeight,
    title: windowConfig.title,
    root: ui.root,
    windowed: screenshotPath === null,
  });

  const uploader = new Uploader(engine, ui);
  uploader.uploadAll();

  /** Set by any subscription; drives whether the next frame uploads at all. */
  let dirty = true;

  subscribeBindings(ui, () => {
    applyTextBindings(ui, changedNodes);
    dirty = true;
  });

  subscribeLists(listBindings, () => {
    updateLists(ui, listBindings);
    dirty = true;
  });

  subscribeStylePatches(stylePatches, () => {
    applyStylePatches(ui, stylePatches);
    dirty = true;
  });

  /**
   * Navigation, all of it.
   *
   * The window's route signal changes, the path is looked up in the compiled table,
   * and `hidden` is written over the routes that left the chain. No allocation, no
   * table growth, nothing rebuilt — and no `await`, so a click cannot hang the
   * window. An unknown path is ignored rather than blanking the window, because a
   * dead link is meant to be a *build* error and silently showing nothing is the
   * failure this design exists to avoid.
   */
  if (routeSignal) {
    routeSignal.subscribe(() => {
      const next = indexOf(routeSignal.value);
      if (next === -1 || next === active) return;
      active = next;
      showRoute(active);
      dirty = true;
    });
  }

  /**
   * Pushes the IR's current state at the engine.
   *
   * Deliberately unconditional about *which* tables it writes: the engine's commit
   * compares span by span and reports what changed, so a second diff here would be
   * the same work with less information. The one exception is strings, which are
   * uploaded incrementally because re-encoding every row of a long list on every
   * keystroke would not be free.
   */
  function upload(): void {
    // A list arena that outgrew its capacity reallocated the IR's node arrays; the
    // engine's tables have to follow, and everything is re-uploaded when they do.
    const want = uploader.needsGrowth();
    if (want !== null) {
      engine.grow(want);
      uploader.rebind();
      uploader.uploadAll();
      return;
    }

    uploader.uploadStyles();
    uploader.uploadVariants();
    uploader.uploadLists();
    uploader.uploadNodes();
    uploader.uploadStrings();
    changedNodes.length = 0;
  }

  /** Nodes, styles and how much of the window is resident but not showing. */
  const summary = () =>
    `${windowId} at "${routeNodes[active]!.path}" — ${ui.nodes.count} nodes, ` +
    `${generated.styles.count} styles, ` +
    `${routeNodes.length - routeChain(routeNodes, active).size} of ${routeNodes.length} routes hidden`;

  // --- headless mode -------------------------------------------------------------
  if (screenshotPath) {
    /**
     * `--patch light,compact` flips those conditional classes on, so headless
     * renders can exercise them without a mouse.
     *
     * By name, not by index. The index into `stylePatches` is whatever order the
     * compiler's tree walk produced, so adding a conditional class anywhere
     * renumbered every later one and `--patch 1` quietly began flipping something
     * else — which is how eight nav highlights broke two golden scenarios that had
     * nothing to do with them.
     */
    const patchIndex = argv.indexOf("--patch");
    if (patchIndex !== -1 && argv[patchIndex + 1]) {
      const names = stylePatches.map((p) => p.className);

      for (const wanted of argv[patchIndex + 1]!.split(",")) {
        const patch = stylePatches.find((p) => p.className === wanted);
        if (!patch) {
          throw new Error(`no conditional class "${wanted}". Classes are ${names.join(", ")}.`);
        }
        // A patch driven by a derived cell — `router.matches(…)` — has no setter, and
        // saying so beats "value is not writable" from three frames down.
        if (!("value" in patch.signal) || Object.isFrozen(patch.signal)) {
          throw new Error(`"${wanted}" is derived and cannot be set directly.`);
        }
        (patch.signal as Signal<boolean>).value = true;
      }
    }

    engine.setInputState(numberFlag("--hover"), -1, numberFlag("--focus"));
    upload();
    engine.tick();

    await Bun.write(screenshotPath, engine.readPng());

    const [width, height] = engine.surfaceInfo();
    console.log(
      `${summary()}, font ${engine.fontFamily()}\n` +
        `  frame ${engine.lastFrameMs().toFixed(3)}ms at ${width}x${height}\n` +
        `  wrote ${screenshotPath}`,
    );

    engine.close();
    process.exit(0);
  }

  // --- the loop -------------------------------------------------------------------
  console.log(
    `${summary()}\n` +
      `  font: ${engine.fontFamily()} — hover and click; close the window to exit.\n` +
      `  --route <path> starts elsewhere: ${routeNodes.map((r) => r.path).join(", ")}`,
  );

  let running = true;
  let frames = 0;

  /**
   * `--block <ms>` and `--run-ms <n>`, so this path can be measured against the
   * Worker one on equal terms.
   *
   * Here they are in the same thread, which is the point of the comparison: a
   * block here stops the frame loop dead, and the reported frame count says by
   * how much.
   */
  const numberArg = (name: string): number => {
    const i = argv.indexOf(name);
    const value = i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const runFor = numberArg("--run-ms");
  const startedAt = performance.now();

  const blockMs = numberArg("--block");
  if (blockMs > 0) {
    upload();
    engine.tick();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
  }

  while (running) {
    if (runFor > 0 && performance.now() - startedAt >= runFor) {
      console.log(`frames=${frames} pumped=0 over ${runFor}ms`);
      break;
    }

    if (dirty) {
      upload();
      dirty = false;
    }

    engine.tick();
    frames++;

    if (showStats && frames % 60 === 0) {
      console.log(`frame ${engine.lastFrameMs().toFixed(3)}ms`);
    }

    for (const event of engine.drainEvents()) {
      switch (event.kind) {
        case EventKind.QUIT:
          running = false;
          break;

        case EventKind.CLICK:
          // A row's handler is found by decomposing the node into (slot, offset);
          // a plain handler is looked up by node. Both batch, so one click costs
          // one repaint however many signals it writes.
          if (!dispatchItem(ui, listBindings, event.node)) dispatch(ui, event.node);
          break;

        // Focus lives in the engine now — it owns input, so it is the thing that
        // knows what was clicked. It rides along on the event rather than being
        // mirrored here, which is one fewer piece of state to keep in sync.
        case EventKind.TEXT_INPUT:
          if (typeInto(editables, event.node, { text: event.text, backspace: false })) {
            dirty = true;
          }
          break;

        case EventKind.KEY_DOWN:
          if (event.a === KEY_BACKSPACE) {
            if (typeInto(editables, event.node, { text: null, backspace: true })) dirty = true;
          } else if (event.a === KEY_ESCAPE) {
            engine.setInputState(-1, -1, -1);
          }
          break;
      }
    }

    // Bun polls; the engine skips painting when nothing changed, so an idle frame
    // costs an event-queue drain. This becomes a blocking wait when the engine
    // owns its own frame loop (A0 step 3).
    await Bun.sleep(8);
  }

  engine.close();
}
