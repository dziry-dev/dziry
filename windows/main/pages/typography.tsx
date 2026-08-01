/** @jsxImportSource ../../../src/compiler */

/** The route at `"typography"` — sizes, weights and text colour. */
export default function Typography() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">size</div>
        <div className="flex flex-col gap-2">
          <div className="text-xs text-zinc-300">text-xs · the quick brown fox</div>
          <div className="text-sm text-zinc-300">text-sm · the quick brown fox</div>
          <div className="text-base text-zinc-200">text-base · the quick brown fox</div>
          <div className="text-lg text-zinc-200">text-lg · the quick brown fox</div>
          <div className="text-xl text-zinc-100">text-xl · the quick brown fox</div>
          <div className="text-2xl text-zinc-100">text-2xl · the quick brown fox</div>
          <div className="text-3xl text-zinc-50">text-3xl · the quick brown fox</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">weight</div>
        <div className="flex flex-col gap-2">
          <div className="text-base font-light text-zinc-200">font-light</div>
          <div className="text-base font-normal text-zinc-200">font-normal</div>
          <div className="text-base font-medium text-zinc-200">font-medium</div>
          <div className="text-base font-semibold text-zinc-200">font-semibold</div>
          <div className="text-base font-bold text-zinc-200">font-bold</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">colour</div>
        <div className="text-xs text-zinc-400">
          The palette is Tailwind's own, from theme.css — oklch() resolved to sRGB at build time.
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-base text-red-400">text-red-400</div>
          <div className="text-base text-amber-400">text-amber-400</div>
          <div className="text-base text-emerald-400">text-emerald-400</div>
          <div className="text-base text-sky-400">text-sky-400</div>
          <div className="text-base text-violet-400">text-violet-400</div>
          <div className="text-base text-zinc-400">text-zinc-400</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">wrapping</div>
        <div className="text-xs text-zinc-400">
          Text measured and broken by SkParagraph, not by us. This paragraph is here so the line
          breaks move when the window is resized — the same relayout a media query causes, for a
          different reason.
        </div>
      </div>
    </div>
  );
}
