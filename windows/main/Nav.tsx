/**
 * The window's chrome. An ordinary component in the window folder — `pages/` holds
 * routes and nothing else.
 *
 * These navigate for real: a click writes the window's route signal, the host looks
 * the path up in the compiled route table and writes `hidden` over the routes that
 * left the chain. One byte per route root, no allocation, one relayout.
 *
 * The active entry is `router.matches(path)` in a conditional class. Nothing
 * compares strings at run time — the comparison is compiled into a cell and then
 * into style-table writes, so highlighting costs a few integers when the route
 * changes and nothing per frame.
 *
 * `hover:` compiles to an escaped selector (`.hover\:bg-zinc-700:hover`) and a
 * predicate bit, so hovering is resolved by the engine with nothing sent back here.
 */
import { cn, useRouter } from "dziri";
import {
  goBorders,
  goColors,
  goControls,
  goFeatures,
  goLayout,
  goOverview,
  goProducts,
  goReactivity,
  goSpacing,
  goTypography,
} from "./router.ts";

const LINK = "link rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700";

export function Nav() {
  const router = useRouter();

  return (
    <div className="flex flex-row items-center justify-between rounded-xl bg-zinc-900 px-5 py-4">
      <div className="flex flex-col gap-1">
        <div className="heading text-lg font-semibold text-zinc-50">Tailwind, compiled</div>
        <div className="muted text-xs text-zinc-400">
          real utility CSS · resolved at build time · no CSS at run time
        </div>
      </div>
      <div className="flex flex-row gap-2">
        <button className={cn(LINK, { active: router.matches("/") })} onClick={goOverview}>
          Overview
        </button>
        <button className={cn(LINK, { active: router.matches("layout") })} onClick={goLayout}>
          Layout
        </button>
        <button className={cn(LINK, { active: router.matches("spacing") })} onClick={goSpacing}>
          Spacing
        </button>
        <button
          className={cn(LINK, { active: router.matches("typography") })}
          onClick={goTypography}
        >
          Type
        </button>
        <button className={cn(LINK, { active: router.matches("colors") })} onClick={goColors}>
          Color
        </button>
        <button className={cn(LINK, { active: router.matches("borders") })} onClick={goBorders}>
          Borders
        </button>
        <button className={cn(LINK, { active: router.matches("controls") })} onClick={goControls}>
          Controls
        </button>
        <button className={cn(LINK, { active: router.matches("features") })} onClick={goFeatures}>
          Features
        </button>
        <button
          className={cn(LINK, { active: router.matches("reactivity") })}
          onClick={goReactivity}
        >
          Reactivity
        </button>
        {/* Prefix-aware: stays lit on products/new and products/$id too. */}
        <button className={cn(LINK, { active: router.matches("products") })} onClick={goProducts}>
          Routing
        </button>
      </div>
    </div>
  );
}
