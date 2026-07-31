# Browser facts — measured, not remembered

dziri repeatedly has to answer *"what does a browser actually do here?"* — for focus, cascade,
list markers, form controls, scroll anchoring, IME. Recalled answers are wrong often enough to
be dangerous, so every answer here is **measured** and stamped with the engine and version.

Run new probes with the `browser-oracle` skill. Append results; never overwrite.

> Distinct from A1's Tailwind conformance harness, which is an automated `getComputedStyle` diff
> over a curated utility corpus. This file is for one-off behavioural questions.

---

## Focus when a focused element is hidden or removed

**Measured 2026-07-31 · Chromium 151 (via Edge 151) · headless, `bun run probe focus-removal`.**

| Mutation | `document.activeElement` after | `blur`/`focusout` fired |
|---|---|---|
| `el.remove()` | **BODY** | **yes** |
| remove an ancestor subtree | **BODY** | **yes** |
| detach + immediately re-insert the same node | **BODY** | **yes** |
| `el.disabled = true` | **BODY** | **yes** |
| `el.style.display = "none"` | **unchanged — still the element** | no |
| ancestor `display: none` | **unchanged** | no |
| ancestor `visibility: hidden` | **unchanged** | no |
| ancestor `hidden` attribute | **unchanged** | no |
| ancestor `inert` | **unchanged** | no |

1. **Removal clears focus to `BODY`; hiding does not.** A `display:none` element stays
   `document.activeElement` — not tabbable (`offsetParent === null`), but still holding focus.
   It is released only when something else takes focus. Widely treated as a Blink wart; UI
   libraries call `blur()` manually before hiding.
2. **Removal is destructive even if you put the node straight back.** Detach and re-insert the
   *same node object* in the same tick and focus is still `BODY`. Re-showing a hidden element,
   by contrast, restores it seamlessly because focus was never lost.
3. **Removal does notify.** `blur` and `focusout` both fire.

> **Corrected 2026-07-31, same day.** An earlier extension-driven run of this probe reported
> `events=[none]` on all four removal cases and that claim was published here and used to justify
> an API divergence. It was wrong: the tab being driven was backgrounded, and Chrome suppresses
> focus events when the document does not have OS focus. Headless CDP always has document focus
> and reports the events. **Probes must run through `bun run probe`, never by injecting into a
> live tab** — the contamination is silent and looks like a real finding.

**Unresolved:** whether a `keydown` dispatched at a `display:none` element reaches it. Two runs
disagreed, and reading `document.activeElement` around the dispatch appears to perturb the
result. Needs a probe that observes without touching `activeElement`. Not currently
decision-bearing.

**Bearing on dziri:** collapse is a `hidden` byte, i.e. `display:none` semantics — so copying
Chromium literally would strand focus on an invisible node that still swallows keystrokes. And
recycling a row and re-seating the same item does *not* restore focus under browser rules, so
keying focus to the logical item is **better than** the platform, not equivalent to it.

---

## `border-width` does nothing without `border-style`

**Measured 2026-07-31 · Chromium 151 · `bun run conformance` (first run, found immediately).**

| Declared | Chrome computed `border-top-width` | dziri |
|---|---|---|
| `border-width: 2px` | **0px** | 2 |
| `border: 2px solid #3f3f46` | 2px | 2 |

`border-style` defaults to `none`, and a `none` border computes to width `0` regardless of what
`border-width` says. So bare `border-width` paints nothing in a browser.

**Bearing on dziri:** there is no `border-style` field in `STYLE_FIELDS`, and `expand()` in
`css.ts` has no `border-style` case — so dziri paints a 2px border where a browser paints none.
A web developer copying CSS in will hit this. Options are to add `border-style` (at minimum
`none | solid`, since that is the meaningful distinction here), or to treat a `border-width`
with no style as zero. The second is cheaper and matches the browser; the first is needed anyway
the moment anyone writes `border-style: dashed`.

---

## `overflow` on one axis changes the computed value of the other

**Measured 2026-07-31 · Chromium 151 (via Edge 151) · headless, `bun run probe overflow-axis-coercion`.**
Two runs, identical.

| Declared | computed `overflow-x` | computed `overflow-y` |
|---|---|---|
| `overflow-y: auto` | **auto** | auto |
| `overflow-y: scroll` | **auto** | scroll |
| `overflow-y: hidden` | **auto** | hidden |
| `overflow-y: clip` | **visible** | clip |
| `overflow-x: auto` | auto | **auto** |
| `overflow-x: visible; overflow-y: auto` (explicit!) | **auto** | auto |
| `overflow-x: visible; overflow-y: hidden` (explicit!) | **auto** | hidden |
| `overflow-x: visible; overflow-y: clip` (explicit!) | **visible** | clip |
| `overflow-x: visible; overflow-y: visible` | visible | visible |

1. **`visible` cannot survive next to a scroll-container value.** If one axis is `auto`,
   `scroll` or `hidden`, a `visible` on the other axis computes to **`auto`** — even when the
   author wrote `visible` explicitly. So `body { overflow-y: auto }` makes a page scrollable in
   *both* directions.
2. **`clip` is the exception.** `overflow-y: clip` leaves `overflow-x: visible` alone. `clip` is
   not a scroll container, so there is nothing for the other axis to have to co-operate with —
   which is exactly why `clip` exists as distinct from `hidden`.

### The same probe on a too-narrow layout

Two `1fr` tracks in a 300px viewport, holding one unbreakable word. **Geometry was byte-identical
under all four overflow configurations** — `cardA` measured 340px inside a ~125px track in every
case, bursting its own grid track:

| viewport declaration | max `scrollLeft` reached |
|---|---|
| `overflow-y: auto` | **129** — the rest is reachable |
| nothing declared (both visible) | **0** — clipped, unreachable |
| `overflow-x: hidden; overflow-y: auto` | 129 |
| `overflow-y: auto` + `min-width: 0` on the flex text | 129 |

3. **Overflow does not change layout, only reachability.** A grid item whose content cannot shrink
   overflows its track identically whether or not anything scrolls.
4. **`min-width: 0` on the flex text did not help**, which contradicts the usual folklore: the
   card's *min-content contribution* still includes the unbreakable word, so the track still
   overflows. Fixing that needs `overflow: hidden` or a word-break, not `min-width`.

**Bearing on dziri — this refuted a decision, it did not confirm one.** `overflowX`/`overflowY`
were implemented as independent fields taking `visible` literally, and `app.css` sets only
`overflow-y: auto` on the body. Chromium computes `overflow-x: auto` there; dziri computed
`visible`, so a too-narrow window clipped the right-hand column with no way to reach it — which
is what was reported. The layout was never wrong; the *reachability* was. Fixing it is the
coercion rule, applied where computed values are resolved, plus a distinct `CLIP` value so the
one keyword that must **not** coerce can be told apart from `hidden`.

---

## What a scrollbar costs in layout room

**Measured 2026-07-31 · Chromium 151 (via Edge 151) · headless, `bun run probe scrollbar-gutter`.**
Two runs at dpr 1 and dpr 2, identical.

`gutter = offsetSize - clientSize` on a fixed 100x100 box. `scrollable` is whether the box
actually had anywhere to scroll.

| Declared | vertical gutter | horizontal gutter | scrollable |
|---|---|---|---|
| `overflow-y: auto`, content taller | **15** | 0 | yes |
| `overflow-y: auto`, content fits | **0** | 0 | no |
| `overflow-y: scroll`, content taller | 15 | 0 | yes |
| `overflow-y: scroll`, **content fits** | **15** | 0 | **no** |
| `overflow-y: hidden`, content taller | **0** | 0 | yes |
| `overflow-y: clip`, content taller | 0 | 0 | yes |
| `overflow-y: visible`, content taller | 0 | 0 | yes |
| `overflow-x: auto`, content wider | 0 | **15** | yes |
| `overflow: auto`, content larger both ways | 15 | 15 | yes |
| `overflow-y: auto` + `scrollbar-width: thin` | **10** | 0 | yes |
| `overflow-y: auto` + `scrollbar-width: none` | **0** | 0 | yes |
| `overflow-y: auto` + `scrollbar-gutter: stable`, content fits | **15** | 0 | no |

Root scroller: `innerWidth - documentElement.clientWidth` = **15**, same number.

1. **15 CSS px, and it is CSS px.** Identical at `dpr 2`, so the gutter scales with the display
   rather than staying 15 device pixels. `thin` is 10, `none` is 0.
2. **`auto` and `scroll` differ measurably, and only when the content fits.** `auto` reserves
   nothing; `scroll` reserves 15 px around content that does not need it. Once the content
   overflows the two are indistinguishable.
3. **A scrollbar is the only thing that takes room.** `hidden` and `clip` contain overflow and
   reserve nothing, so "clips" and "costs layout room" are independent properties.
4. **The gutter is per axis**, matching the axis that scrolls, and both are reserved when both
   scroll.

**Bearing on dziri.** The compiler collapses `auto` and `scroll` into one `SCROLL` value
(`src/compiler/css.ts` `overflowKeyword`), and Taffy's `scrollbar_width` is a *static* style
input — it reserves unconditionally for `Overflow::Scroll`, which is `scroll` semantics. So with
one wire value there is no setting of `scrollbar_width` that is right for both rows above:
15 gives `overflow-y-auto` a permanent 15 px inset that Chromium only applies when the content
overflows, and Tailwind's `overflow-y-auto` is by far the common case. Chromium reaches the
conditional answer by laying out twice.

That is the measured reason dziri draws an **overlay** scrollbar over the content and keeps
`scrollbar_width` at 0 — not an unimplemented gutter. Reserving one honestly needs both a wire
value that tells `auto` from `scroll` *and* a second layout pass, and buys only the case where
content fits. Overlay scrollbars are also what this measurement cannot see: Chromium draws them
when `--enable-features=OverlayScrollbar` is on, and they reserve nothing by design.
