---
title: Windows
sidebar_position: 2
---

# Windows

A window in dziry is an OS window. Each subdirectory of `windows/` defines
one, and its `index.tsx` default-exports a `<Window>` element.

```tsx no-check
import { Outlet, Window } from "dziry";
import { route } from "./router.ts";

export default function Main() {
  return (
    <Window title="my app" width={1040} height={700} route={route}>
      <Outlet />
    </Window>
  );
}
```

## Configuration is compile-time

`title`, `width`, `height`, `minWidth` and `minHeight` are compile-time
constants: a window's title and size floor are known before the process
starts, so they are ordinary props rather than signals.

`title` is required — the OS shows it in the title bar and the task switcher,
and there is no sensible default. An empty title, or a non-integer or
non-positive size, is a build error.

## The window is the body element

`<Window>` plays the role `<body>` plays on the web. A theme rule written
against `body.light` is toggled by putting the class on the window:

```tsx no-check
<Window title="my app" className={cn({ light: isLight })}>
```

## Each window owns its route

The route signal is defined in your project and passed in:

```ts title="windows/main/router.ts" no-check
import { signal } from "dziry";

export const route = signal("/");
```

```tsx no-check
<Window title="my app" route={route}>
  <Outlet />
</Window>
```

dziry has no global `currentRoute`, because a route belongs to a window and
two windows on different routes is the normal case. `<Outlet />` marks where
the matched page renders. See [Routing](./routing.md) for the route table,
navigation and typed parameters.

## Services and lifetimes

`<Window layer={...}>` accepts an [Effect](../guides/effect.md) `Layer` for
dependency injection: resources open when the window launches and their
finalizers run when it closes. One window, one layer, one runtime.

## Threads

Application code runs in a worker thread; the window itself is serviced by a
separate engine thread. A slow handler cannot freeze the window — input,
resize and repaint keep running while your code works. See
[Two threads](../../architecture/threads.md) for the design.

## See also

- **[Window reference](../../reference/window.mdx)** — the full prop table and types.
