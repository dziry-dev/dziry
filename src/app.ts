/**
 * The host: loads compiled IR, uploads it to the engine, dispatches input.
 *
 *   bun run app
 *   bun run app --stats                 # frame timings
 *   bun run app --screenshot out.png    # render one frame headlessly and exit
 *   bun run app --size 600x400          # a window of that size, headless or not
 *   bun run app --size 400x600 --min-size none   # ...and let it be dragged narrower
 *
 * Note what is absent, and what has become absent. There is still no HTML
 * parser, no CSS parser, no selector matching and no cascade — the IR arrives as
 * an imported module of typed arrays. And there is no longer any layout, paint,
 * text measurement or windowing here either: the engine owns all four, and this
 * file is what is left, which is state and dispatch.
 *
 * The loop is:
 *
 *   signals change -> bindings/patches/lists mutate the IR -> upload -> tick
 *                                                                        |
 *                                     handlers <- drain events <---------+
 */
import { join } from "node:path";
import type { CompiledUi } from "./ir.ts";
import { Engine } from "./engine/host.ts";
import { Uploader, capacitiesFor } from "./engine/upload.ts";
import { EventKind } from "./protocol/generated.ts";
import {
  applyTextBindings,
  subscribeBindings,
  dispatch,
  typeInto,
  Dirty,
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
import * as generated from "../app/ui.gen.ts";

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

/// The window size, as `WxH`. Defaults to the size the demo was laid out against.
///
/// A flag rather than a constant because the interesting cases are the small ones:
/// whether the page scrolls, whether a scrollbar appears, whether a narrow window
/// reflows — none of which can be seen at a size chosen to make everything fit.
const [windowWidth, windowHeight] = (() => {
  const i = argv.indexOf("--size");
  const raw = i !== -1 ? argv[i + 1] : null;
  const match = raw?.match(/^(\d+)x(\d+)$/);
  if (raw && !match) throw new Error(`--size takes WxH, got "${raw}"`);
  return match ? [Number(match[1]), Number(match[2])] : [1040, 560];
})();

/// `--min-size none` (or `WxH`) lifts the engine's 564x320 floor for this run.
///
/// It has to be set here rather than passed, because it is an environment variable the
/// engine reads at window creation rather than a field on the config — see
/// `MIN_WINDOW_ENV` in `window.rs` for why it is not on the wire. Setting it before the
/// engine is created is the whole requirement; `dlopen` has already happened by now and
/// does not matter, since the read is in `Window::new`.
///
/// Without this, `--size 400x600` silently gives you a 564-wide window: SDL clamps up
/// to the minimum, so the flag that exists to *reach* small sizes cannot reach them.
{
  const i = argv.indexOf("--min-size");
  const raw = i !== -1 ? argv[i + 1] : null;
  if (i !== -1 && !raw) throw new Error(`--min-size takes WxH or "none"`);
  if (raw) process.env.DZIRI_MIN_WINDOW = raw;
}

// The generated module *is* the IR — no parsing, no deserialization.
//
// And no assertion either. This used to end in `as unknown as CompiledUi`, which
// is the one place a project built on generated identity stopped checking: the
// compiler emits the artifact, the runtime consumes it, and the cast told `tsc`
// to take both on trust. The module now declares `satisfies` against these same
// types, so a field the compiler renames is a compile error in the artifact
// rather than a `TypeError` in whichever test happens to touch it first.
const ui: CompiledUi = {
  strings: generated.strings,
  styles: generated.styles,
  nodes: generated.nodes,
  variants: generated.variants,
  interactive: generated.interactive,
  textBindings: generated.textBindings,
  handlers: generated.handlers,
  lists: generated.lists,
  root: generated.root,
};

const stylePatches: StylePatchRef[] = generated.stylePatches;
const listBindings: ListBindingRef[] = generated.listBindings;
const editables: EditableRef[] = generated.editables;

// --- state, before the engine exists -----------------------------------------
//
// Bindings, patches and lists all mutate the IR in place, and lists can grow the
// node arrays. Running them once up front means the engine is sized for the tree
// that actually exists rather than the one the compiler emitted.
const changedNodes: number[] = [];
applyTextBindings(ui, changedNodes);
updateLists(ui, listBindings);
applyStylePatches(ui, stylePatches);

// --- the engine ---------------------------------------------------------------
const engine = Engine.open({
  ...capacitiesFor(ui),
  width: windowWidth,
  height: windowHeight,
  title: "dziri — compiled UI",
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
    `${ui.nodes.count} nodes, ${generated.styles.count} styles, font ${engine.fontFamily()}\n` +
      `  frame ${engine.lastFrameMs().toFixed(3)}ms at ${width}x${height}\n` +
      `  wrote ${screenshotPath}`,
  );

  engine.close();
  process.exit(0);
}

// --- the loop -------------------------------------------------------------------
console.log(
  `${ui.nodes.count} nodes, ${generated.styles.count} styles, ` +
    `${generated.strings.length} strings\n` +
    `  font: ${engine.fontFamily()} — hover and click; close the window to exit.`,
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
