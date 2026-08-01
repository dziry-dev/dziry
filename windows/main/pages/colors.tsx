/** @jsxImportSource ../../../src/compiler */

/** The route at `"colors"` — backgrounds across Tailwind's palette and scale. */
export default function Colors() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">one hue, the whole scale</div>
        <div className="text-xs text-zinc-400">bg-sky-50 through bg-sky-950</div>
        <div className="flex flex-row gap-2">
          <div className="h-12 w-12 rounded bg-sky-50" />
          <div className="h-12 w-12 rounded bg-sky-100" />
          <div className="h-12 w-12 rounded bg-sky-200" />
          <div className="h-12 w-12 rounded bg-sky-300" />
          <div className="h-12 w-12 rounded bg-sky-400" />
          <div className="h-12 w-12 rounded bg-sky-500" />
          <div className="h-12 w-12 rounded bg-sky-600" />
          <div className="h-12 w-12 rounded bg-sky-700" />
          <div className="h-12 w-12 rounded bg-sky-800" />
          <div className="h-12 w-12 rounded bg-sky-900" />
          <div className="h-12 w-12 rounded bg-sky-950" />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">one step, every hue</div>
        <div className="text-xs text-zinc-400">
          the 500 of each — authored as oklch() in Tailwind's theme, resolved at build time
        </div>
        <div className="grid grid-cols-6 gap-2">
          <div className="h-12 rounded bg-red-500" />
          <div className="h-12 rounded bg-orange-500" />
          <div className="h-12 rounded bg-amber-500" />
          <div className="h-12 rounded bg-yellow-500" />
          <div className="h-12 rounded bg-lime-500" />
          <div className="h-12 rounded bg-green-500" />
          <div className="h-12 rounded bg-emerald-500" />
          <div className="h-12 rounded bg-teal-500" />
          <div className="h-12 rounded bg-cyan-500" />
          <div className="h-12 rounded bg-sky-500" />
          <div className="h-12 rounded bg-blue-500" />
          <div className="h-12 rounded bg-indigo-500" />
          <div className="h-12 rounded bg-violet-500" />
          <div className="h-12 rounded bg-purple-500" />
          <div className="h-12 rounded bg-fuchsia-500" />
          <div className="h-12 rounded bg-pink-500" />
          <div className="h-12 rounded bg-rose-500" />
          <div className="h-12 rounded bg-slate-500" />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">hover</div>
        <div className="text-xs text-zinc-400">
          hover:bg-* compiles to an escaped selector and a predicate bit — one int swap per
          hovered node, resolved by the engine, with nothing sent back to Bun.
        </div>
        <div className="flex flex-row gap-3">
          <div className="rounded-lg bg-zinc-800 px-4 py-3 text-sm text-zinc-200 hover:bg-emerald-500">
            hover me
          </div>
          <div className="rounded-lg bg-zinc-800 px-4 py-3 text-sm text-zinc-200 hover:bg-sky-500">
            and me
          </div>
          <div className="rounded-lg bg-zinc-800 px-4 py-3 text-sm text-zinc-200 hover:bg-rose-500">
            and me
          </div>
        </div>
      </div>
    </div>
  );
}
