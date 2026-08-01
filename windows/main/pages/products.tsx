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
 * The header reads `router.path.value` inside a template literal, which is the read
 * an author writes without thinking about it. There is no route at build time, so
 * `.value` hands back a marker and the compiler replaces it with a binding on the
 * window's route signal — the surrounding literal survives, and the line updates on
 * navigation. `{router.path}` on its own compiles to the same thing.
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
          a layout route · its children nest by path prefix · {`currently at ${router.path.value}`}
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
