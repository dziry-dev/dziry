/** @jsxImportSource ../../src/compiler */

/**
 * The window's chrome. An ordinary component in the window folder — `pages/` holds
 * routes and nothing else.
 *
 * These navigate for real: a click writes the window's route signal, the host looks
 * the path up in the compiled route table and writes `hidden` over the routes that
 * left the chain. One byte per route root, no allocation, one relayout.
 *
 * `hover:` compiles to an escaped selector (`.hover\:bg-zinc-700:hover`) and a
 * predicate bit, so hovering is resolved by the engine with nothing sent back here.
 */
import {
  goBorders,
  goColors,
  goFeatures,
  goLayout,
  goOverview,
  goProducts,
  goSpacing,
  goTypography,
} from "./router.ts";

const LINK = "rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700";

export function Nav() {
  return (
    <div className="flex flex-row items-center justify-between rounded-xl bg-zinc-900 px-5 py-4">
      <div className="flex flex-col gap-1">
        <div className="text-lg font-semibold text-zinc-50">Tailwind, compiled</div>
        <div className="text-xs text-zinc-400">
          real utility CSS · resolved at build time · no CSS at run time
        </div>
      </div>
      <div className="flex flex-row gap-2">
        <button className={LINK} onClick={goOverview}>
          Overview
        </button>
        <button className={LINK} onClick={goLayout}>
          Layout
        </button>
        <button className={LINK} onClick={goSpacing}>
          Spacing
        </button>
        <button className={LINK} onClick={goTypography}>
          Type
        </button>
        <button className={LINK} onClick={goColors}>
          Color
        </button>
        <button className={LINK} onClick={goBorders}>
          Borders
        </button>
        <button className={LINK} onClick={goFeatures}>
          Features
        </button>
        <button className={LINK} onClick={goProducts}>
          Routing
        </button>
      </div>
    </div>
  );
}
