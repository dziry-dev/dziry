---
title: Effect
sidebar_position: 8
---

# Effect

[Effect](https://effect.website) is a TypeScript library for typed, composable
computations. dziri recognises Effect values *structurally* and imports the package
*lazily*, so an app that never hands one over never loads a byte of it. This page is
the whole of dziri's Effect support in one place.

Four things you can do with Effect today: run it from a handler, inject it through the
window layer, validate with it, and stream it into a signal.

:::note Installed, never loaded

dziri carries `effect` in its dependencies so its *types* always resolve — the
generated route types name `Effect<A, E, R>` — but the package is *imported* only
when your code actually hands one over: a handler's return value, a layer, a schema,
or a `source()`. An app that never uses one loads zero bytes of it. Installed ≠
loaded.
:::

## Handlers may return an Effect

A handler that returns an Effect is run on the window's runtime; one that returns
nothing is an ordinary function.

```ts no-check
import { Effect } from "effect";

export const addTodo = () =>
  Effect.gen(function* () {
    const store = yield* AppStore; // a required service — see below
    yield* Effect.sync(() => store.commit(events.todoAdded({ id, title })));
    draft.set("");
  });
```

dziri detects the returned Effect, runs it to completion, prints the cause when it
fails, and stays silent when it is interrupted. Nothing about Effect is required until
a handler actually returns one.

## The window layer

Dependency injection has one root: the window. `<Window layer={layer}>` hands dziri a
`Layer`; it builds a `ManagedRuntime` from it at launch and disposes it when the
window closes, so `Layer.scoped` resources (a store, a socket) open while the first
frame paints and their finalizers run on quit.

```ts no-check
import { Effect, Layer } from "effect";

export const layer = Layer.scoped(
  AppStore,
  Effect.acquireRelease(
    Effect.promise(() => createStorePromise({ schema })),
    (store) => Effect.promise(() => store.shutdownPromise()),
  ),
);
```

```tsx no-check
<Window title="todos" width={560} height={680} layer={layer}>
```

A handler asks for a service with `yield* Tag`; the layer satisfies it. One window =
one layer = one runtime.

## Validate with an Effect schema

`validate={schema}` accepts three shapes: a **Standard Schema** (Zod 4, Valibot,
ArkType), an **Effect schema**, or a plain `(data) => issues` function.

```tsx no-check
<form validate={Login} onSubmit={save}> … </form>
```

An Effect schema is recognised by its `ast` and converted with Effect's own
`Schema.standardSchemaV1` after a lazy import — so `validate={Login}` works
unwrapped, without dziri importing `effect` itself.

## `source()` — a signal from a Stream

`source()` is dziri's push primitive — a signal fed from outside. The Effect shape is
a subscribe that returns a `Stream`; dziri recognises it structurally and forks
`Stream.runForEach(stream, x => cell.set(x))` in the window scope, so quitting
interrupts it and releases its subscription. The signal starts at the initial value
and each emission replaces it.

```ts no-check
import { source } from "dziri";
import { Effect, Schedule, Stream } from "effect";

const poll = Effect.promise(() => fetch("/api/notifications").then((r) => r.json()));
const live = Stream.repeatEffect(poll).pipe(Stream.schedule(Schedule.spaced("5 seconds")));

export const notifications = source<Notification[]>(() => live, []);
```

`notifications` is an ordinary `ReadonlySignal<Notification[]>` — bare reads,
`.map` and `bind:value` all work. The explicit generic states the emission type,
because dziri is type-blind to `effect` by design: it can recognise a `Stream` at
run time but cannot name `Stream<A>` to infer `A` (the type parameter lives under a
`unique symbol` only `effect` exports). The initial value carries the type.

The subscribe is a thunk because a stream needs the window layer's live services,
which do not exist while the module is evaluated — the runtime calls it once the
layer is built. `source` also accepts a plain callback (`(set) => unsubscribe`) that
needs no Effect; see [Signals](../api/signals.mdx#source).

## Navigation as control flow

`Redirect` and `Cancel` are tags a handler throws — or an Effect fails with — to
drive the router. Matching is by `_tag`, so the same objects work in a project that
has never installed `effect` and in one that has.

```ts no-check
import { Redirect } from "dziri";
import { Effect } from "effect";

export const guard = () => Effect.fail(new Redirect("login")); // or: throw new Redirect("login")
```

## Route loaders

A route object's `loader` may return an `Effect`; its success value is the
component's `data`, and its failure is the `errorComponent`'s `error` — both resolved
by the generated types, so `Effect<Product, DbError, Store>` types `data: Product`
and `error: DbError` with no manual annotation:

```tsx no-check
// pages/products/$id.tsx
import { defineRoute } from "dziri";
import { Effect } from "effect";

const route = defineRoute("products/$id")({
  loader: ({ id }) => fetchProduct(id), // Effect<Product, DbError, Store>
  component: Product,
  errorComponent: ProductError,
});
export default route;
```

`dziri` still never imports `effect` itself — it recognises the returned `Effect`
structurally and runs it through a lazy import, so a window with no Effect loader
loads zero bytes of the library. A loader that fails with `Redirect`/`Cancel`
navigates or stays; a superseded loader's exit is ignored.
