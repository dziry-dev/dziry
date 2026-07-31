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
