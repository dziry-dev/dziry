/**
 * The route at "products/$id", as a route object.
 *
 * defineRoute stamps the path on the object, which is what lets the generated
 * ComponentProps<typeof route> resolve `data` and `id` — from the loader's return
 * and the route's parameters, respectively. The string is checked against the file
 * during compilation, so a rename that is not mirrored fails the build.
 *
 * `loader` runs on navigation (here synchronous; it may also be async or an
 * Effect). Its success value is the `data` the component reads — `{data.title}` is
 * a data-cell binding the router writes when the loader settles. `errorComponent`
 * is shown on failure, and `loadingComponent` while the loader is in flight.
 */
import { defineRoute } from "dziry";
import type { ComponentProps, ErrorComponentProps } from "dziry";

type Product = { title: string; price: string };

const route = defineRoute("products/$id")({
  loader: ({ id }): Product => ({ title: `Product #${id}`, price: "$12.00" }),
  component: ProductDetail,
  errorComponent: ProductError,
  loadingComponent: ProductSkeleton,
});

export default route;

function ProductDetail({ data, id }: ComponentProps<typeof route>) {
  return (
    <div className="sunken flex flex-col gap-2 rounded-lg bg-zinc-950 p-4">
      <div className="heading text-sm font-semibold text-zinc-100">
        {data.title} <span className="muted text-zinc-500">#{id}</span>
      </div>
      <div className="muted text-xs text-zinc-400">
        {data.price} — the loader's success value, read through a data-cell binding.
      </div>
    </div>
  );
}

function ProductSkeleton() {
  return (
    <div className="sunken flex flex-col gap-2 rounded-lg bg-zinc-950 p-4">
      <div className="heading text-sm font-semibold text-zinc-100">Loading product…</div>
    </div>
  );
}

function ProductError({ error }: ErrorComponentProps<typeof route>) {
  return (
    <div className="sunken flex flex-col gap-2 rounded-lg bg-zinc-950 p-4">
      <div className="heading text-sm font-semibold text-red-400">Failed to load</div>
      <div className="muted text-xs text-zinc-400">{error as string}</div>
    </div>
  );
}
