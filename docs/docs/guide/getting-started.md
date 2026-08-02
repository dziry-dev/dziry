---
title: Getting started
sidebar_position: 3
---

# Getting started

What [`bun create dziri`](./installation.md) gives you, and what each part is for.

## The layout

A project has a `windows/` directory. Each subdirectory is one OS window.

```
windows/
  env.d.ts           # types for `import "./app.css"` — keep it
  main/
    index.tsx        # the window itself — default-exports a <Window>
    app.css          # the stylesheet, imported by index.tsx
    router.ts        # this window's route signal and navigation handlers
    state.ts         # signals and handlers, exported by name
    pages/
      index.tsx      # route "/"
      layout.tsx     # route "layout"
      products.tsx   # route "products"
      products/
        new.tsx      # route "products/new"
        $id.tsx      # route "products/$id"
```

Routes come from the filenames. `index` names the directory it sits in, so
`pages/index.tsx` is `/` and `pages/products/index.tsx` is `products` — which is also
what `pages/products.tsx` produces, and that collision is reported as a duplicate
rather than silently resolved.

A `$` prefix makes a segment a parameter. Static segments beat parameters at the same
depth, so `products/new` matches before `products/$id`.

## The window

```tsx title="windows/main/index.tsx" no-check
import { cn, Outlet, Window } from "dziri";
import { Nav } from "./Nav.tsx";
import { route } from "./router.ts";
import { isLight } from "./state.ts";

export default function Main() {
  return (
    <Window
      title="dziri — compiled UI"
      width={1040}
      height={700}
      minWidth={520}
      minHeight={400}
      route={route}
      className={cn({ light: isLight })}
    >
      <div className="flex flex-col grow gap-6 p-6">
        <Nav />
        <Outlet />
      </div>
    </Window>
  );
}
```

No `@jsxImportSource` pragma — `jsxImportSource: "dziri"` is set once in
`tsconfig.json`, and Bun's transpiler reads it too, so `bun run` and `tsc` agree.

`title` is required: it is what the OS puts in the title bar and the task switcher,
and there is no sensible default. Sizes are compile-time integers in physical pixels.

`route` is passed **in** rather than imported from the framework. A route belongs to a
window — two windows on different routes is the normal case — so a module-level
`currentRoute` inside dziri would make every window share one.

`<Outlet />` is where the matched page renders.

## State

Signals live in a module and are exported, so the compiler can name them.

```ts title="windows/main/state.ts" no-check
import { computed, signal } from "dziri";

export const draft = signal("");
export const todos = signal<Todo[]>([]);

export const remaining = computed(() => todos.filter((t) => !t.done).length);

export function addTodo(): void {
  const title = draft.trim();
  if (title === "") return;
  todos.set([...todos, { id: nextId++, title, done: false }]);
  draft.set("");
}
```

Note `draft.trim()` and `todos.filter(...)` — the reads are bare. `.set` takes either
a value or a function of the previous value.

## A page

```tsx title="windows/main/pages/index.tsx" no-check
import { cn } from "dziri";
import { addTodo, draft, remaining } from "../state.ts";

export default function Home() {
  return (
    <div className="flex flex-col gap-4">
      <div className="text-lg font-semibold">{remaining} left</div>
      <div className="rounded-lg bg-zinc-800 px-3 py-2" bindValue={draft} />
      <button className="rounded bg-sky-600 px-3 py-2" onClick={addTodo}>
        Add
      </button>
    </div>
  );
}
```

A page default-exports a component. That is the whole contract.

## Running it

```bash
dziri dev                                   # compile every window, then run
dziri dev --route products/new --size 520x700
dziri dev --screenshot shot.png             # one frame headlessly, then exit
```

`dev` compiles every window into its `ui.gen.ts` artifact and opens the app. A
window's stylesheets are the ones its modules import, and Tailwind — your project's
own copy — runs over them during the compile. Anything the CLI does not recognise is
passed to the app.

In a framework checkout these are `bun run cli <command>`, and the engine must be built
once with `bun run engine`.

See [The CLI](./cli.md) for every command and flag, including `dziri build`.

Your application code runs in a Worker, not on the thread that owns the window — so a
slow handler cannot freeze the UI. See [Two threads](../internals/threads.md).

## What you will hit first

**"A signal created inside a component has nowhere to live."** Move it to a module and
export it — or, if it really is local to one component, see
[component-local state](./reactivity.md#component-local-state), which does work.

**A conditional class does nothing.** Use `cn`, not a string. `className={"btn " + (isBig ? "big" : "")}`
evaluates at build time against a signal object and freezes. See [Styling](./styling.md).

**`router.path === "layout"` is always false.** It compares a signal to a string. Use
`router.matches("layout")`. See [Routing](./routing.md).
