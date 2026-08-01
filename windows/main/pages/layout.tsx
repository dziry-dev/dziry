/** @jsxImportSource ../../../src/compiler */

/** The route at `"layout"` — flex, grid, gaps and alignment. */
export default function Layout() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">flex</div>
        <div className="text-xs text-zinc-400">flex-row · gap-3 · items-center</div>
        <div className="flex flex-row items-center gap-3">
          <div className="h-10 w-10 rounded-md bg-sky-500" />
          <div className="h-14 w-14 rounded-md bg-sky-400" />
          <div className="h-8 w-8 rounded-md bg-sky-300" />
          <div className="h-16 w-16 rounded-md bg-sky-600" />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">grid</div>
        <div className="text-xs text-zinc-400">grid-cols-4 · gap-3 · col-span-2</div>
        <div className="grid grid-cols-4 gap-3">
          <div className="col-span-2 rounded-md bg-violet-500 p-4 text-xs text-violet-50">
            col-span-2
          </div>
          <div className="rounded-md bg-violet-400 p-4 text-xs text-violet-50">one</div>
          <div className="rounded-md bg-violet-400 p-4 text-xs text-violet-50">two</div>
          <div className="rounded-md bg-violet-300 p-4 text-xs text-violet-900">three</div>
          <div className="rounded-md bg-violet-300 p-4 text-xs text-violet-900">four</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">grow and justify</div>
        <div className="text-xs text-zinc-400">grow · justify-between</div>
        <div className="flex flex-row items-center justify-between gap-3">
          <div className="rounded-md bg-zinc-800 px-4 py-3 text-xs text-zinc-300">start</div>
          <div className="grow rounded-md bg-zinc-700 px-4 py-3 text-xs text-zinc-200">
            grow takes the leftover
          </div>
          <div className="rounded-md bg-zinc-800 px-4 py-3 text-xs text-zinc-300">end</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">responsive</div>
        <div className="text-xs text-zinc-400">
          md:flex-row — one @media condition, one predicate bit, re-evaluated by the engine on
          resize. Drag the window narrower than 768px.
        </div>
        <div className="flex flex-col gap-3 md:flex-row">
          <div className="rounded-md bg-amber-500 p-4 text-xs text-amber-950">first</div>
          <div className="rounded-md bg-amber-400 p-4 text-xs text-amber-950">second</div>
          <div className="rounded-md bg-amber-300 p-4 text-xs text-amber-950">third</div>
        </div>
      </div>
    </div>
  );
}
