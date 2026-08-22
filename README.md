# dziry

A UI framework for building **real desktop apps** with TypeScript, HTML and CSS —
compiled ahead of time, rendered by a native engine. No browser engine, no DOM,
no webview.

> **Beta.** The authoring API is usable and tested, and it is still moving.
> Expect breaking changes between beta releases; each one is called out in the
> release notes.
>
> **Windows x64 only, today.** The engine is written on cross-platform stock
> (SDL3, Skia, Taffy) and carries no Windows assumptions, but it has only ever
> been built and measured on Windows — and this project does not claim what it
> has not measured. The compiler runs anywhere Bun does; it is the native window
> that needs a platform binary. macOS and Linux are in progress.

```tsx
import { signal, computed, Show, Window } from "dziry";

export const count = signal(0);
export const label = computed(() => `clicked ${count} times`);

export default function Main() {
  return (
    <Window title="hello">
      <button className="rounded bg-blue-600 px-4 py-2 text-white" onClick={() => count.set(count + 1)}>
        {label}
      </button>
      <Show when={count > 5} fallback={<p>keep going…</p>}>
        <p>that's plenty.</p>
      </Show>
    </Window>
  );
}
```

## How it works

Your app is TypeScript, JSX and CSS (Tailwind works as an ordinary dependency).
A compiler running on [Bun](https://bun.com) resolves the cascade, specificity,
inheritance and layout styles **at build time**, and emits a compact binary IR.
A native engine — Rust, with [Skia](https://skia.org) for paint,
[Taffy](https://github.com/DioxusLabs/taffy) for flex/grid layout, and SDL3 for
the window — renders it. The two sides share memory: a style change, a list
reorder or a route switch is a handful of direct byte writes, and a frame is one
call.

The governing rule: **everything is assumed to be compile-time unless proven it
must stay dynamic.** `:hover` is a precomputed style variant picked by an
integer. A media query is evaluated engine-side between the resize and the
relayout. Reactivity is bare signal reads (`count * 2`, no `.value`, no
dependency arrays) rewritten at build time. What remains at runtime is current
state — and the runtime is held to a byte-count ratchet in CI.

- **Windows and routing** — `<Window>`, file-path routes with typed `href`
  checking, loaders (sync, async, or [Effect](https://effect.website)),
  `navigate()`/`back()`
- **State** — signals, computeds, effects, `resource()` with `<Suspense>`,
  `<Show>`, keyed lists with arena-backed reordering
- **Forms** — payload by `name`, nested `field` groups, validation with any
  Standard Schema, `:invalid` styling
- **Native-feeling controls** — text input with caret/selection/clipboard,
  checkbox, radio, `<select>` with its picker; keyboard traversal, `:focus-visible`
- **Discipline** — behaviour is measured against Chrome (headless probes,
  layout diff, pixel goldens), never recalled

## Getting started

Requires [Bun](https://bun.com) ≥ 1.4.

```sh
bun create dziry my-app
cd my-app
bun install
bun run dev
```

`dziry dev` opens the window with hot reload; `dziry build` produces a single
executable.

## Documentation

The docs live at **[dziry.dev](https://dziry.dev)** — a getting-started guide,
the full authoring API, and the design notes behind the decisions.

## What it is not

dziry is a UI framework, not a browser. Floats, tables, writing modes,
fragmentation and print are committed non-goals; the CSS surface is scoped to
what Tailwind emits, measured and reported as a percentage rather than claimed.
Accessibility today means real keyboard operability — an assistive-technology
surface (UIAutomation/NSAccessibility/AT-SPI) is on the roadmap and not yet
built.

## License

[MIT](./LICENSE)
