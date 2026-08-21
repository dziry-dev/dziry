/**
 * The route at `"/"` — what this window is, and how to read it.
 *
 * The figures come from `coverage.gen.ts`, which `bun run coverage:snapshot`
 * writes from the tools that compute them. They used to be literals here and both
 * were wrong: the page said 36% of Tailwind and 93 CSS properties while the tools
 * said 41.2% and 98. A number typed into a page is checked by nothing, which is
 * the same reason `doc-lint` exists for citations.
 */
import { COVERAGE } from "../coverage.gen.ts";

export default function Overview() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-2xl font-semibold text-zinc-50">Coverage, rendered</div>
        <div className="text-sm text-zinc-400">
          Each route below is one family of utilities or one framework feature, written the way you
          would write it and compiled by dziry. If something on these pages did not compile, the
          build would have printed a warning naming the property — so what renders is what works.
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-5">
          <div className="text-3xl font-semibold text-emerald-400">{COVERAGE.tailwind.pct}</div>
          <div className="text-xs text-zinc-400">
            of Tailwind classes compile — {COVERAGE.tailwind.have} of {COVERAGE.tailwind.total} from
            the installed tailwindcss
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-5">
          <div className="text-3xl font-semibold text-sky-400">{COVERAGE.css.pct}</div>
          <div className="text-xs text-zinc-400">
            of the curated CSS corpus — {COVERAGE.css.have} of {COVERAGE.css.total}, and{" "}
            {COVERAGE.css.supported} properties parsed in all
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-5">
          <div className="text-3xl font-semibold text-amber-400">{COVERAGE.html.pct}</div>
          <div className="text-xs text-zinc-400">
            of HTML elements render like Chrome — {COVERAGE.html.have} of {COVERAGE.html.total}{" "}
            compared
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-base font-semibold text-zinc-100">What the three numbers mean</div>
        <div className="text-sm text-zinc-400">
          They have different denominators on purpose, and none of them is &ldquo;% of CSS&rdquo;.
          Tailwind is every class the installed tailwindcss can emit. The CSS figure is a curated
          corpus, not all of CSS — &ldquo;everything standard minus the non-goals&rdquo; is still
          ~376 properties including ones a UI framework will never want, so a percentage against
          that would flatter and mislead. The HTML figure is elements whose default rendering
          already matches Chrome, and it is the lowest because the UA stylesheet is young; that is
          the largest single lever left.
        </div>
        <div className="text-xs text-zinc-500">
          Written by `bun run coverage:snapshot` from the three tools. `--check` fails when this
          page disagrees with them, so the numbers cannot quietly rot.
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-base font-semibold text-zinc-100">What is not here yet</div>
        <div className="text-sm text-zinc-400">
          Masks, filters and SVG paint now compile — the engine stores them but does not render
          them yet. What is left is mostly 3D transforms (dziry is 2D), intrinsic sizing keywords
          like fit-content, and a long tail of small properties. They are absent from these pages
          rather than shown broken: a demo that renders a utility wrongly is worse than one that
          omits it.
        </div>
      </div>
    </div>
  );
}
