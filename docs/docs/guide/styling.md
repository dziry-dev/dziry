---
title: Styling
sidebar_position: 5
---

# Styling

Real CSS, resolved at build time. Tailwind v4 is the intended way to write it, and
the pipeline runs the actual Tailwind CLI — not a reimplementation.

## How it works

`bun run tw:css` runs `@tailwindcss/cli` over your source and produces an ordinary
stylesheet. dziri's compiler then resolves that stylesheet against your tree:
selectors match, specificity sorts, inheritance applies, shorthands expand, units
convert.

What comes out is a style table of integers and floats. The engine never sees a
selector.

A utility that dziri cannot compile makes the build **say so**, naming the property.
That is the honest part: a page that renders is a page whose utilities work.

## Static classes

```tsx
<div className="flex flex-col gap-6 rounded-xl bg-zinc-900 p-6" />;
```

Nothing special. These resolve to a style id at build time.

## Conditional classes

Use `cn`. Not string concatenation.

```tsx
const isBig = signal(false);
const isLight = signal(false);

<div className={cn("box rounded-lg px-4 py-2", { active: isBig })} />;
<div className={cn({ light: isLight })} />;
```

`cn` does **not** return a string. By the time a conditional class is a string, the
connection to the signal driving it is gone — and the compiler needs that connection
to resolve the class both ways ahead of time.

So the class is compiled with the flag on and with it off, and flipping it costs a few
integer writes into the style table. No string comparison, no selector matching, and
nothing per frame.

```tsx no-check
// Wrong: evaluates a signal object at build time and freezes that way.
<div className={"box " + (isBig ? "big" : "")} />
```

That compiles cleanly and never updates, which is the failure mode this project treats
as worse than a crash.

## Inline styles

```tsx
<div style="color: red; padding: 8px" />;
<div style={{ color: "red", padding: 8, fontWeight: 600 }} />;
```

A number means pixels, except for genuinely unitless properties — `fontWeight`,
`flexGrow`, `flexShrink`, `flex`, `aspectRatio`, `gridColumn`, `gridRow`, `zIndex`,
`opacity`, `lineClamp`. The same rule React uses.

Inline styles beat every selector, the same precedence a browser gives them, and both
forms cost the runtime nothing.

A non-static value is a **build error**, not a silent drop — there is no node left to
attach it to. Use a conditional class.

## Variants

Pseudo-state variants like `hover:` work, and they work without run-time selector
matching. Each interactive node carries a bitmask of the predicates its styling reads,
plus an offset into a run of precompiled style ids. Hovering costs one `u16`.

The cascade is resolved *per pseudo-state from scratch* rather than as a patch over the
base, which is what makes correct per-property `hover ∧ focus` merging cheap.

## Coverage

dziri supports a subset of CSS, and the subset is defined by what Tailwind emits.

Do not trust a number written in prose — measure it:

```bash
bun run tailwind-coverage   # what fraction works, and what is blocking the rest
bun run css-coverage        # supported / unsupported / committed non-goal
bun run conformance         # compare emitted values against a browser
```

`tailwind-coverage` also ranks the blockers by how many classes each would unblock,
which is how the next thing to implement gets chosen.

## Known gaps

These are the ones you will notice first. Check the coverage runners for the current
list rather than trusting this one.

- `line-height` is unsupported, so `text-sm` and `text-lg` set their font size and
  warn about the line height that comes with them.
- `@media (hover: hover)`, `@property` and `@supports` are skipped at-rules.
- `mask-image` and `mask-composite` are the largest blockers by class count, then
  `calc()` over percentages and viewport units.

## Why not Tailwind's preflight

dziri ships its own user-agent stylesheet. Tailwind's reset is written in selectors
dziri does not have — `:host`, `*`, `::before`, `[hidden]` — and it is optional by
design. So the entry imports `theme.css` and `utilities.css` rather than the umbrella
`@import "tailwindcss"`.

The entry also uses `source(none)` with explicit `@source` directives. Otherwise
Tailwind scans the whole project, finds class-shaped strings inside the compiler's own
TypeScript, and emits utilities no page uses — which inflates the sheet and makes any
coverage claim meaningless.
