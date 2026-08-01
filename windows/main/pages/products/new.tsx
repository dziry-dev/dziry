/** @jsxImportSource ../../../../src/compiler */

/**
 * The route at `"products/new"`, nested inside the `products` layout.
 *
 * Static, so it beats `products/$id` for the concrete path `products/new` — which
 * is the emitted match order rather than a rule anything evaluates at run time.
 */
export default function NewProduct() {
  return (
    <div className="sunken flex flex-col gap-2 rounded-lg bg-zinc-950 p-4">
      <div className="heading text-sm font-semibold text-zinc-100">New product</div>
      <div className="muted text-xs text-zinc-400">
        A static route. It sorts before the parameter route beside it, so a matcher that stops at
        the first hit gets static-beats-param for free.
      </div>
    </div>
  );
}
