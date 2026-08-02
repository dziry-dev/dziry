/**
 * The route at `"transforms"` — `transform`, `transform-origin` and `opacity`.
 *
 * Every box here is Tailwind, so this page is also the evidence that the 402
 * classes `translate` unblocked are real utilities rather than a coverage number:
 * `translate-x-4`, `-translate-x-1/2`, `rotate-45`, `scale-110`, `skew-x-12`,
 * `origin-top-left` and `opacity-50` all compile straight through.
 *
 * The last block is the one worth looking at rather than reading. `hover:scale-110`
 * is a transform that lives in a *variant* slot, so it is only visible through the
 * resolved style — and hit-testing has to see it too, or the pointer would leave
 * the box the moment it grew and the thing would flicker under the cursor.
 */
export default function Transforms() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">translate</div>
        <div className="text-xs text-zinc-400">
          translate-x-4 · -translate-y-2 · translate-x-1/2 — the percentage resolves against
          the box's own width, so the engine does it, not the compiler
        </div>
        {/* h-20 on the row so a translated child has somewhere to go without
            changing the row's height — which it cannot do anyway: transform is
            paint-only, measured. */}
        <div className="flex h-20 flex-row items-start gap-6">
          <div className="h-14 w-14 rounded-lg bg-zinc-700" />
          <div className="h-14 w-14 translate-x-4 rounded-lg bg-sky-500" />
          <div className="h-14 w-14 -translate-y-2 rounded-lg bg-emerald-500" />
          <div className="h-14 w-14 translate-x-1/2 rounded-lg bg-violet-500" />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">rotate</div>
        <div className="text-xs text-zinc-400">
          rotate-45 · rotate-90 · -rotate-12 — about the centre, which is the initial
          transform-origin and is itself a percentage
        </div>
        <div className="flex h-24 flex-row items-center gap-10">
          <div className="h-14 w-14 rounded-lg bg-zinc-700" />
          <div className="h-14 w-14 rotate-45 rounded-lg bg-amber-500" />
          <div className="h-14 w-14 rotate-90 rounded-lg bg-rose-500" />
          <div className="h-14 w-14 -rotate-12 rounded-lg bg-cyan-500" />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">scale and skew</div>
        <div className="text-xs text-zinc-400">
          scale-75 · scale-125 · scale-x-150 · skew-x-12 — none of them moves a sibling
        </div>
        <div className="flex h-24 flex-row items-center gap-10">
          <div className="h-14 w-14 rounded-lg bg-zinc-700" />
          <div className="h-14 w-14 scale-75 rounded-lg bg-lime-500" />
          <div className="h-14 w-14 scale-125 rounded-lg bg-fuchsia-500" />
          <div className="h-14 w-14 scale-x-150 rounded-lg bg-indigo-500" />
          <div className="h-14 w-14 skew-x-12 rounded-lg bg-orange-500" />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">transform-origin</div>
        <div className="text-xs text-zinc-400">
          the same rotate-45 about four different origins — center · top-left · bottom-right ·
          left
        </div>
        <div className="flex h-24 flex-row items-center gap-12">
          <div className="h-14 w-14 rotate-45 rounded-lg bg-teal-500" />
          <div className="h-14 w-14 origin-top-left rotate-45 rounded-lg bg-teal-500" />
          <div className="h-14 w-14 origin-bottom-right rotate-45 rounded-lg bg-teal-500" />
          <div className="h-14 w-14 origin-left rotate-45 rounded-lg bg-teal-500" />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">opacity</div>
        <div className="text-xs text-zinc-400">
          opacity-100 · opacity-75 · opacity-50 · opacity-25 — a group, so the label inside
          each box fades with it rather than separately
        </div>
        <div className="flex flex-row items-center gap-4">
          <div className="rounded-lg bg-sky-500 p-4 text-xs text-white opacity-100">100</div>
          <div className="rounded-lg bg-sky-500 p-4 text-xs text-white opacity-75">75</div>
          <div className="rounded-lg bg-sky-500 p-4 text-xs text-white opacity-50">50</div>
          <div className="rounded-lg bg-sky-500 p-4 text-xs text-white opacity-25">25</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">a transform in a variant</div>
        <div className="text-xs text-zinc-400">
          hover these — hover:scale-110 and hover:-translate-y-1 resolve in the engine, and
          the pointer follows the box to where it was actually drawn
        </div>
        <div className="flex h-24 flex-row items-center gap-4">
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 hover:scale-110">
            hover:scale-110
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 hover:-translate-y-1">
            hover:-translate-y-1
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 hover:rotate-6">
            hover:rotate-6
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 hover:opacity-50">
            hover:opacity-50
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">what is not here yet</div>
        <div className="text-xs text-zinc-400">
          None of the above animates. The endpoints are already resolved — a node with
          `hover:scale-110` carries two finished style rows and the engine picks one — so what
          transitions still need is the clock and the current t, not the styles. That is
          ROADMAP B3.
        </div>
        <div className="text-xs text-zinc-500">
          Also refused, by name rather than silently: `transform: matrix(…)`, every 3D
          function, and any list written outside the order translate · rotate · skew · scale.
        </div>
      </div>
    </div>
  );
}
