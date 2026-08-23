---
title: Project structure
sidebar_position: 3
---

# Project structure

A dziry project has a `windows/` directory, and each subdirectory of it is one
OS window.

```
windows/
  env.d.ts           # type declarations for `import "./app.css"`
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

Routes come from filenames. `index` names the directory it sits in, so
`pages/index.tsx` is `/` and `pages/products/index.tsx` is `products` — the
same route `pages/products.tsx` would produce, and defining both is reported
as a duplicate. A `$` prefix makes a segment a parameter, and static segments
match before parameters at the same depth, so `products/new` wins over
`products/$id`. See [Routing](../concepts/routing.md).

## The window

```tsx title="windows/main/index.tsx" no-check
import { cn, Outlet, Window } from "dziry";
import { Nav } from "./Nav.tsx";
import { route } from "./router.ts";
import { isLight } from "./state.ts";

export default function Main() {
  return (
    <Window
      title="dziry — compiled UI"
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

Three things to notice:

- **`title` is required.** It is what the OS shows in the title bar and the
  task switcher, and there is no sensible default. Sizes are compile-time
  integers in physical pixels.
- **`route` is passed in, not imported from the framework.** A route belongs
  to a window — two windows on different routes is the normal case — so dziry
  has no global `currentRoute`.
- **`<Outlet />`** is where the matched page renders.

There is no `@jsxImportSource` pragma in any file: `jsxImportSource: "dziry"`
is set once in `tsconfig.json`, and Bun's transpiler reads it too, so `bun run`
and `tsc` agree.

## State

Signals live in a module and are exported, so the compiler can refer to them
by name:

```ts title="windows/main/state.ts" no-check
import { computed, signal } from "dziry";

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

Note that reads are plain identifiers — `draft.trim()`, `todos.filter(...)`.
`.set` takes either a value or a function of the previous value.

## A page

```tsx title="windows/main/pages/index.tsx" no-check
import { cn } from "dziry";
import { addTodo, draft, remaining } from "../state.ts";

export default function Home() {
  return (
    <div className="flex flex-col gap-4">
      <div className="text-lg font-semibold">{remaining} left</div>
      <input type="text" className="rounded-lg bg-zinc-800 px-3 py-2" bind:value={draft} />
      <button className="rounded bg-sky-600 px-3 py-2" onClick={addTodo}>
        Add
      </button>
    </div>
  );
}
```

A page default-exports a component. That is the whole contract.

## Running the app

```bash
dziry dev                                   # compile every window, then run
dziry dev --route products/new --size 520x700
dziry dev --screenshot shot.png             # render one frame headlessly, then exit
```

`dev` compiles each window into its generated module (`ui.gen.ts`) and opens
the app. In a framework checkout, use `bun run cli <command>` instead, and
build the engine once with `bun run engine`.

Your application code runs in a worker thread, separate from the thread that
owns the window, so a slow handler cannot freeze the UI. See
[Two threads](../../architecture/threads.md).

## Common first errors

**"A signal created inside a component has nowhere to live."** Move the signal
to a module and export it — or, if it belongs to one component, see
[component-local state](../concepts/reactivity.md#component-local-state).

**A conditional class does nothing.** Use `cn`, not string concatenation.
`className={"btn " + (isBig ? "big" : "")}` is evaluated at build time against
a signal object and never updates. See [Styling](../concepts/styling.md).

**`router.path === "layout"` is always false.** It compares a signal object to
a string. Use `router.matches("layout")`. See [Routing](../concepts/routing.md).
