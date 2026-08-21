# Route objects — loaders, views and generated typing

Date: 2026-08-16 · Status: implemented · Supersedes data-layer-design.md §4's sibling-file views

## The shape

A route file exports a **route object**, not a bare component:

```tsx
// pages/products/$id.tsx
const route = defineRoute("products/$id")({
  loader: ({ id }) => fetchProduct(id),        // A | Promise<A> | Effect<A, E, R>
  component: Product,
  errorComponent: ProductError,                 // optional — bubbles to parent -> root -> default
  loadingComponent: ProductSkeleton,            // optional
});
export default route;
```

`defineRoute` runs at **module scope** (the compiler imports the page before it knows
which route it is compiling), so it does not check the string itself — the compiler's
`pageModule` does, comparing the stamped `path` against the file's scanned route.
`useRoute`'s check stays where it is, because `useRoute` runs *inside* the component,
during `withPage`.

- `loader` runs on navigation; its params are typed from the generated `RouteParams`.
- `component` reads `data` (success) + params; `errorComponent` reads `error` (failure).
- Both are bindings — the same mechanism as `{args.id}` (a data-cell / error-cell the router writes).
- `errorComponent` absent -> walk the route's parent chain; none anywhere -> a built-in default error view.

## Typing — generated, TanStack-style

`routes.gen.ts` is regenerated on every compile (`dziry dev` and `dziry build` both run the compile;
`dziry routes` regenerates on demand — the `emitRoutes` call already writes it). It imports Effect
from a shipped, type-only re-export, so users never install effect themselves:

```ts
// routes.gen.ts — generated, dev-only
import type { Effect } from "dziry/effect";

export type RouteParams = { "/products/$id": { id: string }; ... };
type LoaderData<F>  = F extends Effect.Effect<infer A, any, any> ? A : Awaited<F>;
type LoaderError<F> = F extends Effect.Effect<any, infer E, any> ? E : unknown;
export type ComponentProps<R>      = { data: LoaderData<R["loader"]> } & RouteParams[R["path"]];
export type ErrorComponentProps<R> = { error: LoaderError<R["loader"]> };
```

`ComponentProps<typeof route>` gives `{ data: A; ...params }`; `ErrorComponentProps` gives `{ error: E }`.
A loader returning `Effect<Product, DbError, Store>` yields `data: Product`, `error: DbError`.

## Zero-dependency, preserved

- `effect` moves from devDependencies -> **dependencies** so its types always resolve.
- A shipped, **type-only** re-export (`dziry/effect`) is the only thing the generated file imports.
- Runtime is unchanged: `effects.ts` still lazy-`import("effect")` behind the property-read specifier,
  so an app that never uses an Effect loads **zero bytes** of it. Installed ≠ loaded.

## Runtime (the data-cell / error-cell)

- `{data.x}` compiles to a **data binding** (`dataBindings`), resolved by `applyDataBindings`
  against the loader's success value — the same mechanism as `{args.id}`'s `paramBindings`,
  reading a recorded path out of the exit rather than a signal.
- `{error.x}` compiles to an **error binding** (`errorBindings`), resolved against the failure value.
- `loadingComponent`'s nodes show while the loader is in flight; `errorComponent`'s on failure.
- A route with no `errorComponent` bubbles to the nearest ancestor that has one; with none anywhere,
  the compiler synthesizes a built-in default error view as that leaf's error roots.
- `Redirect`/`Cancel` -> navigation, not a cell write (already built); a superseded loader's exit
  is ignored by a navigation token.
