/** @jsxImportSource ../../../src/compiler */

/** The route at `"borders"` — widths, colours and radii. */
export default function Borders() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">width</div>
        <div className="text-xs text-zinc-400">border · border-2 · border-4 · border-8</div>
        <div className="flex flex-row items-start gap-3">
          <div className="border border-sky-400 p-4 text-xs text-zinc-300">border</div>
          <div className="border-2 border-sky-400 p-4 text-xs text-zinc-300">border-2</div>
          <div className="border-4 border-sky-400 p-4 text-xs text-zinc-300">border-4</div>
          <div className="border-8 border-sky-400 p-4 text-xs text-zinc-300">border-8</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">radius</div>
        <div className="text-xs text-zinc-400">
          rounded-none · rounded-sm · rounded-md · rounded-lg · rounded-xl · rounded-2xl
        </div>
        <div className="flex flex-row items-start gap-3">
          <div className="h-14 w-14 rounded-none bg-fuchsia-500" />
          <div className="h-14 w-14 rounded-sm bg-fuchsia-500" />
          <div className="h-14 w-14 rounded-md bg-fuchsia-500" />
          <div className="h-14 w-14 rounded-lg bg-fuchsia-500" />
          <div className="h-14 w-14 rounded-xl bg-fuchsia-500" />
          <div className="h-14 w-14 rounded-2xl bg-fuchsia-500" />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">colour</div>
        <div className="text-xs text-zinc-400">border-2 with a colour per box</div>
        <div className="grid grid-cols-4 gap-3">
          <div className="border-2 border-red-500 p-4 text-xs text-zinc-300">red</div>
          <div className="border-2 border-emerald-500 p-4 text-xs text-zinc-300">emerald</div>
          <div className="border-2 border-violet-500 p-4 text-xs text-zinc-300">violet</div>
          <div className="border-2 border-amber-500 p-4 text-xs text-zinc-300">amber</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">not here: per-corner radii</div>
        <div className="text-xs text-zinc-400">
          rounded-t-*, rounded-l-* and rounded-br-* are absent on purpose. The style table holds
          one radius per node, so the per-corner longhands do not compile — they would render as
          square corners while the page claimed otherwise, and a demo that shows a utility working
          when it does not is the one thing this window must never do.
        </div>
      </div>
    </div>
  );
}
