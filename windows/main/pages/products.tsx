/** @jsxImportSource ../../../src/compiler */

/**
 * A layout, because it renders an `<Outlet/>`.
 *
 * Nothing declares it one. `products/new` and `products/$id` extend its path, so
 * they nest inside it; that is the only rule.
 */
import { Outlet } from "../../../src/compiler/window.ts";

export default function Products() {
  return (
    <div className="card">
      <div className="title">Products</div>
      <div className="tabs">
        <div className="tab">New</div>
        <div className="tab">First</div>
      </div>
      <Outlet />
    </div>
  );
}
