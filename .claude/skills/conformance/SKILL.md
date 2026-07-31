---
name: conformance
description: Measure dziri's CSS against Chrome as an oracle — compile a declaration, compare the emitted style value with getComputedStyle. Use when adding or changing a CSS property in src/compiler/css.ts or STYLE_FIELDS in src/ir.ts, when working on A1 Tailwind coverage, when asked "do we support X correctly", and before claiming any coverage number. Runs `bun run conformance`.
---

# conformance

ROADMAP A1 asks for exactly this: *"compile a utility, diff computed values against
`getComputedStyle`"*, over a **curated** corpus rather than a generated one — because Tailwind's
JIT emits arbitrary values like `min-h-[calc(100vh-4rem)]` that we cannot test and do not support.
Coverage is only meaningful against a defined denominator.

```bash
bun run conformance                    # whole corpus, coverage %
bun run conformance --only padding     # substring filter on declaration or property
bun run conformance --verbose          # show agreements too
```

## How a case works

1. Write `<div class="probe">` plus one rule into a temp html/css pair.
2. Compile with dziri, import the emitted module, read the probe's row out of the style table.
3. Set the same markup and CSS in headless Chrome, read `getComputedStyle`.
4. Normalise both sides and compare.

Step 4 is where the judgement lives, and the normalisers are **part of the spec, not plumbing**.
dziri stores packed ARGB integers and raw floats; Chrome returns `rgb(24, 24, 27)` and `12px`. A
representation mismatch is not a conformance failure — but each normaliser is deliberately strict,
because a lenient one converts a real bug into a pass. If you loosen one, say why in a comment.

## Adding a case

Append to `CORPUS` in `scripts/conformance.ts`:

```ts
{ decl: "padding: 4px 16px", field: "padL", prop: "padding-left", kind: "px" },
```

`field` is the key in the emitted `styles` object (see `STYLE_FIELDS` in `src/ir.ts`), `prop` is
what Chrome reports it under. Only add values the compiler claims to handle — a case for an
unsupported value tests nothing and permanently depresses the number.

## When a case fails, suspect the case first

The first run found `border-width: 2px` disagreeing: Chrome said `0px`, dziri said `2`. Chrome was
right — `border-style` defaults to `none` and a none-border computes to zero width. That turned out
to be a **real divergence** (dziri has no `border-style` at all, so it paints a border where a
browser paints nothing) and it is recorded in `BROWSER-FACTS.md`.

So the order is: is my declaration valid CSS in isolation? Does the property need a companion
declaration to take effect? Only then is it a dziri bug — and if it is, record it in
`BROWSER-FACTS.md` before fixing, because the measurement is the durable part.

## Scope

Uses inline `<style>` via `Page.setDocumentContent`, no server — each case is one rule in one
sheet, so there is nothing for sheet ordering to affect. Questions about *sheet interaction*
(cascade origins, `@layer`, `@import`, UA-vs-author) need a real document and belong in
`browser-oracle` instead.

Shares the CDP client in `scripts/cdp.ts` with the probe runner: installed Chrome or Edge, headless,
no download, throwaway profile cleaned up on exit.
