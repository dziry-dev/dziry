# {{name}}

A [dziri](https://github.com/dziri/dziri) app: HTML, CSS and TypeScript compiled to
a native UI. No browser engine, no DOM, no webview — layout, painting and the window
are a Rust engine built on SDL3, Skia and Taffy.

```
bun run dev      # compile and run
bun run build    # one executable in dist/
bun run check    # tsc
```

## What is here

```
windows/
  env.d.ts       types for `import "./app.css"` — keep it
  main/
    index.tsx      the window — chrome that stays put, with an <Outlet/>
    app.css        the stylesheet, imported by index.tsx
    state.ts       signals and handlers, as module-level exports
    router.ts      the window's route signal and its navigation helpers
    pages/         one file per route, by path
```

`windows/<id>/index.tsx` is a window. `windows/<id>/pages/**` is its routes, matched
by file path — `pages/products/$id.tsx` is `products/$id`. Everything in `windows/`
that ends in `.gen.ts` is compiler output.

## Three things that are not like the web

**A signal reads as its value.** No `.value`, no dependency arrays.

```tsx
const count = signal(0);
count.set(count + 1);        // reads work anywhere, including in handlers
<div>{count * 2}</div>       // a live binding, not a frozen number
```

**Signals passed to markup have to be module-level exports**, because the compiler
reverse-maps the object it was handed back to the name it came from, and a name is
all that survives into the generated artifact. State declared inside a component is
the exception — `const n = signal(0)` in a component body is registered by the
compiler and belongs to that component.

**CSS is resolved at build time.** Selectors, specificity, the cascade and
inheritance all happen in the compiler; what reaches the running app is a table of
integers. A `:hover` rule becomes a second style row and an int swap. There is no
CSS in the process at run time, which is why a class the compiler cannot handle is a
build warning rather than a silent no-op.

## Building for other platforms

`bun run build` embeds the engine built for *this* machine, so the executable it
produces runs here. Shipping for another OS means building there — cross-compilation
and signing are not wired up yet.
