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
import { signal } from "dziry";

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
`currentRoute` inside dziry would make them share one.

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

Params are live bindings: `{id}` in the component is a signal the router writes on
navigation, so navigating from `products/1` to `products/2` updates the text without
recompiling anything.

## Navigating

A link is the ordinary way. `href` is a concrete route path, checked at build time —
a path the route table cannot answer for fails the compile rather than shipping as a
click that silently does nothing — and a checked link navigates by itself:

```tsx no-check
<a href="products/new">New</a>
```

An `onClick` on the link wins over the synthesized navigation, for the cases where
navigating is only part of what the click does.

For navigation outside a link, `navigate` and `back` come from `dziry`:

```ts no-check
import { navigate, back } from "dziry";

export const goLayout = () => navigate("layout");
```

`navigate("…")` literals in handlers are checked against the route table the same way
`href` is; a computed path is the author's to get right. History is one entry deep, by
decision — `back()` returns to the previous route, and a second `back()` returns to
where you just were, not anywhere older.

## Link typing

Each window gets an `Href` union generated from its route table, so a typo in a static
segment is caught in the editor. See the [API page](../api/routing.mdx#href) for the limits
of that type — in particular, a parameter in the first segment collapses the union to
`string`.
