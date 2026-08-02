/** @jsxImportSource ../../../src/compiler */

/**
 * A layout, because it renders an `<Outlet/>`.
 *
 * Nothing declares it one. `products/new` and `products/$id` extend its path, so
 * they nest inside it; that is the only rule. This page stays on screen while they
 * swap underneath, which is what makes it worth being a layout rather than three
 * pages that each repeat the header.
 *
 * The tabs show `useRouter()` doing the thing it exists for: the active one is a
 * conditional class driven by a `computed` over the route, so switching costs
 * style-table writes rather than a re-render of anything.
 *
 * The header renders `{router.path}` on its own rather than inside a template
 * literal, and the difference is worth knowing. A bare brace is resolved by
 * *identity* — the compiler recognises the signal object and emits a binding. An
 * expression is rewritten into a cell instead, and a cell has to be written into the
 * artifact as text, which can only name module exports. `router` is a local from
 * `useRouter()`, so `` {`at ${router.path}`} `` is a build error naming exactly that.
 */
import { cn } from "../../../src/compiler/jsx-runtime.ts";
import { Outlet } from "../../../src/compiler/window.ts";
import { useRouter } from "../../../src/compiler/route.ts";
import { goNewProduct, goProductDetail, onNewProduct, onProductDetail } from "../router.ts";

const TAB = "tab rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700";

export default function Products() {
  const router = useRouter();

  return (
    <div className="card flex flex-col gap-4 rounded-xl bg-zinc-900 p-6">
      <div className="flex flex-col gap-1">
        <div className="heading text-lg font-semibold text-zinc-50">Products</div>
        <div className="muted text-xs text-zinc-400">
          a layout route · its children nest by path prefix · currently at {router.path}
        </div>
      </div>

      <div className="flex flex-row gap-2">
        <button className={cn(TAB, { active: onNewProduct })} onClick={goNewProduct}>
          New
        </button>
        <button className={cn(TAB, { active: onProductDetail })} onClick={goProductDetail}>
          First
        </button>
      </div>

      <Outlet />
    </div>
  );
}
