/**
 * Host for a compiled window.
 *
 *   bun run window:run
 *   bun run window:run --route products/new
 *   bun run window:run --route about --screenshot out.png
 *
 * The routing half of this file is `showRoute`, and it is the whole runtime cost of
 * having routes: a byte per route root. Everything is already resident — one table
 * set, every route in it — so switching route allocates nothing, grows nothing and
 * rebuilds nothing. What it costs is the relayout the change genuinely causes.
 *
 * `navigate("products/1")` is this plus two things it does not have yet: a matcher
 * turning a concrete path into a route index and binding its parameters, and the
 * one-entry history `back()` returns to. The matcher is decided to live in the
 * engine, next to the media-query evaluator, which needs the route table on the
 * wire.
 *
 * One window, imported statically so the artifact stays type-checked rather than
 * asserted. A second window needs a single SDL event pump — `Window::new` creates
 * an `EventPump` per engine and SDL's queue is process-global — which is an engine
 * refactor independent of any of this.
 */
import { routeChain, type CompiledUi } from "./ir.ts";
import { Engine } from "./engine/host.ts";
import { Uploader, capacitiesFor } from "./engine/upload.ts";
import { EventKind } from "./protocol/generated.ts";
import { applyTextBindings, subscribeBindings, dispatch } from "./runtime/bindings.ts";
import { applyStylePatches, subscribeStylePatches } from "./runtime/patches.ts";
import { updateLists, subscribeLists, dispatchItem } from "./runtime/list-runtime.ts";
import * as generated from "../windows/main/ui.gen.ts";

const argv = process.argv.slice(2);
const screenshotIndex = argv.indexOf("--screenshot");
const screenshotPath = screenshotIndex !== -1 ? argv[screenshotIndex + 1] : null;

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

const { routeNodes, initialRoute, windowConfig, windowId } = generated;

/**
 * Shows one route, hiding the rest.
 *
 * Writes are per route root, so this is bounded by route count and not by node
 * count — a 10,000-node window with twenty routes writes twenty bytes. The same
 * `routeChain` the emitter used decides what stays visible, so the first frame and
 * every frame after it agree.
 */
function showRoute(index: number): void {
  const chain = routeChain(routeNodes, index);
  for (const [i, route] of routeNodes.entries()) {
    const hide = chain.has(i) ? 0 : 1;
    for (const node of route.roots) ui.nodes.hidden[node] = hide;
  }
}

/** `--route products/new`, by exact path. Matching a *concrete* path is the matcher's job. */
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

const changedNodes: number[] = [];
applyTextBindings(ui, changedNodes);
updateLists(ui, generated.listBindings);
applyStylePatches(ui, generated.stylePatches);
showRoute(active);

const engine = Engine.open({
  ...capacitiesFor(ui),
  width: windowConfig.width ?? 1040,
  height: windowConfig.height ?? 560,
  title: windowConfig.title,
  root: ui.root,
  windowed: screenshotPath === null,
});

const uploader = new Uploader(engine, ui);
uploader.uploadAll();

let dirty = true;

subscribeBindings(ui, () => {
  applyTextBindings(ui, changedNodes);
  dirty = true;
});
subscribeLists(generated.listBindings, () => {
  updateLists(ui, generated.listBindings);
  dirty = true;
});
subscribeStylePatches(generated.stylePatches, () => {
  applyStylePatches(ui, generated.stylePatches);
  dirty = true;
});

function upload(): void {
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

if (screenshotPath) {
  upload();
  engine.tick();
  await Bun.write(screenshotPath, engine.readPng());

  const [width, height] = engine.surfaceInfo();
  console.log(
    `${windowId} at "${routeNodes[active]!.path}" — ${ui.nodes.count} nodes, ` +
      `${routeNodes.length - routeChain(routeNodes, active).size} route(s) hidden\n` +
      `  frame ${engine.lastFrameMs().toFixed(3)}ms at ${width}x${height}\n` +
      `  wrote ${screenshotPath}`,
  );

  engine.close();
  process.exit(0);
}

console.log(
  `${windowId} at "${routeNodes[active]!.path}" — ${ui.nodes.count} nodes, ` +
    `${routeNodes.length} route(s) resident\n` +
    `  --route <path> to show another; close the window to exit.`,
);

let running = true;
while (running) {
  if (dirty) {
    upload();
    dirty = false;
  }

  engine.tick();

  for (const event of engine.drainEvents()) {
    if (event.kind === EventKind.QUIT) running = false;
    else if (event.kind === EventKind.CLICK) {
      if (!dispatchItem(ui, generated.listBindings, event.node)) dispatch(ui, event.node);
    }
  }

  await Bun.sleep(8);
}

engine.close();
