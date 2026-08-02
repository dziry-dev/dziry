/** The route at `"spacing"` — padding, margin and fixed sizes. */
export default function Spacing() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">padding</div>
        <div className="text-xs text-zinc-400">p-2 · p-4 · p-6 · px-6 py-2</div>
        <div className="flex flex-row items-start gap-3">
          <div className="rounded-md bg-teal-500 p-2 text-xs text-teal-950">p-2</div>
          <div className="rounded-md bg-teal-500 p-4 text-xs text-teal-950">p-4</div>
          <div className="rounded-md bg-teal-500 p-6 text-xs text-teal-950">p-6</div>
          <div className="rounded-md bg-teal-400 px-6 py-2 text-xs text-teal-950">px-6 py-2</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">margin</div>
        <div className="text-xs text-zinc-400">ml-0 · ml-4 · ml-8 · ml-12, inside one column</div>
        <div className="flex flex-col gap-2">
          <div className="rounded-md bg-rose-500 p-3 text-xs text-rose-50">ml-0</div>
          <div className="ml-4 rounded-md bg-rose-500 p-3 text-xs text-rose-50">ml-4</div>
          <div className="ml-8 rounded-md bg-rose-400 p-3 text-xs text-rose-950">ml-8</div>
          <div className="ml-12 rounded-md bg-rose-300 p-3 text-xs text-rose-950">ml-12</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">size</div>
        <div className="text-xs text-zinc-400">
          w-16 h-8 · w-24 h-8 · w-32 h-8 · size-12 — rem, resolved to px at build time
        </div>
        <div className="flex flex-col gap-2">
          <div className="h-8 w-16 rounded-md bg-indigo-500" />
          <div className="h-8 w-24 rounded-md bg-indigo-400" />
          <div className="h-8 w-32 rounded-md bg-indigo-300" />
          <div className="size-12 rounded-md bg-indigo-200" />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">gap</div>
        <div className="text-xs text-zinc-400">gap-1 · gap-4 · gap-8, same three boxes</div>
        <div className="flex flex-row gap-1">
          <div className="h-6 w-6 rounded bg-zinc-600" />
          <div className="h-6 w-6 rounded bg-zinc-600" />
          <div className="h-6 w-6 rounded bg-zinc-600" />
        </div>
        <div className="flex flex-row gap-4">
          <div className="h-6 w-6 rounded bg-zinc-500" />
          <div className="h-6 w-6 rounded bg-zinc-500" />
          <div className="h-6 w-6 rounded bg-zinc-500" />
        </div>
        <div className="flex flex-row gap-8">
          <div className="h-6 w-6 rounded bg-zinc-400" />
          <div className="h-6 w-6 rounded bg-zinc-400" />
          <div className="h-6 w-6 rounded bg-zinc-400" />
        </div>
      </div>
    </div>
  );
}
