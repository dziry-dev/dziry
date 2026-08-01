/** @jsxImportSource ../../../src/compiler */

/** The route at `"/"` — what this window is, and how to read it. */
export default function Overview() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-2xl font-semibold text-zinc-50">Utility coverage, rendered</div>
        <div className="text-sm text-zinc-400">
          Each route below is one family of Tailwind utilities, written the way you would write
          them and compiled by dziri. If a utility on these pages did not compile, the build would
          have printed a warning naming the property — so what renders is what works.
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-5">
          <div className="text-3xl font-semibold text-emerald-400">36%</div>
          <div className="text-xs text-zinc-400">of Tailwind classes compile today</div>
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-5">
          <div className="text-3xl font-semibold text-sky-400">93</div>
          <div className="text-xs text-zinc-400">CSS properties supported</div>
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-5">
          <div className="text-3xl font-semibold text-zinc-100">0</div>
          <div className="text-xs text-zinc-400">bytes of CSS in the runtime</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-base font-semibold text-zinc-100">What is not here yet</div>
        <div className="text-sm text-zinc-400">
          The largest blockers by class count are mask-image and mask-composite, then calc() over
          percentages and viewport units. They are absent from these pages rather than shown
          broken: a demo that renders a utility wrongly is worse than one that omits it.
        </div>
      </div>
    </div>
  );
}
