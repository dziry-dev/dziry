---
title: Styling
sidebar_position: 5
---

# Styling

dziry apps are styled with real CSS, resolved at build time. Tailwind v4 is
the intended authoring layer, and the build runs the actual Tailwind — your
project's own copy, not a reimplementation.

## How stylesheets are processed

A stylesheet reaches the compiler by being imported, as in any web project:

```tsx
// windows/main/index.tsx
import "./app.css";
```

Multiple imports cascade in the order the module graph evaluates them, so a
sheet imported later wins ties. An inline `style={{ … }}` beats both, with the
same precedence a browser gives it.

If a stylesheet uses Tailwind, the compiler runs your project's `tailwindcss`
dependency over it during the build — `@import "tailwindcss"` resolves against
your `node_modules`, so your version is the one that runs, and nothing is
written to disk:

```css
/* windows/main/app.css */
@import "tailwindcss";
```

The compiler then resolves the result against your tree: selectors match,
specificity sorts, inheritance applies, shorthands expand, units convert. The
output is a style table of integers and floats; the engine never sees a
selector.

A utility the compiler cannot handle produces a **build warning naming the
property** — a page that compiles without warnings is a page whose utilities
all work.

## Static classes

```tsx
<div className="flex flex-col gap-6 rounded-xl bg-zinc-900 p-6" />;
```

Static classes resolve to a style id at build time. Nothing further to know.

## Conditional classes

Use `cn`, not string concatenation:

```tsx
const isBig = signal(false);
const isLight = signal(false);

<div className={cn("box rounded-lg px-4 py-2", { active: isBig })} />;
<div className={cn({ light: isLight })} />;
```

`cn` does not return a string. The compiler needs the connection between the
class and the signal that drives it, so it can resolve the class both ways
ahead of time — once a conditional class has become a string, that connection
is gone. Flipping the signal at run time costs a few integer writes into the
style table.

```tsx no-check
// Wrong: evaluated once at build time against a signal object; never updates.
<div className={"box " + (isBig ? "big" : "")} />
```

The concatenated form compiles without error and never updates — watch for it.

## Inline styles

```tsx
<div style="color: red; padding: 8px" />;
<div style={{ color: "red", padding: 8, fontWeight: 600 }} />;
```

A bare number means pixels, except for the genuinely unitless properties —
`fontWeight`, `flexGrow`, `flexShrink`, `flex`, `aspectRatio`, `gridColumn`,
`gridRow`, `zIndex`, `opacity`, `lineClamp` — the same convention React uses.

Inline styles beat every selector, and both forms cost the runtime nothing.

A non-static inline value is a **build error**, not a silent drop: once the
components are gone there is no node to update. Use a conditional class
instead.

## State variants

Pseudo-class variants like `hover:` work without any run-time selector
matching. Each interactive node carries a bitmask of the predicates its
styling reads, plus an offset into a run of precompiled style ids — hovering
costs one 16-bit write.

The supported set is `:hover`, `:active`, `:focus`, `:focus-visible`,
`:checked`, `:disabled`, `:open` and `:invalid`. Most are the engine's own
knowledge of pointer and focus; `:invalid` is driven by your code — a
`validate={…}` runs, and a rejected field carries the bit until the next
validation clears it.

The cascade is resolved per pseudo-state from scratch rather than as a patch
over the base state, which is what makes per-property `hover` + `focus`
merging correct.

:::note Predicates are per node; conditional classes are per style row

The difference shows up in lists. Rows are compiled once and replicated, so
every replica shares one style row — a conditional class on a row's input is
the same class on all of them. A predicate is resolved per node against the
controls table, where each replica has its own entry — so `:invalid` can be
true for row 3 and false for row 4, and `cn("x", { on: sig })` cannot.
:::

## CSS coverage

dziry supports a subset of CSS, scoped to what Tailwind emits. The coverage is
measured, not estimated:

```bash
bun run tailwind-coverage   # what fraction works, ranked by what blocks the rest
bun run css-coverage        # supported / unsupported / committed non-goal
bun run conformance         # compare emitted values against a browser
```

### Known gaps

The gaps you are most likely to notice — check the coverage runners for the
current list:

- `line-height` is unsupported, so `text-sm` and `text-lg` set the font size
  and warn about the line height they carry.
- `@media (hover: hover)` and `@supports` are skipped. `@property` is not: its
  `initial-value` is read, which is what makes Tailwind's `--tw-*` variables
  resolve.
- `::selection` accepts `background-color` and `color` only — the same short
  list CSS gives highlight pseudo-elements, since a selection is a range, not
  a box.
- `box-shadow` supports the ring subset only: no offset, no blur, a solid
  spread. Every `ring-*`, `inset-ring-*` and `ring-offset-*` utility works;
  `shadow-md` warns and draws nothing.
- `mask-image` and `mask-composite` are the largest unimplemented blockers by
  class count, followed by `calc()` over percentages and viewport units.

## The user-agent stylesheet

dziry ships its own user-agent stylesheet rather than Tailwind's preflight —
the preflight is written with selectors dziry does not implement (`:host`,
`*`, `::before`, `[hidden]`) and is optional by design. The template's entry
stylesheet therefore imports `theme.css` and `utilities.css` rather than the
umbrella `@import "tailwindcss"`, and restricts scanning with `source(none)`
plus explicit `@source` directives so Tailwind only generates utilities your
pages actually use.
