/**
 * Installs the reactive rewrite for every `bun` process in this repo.
 *
 * Registered as a `preload` in `bunfig.toml`, because the rewrite is not a
 * build-time step that can be done once. Authored modules under `windows/` are
 * loaded by *three* different processes and all of them need it:
 *
 *   - `compile-window.ts`, which expands components to build the IR
 *   - `window-host.ts`, which imports `state.ts` at run time — the generated
 *     artifact imports every signal and handler by name, so the module runs for real
 *   - `bun test`, wherever a test reaches into the demo window
 *
 * Found by the goldens. The compiler had the plugin and the host did not, so the
 * window compiled cleanly and then every scenario failed to render: `todos.filter`
 * on an unrewritten module is a method on a signal object, which does not exist.
 * A preload is the only place that covers all three without each entry point having
 * to remember.
 */
import { installReactivePlugin } from "./reactive-plugin.ts";

installReactivePlugin();
