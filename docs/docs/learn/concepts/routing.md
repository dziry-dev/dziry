---
title: Routing
sidebar_position: 3
---

# Routing

Routes are files under `pages/`. Navigation writes a signal. Everything in
between — the route table, the matcher, link checking — is resolved at build
time.

## File-based routes

```
windows/main/pages/
  index.tsx          ->  /
  layout.tsx         ->  layout
  products.tsx       ->  products
  products/
    new.tsx          ->  products/new
    $id.tsx          ->  products/$id
```

`index` names the directory it sits in, so `pages/products/index.tsx` also
produces `products` — the same route `pages/products.tsx` produces. Defining
both is reported as a duplicate rather than silently resolved.

A `$` prefix makes a segment a parameter. Static segments match before
parameters at the same depth, so `products/new` matches before `products/$id`.

## The route signal

Each window owns its route and hands it to `<Window>`:

```ts title="windows/main/router.ts" no-check
import { signal } from "dziry";

export const route = signal("/");
```

```tsx no-check
<Window title="…" route={route}>
  <Outlet />
</Window>
```

The host subscribes to the signal, looks the path up in the route table, and
updates visibility for the routes that entered or left. The signal is defined
in your project rather than imported from dziry because a route belongs to a
window — see [Windows](./windows.md).

## The cost of navigating

Nothing is built when the route changes. Every route in a window is compiled
into one set of tables with a `hidden` column, so navigation flips `hidden`
off for the routes that entered the active chain and on for the ones that
left: integer writes, then a repaint.

## Reading the current route

```tsx no-check
const router = useRouter();

<div>You are at {router.path}</div>;
```

### Highlighting the active link

```tsx no-check
<button className={cn("link", { active: router.matches("layout") })}>Layout</button>
```

`matches` is prefix-aware: `matches("products")` is true on `products/new`
too, which is what a navigation entry that names a section wants.

:::danger `router.path === "layout"` is always false

`router.path` is a signal, so comparing it to a string compares an object to a
string — the result is `false` at build time and stays that way. The build
succeeds and the link never highlights.

Use `matches`. For exact equality, declare a `computed` in the window's own
module, where the reactive rewrite applies:

```ts no-check
export const onNewProduct = computed(() => route === "products/new");
export const onProductDetail = computed(() => route === "products/$id");
```

These cover the case `matches` cannot: tabs *within* a section, where
`matches("products")` is true for both.
:::

`useRouter()` is read-only. Anything derived from the route belongs next to
the route signal as a `computed`, because a `computed` created inside a
component has no export name for the generated module to import.

## Typed parameters

```tsx no-check
export default function ProductDetail() {
  const route = useRoute("products/$id");
  // ...
}
```

The string passed to `useRoute` must match the file's own path under `pages/`
— it is what types the parameters, and a mismatch is an error naming both
paths.

Parameters are live bindings: `{id}` in the component is a signal the router
writes on navigation, so going from `products/1` to `products/2` updates the
text without rebuilding anything.

## Navigating

A link is the ordinary way to navigate. `href` takes a concrete route path,
checked at build time — a path the route table cannot match fails the compile
instead of shipping as a dead link:

```tsx no-check
<a href="products/new">New</a>
```

An `onClick` on a link takes precedence over the synthesized navigation, for
cases where navigating is only part of what the click does.

Outside a link, use `navigate` and `back`:

```ts no-check
import { navigate, back } from "dziry";

export const goLayout = () => navigate("layout");
```

String literals passed to `navigate` are checked against the route table the
same way `href` is; a computed path is yours to get right. History is one
entry deep: `back()` returns to the previous route, and a second `back()`
returns to where you just were.

## Link typing

Each window generates an `Href` union from its route table, so a typo in a
static segment is caught in the editor. See the
[routing reference](../../reference/routing.mdx#href) for the limits of the
type — in particular, a parameter in the first segment widens the union to
`string`.
