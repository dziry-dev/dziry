/**
 * The route at `"animations"` — `transition-*` and `@keyframes`, which are one
 * mechanism reached from two syntaxes.
 *
 * Nothing on this page is animated by JavaScript, and nothing on it is animated by a
 * style object either. Every box carries a predicate mask and a run of fully-resolved
 * interned style rows that the compiler produced; what the engine adds is a `t`. So a
 * transition here is interpolation between two rows of a table that was finished at
 * build time, and a `@keyframes` animation is the same operation over rows the
 * compiler resolved from the keyframe blocks. `(from, to, t)` serves both.
 *
 * Read the last two blocks rather than only looking at them. The interruption block
 * is the measured behaviour that killed the obvious design — a reversal is a *rewind*
 * of the same pair of rows, which is why no row anywhere holds an interpolated value —
 * and the refusal block is the scope boundary: only paint reads a blend, so a
 * transition on anything that moves a box is declined by name.
 */
export default function Animations() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">transition-colors</div>
        <div className="text-xs text-zinc-400">
          hover these — a colour is a packed u32, so it interpolates per channel in sRGB and
          premultiplied by alpha, which is measured rather than assumed
        </div>
        <div className="flex flex-row items-center gap-4">
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-colors duration-300 hover:bg-sky-500 hover:text-white">
            300ms
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-colors duration-700 hover:bg-emerald-500 hover:text-white">
            700ms
          </button>
          {/* Tailwind's `transition-colors` names `border-color` too, so the ring
              eases with the fill rather than snapping a frame ahead of it. */}
          <button className="link rounded-lg border-2 border-zinc-700 bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-colors duration-500 hover:border-violet-400 hover:bg-violet-500/20">
            border too
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">transition-transform</div>
        <div className="text-xs text-zinc-400">
          the transform is stored decomposed — fourteen scalars, never a matrix — which is
          exactly what makes this possible: rotate(0) and rotate(360deg) are the same matrix
          and a matrix lerp between them could not move
        </div>
        <div className="flex h-24 flex-row items-center gap-4">
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-transform duration-300 hover:scale-110">
            scale-110
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-transform duration-300 hover:-translate-y-2">
            -translate-y-2
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-transform duration-500 hover:rotate-6">
            rotate-6
          </button>
          {/* Two properties in one transition: the mask is a bitmask over the 25
              animatable style fields, so `transform` contributes nine bits and
              `opacity` one. */}
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition duration-500 hover:-translate-y-2 hover:scale-110 hover:opacity-50">
            all three
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">easing</div>
        <div className="text-xs text-zinc-400">
          the same 700ms translate on four curves — linear · ease-in · ease-out · ease-in-out.
          Solving a cubic bezier for t is a Newton iteration with a bisection fallback, and the
          measured progress table in BROWSER-FACTS.md is what it is checked against
        </div>
        <div className="flex h-24 flex-row items-center gap-4">
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-transform duration-700 ease-linear hover:translate-x-8">
            linear
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-transform duration-700 ease-in hover:translate-x-8">
            ease-in
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-transform duration-700 ease-out hover:translate-x-8">
            ease-out
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-transform duration-700 ease-in-out hover:translate-x-8">
            ease-in-out
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">delay</div>
        <div className="text-xs text-zinc-400">
          delay-0 · delay-150 · delay-300 · delay-500, all fading over 300ms — hover the row and
          they arrive in sequence. A delay under one frame is not rounded up to one: the
          overshoot is carried into t.
        </div>
        <div className="flex flex-row items-center gap-4">
          <button className="link rounded-lg bg-sky-500 px-4 py-3 text-xs text-white transition-opacity duration-300 delay-0 hover:opacity-25">
            0
          </button>
          <button className="link rounded-lg bg-sky-500 px-4 py-3 text-xs text-white transition-opacity duration-300 delay-150 hover:opacity-25">
            150
          </button>
          <button className="link rounded-lg bg-sky-500 px-4 py-3 text-xs text-white transition-opacity duration-300 delay-300 hover:opacity-25">
            300
          </button>
          <button className="link rounded-lg bg-sky-500 px-4 py-3 text-xs text-white transition-opacity duration-300 delay-500 hover:opacity-25">
            500
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">@keyframes, via Tailwind</div>
        <div className="text-xs text-zinc-400">
          all four of Tailwind's animations, and all four need only transform and opacity —
          which is why they were the scope boundary. Each is an offset → style-row table the
          compiler built by resolving each keyframe against the element's own computed style.
        </div>
        <div className="flex h-24 flex-row items-center gap-10">
          {/* `spin` has only a `to`; the implicit `from` is the element's own
              computed style, measured, so no synthetic value is invented for it.

              A square rather than the usual ring-with-one-coloured-edge, because
              that needs `border-top-color` and dziri has one `borderColor` field
              for all four sides. A rotating circle would also be a rotation
              nobody can see, which is the more useful reason. */}
          <div className="flex flex-col items-center gap-2">
            <div className="h-10 w-10 animate-spin rounded-lg border-4 border-sky-400 bg-sky-500/20" />
            <div className="text-xs text-zinc-500">animate-spin</div>
          </div>
          {/* `ping` is `75%, 100% { … }` — one block, two rows. Measured: it reads
              halfway to *75%* a third of the way through, not halfway to 100%. */}
          <div className="flex flex-col items-center gap-2">
            <div className="h-10 w-10 animate-ping rounded-full bg-rose-500" />
            <div className="text-xs text-zinc-500">animate-ping</div>
          </div>
          <div className="flex flex-col items-center gap-2">
            <div className="h-10 w-10 animate-pulse rounded-lg bg-amber-500" />
            <div className="text-xs text-zinc-500">animate-pulse</div>
          </div>
          {/* `bounce` is the one that needed the data model to be right: it declares
              `animation-timing-function` *inside* two of its keyframes, and measured,
              that governs the segment *leaving* the keyframe. So the curve is a
              column on the keyframe row rather than a style field. */}
          <div className="flex flex-col items-center gap-2">
            <div className="h-10 w-10 animate-bounce rounded-lg bg-emerald-500" />
            <div className="text-xs text-zinc-500">animate-bounce</div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">@keyframes, hand-written</div>
        <div className="text-xs text-zinc-400">
          `drift` is authored in app.css, not generated: four keyframes, a multi-offset
          selector, and a per-keyframe easing. It is the same table and the same engine path
          Tailwind's four take — there is no second mechanism for an author's own animation.
        </div>
        <div className="flex h-20 flex-row items-center gap-8">
          <div className="drift h-10 w-10 rounded-lg bg-violet-500" />
          <div className="drift-slow h-10 w-10 rounded-full bg-cyan-400" />
          <div className="text-xs text-zinc-500">
            the same @keyframes at two durations — one interned block, two tween rows
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">interruption</div>
        <div className="text-xs text-zinc-400">
          hover one of these and pull away halfway. The way back takes as long as the distance
          still to travel, not the full duration — measured: interrupted at t=0.4, the reversal
          runs 400ms of a 1000ms transition and starts from the value already reached.
        </div>
        <div className="text-xs text-zinc-500">
          That measurement is what makes this cheap. Interned style rows are shared between
          nodes, so there is no row to write an interpolated value into — and none is needed,
          because a reversal is the same pair of rows traversed backwards. Both the timing and
          the value continuity fall out of `t` moving at ±1/duration.
        </div>
        <div className="flex h-28 flex-row items-center gap-4">
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-transform duration-1000 ease-linear hover:translate-x-16">
            1000ms · pull away
          </button>
          <button className="link rounded-lg bg-zinc-800 px-4 py-3 text-xs text-zinc-200 transition-colors duration-1000 ease-linear hover:bg-rose-500">
            and again in colour
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">what is refused, and why</div>
        <div className="text-xs text-zinc-400">
          `transition: width` and every other layout-affecting property is declined **by
          name**, with a build warning. Only paint reads an interpolated value, so honouring
          it halfway would ease a box's colour while its geometry jumped — and the schema
          enforces the boundary rather than trusting it: a style field marked animatable but
          not paint-only stops the build.
        </div>
        <div className="text-xs text-zinc-500">
          Also not here: per-property timing (`transition: opacity 1s, transform 2s` really
          does compute to two durations in CSS, measured — dziri carries one per node and says
          so), `animation-direction: alternate`, `animation-fill-mode`, and more than one
          animation on one element. Each warns by name rather than half-working.
        </div>
        <div className="text-xs text-zinc-500">
          What Bun spends per frame, for all of the above: one `engine.tick()` call. The clock,
          the tween state, the easing and the interpolation are all on the other side of it,
          reading tables written once at build time.
        </div>
      </div>
    </div>
  );
}
