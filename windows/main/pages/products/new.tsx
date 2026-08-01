/** @jsxImportSource ../../../../src/compiler */

/**
 * The route at `"products/new"`, nested inside the `products` layout.
 *
 * Static, so it beats `products/$id` for the concrete path `products/new` — which
 * is the emitted match order rather than a rule anything evaluates.
 */
export default function NewProduct() {
  return (
    <div className="panel">
      <div className="body">A static route, sorted before the parameter route beside it.</div>
    </div>
  );
}
