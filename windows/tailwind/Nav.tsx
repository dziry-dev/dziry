/** @jsxImportSource ../../src/compiler */

/**
 * The window's chrome. An ordinary component in the window folder — `pages/` holds
 * routes and nothing else.
 *
 * The links are inert until `<a>` is a tag the compiler accepts; what they are
 * here for is the `hover:` variant, which compiles to an escaped selector
 * (`.hover\:bg-zinc-700:hover`) and a predicate bit rather than anything the
 * runtime resolves.
 */
export function Nav() {
  return (
    <div className="flex flex-row items-center justify-between rounded-xl bg-zinc-900 px-5 py-4">
      <div className="flex flex-col gap-1">
        <div className="text-lg font-semibold text-zinc-50">Tailwind, compiled</div>
        <div className="text-xs text-zinc-400">
          real utility CSS · resolved at build time · no CSS at run time
        </div>
      </div>
      <div className="flex flex-row gap-2">
        <div className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
          Layout
        </div>
        <div className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
          Spacing
        </div>
        <div className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
          Type
        </div>
        <div className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
          Color
        </div>
        <div className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
          Borders
        </div>
      </div>
    </div>
  );
}
