/**
 * Installs the reactive rewrite for a `bun` process that is going to load
 * authored window modules from source.
 *
 * The rewrite is not a build-time step that can be done once. Authored modules
 * under `windows/` are loaded by several different processes and all of them need
 * it:
 *
 *   - the compiler, which expands components to build the IR
 *   - the host, which imports `state.ts` at run time — the generated artifact
 *     imports every signal and handler by name, so the module runs for real
 *   - `bun test`, wherever a test reaches into a demo window
 *
 * Found by the goldens. The compiler had the plugin and the host did not, so the
 * window compiled cleanly and then every scenario failed to render: `todos.filter`
 * on an unrewritten module is a method on a signal object, which does not exist.
 *
 * Reached two ways. This repository preloads it from `bunfig.toml`, which covers
 * `bun test` and the harnesses; `dziry dev` passes `--preload` to the app it
 * spawns, so a scaffolded project needs no bunfig entry — and therefore has no
 * bunfig entry for a *packaged* app to trip over. See below.
 */
/**
 * Whether this process is a `bun build --compile` executable.
 *
 * A standalone binary reads `bunfig.toml` **from its working directory** and
 * honours the `preload` it finds there — measured, and it is a trap rather than a
 * feature: `./dist/app.exe` run from this repository died with "Cannot find
 * package 'magic-string'", because it had been told to preload the compiler and
 * the compiler's dependencies are not inside it. A shipped app started next to any
 * project's bunfig would do the same.
 *
 * It is also pointless work even when it succeeds. `dziry build` applies the
 * rewrite through `Bun.build`'s plugin list, so the modules inside the executable
 * are *already* rewritten; installing a loader plugin over them would at best
 * change nothing.
 *
 * The marker is Bun's own virtual filesystem. In a standalone build every module,
 * `Bun.main` included, lives under `B:/~BUN/root/` (Windows) or `/$bunfs/root/`.
 * There is no module path that looks like that in an ordinary run.
 */
function isStandaloneBuild(): boolean {
  const main = Bun.main.replaceAll("\\", "/");
  return main.includes("/~BUN/") || main.startsWith("/$bunfs/");
}

/**
 * A dynamic import, because a static one is hoisted above the guard.
 *
 * The first version of this check read exactly right and did nothing: the module
 * graph is resolved before any statement runs, so `import { installReactivePlugin }`
 * pulled in `reactive-transform.ts` — and `magic-string` with it — while the guard
 * was still waiting its turn. The packaged app failed on the import, not on the
 * call. Keeping the compiler behind `await import` is what makes the guard real.
 */
if (!isStandaloneBuild()) {
  const { installReactivePlugin } = await import("./reactive-plugin.ts");
  installReactivePlugin();
}

// Makes this a module, which is what lets the `await` above be top-level. With
// the static import gone there was nothing else saying so.
export {};
