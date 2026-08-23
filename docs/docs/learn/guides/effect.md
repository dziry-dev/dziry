---
title: Using Effect
sidebar_position: 1
---

# Using Effect

[Effect](https://effect.website) is a TypeScript library for typed, composable
programs — services, resource management, retries, streams. dziry integrates
with it in five places: handlers, the window layer, validation, `source()`,
and route loaders.

The integration is structural and lazy. dziry recognizes Effect values by
their shape at run time and imports the `effect` package only when your code
actually hands one over — an app that never uses Effect loads none of it.

:::note Installed, but only loaded on use

dziry lists `effect` in its dependencies so its types always resolve (the
generated route types name `Effect<A, E, R>`), but the package is imported
only when a handler returns an Effect, a layer is passed, a schema is used, or
a `source()` returns a Stream.
:::

## Returning an Effect from a handler

A handler that returns an Effect is run on the window's runtime; one that
returns nothing is an ordinary function.

```ts no-check
import { Effect } from "effect";

export const addTodo = () =>
  Effect.gen(function* () {
    const store = yield* AppStore; // a required service — see the window layer below
    yield* Effect.sync(() => store.commit(events.todoAdded({ id, title })));
    draft.set("");
  });
```

dziry detects the returned Effect, runs it to completion, prints the cause if
it fails, and stays silent if it is interrupted. Nothing about Effect is
required until a handler actually returns one.

## Providing services with the window layer

Dependency injection has one root: the window. `<Window layer={layer}>` hands
dziry a `Layer`; a `ManagedRuntime` is built from it at launch and disposed
when the window closes, so `Layer.scoped` resources — a store, a socket —
open while the first frame paints and their finalizers run on quit.

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

A handler requests a service with `yield* Tag`, and the layer satisfies it.
One window, one layer, one runtime.

## Validating with an Effect schema

`validate={schema}` accepts three shapes: a **Standard Schema** (Zod 4,
Valibot, ArkType), an **Effect schema**, or a plain `(data) => issues`
function.

```tsx no-check
<form validate={Login} onSubmit={save}> … </form>
```

An Effect schema is recognized by its `ast` property and converted with
Effect's own `Schema.standardSchemaV1` behind a lazy import — pass it
unwrapped.

## Feeding a signal from a Stream

`source()` creates a signal fed from outside the process. When its subscribe
function returns an Effect `Stream`, dziry runs the stream with
`Stream.runForEach(stream, x => cell.set(x))`, forked in the window scope —
quitting the window interrupts the stream and releases its subscription. The
signal starts at the initial value, and each emission replaces it.

```ts no-check
import { source } from "dziry";
import { Effect, Schedule, Stream } from "effect";

const poll = Effect.promise(() => fetch("/api/notifications").then((r) => r.json()));
const live = Stream.repeatEffect(poll).pipe(Stream.schedule(Schedule.spaced("5 seconds")));

export const notifications = source<Notification[]>(() => live, []);
```

`notifications` is an ordinary `ReadonlySignal<Notification[]>` — bare reads,
`.map` and `bind:value` all work.

Two details worth knowing:

- **The explicit generic states the emission type.** dziry recognizes a
  `Stream` at run time but cannot name `Stream<A>` at the type level (the type
  parameter lives under a symbol only `effect` exports), so the initial value
  and the generic carry the type.
- **The subscribe is a thunk** because a stream may need the window layer's
  services, which do not exist while the module is being imported. dziry calls
  it once the layer is built.

`source` also accepts a plain callback (`(set) => unsubscribe`) that involves
no Effect at all — see [source](../../reference/signals.mdx#source).

## Redirects and cancellation

`Redirect` and `Cancel` are tags a handler can throw — or an Effect can fail
with — to drive the router. They are matched by `_tag`, so the same objects
work whether or not `effect` is installed.

```ts no-check
import { Redirect } from "dziry";
import { Effect } from "effect";

export const guard = () => Effect.fail(new Redirect("login")); // or: throw new Redirect("login")
```

## Route loaders

A route's `loader` may return an `Effect`. Its success value becomes the
component's `data`, and its failure becomes the `errorComponent`'s `error` —
both carried by the generated route types, so
`Effect<Product, DbError, Store>` types `data: Product` and `error: DbError`
with no annotation:

```tsx no-check
// pages/products/$id.tsx
import { defineRoute } from "dziry";
import { Effect } from "effect";

const route = defineRoute("products/$id")({
  loader: ({ id }) => fetchProduct(id), // Effect<Product, DbError, Store>
  component: Product,
  errorComponent: ProductError,
});
export default route;
```

A loader that fails with `Redirect` or `Cancel` navigates or stays; a
superseded loader's result is discarded.
