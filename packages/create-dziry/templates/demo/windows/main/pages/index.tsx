/**
 * The route at `"/"` — the first page your app shows.
 *
 * This file is the template's own, not copied from the dziry demo: the demo's
 * landing page renders coverage figures from a generated artifact that only the
 * framework's repository writes. Everything else under `pages/` is the demo,
 * kept because each route exercises one family of CSS or one framework feature —
 * delete them as your app takes shape, and this page first of all.
 */
export default function Overview() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-2xl font-semibold text-zinc-50">It runs.</div>
        <div className="text-sm text-zinc-400">
          This window is HTML, CSS and TypeScript compiled to a native UI — no browser engine, no
          DOM, no webview. Layout, paint and the window itself are a Rust engine on SDL3, Skia and
          Taffy; what your code became is a table of integers it renders.
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-5">
          <div className="text-lg font-semibold text-emerald-400">Edit a page</div>
          <div className="text-xs text-zinc-400">
            This page is windows/main/pages/index.tsx. Change some markup or a Tailwind class and
            run `bun run dev` again — a class the compiler cannot handle is a build warning naming
            the property, never a silent no-op.
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-5">
          <div className="text-lg font-semibold text-sky-400">Add a route</div>
          <div className="text-xs text-zinc-400">
            A file under pages/ is a route, matched by path: pages/settings.tsx is `settings`, and
            pages/products/$id.tsx is `products/42`. The nav in Nav.tsx is ordinary markup — add a
            link where the others are.
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-5">
          <div className="text-lg font-semibold text-violet-400">Hold some state</div>
          <div className="text-xs text-zinc-400">
            Signals read bare — no .value, no dependency arrays — and live as module-level exports
            so the compiler can name them. state.ts is the shape to copy.
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-6">
        <div className="text-lg font-semibold text-zinc-50">The routes above</div>
        <div className="text-sm text-zinc-400">
          Each one demonstrates a family of utilities or a framework feature — typography, layout,
          forms, real form controls, keyed lists, reactivity. They are the demo the framework
          develops against, shipped so a fresh app starts with working examples of the sharp edges
          rather than a blank window. Read them, then replace them.
        </div>
      </div>
    </div>
  );
}
