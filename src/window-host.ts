/**
 * The host: loads a compiled window, uploads it to the engine, dispatches input.
 *
 *   bun run dev                              # compile, then run
 *   bun run window:run --route products/new  # start on another route
 *   bun run window:run --stats               # frame timings
 *   bun run window:run --screenshot out.png  # render one frame headlessly and exit
 *   bun run window:run --size 600x400        # a window of that size, headless or not
 *   bun run window:run --size 400x600 --min-size none   # ...and let it be dragged narrower
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
 */
import { routeChain, type CompiledUi } from "./ir.ts";
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
import type { Signal } from "./runtime/signal.ts";
import {
  updateLists,
  subscribeLists,
  dispatchItem,
  type ListBindingRef,
} from "./runtime/list-runtime.ts";
import { artifacts, windowIds, type WindowId } from "../windows/windows.gen.ts";

/** SDL keycodes. Two constants is cheaper than binding the whole keysym table. */
const KEY_BACKSPACE = 8;
const KEY_ESCAPE = 27;

const argv = process.argv.slice(2);
const showStats = argv.includes("--stats");
const screenshotIndex = argv.indexOf("--screenshot");
const screenshotPath = screenshotIndex !== -1 ? argv[screenshotIndex + 1] : null;

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
  if (!wanted) return artifacts[windowIds[0]!];

  if (!(wanted in artifacts)) {
    throw new Error(`no window "${wanted}". Windows are ${windowIds.join(", ")}.`);
  }
  return artifacts[wanted as WindowId];
})();

// The generated module *is* the IR — no parsing, no deserialization.
//
// And no assertion either. This used to end in `as unknown as CompiledUi`, which
// is the one place a project built on generated identity stopped checking: the
// compiler emits the artifact, the runtime consumes it, and the cast told `tsc`
// to take both on trust. The module declares `satisfies` against these same
// types, so a field the compiler renames is a compile error in the artifact
// rather than a `TypeError` in whichever test happens to touch it first.
//
// The registry keeps that property across windows: `artifacts` is a record of
// statically imported modules, so reading `.routeNodes` off one is checked. A
// dynamic `import(id)` would return `any` and give up the one interface this
// project cannot afford to stop checking.
const ui: CompiledUi = {
  strings: generated.strings,
  styles: generated.styles,
  nodes: generated.nodes,
  variants: generated.variants,
  interactive: generated.interactive,
  textBindings: generated.textBindings,
  handlers: generated.handlers,
  lists: generated.lists,
  media: generated.media,
  root: generated.root,
};

const stylePatches: StylePatchRef[] = generated.stylePatches;
const listBindings: ListBindingRef[] = generated.listBindings;
const editables: EditableRef[] = generated.editables;

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

/** `--route routing`, by exact path — matching a *concrete* path is the matcher's job. */
function requestedRoute(): number {
  const i = argv.indexOf("--route");
  const wanted = i !== -1 ? argv[i + 1] : null;
  if (!wanted) return initialRoute;

  const found = routeNodes.findIndex((r) => r.path === wanted);
  if (found === -1) {
    const paths = routeNodes.map((r) => r.path).join(", ");
    throw new Error(`no route "${wanted}" in window ${windowId}. Routes are ${paths}.`);
  }
  return found;
}

const active = requestedRoute();

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
  if (uploader.ensureCapacity()) {
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
  // `--patch 0,1` flips those conditional classes on, so headless renders can
  // exercise them without a mouse.
  const patchIndex = argv.indexOf("--patch");
  if (patchIndex !== -1 && argv[patchIndex + 1]) {
    for (const raw of argv[patchIndex + 1]!.split(",")) {
      const patch = stylePatches[Number(raw)];
      if (patch) (patch.signal as Signal<boolean>).value = true;
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

while (running) {
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
