# dziry

dziry is a framework for building desktop applications in TypeScript, HTML and
CSS — compiled ahead of time, rendered by a native engine. No browser engine,
no DOM, no webview.

> **Beta.** The authoring API is usable and tested, and it is still moving.
> Expect breaking changes between beta releases; each one is called out in the
> release notes.
>
> **Windows, macOS and Linux** (x64 and arm64; Windows is x64 only for now).
> The engine — SDL3, Skia, Taffy — builds and passes its full test suite on all
> three platforms in CI, and each release ships a prebuilt binary per platform
> as an optional dependency, so installing needs no Rust toolchain. Windows is
> where the engine is developed and measured most; a platform-specific bug on
> the others is a bug report we want.

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

- **Windows and routing** — `<Window>`, file-based routes with typed `href`
  checking, loaders (sync, async, or [Effect](https://effect.website)),
  `navigate()`/`back()`
- **State** — signals, computeds, effects, `resource()` with `<Suspense>`,
  `<Show>`, keyed lists with arena-backed reordering
- **Forms** — payload collected by `name`, nested `field` groups, validation
  with any Standard Schema or Effect schema, `:invalid` styling
- **Native-feeling controls** — text input with caret, selection and
  clipboard; checkbox, radio, `<select>` with its picker; keyboard traversal
  and `:focus-visible`
- **Verified against a browser** — CSS behavior is tested against Chrome with
  headless probes, layout diffs and pixel goldens, not implemented from memory

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

The documentation lives at **[dziry.dev](https://dziry.dev)**: a quick start,
the core concepts, the full API reference with per-feature status, and the
architecture behind it.

## What dziry is not

dziry renders applications, not documents. Floats, tables, writing modes,
fragmentation and print are committed non-goals, and the CSS surface is scoped
to what Tailwind emits — coverage is measured by a script in the repository
rather than claimed. Accessibility today means real keyboard operability; an
assistive-technology surface (UIAutomation/NSAccessibility/AT-SPI) is planned
and not yet built.

## License

[MIT](./LICENSE)
