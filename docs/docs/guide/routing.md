---
title: Routing
sidebar_position: 9
---

# Routing

Routes are files. Navigation is a signal. Everything in between is compiled.

## Files become routes

```
windows/main/pages/
  index.tsx          ->  /
  layout.tsx         ->  layout
  products.tsx       ->  products
  products/
    new.tsx          ->  products/new
    $id.tsx          ->  products/$id
```

`index` names the directory it sits in, so `pages/products/index.tsx` also produces
`products` — and that collision is reported as a duplicate rather than quietly
resolved.

A `$` prefix makes a segment a parameter. Static segments beat parameters at the same
depth, so `products/new` matches before `products/$id`.

```bash
bun run routes    # print the table
```

## The route signal

A window owns its route:

```ts title="windows/main/router.ts" no-check
import { signal } from "dziri";

export const route = signal("/");
```

and hands it to `<Window>`:

```tsx no-check
<Window title="…" route={route}>
  <Outlet />
</Window>
```

That is the whole of navigation's plumbing. The host subscribes, looks the path up in
the route table, and writes `hidden` over the routes that left the chain.

It is passed in rather than imported from the framework because a route belongs to a
window — two windows on different routes is the normal case, and a module-level
`currentRoute` inside dziri would make them share one.

## What a route change costs

Nothing is built. Every route in a window compiles into **one** set of tables with a
`hidden` column, so navigating flips `hidden` on the routes that left the chain and
clears it on the ones that joined.

Integer writes, then a repaint.

## Reading the current route

```tsx no-check
const router = useRouter();

<div>You are at {router.path}</div>;
```

### Highlighting the active link

```tsx no-check
<button className={cn("link", { active: router.matches("layout") })}>Layout</button>
```

`matches` is prefix-aware: `matches("products")` holds on `products/new` too, which is
what a nav entry naming a section wants.

:::danger `router.path === "layout"` is always false

`router.path` is a signal, so comparing it to a string is `false` at build time and
stays that way. The nav compiles clean and never highlights.

Use `matches`. For **exact** equality, compare in the window's own module, where the
reactive rewrite runs:

```ts no-check
export const onNewProduct = computed(() => route === "products/new");
export const onProductDetail = computed(() => route === "products/$id");
```

Those are the two cases `matches` would get wrong — tabs *within* a section, where
`matches("products")` is true for both.
:::

`useRouter()` is read-only. Anything derived from the route belongs beside the route as
a `computed`, because a `computed()` created inside a component has no export name for
the generated module to import.

## Typed params

```tsx no-check
export default function ProductDetail() {
  const route = useRoute("products/$id");
  // ...
}
```

The string must match the file's own path under `pages/`. It is what types the params
and nothing else verifies it, so a mismatch is an error naming both paths.

:::warning Params are not live bindings yet

The recorders exist but the emitter does not read them, so a param does not yet produce
a binding that updates. Check `API.md` for status.
:::

## Navigating

There is no `navigate()` yet. A window exports one handler per destination:

```ts no-check
let previous = "/";

function go(path: string): void {
  if (path === route) return;
  previous = route;
  route.set(path);
}

export const goLayout = () => go("layout");
export const goProducts = () => go("products/new");
export const back = () => go(previous);
```

This is not boilerplate to apologise for. A click handler has to be a module-level
export, because the generated artifact imports it by name —
`onClick={() => go("layout")}` at the call site would be a closure created inside a
component, with nowhere to live once components are erased.

`navigate` needs the matcher and a way to pass an argument to a compiled handler. Until
then the repetition is visible and honest rather than hidden behind something that does
not work yet.

History is one entry deep, by decision.

## Link typing

Each window gets an `Href` union generated from its route table, so a typo in a static
segment is caught in the editor. See the [API page](../api/routing.mdx#href) for the limits
of that type — in particular, a parameter in the first segment collapses the union to
`string`.
