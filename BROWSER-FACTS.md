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

## An omitted border colour is `currentcolor`, not transparent

**Found by `bun run spec-audit` (mdn-data), confirmed by measurement 2026-07-31 · Chromium 151.**

```css
.probe { color: #ff0000; border: 2px solid; }   /* no colour given */
```

| computed | Chrome |
|---|---|
| `border-top-color` | **rgb(255, 0, 0)** — the element's `color` |
| `border-top-width` | 2px |
| `border-top-style` | solid |

`border-color`'s initial value is `currentcolor`, which resolves to the element's computed
`color`. dziri's `INITIAL_STYLE.borderColor` is `0` — fully transparent.

**Bearing on dziri:** `border: 2px solid` with no colour is invisible in dziri and text-coloured
in a browser. Together with the `border-style` gap below, borders diverge in *both* directions —
one paints when it should not, the other does not paint when it should. Both are things a web
developer hits on their first stylesheet.

The fix is cheap and on-thesis: `currentcolor` looks dynamic but is not. The cascade already
resolves `color` per node at build time, so `currentcolor` is just that node's `fg`. It costs a
resolution step in the cascade and nothing at runtime — question 1 of the compile-time gate,
answered yes.

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

### Which scrollbar declarations the parser keeps, and which inherit

**Measured 2026-07-31 · Chromium 151 (via Edge 151) · same probe, two runs.** `kept` is whether
the CSSOM held the declaration at all; a dropped one reads back as the initial value.

| Declaration | kept | computed |
|---|---|---|
| `scrollbar-width: auto` / `thin` / `none` | yes | as written (gutter 15 / 10 / 0) |
| `scrollbar-width: thick` | **no** | `auto` |
| `scrollbar-width: 12px` | **no** | `auto` |
| `scrollbar-color: auto` | yes | `auto` |
| `scrollbar-color: red orange` | yes | `rgb(255, 0, 0) rgb(255, 165, 0)` |
| `scrollbar-color: red` (one colour) | **no** | `auto` |
| `scrollbar-color: currentcolor transparent` | yes | `rgb(0, 0, 0) rgba(0, 0, 0, 0)` |
| `scrollbar-gutter: stable both-edges` | yes | gutter **30** — both edges |
| `scroll-behavior: smooth` | yes | `smooth` |

Inheritance, from a parent declaring both onto a nested scroller:

| Property | inherited |
|---|---|
| `scrollbar-color` | **yes** |
| `scrollbar-width` | **no** |

1. **`scrollbar-width` is `auto | thin | none` and nothing else.** MDN's *Scrollbars styling*
   guide summarises it as `auto | thin | thick | <length>`; Chromium 151 rejects both of those
   outright. The Scrollbars Level 1 grammar is the one that is real. **This refuted the source it
   came from** — the guide the request cited — so it is recorded rather than assumed.
2. **`scrollbar-color` takes exactly two colours, thumb then track.** One colour is not a partial
   declaration, it is an invalid one, and the whole thing is dropped.
3. **The two properties differ on inheritance**, which is easy to get wrong in the same breath
   because they are always described together. Only the colour inherits.
4. `currentcolor` resolves against the element's own colour, and `transparent` survives as
   `rgba(0,0,0,0)` — so a fully transparent thumb is expressible and distinct from `auto`.

**Bearing on dziri.** `scrollbarColor` goes in the cascade's inherited set and `scrollbarWidth`
does not. `thin` and `none` are honoured against dziri's own overlay thickness rather than
Chromium's gutter widths, because the gutter is not reserved here at all (see above) — `none` means
no bar drawn *and* nothing to grab, while the wheel keeps working, which is exactly what the
property means.

---

## A word too long for its line: Chrome overflows, Skia breaks it

Measured 2026-08-01 with `bun run layout-diff` (Chrome/Edge over CDP, `wrap-unbreakable`) against
dziri's own SkParagraph path, both laying out `Unbreakablesupercalifragilistic` at 16px in a 120px
box:

| Engine | lines | box height |
|---|---|---|
| Chrome | **1** | 21 |
| dziri (SkParagraph) | **2** | 42 |

CSS's initial `overflow-wrap: normal` / `word-break: normal` says a token with no break
opportunity **stays on one line and overflows its box**. Chrome does that. Skia's line breaker
falls back to breaking anywhere once a word cannot fit the width, so the token is cut mid-word and
the box grows a line — Flutter's behaviour, which is unsurprising given whose text stack this is.

Confirmed from both sides: `text.rs`'s `an_unbreakable_token_is_broken_by_cluster_not_overflowed`
pins dziri at ≤ the requested width over several lines, and `layout-diff` reports Chrome at one
line for the same input.

**Bearing on dziri.** Not adjustable from `ParagraphStyle` or `TextStyle` — there is no
word-break or overflow-wrap setting exposed anywhere in skia-safe 0.87's paragraph module. Closing
it means implementing `overflow-wrap`/`word-break` as real properties and doing the fallback
by hand, which is A2 work that has not been priced. Until then it is a known divergence and the
one scenario `layout-diff` is expected to report red. **A red `wrap-unbreakable` is the status
quo, not a regression** — if any *other* scenario goes red, that is new.

An adjacent finding from the same work, recorded because it is the opposite mistake: **Skia's
`ParagraphStyle::apply_rounding_hack` is on by default** and rounds line widths up to whole
pixels, which browsers do not do. dziri turns it off. What dziri *does* round is the measurement
it hands Taffy, and for an unrelated reason — see the comment on `Measurer::measure`.

## Which `appearance` values the parser keeps

**Measured 2026-08-02 · Chromium 151 (via Edge 151) · every value declared on both a `<div>` and a
`<select>`, read back with `getComputedStyle`.** A dropped declaration reads back as the initial
value, so `none` on the div and `auto` on the select — the select's `auto` comes from the UA sheet,
which is why the two columns differ for the rejected values and agree for the kept ones.

| Declared | on `<div>` | on `<select>` | kept |
|---|---|---|---|
| `none` / `auto` | as written | as written | yes |
| `base-select` | `base-select` | `base-select` | **yes** |
| `base` | `none` | `auto` | **no** |
| `button` `checkbox` `radio` `menulist` `listbox` `meter` `progress-bar` `searchfield` `textarea` | as written | as written | yes |
| `textfield` / `menulist-button` | as written | as written | yes |
| `push-button` / `square-button` / `slider-horizontal` | `none` | `auto` | **no** |

1. **`base-select` is real and shipping**, on any element, not only `<select>`. It is the opt-in
   that makes a `<select>` and its `::picker(select)` fully styleable, and it is the whole reason
   `appearance` is worth having in a framework that draws its own controls. **`mdn-data` does not
   list it**: its `appearance` syntax is still `none | auto | <compat-auto> | <compat-special>`.
   MDN's prose page has it. When the two disagree, the browser settles it — here the prose was right.
2. **MDN's prose lists three values Chromium rejects.** `push-button`, `square-button` and
   `slider-horizontal` appear on the `appearance` page; all three are dropped. `mdn-data`'s
   `<compat-auto>` — nine keywords, none of those three — is the accurate list. **This is the second
   time an MDN prose page has been refuted by measurement** (the first was `scrollbar-width: thick`,
   above), and the second time `mdn-data` was right where the prose was not. Prefer `mdn-data` for
   grammar; use the prose for values too new for it, and measure those.
3. **`base` is specified and implemented nowhere**, exactly as MDN says. Refused rather than folded
   to `auto`, because "the spec defines it" is not the same claim as "a browser does it".
4. **`<compat-auto>` computes as-specified, not as `auto`.** The spec says the values *behave* as
   `auto`; it does not say they *compute* to it, and `appearance`'s computed value is `asSpecified`.
   dziri's style field stores the effect, so it folds them and reports `auto` where Chrome reports
   `button`. That is a representation divergence with no behavioural difference, and it is
   `conformance`'s first `KNOWN` entry rather than something hidden.

**Bearing on dziri.** The customizable-`<select>` model is the one to build against, and it is
*not* shadow DOM: MDN documents the parts as ordinary light-DOM children —
`<select><button><selectedcontent></selectedcontent></button><option>…</option></select>` — with
`::picker(select)` defined as "all descendants except the first `<button>`". That is a structural
grouping a compiler can compute, which is why compile-time expansion is a fit and `::part`,
`::-webkit-*` and shadow piercing are not needed. What it does need that dziri lacks is the popover
and anchor-positioning the picker relies on — the overlay layer, ROADMAP B1.

## How a transform composes, and how a transition samples it

**Measured 2026-08-02 · Chromium 151 (via Edge 151) · `probes/transform-composition.html` and
`probes/transition-sampling.html`, each run twice with identical output.** Transitions were sampled
from a *paused* `element.animate()` with an explicit `currentTime` rather than from a live
transition, because sampling a running transition races the compositor and is not reproducible.

### Composition

| Question | Measured |
|---|---|
| Computed value of `transform` | always `matrix(a,b,c,d,e,f)` — never the source list. `translateZ` promotes it to `matrix3d` |
| Percentages in the computed value | **resolved** — `translateX(50%)` on a 100px box computes `matrix(1,0,0,1,50,0)` |
| List order | `A B` = matrix product `A × B`; the **rightmost function applies to the point first** |
| Default `transform-origin` | `50% 50%`, computed as resolved px — `50px 25px` on a 100×50 box |
| Percentage `transform-origin` | resolved against the element's own **border box** |
| Percentage `translate()` | also the element's own border box: `translateX(50%)` moves a 100px box 50px |
| `translate` / `rotate` / `scale` properties | compose in that fixed order **regardless of source order**, then `transform` last: the full chain is `T · R · S · transform` |
| Their computed `transform` | `none` — the individual properties do **not** fold into it. Only the rect witnesses the composed result |
| Effect on layout | **none.** Parent height and sibling position are untouched by translate, scale and rotate alike |
| Effect on a child's rect | **yes** — a parent's transform scales and moves the child's reported rect |
| Non-replaced inline box | computed value is the matrix, but the box **does not move** (0.0px). `inline-block` and `block` move |

The load-bearing equivalence for dziri's representation: `translate:10px 20px; rotate:30deg;
scale:2 3` and `transform:translate(10px,20px) rotate(30deg) scale(2,3)` produce the **same rect**
to 0.1px (`x=-40.1 y=-0.9 w=248.2 h=229.9`). Exact matrices to assert against:

```
translate(10px,20px) rotate(30deg) scale(2,3)                    matrix(1.73205, 1, -1.5, 2.59808, 10, 20)
translate(10px,20px) rotate(30deg) skewX(10deg) skewY(5deg) scale(2,3)
                                                                 matrix(1.67128, 1.16696, -1.04189, 2.86257, 10, 20)
skewX(10deg) skewY(5deg)                                         matrix(1.01543, 0.0874887, 0.176327, 1, 0, 0)
skewY(5deg) skewX(10deg)                                         matrix(1, 0.0874887, 0.176327, 1.01543, 0, 0)
```

### Interpolation — this one refutes the obvious design

**A transform is not interpolated as a matrix.** `rotate(0deg) → rotate(360deg)` has *identical*
endpoint matrices, so a componentwise matrix lerp would not move at all. It measures 180° at
t=0.5. `rotate(0deg) → rotate(720deg)` measures 180° at t=0.25 and keeps winding.

| Endpoints | t=0.5 | Means |
|---|---|---|
| `rotate(0)` → `rotate(360deg)` | `matrix(-1,0,0,-1,0,0)` = 180° | interpolates the **angle**, not the matrix |
| `rotate(0)` → `rotate(720deg)` | 180° at t=0.25 | the angle is **not normalised** to one turn |
| `translateX(100px)` → `rotate(90deg)` | `matrix(0.707,0.707,-0.707,0.707,50,0)` | mismatched lists **decompose**, then lerp the components — a naive matrix lerp would give `0.5` not `0.707` |
| `none` → `rotate(90deg)` | 45° | `none` is the **per-function neutral**, identical to `rotate(0deg) → rotate(90deg)` |
| `translateX(20px)` → `translateX(100%)` | 60px on a 100px box | percentages resolve, then lerp; mixes with px |

**Bearing on dziri.** Store the transform **decomposed** — `translateX/Y`, `rotate`, `scaleX/Y`,
`skewX/Y` as separate scalars with an unnormalised rotation — not as a 6-float matrix. Decomposed
storage reproduces every row above; matrix storage fails the first two outright. It is also what
the `translate`/`rotate`/`scale` properties already are, and what Tailwind emits.

The cost is that a decomposed store can only express one canonical order, so a hand-written
`transform: rotate(45deg) translateX(10px)` — measured above as genuinely different from
`translateX(10px) rotate(45deg)` — cannot be represented. Refuse it rather than silently
reordering, the way `appearance: base` and non-string `content` are refused.

Two consequences for *where* the work happens: percentage `translate` and the default
`transform-origin` both resolve against the element's own border box, so **neither can be folded at
compile time** — the engine resolves them against the laid-out box. And since a parent's transform
moves a child's rect, hit-testing has to apply the inverse.

### Easing

Keywords do **not** normalise to `cubic-bezier()` in the computed value — `ease` reads back as
`ease`. The two step keywords do: `step-start` → `steps(1, start)`, `step-end` → `steps(1)`.

Measured progress for `opacity: 0 → 1`, which is the curve itself:

| easing | t=0.1 | t=0.25 | t=0.5 | t=0.75 | t=0.9 |
|---|---|---|---|---|---|
| `linear` | 0.1000 | 0.2500 | 0.5000 | 0.7500 | 0.9000 |
| `ease` | 0.0948 | 0.4085 | 0.8024 | 0.9605 | 0.9943 |
| `ease-in` | 0.0170 | 0.0935 | 0.3154 | 0.6219 | 0.8394 |
| `ease-out` | 0.1606 | 0.3781 | 0.6846 | 0.9065 | 0.9830 |
| `ease-in-out` | 0.0197 | 0.1292 | 0.5000 | 0.8708 | 0.9803 |
| `cubic-bezier(0.4,0,0.2,1)` | 0.0259 | 0.2366 | 0.7756 | 0.9594 | 0.9944 |
| `steps(4, end)` | 0.0000 | 0.2500 | 0.5000 | 0.7500 | 0.7500 |
| `steps(4, start)` | 0.2500 | 0.5000 | 0.7500 | 1.0000 | 1.0000 |

`ease-out` is `ease-in` mirrored (0.1606 = 1 − 0.8394) and `ease-in-out` is exactly 0.5 at the
midpoint, which is the cheap check that an implementation's curve is the right one.

`transition` shorthand defaults, confirmed: timing function `ease`, delay `0s`, property `all`. In
`transition: opacity 1s 2s` the **first** time is the duration and the second the delay.

## How a transition is interrupted, and how a keyframe's easing is scoped

**Measured 2026-08-03 · Chromium 151 (via Edge 151) · `probes/animation-semantics.html`, run twice
with identical output.** Values are read from a *paused* animation at an explicit `currentTime`,
except the two interruption cases, which ask the live `CSSTransition` object about its own timing —
a sampled pixel mid-interruption is not reproducible, and `getComputedTiming()` is exact.

### Colour interpolation happens in gamma-encoded sRGB, premultiplied

| Endpoints | t | Measured | Means |
|---|---|---|---|
| `rgb(0,0,0)` → `rgb(255,255,255)` | 0.25 / 0.5 / 0.75 | `rgb(64,64,64)` / `rgb(128,128,128)` / `rgb(191,191,191)` | plain per-channel lerp of the **gamma-encoded** bytes, not linear-light |
| `rgb(255,0,0)` → `rgb(0,0,255)` | 0.5 | `rgb(128,0,128)` | sRGB, not oklab |
| `rgba(255,0,0,1)` → `rgba(0,0,255,0)` | 0.5 | `rgba(255,0,0,0.5)` | **premultiplied** — a plain per-channel lerp would give `rgba(128,0,128,0.5)` |
| `oklch(0.7 0.15 20)` → `oklch(0.7 0.15 200)` | 0.5 | `oklab(0.7 0 0)` | a colour *authored* in a modern space interpolates in that space |

`color-mix()` is the contrast that makes this worth writing down: `color-mix(in oklab, black, white)`
is `oklab(0.5 …)`, a visibly lighter grey than `rgb(128,128,128)`. The two features do **not** share
a space. A real CSS transition agrees with `element.animate()` on every row above.

Bearing on dziri: colours are a packed `0xAARRGGBB` `u32`, so per-channel sRGB is already the
representation, and the only thing that has to be got right is **premultiplying by alpha** — which is
the one row a naive implementation fails. An `oklch()`-authored colour was already flattened to sRGB
by the compiler, so it interpolates in sRGB here; that is a known divergence and the same one
`conformance` records for oklab conversion generally.

### An interruption is a rewind of the same pair, at the same rate

`opacity: 1 → 0` over `1s linear`, interrupted partway and sent back:

| Interrupted at | Value there | Reverse `activeDuration` | Reverse's own t=0 reads |
|---|---|---|---|
| t = 0.1 | 0.900 | **100 ms** | — |
| t = 0.4 | 0.600 | **400 ms** | **0.6** |
| t = 0.9 | 0.100 | **900 ms** | — |
| t = 0.4, retargeted to `0.5` (a *third* value) | 0.600 | **1000 ms** | 0.6 |

So a reversal covers the distance still to travel at the *same speed* as the outgoing transition —
this is CSS's `reversing-shortening-factor` — and it starts from the value the outgoing one had
reached, not from an endpoint. A retarget to a value that is neither endpoint gets the **full**
duration, also starting from the current value.

**This is what makes a transition cheap for dziri, and it refutes the "rewrite `from` to the current
interpolated slot" sketch.** Both endpoints are interned style rows, and there is no row holding an
interpolated value — but none is needed: a reversal is the *same* `(from, to)` pair traversed
backwards from the current `t` towards 0. Value continuity and the measured 400 ms both fall out of
"`t` moves at ±1/duration per second", with no new row and no allocation. Only the third-value
retarget genuinely needs a row dziri does not have, and it is the one case approximated — see
API.md.

### A keyframe's `animation-timing-function` governs the segment *leaving* it

`steps(1, end)` holds a segment at its start value for the segment's whole length, which makes the
question decidable in one reading:

| Where the easing sits | t=0.25 | t=0.49 | t=0.75 | t=0.99 |
|---|---|---|---|---|
| on `0%` (`0 → 0.5 → 1`) | **0** | **0** | 0.75 | — |
| on `50%` | 0.25 | — | **0.5** | **0.5** |

So it is the segment that *starts* at the keyframe. A segment naming no easing of its own uses the
**animation's**: with `animation: … ease-in` and `linear` declared on the `50%` keyframe, t=0.25
reads `0.157678`, which is `ease-in` at half of the first segment (0.3154 × 0.5), while t=0.75 reads
exactly `0.75`.

The keyframe's easing does **not** appear in the element's computed `animation-timing-function` — that
still reads the animation-level value. It is genuinely per-segment data, so it belongs on the segment
row rather than anywhere on the style row.

Tailwind's `bounce` is the whole thing in one animation, and its numbers are the check:
`translateY(-25%)` → `none` → `translateY(-25%)` on a 100×50 box measures `-12.5`, `-10.4906`, `0`,
`-10.4906` at t = 0, 0.25, 0.5, 0.75. `-10.4906` is `cubic-bezier(0.8,0,1,1)` evaluated at *segment*
progress 0.5 (≈0.1607) applied to 12.5 px — so it pins the per-segment easing and the bezier solve at
once.

### Multi-offset selectors are simply duplicated, and a missing endpoint is the element's own value

`@keyframes { 0% {opacity:0} 75%, 100% {opacity:1} }` reads 0.5 at t=0.375 — halfway to 75%, not to
100% — and 1 at t=0.9. So `75%, 100%` is two keyframes with the same declarations.

Tailwind's `ping` has no `0%` at all, and at t=0 reads the element's own `opacity: 1` and
`transform: none`. The implicit `from` is the element's computed style, which is exactly the interned
row dziri already has: a keyframe with no `0%` needs no synthetic value, only the base slot.

### `animation` shorthand and `transition-property`, confirmed

| Declaration | name | dur | delay | iter | fn |
|---|---|---|---|---|---|
| `animation: spin 1s linear infinite` | spin | 1s | 0s | infinite | linear |
| `animation: bounce 1s infinite` | bounce | 1s | 0s | infinite | **ease** |
| `animation: 1s spin` | spin | 1s | 0s | 1 | ease |
| `animation: spin 1s 2s 3 reverse both` | spin | 1s | **2s** | 3 | ease |

Order within the shorthand is free — `1s spin` parses — and as with `transition`, the **first** time
is the duration and the second the delay. Defaults are `ease`, `0s`, `1`, `normal`, `none`.

`transition-property`'s computed value keeps the author's list **verbatim**: `all` does not expand,
`none` stays `none`, and an unknown name is retained rather than dropped. The trap is that the
longhands are *parallel lists* — `transition: opacity 1s, transform 2s ease-in 3s` computes to
`dur=[1s, 2s] delay=[0s, 3s]` — so timing is per property, not per element. Tailwind never emits
that shape: every one of its utilities sets one `transition-duration` for the whole list.

`display` is in Tailwind's default `transition-property` list, so discrete properties are not
hypothetical. `transition-behavior: allow-discrete` parses as measured, but `display` is
layout-affecting in dziri and transitions there are refused by name — see API.md.

## `:hover` and `:active` match the ancestors too; `:focus` does not

**Measured 2026-08-03 · Chromium 151 (via Edge 151) · `probes/hover-propagation.html`, run
twice with identical output.** With a *real* pointer, dispatched over CDP — this is the first
probe that needed one, and it is why `scripts/probe.ts` grew the mouse handshake. A
synthesised `MouseEvent` does not set `:hover`, and DevTools' `CSS.forcePseudoState` forces
the state on **one** element, which measures the tool rather than the browser when the
question is precisely which *other* elements come along.

`document.querySelectorAll(':hover')` is the whole measurement: the selector matches every
element in the hover chain, so asking the document for it returns exactly the set in
question, in document order. The structure is `body > #card > #mid > #button`.

| Pointer over | `:hover` matched |
|---|---|
| `#button`, three levels deep | `html body card mid btn` |
| `#mid` only | `html body card mid` |
| `#card`'s padding | `html body card` |
| nothing | `html` |

So **`:hover` matches the element under the pointer and every ancestor of it**, up to and
including `html`. And while the button is held down, `:active` matches the *identical* set —
`html body card mid btn` — so the two rules are the same rule.

`:focus` is the exception, and it is worth having measured rather than recalled because the
three are always described in one breath:

| | matched |
|---|---|
| `:focus` after `btn.focus()` | `btn` |
| `:focus-within` after the same | `html body card mid btn` |

So focus does **not** propagate, and `:focus-within` is the ancestor form. dziri has neither
`:focus-within` nor any need to change `:focus`.

### It is the DOM ancestor chain, not geometric containment

The row that decides the implementation. `#escapee` is `position: absolute; left: 200px`
inside a 120px-wide `#clip`, so it renders entirely **outside** its parent's box — and
pointing at it still matches `clip`:

```
over the escapee, which is outside its parent's box
    :hover        html body card clip escapee
```

So the chain is walked up the *tree*, which means `nodes.parent` is exactly the right column
and no geometry is involved. dziri cannot currently reach this row from the other direction
anyway: `hit_test` prunes a subtree whose parent rect does not contain the point — a
deliberate divergence the TypeScript runtime also had — so a child outside its parent is
unhittable, and every chain dziri can produce is geometric as well as structural. Recorded
because the two stop agreeing the moment that pruning is relaxed, and then this row is the
specification.


## What activates a form control, and when in the press the bit actually flips

**Measured 2026-08-03 · Chromium 151 (via Edge 151) · `probes/control-activation.html`, driven by a
real pointer through `Input.dispatchMouseEvent`.** Asked before writing any of it, because "a click
toggles a checkbox" hides at least five decisions, and four of them are guessable in the wrong
direction.

### The bit flips during the click, not on the release

| moment | `cbw.checked` | `:checked` matches |
|---|---|---|
| `mousedown` listener | 0 | — |
| `mouseup` listener | 0 | — |
| `click` listener | **1** | `cbw` |

So checkedness is set by the *pre-click activation behaviour*, which runs after `mouseup` and
before the `click` event is dispatched. A `mouseup` handler still sees the old value. This is the
one that decides *where* in an engine's press handling the flip belongs: beside the code that
decides a click happened, not beside the code that handles the release.

### A disabled control receives no button events at all

Pointing at `<input type="checkbox" disabled>` and pressing produced **no `mousedown`, no
`mouseup` and no `click`** — not a click that was ignored, no events. `mousemove` still arrived
(the step counter advanced), and the control never took focus.

Its *label* is different, and the difference is worth stating:

| pressed | `:active` matched | fired | toggled |
|---|---|---|---|
| the disabled input itself | (nothing) | nothing at all | no |
| the label of a disabled input | `html body div cbd ld` | `click` on `ld` only | no |

So `cbd` joins the `:active` chain through its label while remaining unclickable, and the label's
click is **not** forwarded to it.

### A label's click is a second, synthetic click on the control

| pressed | events, in dispatch order |
|---|---|
| the input, inside a wrapping `<label>` | `click` on `cbw`, then `click` on `lw` (bubbling, `target` still `cbw`) |
| the wrapping label's own padding | `click` on `lw`, **then a fresh `click` on `cbw`** |
| a nested `<span>` in that label | `click` on `spanw` → `lw`, **then a fresh `click` on `cbw`** |
| a `for=` label | `click` on `lf`, **then a fresh `click` on `cbf`** |

One toggle in every row. The forwarded click is dispatched *after* the label's own, and it is
skipped exactly when the original target already is the labelled control — which is what stops a
wrapping label from toggling twice. It is also skipped when the control is disabled.

### `:active` follows a label to its control from anywhere in the chain; `:hover` only from the label itself

The second asymmetry in this file between these two, after the earlier one against `:focus` — and
this one is *between* the pair that the other finding showed to be identical sets. Both were
recorded because assuming either way would have been a coin flip.

| pointer on | `:hover` matched | `:active` matched, while held |
|---|---|---|
| the input inside the wrapping label | `html body div lw cbw` | `html body div lw cbw` |
| **the wrapping label's own padding** | `html body div lw` **`cbw`** | `html body div lw cbw` |
| **a nested `<span>` in that label** | `html body div lw spanw` — **no `cbw`** | `html body div lw` **`cbw`** `spanw` |
| a `for=` label | `html body div cbf lf` | `html body div cbf lf` |
| the label of a *disabled* input | `html body div cbd ld` | `html body div cbd ld` |

Read the two middle rows together: they are the same label and the same control, differing only in
whether the pointer landed on the label or on a descendant of it. So

- `:hover` reaches the control when the label **is the hit node**, and not when the hit node is a
  descendant of the label;
- `:active` reaches it in **both** cases, i.e. from any label in the chain.

The `for=` rows also confirm the forwarding is not containment: `cbf` is a *sibling* of `lf`, not an
ancestor or a descendant. And the last row shows there is no disabled guard on either — a disabled
control still joins both chains through its label, while still receiving no events of its own.

One asymmetry looks like a spec requirement and the other like an implementation artifact, but both
are what Chromium does, so both are what dziri does. The difference is one line each in
`FrameState::set_input`.

### Focus is the default action of the press, and a label never keeps it

Focus moved to the control between the `mousedown` and `mouseup` listeners — a `mousedown` handler
sees the old focus. For a label click, `:focus` was empty on release and became the *control* after
the forwarded click; the label itself never held focus. Pressing a control and releasing away from
it **focused it without toggling it**.

### A radio cannot be unchecked by pointer, and its group is the form

Clicking an already-checked radio fired `click` and neither `input` nor `change`, and it stayed
checked.

| radio | `name` | form owner | end state |
|---|---|---|---|
| `r1` | `plan` | none | 0 |
| `r2` | `plan` | none | 1 |
| `r3` | `plan` | form A | 1 |
| `r4` | `plan` | form B | 1 |

Three radios named `plan` checked at once. The group is scoped to the **form owner**, not to the
name alone — so a compiler interning group ids has to key on `(form, name)`, and radios with no
form owner form their own group per name in tree scope.

`:indeterminate` matched nothing; it is unreachable without script.

## What box each form control gets from the UA sheet

**Measured 2026-08-03 · Chromium 151 (via Edge 151) · `probes/control-metrics.html`,** every
`type` HTML defines, read from `getComputedStyle` with nothing authored but the attribute. A 16px
root and the platform default fonts.

`font-size` is **13.3333px on every input type** and `font-family` is Arial — a control does not
inherit the page's font, which is why an unstyled form looks nothing like the text around it. The
date/time family gets `monospace` instead. `accent-color` computes to `auto` everywhere, so the
blue is not readable from the DOM at all.

| type | width × height | box-sizing | border | padding | margin |
|---|---|---|---|---|---|
| `hidden` | `display: none` | | | | |
| `text` `tel` `url` `email` `password` `number` | 169 × 15 → **177 × 21** | content | 2px inset | 1px 2px | 0 |
| `search` | 177 × 21 | **border** | 2px inset | 1px 2px | 0 |
| `date` | 111.328 × 17.3281 → 116 × 21 | content | 2px inset | 0 1px | 0 |
| `month` | 139.328 → 144 × 21 | content | 2px inset | 0 1px | 0 |
| `week` | 131.328 → 136 × 21 | content | 2px inset | 0 1px | 0 |
| `time` | 93 × 20 → 98 × 24 | content | 2px inset | 0 1px | 0 |
| `datetime-local` | 183.328 → 188 × 21 | content | 2px inset | 0 1px | 0 |
| `range` | 129 × 16 | content | none | 0 | 2px |
| `color` | 50 × 27 | border | 1px solid | 1px 2px | 0 |
| `checkbox` | **13 × 13** | border | none | 0 | 3px |
| `radio` | **13 × 13** | border | none | 0 | 3px, `margin-bottom: 0` |
| `file` | 253 × 21 | content | none | 0 | 0 |
| `submit` | 57.5 × 21 | border | 2px outset | 1px 6px | 0 |
| `reset` | 50.8281 × 21 | border | 2px outset | 1px 6px | 0 |
| `button` | 16 × 21 | border | 2px outset | 1px 6px | 0 |
| `image` | 0 × 0 | content | none | 0 | 0 |

Backgrounds: transparent for `checkbox` `radio` `file` `image` `hidden`; white for the text and
date families and for `range`; `#f0f0f0` for `color` `submit` `reset` `button`. `cursor` is `text`
for the text family, `pointer` for `image`, `default` for everything else. An **unknown `type`
falls back to `text`** metrics exactly.

### A text field's width is a character count, and a value never changes it

The default is `size="20"`, so the px figure is a function of the font and cannot be written into a
sheet as a constant. Measured content width against `size`:

| `size` | 1 | 2 | 5 | 10 | 20 | 40 |
|---|---|---|---|---|---|---|
| width | 36 | 43 | 64 | 99 | **169** | 309 |

Exactly `29 + 7 × size` px at 13.3333px Arial — linear, with a 29px fixed part.

**A 30-character value gives the same 169px as an empty field.** An input that grows or shrinks with
its content is not what a browser does; the box is set by `size` and stays.

### The other form elements

| element | width × height | border | padding |
|---|---|---|---|
| `select` (empty) | 22 × 19 border-box | 1px | 0 |
| `select[multiple]` | 17 × 66 | 1px | 0, radius 2px |
| `textarea` | 162 × 30 → 168 × 36 | 1px | 2px |
| `button` | 16 × 6 | 2px outset | 1px 6px |
| `progress` | 120 × 12 | none | 0 |
| `meter` | 60 × 12 | none | 0 |
| `fieldset` | → 22 × 16 | 2px | 4.2px 9px, margin-inline 2px |
| `label` `output` | `auto`, no box of their own | | |

### The tick and the dot have no DOM, so they were read off pixels

`probes/control-metrics.html` renders unchecked and checked checkbox and radio at `zoom: 8` for
exactly this reason: a UA-drawn tick is not an element and `getComputedStyle` has nothing to say
about it. At 13px, from the screenshot:

- checkbox: ~2px corner radius, ~2px grey border unchecked; checked fills with the accent blue and
  draws a white tick roughly 60% of the box.
- radio: a full circle, ~1px grey border unchecked; checked draws a ~2px accent ring and a solid
  centre dot roughly **45–50% of the box diameter** — a proportion, not a fixed size.

These are proportions read off an image rather than numbers reported by an API, and they are
recorded as approximate on purpose.

## What counts as a child for `:first-child` / `:last-child`, and whether the root does

**Measured 2026-08-03 · Chromium 151 (via Edge 151) · `probes/structural-pseudo-root.html`,
run twice with identical output.** Asked because `space-y-*` and `divide-*` are emitted as
`:where(.space-y-4 > :not(:last-child))`, so implementing them meant deciding three edge cases
the compiler cannot avoid: what the root element answers, and whether the two kinds of
non-element child that dziri's IR *does* give a node — text runs and generated boxes — join
the count.

| | matched |
|---|---|
| `html:first-child`, `:last-child`, `:only-child` | all **true** |
| `html:first-of-type`, `html:nth-child(1)` | true |
| first element with a text run before it, `:first-child` | true |
| last element with a text run after it, `:last-child` | true |
| sole element child with `::before` *and* `::after`, `:only-child` | true |

So an element with **no parent still matches all three** — Selectors 4's "first among its
inclusive siblings" wording, not Selectors 3's "first child of some other element" — and
neither text nodes nor generated boxes are counted.

All three matter to dziri and all three are now what `positionOf` in `compile.ts` implements.
The text-node row is the one that would have been silently wrong: a container written across
several lines has a text run after its final element, so counting *nodes* would mean nothing is
ever the last child, and `space-y-4` would have put a trailing margin on every row including
the last. The `::before` row is the same hazard from the other side, because dziri gives a
generated box a real IR node with a real position in its parent's child array.

The end-to-end shape, on the same page, to check the three answers compose into the behaviour
the utility is for — three `<p>` in a `:where(.sp > :not(:last-child)){margin-block-end:16px}`
container:

| | `margin-bottom` |
|---|---|
| `p1` | 16px |
| `p2` | 16px |
| `p3`, the last child | 12px — the UA `margin-block: 1em`, so the rule did not reach it |

---

## Opening, dismissing and committing a `<select>`

**Measured 2026-08-04 · Chromium 151 (via Edge 151) · `probes/select-picker.html`, driven by a real
pointer *and real keys* through `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`.** Asked
before writing any of B1, because "clicking a select opens a list" hides at least six decisions and
half of them are guessable backwards.

**Measured on `appearance: base-select`, deliberately.** A native picker is browser *chrome*: not in
the DOM, no computed style, and no script can see whether it is open — so on a legacy control every
question below is unobservable, and answering them would be reporting confidence rather than
measurement. `base-select` is the spec's opt-in that moves the picker into the page, which is what
makes `:open`, `toggle` and `::picker(select)` exist at all; it is also the model dziri is already
copying, since `ua-structure.ts` builds the `<button><selectedcontent>` half of it.

| step | `:open` | `value` | `document.activeElement` | events on the select |
|---|---|---|---|---|
| initial | closed | free | BODY | — |
| **press** the closed select | **open** | free | OPTION | none |
| release on it | open | free | OPTION | `click` |
| ArrowDown, picker open | open | free | OPTION | `keydown` |
| Enter | **closed** | **pro** | **SELECT** | `keydown`, **`input`, `change`** |
| click to open again | open | pro | OPTION | `click` |
| ArrowDown, picker open | open | pro | OPTION | `keydown` |
| Escape | **closed** | **pro** — unchanged | **SELECT** | `keydown` only |
| click to open a third time | open | pro | OPTION | `click` |
| click a `<button>` outside | **closed** | pro | **BUTTON#outside** | none |
| ArrowDown, closed + focused | **open** | pro | OPTION | `keydown` |
| ArrowUp, closed + focused | **open** | pro | OPTION | `keydown` |

Identical across two consecutive runs.

### It opens on `mousedown`, not on the click

The press alone opened it, before any release. **This is the opposite of a checkbox**, whose bit
flips during the *click*, after `mouseup` — measured in "What activates a form control" above. So
the two cannot share a trigger point: `Engine::mouse_down` has to open a picker while
`activate_control` stays where it is, on the release. Putting the picker on `mouse_up` would make a
select feel a frame late in exactly the gesture people use most.

### Focus goes *into* the picker, and comes back to the select on close

While open, `activeElement` is an `OPTION` — not the select. Both exits restore it to the SELECT,
Enter and Escape alike. That confirms ROADMAP B1's "restore focus to the trigger on dismissal" and
extends it: the restore is not specific to cancelling, it is what closing does.

### Navigating is not committing, and Escape throws the highlight away

An arrow key with the picker open fires `keydown` and **nothing else** — no `input`, no `change`,
and `value` does not move. Enter is what commits, and it fires **`input` then `change`**, in that
order, once. Escape closes with `value` untouched and neither event.

So a picker needs **two pieces of state, not one**: the committed selection and a pending highlight
that Escape discards. One integer each, and the highlight belongs to the open picker rather than to
every select — only one can be open — so it costs nothing per select and nothing per frame. This is
also the measured basis for A3's `onChange`/`onInput` split: both fire, in that order, only on
commit.

**Update, 2026-08-06, when this was implemented: it needs *neither* integer.** The measurement is
unchanged and the conclusion drawn from it was too weak. Both pieces of state already existed. The
committed selection is `CHECKED` on an option, because committing one *is* a radio set — check it,
clear its group — so `Controls::clear_group` is the code that runs. And the highlight is **focus**,
which follows from the finding in the section just above rather than from anything new: if
`activeElement` is an `<option>` while the picker is open, then arrowing through the picker *is*
moving focus. So `option:focus` draws the highlight and Escape discards it by doing what closing
always does. Recorded because the shape of the error is worth remembering — the measurement was
right, and the design read off it invented state the measurements themselves said was already
there. Only dziri emits `CHANGE` today; `INPUT` waits for A3's `onInput` to have a subscriber.

### A dismissing click still reaches what it hit

Clicking a `<button>` outside an open picker closed the picker **and fired that button's own
`click`**, leaving focus on it. Dismissal does not swallow the press.

Worth stating because ROADMAP B1 says "a click on an overlay must not reach nodes beneath it", and
that is a different rule about a different click — a press on the *overlay* is consumed by it, while
a press *outside* both dismisses and activates. Implementing the first and assuming it covered the
second would make every click that closes a dropdown mysteriously do nothing else.

### An arrow key on a closed, focused select opens the picker — it does not change the value

Both ArrowDown and ArrowUp opened it, with no `input` and no `change`. **This refutes the common
belief** that arrowing a closed select in Chrome walks the value directly; that is legacy-appearance
behaviour, and `base-select` does not inherit it. Convenient for dziri: keyboard opening is then the
same path as the click, not a second mechanism.

### Which keys open a closed select: Space, F4 and Alt+ArrowDown — **not Enter**

> **SUPERSEDED, 2026-08-06 (same day, later).** The Enter row of this table measured the *probe
> runner*, not the browser. **Enter does open a closed select.** The rest of the table stands and
> was re-measured. Left in place unedited, because the reasoning below was built on it and a
> deleted claim cannot be traced — see "Enter opens a closed select after all" at the end of this
> file for what went wrong and what it cost.

**Measured 2026-08-06 · Chromium 151 (via Edge 151) · same probe, extended.** Asked because
Enter was asserted to open a closed `<select>`, and the arrows were the only opening keys
anything here had measured.

| key, on a closed + focused select | `:open` after |
|---|---|
| ArrowDown | **open** |
| ArrowUp | **open** |
| Space | **open** |
| F4 | **open** |
| Alt+ArrowDown | **open** |
| **Enter** | **closed — nothing happens** |

Identical across two consecutive runs. Each row is preceded by an Escape, so every key is
measured against a genuinely closed picker rather than against the state the previous key
left.

**So Enter does not open a picker, and the belief that it does is worth understanding rather
than just contradicted.** Two things feed it. On a *legacy* select — the native-popup kind —
Enter inside a `<form>` submits, which is a visible response and easy to read as activation.
And on macOS, Enter and Space both open a native select, so the expectation is correct on one
platform and for one control. Neither is the model dziri copies: `base-select` on Chromium is,
and there Enter is reserved for *committing* a highlight, which is what the section above
measured. A key that both opened and committed would make Down-then-Enter ambiguous.

**Bearing on dziri.** Space, F4 and Alt+ArrowDown join the arrows as opening keys, which is
three more rows in `Engine::picker_key` and no new state — they are the same "open it" path.
Enter deliberately stays a commit-only key. The plain-arrow behaviour was already built on the
earlier measurement and is unchanged.

### The legacy control: what could not be measured, recorded as a limitation

A plain `<select>` beside it was clicked and arrowed, and produced **no value change and no events
at all**. That is not a finding about legacy selects — under headless the native popup is almost
certainly up and consuming the keys, and native popup behaviour is not trustworthy to measure
headlessly. Recorded so nobody reads the empty cells as "legacy arrows do nothing", and so the
question is re-asked headed if it ever matters.

---

## How tall a text field is, and whether its content has any say

**Measured 2026-08-04 · Chromium 151 (via Edge 151) · `probes/text-field-box.html`.** Asked because
dziri rendered an empty field as a bare line: its height came from the text inside it, and an empty
string measures zero. A browser plainly does not do that — but "one line high" is not a number, and a
number is what a layout pass needs.

| case | outer | content height | line-height | font |
|---|---|---|---|---|
| `input`, empty | 177 × 21 | **15.0** | normal | 13.3333px Arial |
| `input`, one char | 177 × 21 | **15.0** | normal | |
| `input`, 40 chars (overflowing) | 177 × 21 | **15.0** | normal | |
| `input` at `font-size: 20px` | 251 × 29 | 23.0 | normal | 20px Arial |
| `input` at `line-height: 40px` | 251 × 46 | **40.0** | 40px | |
| `input` at `line-height: 1` (= 20px) | 251 × 29 | **23.0** | 20px | |
| `div`, empty | 976 × 0 | **0.0** | normal | |
| `div`, one char | 976 × 15 | 15.0 | normal | |
| `div`, empty `<span>` child | 976 × 0 | **0.0** | normal | |
| `contenteditable`, empty | 976 × 15 | **15.0** | normal | |
| `contenteditable`, one char | 976 × 15 | 15.0 | normal | |

Identical across two runs.

### Content has no say at all, and the font decides

Empty, one character and forty all give exactly 15.0. The height tracks the **font** — 20px gives
23.0 — and an explicit *larger* `line-height` raises it, while `line-height: 1` (20px, below the
font's own line box at 23) does **not** lower it. So the font's line height is a floor rather than
just a default.

This is the same fact as "a text field's width is a character count" two sections up, on the other
axis: **neither dimension of a text field is a function of its value.**

### A block box does the opposite, and that is what scopes the fix

`<div></div>` is 0 high, and so is a div containing an empty `<span>`. Only the *editable* box has a
floor — `contenteditable` behaves exactly like `<input>`, empty or not.

That distinction is load-bearing for dziri, because it rules out the fix that first suggests itself.
dziri only ever emits a text node with an empty string for a **dynamic binding**, so giving every
empty run a line's height would appear to work and would be wrong the moment a non-editable binding
rendered `""` — Chrome gives that 0, and a counter reading empty would silently reserve a line
forever. Hence `NodeFlags.EDITABLE` (protocol v14) on the run itself: the compiler already knows
which runs those are, because it is the `editables` table it has been emitting all along.

### What it means for dziri

`Measurer::line_height` takes the height from a **one-line paragraph**, not from raw font metrics,
and the reason is the failure mode it avoids: that height has to equal what the *filled* field
reports one keystroke later, or the box moves by a fraction of a pixel the first time anyone types —
the same bug being fixed, only smaller and harder to see.

Still not implemented, and now measured rather than assumed: the **width** floor. dziri sizes a field
by its CSS box, so `size="20"` does nothing, and an `<input>` with no width class is as wide as its
container rather than 169px. That is the `29 + 7 × size` figure recorded above, and it wants the same
treatment on the inline axis.

---

## Where a click puts the caret, and what keys do to a selection

**Measured 2026-08-05 · Chromium 151 (via Edge 151) · `probes/caret-and-selection.html`,
driven by a real pointer and real keys.** Asked before writing a caret, because every rule
below is a coin flip from memory and each one is visible the first time a user clicks.

The caret itself is unmeasurable — it is browser chrome, so its width, blink rate and colour are
not readable from script. `selectionStart` / `selectionEnd` / `selectionDirection` **are** the caret
and the selection exactly, and they are the numbers an engine has to reproduce. The fixture is a
monospace field holding `abcdefghij`; one character advances 8.797px, and every x below is a
multiple of that read off the page rather than assumed.

### A click resolves to the *nearest* boundary, not the character under the pointer

| click x, in characters | caret |
|---|---|
| 0.0 | 0 |
| **0.4** | **0** |
| **0.6** | **1** |
| 3.4 | 3 |
| 3.6 | 4 |
| 40 (past the text, inside the box) | **10** — clamped to the length, not to the box |

So it is `round(x / advance)` against character boundaries, and the answer for a point past the end
is the text length. Flooring instead would put the caret before the character you clicked the right
half of, which reads as the click being ignored.

### Arrows move one boundary and stop dead at both ends

`ArrowLeft` at 0 and `ArrowRight` at the length both leave the caret where it is. `Home` is 0,
`End` is the length.

### An arrow with a live selection *collapses* it to the matching end

With `2..6` selected, `ArrowLeft` gives `2..2` and `ArrowRight` gives `6..6` — neither moves a
further step. Collapsing to the near end and *then* moving would be one character out, in the
direction the user is looking.

### A drag records a direction, and the offsets stay ordered

Pressing at 2 and releasing at 6 gives `2..6 forward`. Pressing at **8** and dragging back to 3
gives `3..8 **backward**` — `start` and `end` are always in document order, and the direction is
carried separately. An engine storing `(anchor, focus)` gets this for free; one storing
`(start, end)` needs the flag beside them or it cannot extend the right end.

### Shift extension keeps the anchor, and survives a reversal through it

From a collapsed caret at 5:

| step | selection |
|---|---|
| Shift+ArrowRight | `5..6 forward` |
| Shift+ArrowRight | `5..7 forward` |
| Shift+ArrowLeft | `5..6 forward` — shrinks, does not move the anchor |
| Shift+ArrowLeft | `5..5 forward` |
| **Shift+ArrowLeft** | **`4..5 backward`** — through the anchor, which stays at 5 |
| Shift+Home | `0..5 backward` |
| Shift+End | `5..10 forward` — still anchored at 5 |
| plain ArrowLeft | `5..5` |

The anchor at 5 survives all of it, including the flip. That is the argument for storing
`(anchor, focus)` rather than `(start, end)`: with the ordered pair, "extend" has no way to know
which end to move once the two have crossed.

### Not measured, and recorded so nobody reads the row as an answer

A double click reported `0..10` — the whole value — but the fixture is the single word
`abcdefghij`, so that measures "a double click selects a word" and says **nothing about where a word
ends**. Word boundaries, and whether a trailing space is included, need a fixture with spaces in it
and are unrecorded.

---

## What Tailwind's ring utilities actually compile to

**Measured 2026-08-05 · Tailwind CSS v4.3.3 via `bunx @tailwindcss/cli`, then resolved through
dziri's own `var()` / `@property` machinery** (`parseCss` + `extendVarEnv` + `substituteVars`).

Not a browser measurement, and it is here anyway: the question is the same shape — *what does the
real thing emit, rather than what do I remember it emitting* — and the `tailwind-coverage` skill
already records one wrong recollection about this exact property (`box-shadow` "plus a
`color-mix()`", which v4.3.3 does not emit).

Every ring utility goes through **`box-shadow`**, as one five-layer list that is identical on
every ring class:

```css
box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow),
            var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
```

What differs is which `--tw-*` variable the class sets. After substitution, the value that reaches
the expander is:

| Classes | Resolved `box-shadow` |
|---|---|
| `ring-2` | `0 0 #0000, 0 0 #0000, 0 0 #0000,  0 0 0 calc(2px + 0px) currentcolor, 0 0 #0000` |
| `ring-2 ring-sky-400` | `… 0 0 0 calc(2px + 0px) #38bdf8, 0 0 #0000` |
| `ring-2 ring-sky-400 ring-offset-2 ring-offset-black` | `0 0 #0000, 0 0 #0000,  0 0 0 2px #000,  0 0 0 calc(2px + 2px) #38bdf8, 0 0 #0000` |
| `ring-2 ring-sky-400 ring-inset` | `… inset 0 0 0 calc(2px + 0px) #38bdf8, 0 0 #0000` |
| `inset-ring-2` | `0 0 #0000, inset 0 0 0 2px currentcolor, 0 0 #0000, 0 0 #0000, 0 0 #0000` |
| `shadow-md` | `0 0 #0000, ×4, 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)` |

Six things follow, and all six changed what got built.

1. **A ring is a spread-only shadow: no offset, no blur, one solid colour.** That is a subset a
   fixed style row can hold, which is why dziri supports `box-shadow` as *concentric bands* rather
   than as a layer list. `shadow-md` is the counter-example in the same table — it has offsets, a
   blur and a negative spread, so it is warned about and dropped rather than approximated.

2. **The four unset layers arrive as `0 0 #0000`**, from `@property … initial-value: 0 0 #0000`.
   A parser that rejected a two-length layer, or that treated a transparent layer as an error,
   would reject every ring in the framework. Four of five layers are this on any single-ring
   element.

3. **A ring offset is a second, narrower band written *earlier* in the list** — `2px #000` before
   `calc(2px + 2px) #38bdf8`. Earlier layers paint over later ones, so the visible result is the
   offset colour from 0 to 2 and the ring colour from 2 to 4. Nothing in the CSS says "offset";
   the layering *is* the offset. That is why dziri stores two outset extents rather than a width
   and a gap, and why a narrower band written *later* is dropped: it would be entirely hidden.

4. **`ring-2` with no ring colour is `currentcolor`**, reached through
   `var(--tw-ring-color, currentcolor)` — the `@property` for it declares no `initial-value`, so
   the fallback is used. dziri had no value for `currentcolor` at all, which meant the commonest
   ring in the framework resolved to nothing. It is not dynamic: it is the element's computed
   `color`, which the cascade already has, so it is substituted textually before the expander
   runs. Same observation as the `border-color` entry above.

5. **`var(--tw-ring-inset,)` has an empty fallback**, and that is deliberate on Tailwind's part —
   it resolves to nothing on an outset ring and to the token `inset` when `ring-inset` sets it.
   A `var()` implementation that treated an empty fallback as "no fallback" would drop the whole
   declaration.

6. **`@layer properties { @supports (…) { *, ::before { --tw-ring-color: initial; … } } }` must
   stay skipped.** dziri treats `@layer` as transparent and skips `@supports`, so those `initial`
   tokens never land — which is correct, and load-bearing: if that block were applied, `env.has()`
   would find the literal string `initial` and every ring colour would resolve to garbage rather
   than to the `var()` fallback.

Reproduce with `scripts/` nothing — this is a compiler measurement, and it is pinned by
`css.test.ts` ("Tailwind's ring utilities become concentric bands"), whose input strings are the
right-hand column of the table above rather than hand-written approximations of it.

---

## What selects a word, and what editing does to a live selection

**Measured 2026-08-05 · Chromium 151 (via Edge 151) · `probes/selection-editing.html`, driven by
real pointer and key events. Run twice, identical.**

This closes the row the previous section left open: its fixture was the single word `abcdefghij`,
so a double click reporting `0..10` said "a double click selects a word" and nothing about where a
word ends. Four fields here — `"the quick-brown fox"`, `"abcdefghij"`, `"a,, bb  cc"` and
`"a-b c,d e - f"` — pin the boundary rule, and the second one carries the editing half.

### The harness had to be fixed before it measured anything

A first pass sent only `clickCount: 2` events and **every double click reported `0..4`** regardless
of where it clicked. Not a browser behaviour: the first one landed and the rest did nothing, because
a real double click is a *sequence* — press/release at count 1, then press/release at count 2 — and
Chrome will not treat a lone count-2 press at a new position as the second half of one. Every double
click below is preceded by a plain single click at the same point, which also collapses the previous
row's selection so no row inherits another's state.

Recorded because the wrong version was *plausible*: `0..4` is "the ", a real word selection, and a
table of thirteen identical rows is easy to read as "Chrome always selects the first word".

### A double click selects the segment at the **nearest boundary**, plus trailing whitespace

| field | pointer | nearest boundary | selection | what that is |
|---|---|---|---|---|
| `the quick-brown fox` | 1.0 | 1 | `0..4` | `"the "` — **the trailing space is included** |
| | 6.0 | 6 | `4..9` | `"quick"` — the hyphen is **not** |
| | 9.55 | 10 | `10..16` | `"brown "` — not the hyphen it is hovering |
| | 12.0 | 12 | `10..16` | `"brown "` |
| | 3.52 | 4 | `4..9` | `"quick"` — not the space it is hovering |
| | 17.0 | 17 | `16..19` | `"fox"` — nothing follows, so nothing is appended |
| | 30 (past end) | 19 | `16..19` | `"fox"` |
| `a,, bb  cc` | 2.05 | 2 | `2..4` | the **second** comma plus the space — not the `,,` run |
| | 5.0 | 5 | `4..8` | `"bb  "` — the **whole** run of two spaces comes with it |
| | 7.05 | 7 | `6..8` | `"  "` — whitespace alone selects the run |
| `a-b c,d e - f` | 1.48 | 1 | `1..2` | the hyphen alone, `b` follows so nothing is appended |
| | 5.46 | 5 | `5..6` | the comma alone |
| | 10.46 | 10 | `10..12` | the hyphen plus its trailing space |

One rule explains all thirteen:

1. Resolve the pointer to the **nearest character boundary** — the same rounding a single click
   uses, `boundary_at`.
2. Take the segment that boundary falls in. Segments are a run of word characters, a run of
   whitespace, or **one** punctuation character (`,,` is two segments, which is why clicking the
   second comma selects only it).
3. When the boundary sits exactly between two segments, prefer the one **starting** there; at the
   very end of the text, where nothing starts, take the one ending there.
4. Unless the segment is whitespace, append the whole run of whitespace that follows it.

Rule 3 is what made two rows look contradictory before it was found. A pointer at 9.55 is *inside*
the hyphen of `quick-brown`, and a pointer at 10.46 is inside the hyphen of `e - f`; the first
selects `brown ` and the second selects the hyphen. Both round to boundary 10, and in the first case
a word starts there while in the second the hyphen does. **A double click does not use the character
under the pointer.** Implementing it that way would have made every click in the right half of a
character select the wrong segment.

Rule 2 is the one worth stating out loud: the hyphen in `quick-brown` is a word boundary, so
`quick-brown` is two words, not one.

### Triple click and Ctrl+A both select everything

`0..19 forward` for both, on a single-line field. A triple click in a paragraph selects a line; an
input has only one, so the two coincide here and nothing distinguishes them.

### Shift+click extends from the anchor, and flips through it

From a collapsed caret at 4: Shift+click at 9 gives `4..9 forward`; a second Shift+click at 1 gives
`1..4 **backward**` — the anchor stays at 4. The same `(anchor, focus)` argument the Shift+Arrow
table makes, reached with the pointer instead.

### Editing over a range replaces exactly the range

| before | key | after | caret |
|---|---|---|---|
| `abcdefghij`, `2..6` | `X` | `abXghij` | `3..3` — **after the inserted text** |
| `abXghij`, `1..4` | Backspace | `ahij` | `1..1` |
| `ahij`, `1..3` | Delete | `aj` | `1..1` |
| `aj`, `1..2 **backward**` | `Z` | `aZ` | `2..2` |
| `aZ`, `2..2` (collapsed) | Backspace | `a` | `1..1` |

Four things follow, and three of them are places an implementation can plausibly go wrong.

- **Backspace and Delete are identical when a range is live.** Both erase exactly the range and
  neither takes the extra character its collapsed behaviour would. So the erase direction is only
  consulted on a collapsed caret.
- **Insertion leaves the caret after the inserted text**, not at the start of what it replaced.
- **The direction does not change the splice.** A backward `1..2` edits the same as a forward one,
  which matters because the engine stores `(anchor, focus)` and could easily splice `anchor..focus`
  the wrong way round.
- A collapsed range is still a caret, so the erasing keys must not treat it as a zero-length range
  and do nothing.

### The UA's own selection colour is **not readable**, and an author rule is

```
::selection with no author rule: background=rgba(0, 0, 0, 0) color=rgb(0, 0, 0)
::selection with an author rule:  background=rgb(1, 2, 3) color=rgb(4, 5, 6)
```

Chromium does not expose its highlight colour through `getComputedStyle` — the transparent
background is a "nothing here", not the colour it paints. Same category as the caret's width and
blink rate: browser chrome, unmeasurable from script, and it would take a screen recording to get.

So dziri's default belongs in **its own UA sheet**, where a UA default is supposed to live, and is
therefore a stated convention rather than a match. An author `::selection` rule *is* honoured, which
is what makes the two style fields worth having: the default is a guess, and overriding it is not.

### Not measured

Double-click-then-drag extends by *word* in Chrome, and a shift+double-click extends to a word
boundary. Neither is measured here and neither is implemented; a drag after a double click extends
by character.

---

## Enter opens a closed select after all — and what a textless key event cost

**Measured 2026-08-06 · Chromium 151 (via Edge 151) · `probes/select-picker.html`, after a fix to
`scripts/probe.ts`. Two identical consecutive runs.** This **corrects** "Which keys open a closed
select: Space, F4 and Alt+ArrowDown — *not Enter*", recorded earlier the same day.

| key, on a closed + focused select | recorded first | re-measured with the fixed runner |
|---|---|---|
| ArrowDown | open | open |
| ArrowUp | open | open — but see below, it had never actually been measured |
| Space | open | open |
| F4 | open | open |
| Alt+ArrowDown | open | open |
| **Enter** | **closed — nothing happens** | **open** |

Every other row is unchanged. Enter still commits an open picker, firing `input` then `change`, so
Enter is now **both** an opening key and a committing key — which the earlier write-up argued was
impossible without ambiguity. It is not ambiguous, because the two readings are separated by state
rather than by key: closed means open it, open means commit the highlight.

### The instrument, not the browser

CDP's `Input.dispatchKeyEvent` treats a `keyDown` carrying no `text` as a **`rawKeyDown`**:
listeners fire, but no character event is generated. Blink's activation path for Enter hangs off
that character event. The runner added `text` only when the key name was one character long — so
`" "` got it and `"Enter"` did not, and every Enter this repo has ever dispatched was inert.

**The tell was a missing `keypress`.** In the run that caught it, a plain `<button>` produced
`keydown, keyup` on Enter and `keydown, keypress, keyup, click` on Space. A browser in which Enter
does not activate a button is not a browser, and the only structural difference between the two
keys was the one this runner treats specially. Fixed by a `TEXT` map in `scripts/probe.ts` sending
`\r`; re-running turned three inert Enters into activations at once — button, form submission, and
this select.

### What the wrong measurement cost, recorded because the shape repeats

1. A finding was written here as fact, with a table and a "identical across two consecutive runs"
   — which it was. **Repeatability is not validity.** A broken instrument is perfectly repeatable.
2. Code was written to it: `Engine::picker_key` grew a comment explaining why Enter is excluded.
3. **An explanation was invented to fit it.** The write-up said the belief that Enter opens a select
   comes from legacy form submission and from macOS. Neither was measured; both were produced to
   make a wrong measurement feel principled. This is the worst of the three, because it made the
   error *more* convincing, and it contradicted a user who was simply right.

A measurement that refutes a widely held belief is the highest-value output of a probe, and it is
also the one that most deserves a second instrument pointed at it. The rule that follows: when a
probe refutes something *everybody* believes, test the harness on a case whose answer is not in
doubt before recording. `Enter activates a button` was that case and it was one line away.

### `ArrowUp` had never been measured either

Separate defect in the same table, found while re-running. The `ArrowUp while closed + focused`
step ran immediately after `ArrowDown while closed + focused`, which had *opened* the picker — so
it measured an in-picker move (`pro` → `free`) and was captioned as an opening. The recorded fact
"ArrowUp opens a closed select" was read off a row that never tested it.

With an Escape inserted first, **ArrowUp does open a closed select**, and focus lands on the
committed option rather than one above it. The conclusion survives; it just now has a measurement
under it. Both defects are the same mistake: *the state a step runs against is set by the step
before, and a caption naming the intended state is not evidence the state was there.*

### The picker clamps at both ends; Home and End work

**Same probe, same runs.** Four presses down a three-option list, from `pro`:

| press | focused option |
|---|---|
| open with ArrowDown | `pro` (the committed one) |
| Down ×1 | `ent` |
| Down ×2, ×3, ×4 | `ent` — **clamped, no wrap** |
| Up ×1 | `pro` |
| Up ×2, ×3, ×4 | `free` — **clamped** |
| Home | `free` |
| End | `ent` |

**A picker clamps and a radio group wraps** (the group is measured below: ArrowLeft off the first
member lands on the last). So the two are *not* the same navigation rule, and ROADMAP A3's "one tab
stop, arrows inside it" generalisation carries a per-kind wrap flag rather than one shared walk.
Cheap — it is a bool on the arm that already dispatches on `ControlKind` — but it had to be known
before the shared code was written, which is why it was asked now.

`Engine::picker_key` already clamps, and its comment asserted that browsers do too. That assertion
was true and unmeasured; it is measured now. **Home and End are a real gap** — dziri handles
neither in a picker, and both work here.

---

## What is a tab stop, and in what order

**Measured 2026-08-06 · Chromium 151 (via Edge 151) · `probes/tab-order.html`, real Tab and
Shift+Tab through `Input.dispatchKeyEvent`. Two identical consecutive runs.** Asked before writing
any of A3, because the ROADMAP's claim that the focusable **set** is compile-time while only the
**order** is a live walk is only worth building if the set really is a function of the markup.

### The set

`focus()` is script focus; the Tab column is what the walk reached.

| candidate | `focus()` | reached by Tab |
|---|---|---|
| `<a href>` | yes | yes |
| `<a>` with no href | **no** | no |
| `<button>` | yes | yes |
| `<button disabled>` | **no** | no |
| `<input type=text>` | yes | yes |
| `<input disabled>` | **no** | no |
| `<input readonly>` | **yes** | **yes** |
| `<textarea>` | yes | yes |
| `<input type=checkbox>` | yes | yes |
| `<label>` | **no** | no |
| `<input type=radio>` | yes | yes (one per group — see below) |
| `<select>` | yes | yes — **one stop, not two** |
| `<div>` | no | no |
| `<div tabindex="0">` | yes | yes |
| `<div tabindex="-1">` | **yes** | **no** |
| `<div tabindex="3">` | yes | yes — but out of order, see below |
| `<span>`, `<p>`, `<img>` | no | no |
| `display:none` button | no | no |
| `visibility:hidden` button | no | no |

Four things dziri has to act on:

1. **`tabindex="-1"` splits the two sets**, and it is the only thing that does. Everything else is
   focusable-and-tabbable or neither. So dziri needs two bits, or one bit plus one predicate — not
   one "focusable" flag.
2. **`readonly` stays in the order; `disabled` leaves it.** These are easy to conflate and the
   engine already distinguishes them: `:disabled` is a live predicate bit, so the tab walk asks the
   same question the cascade does, and a control that becomes disabled at run time leaves the order
   for free.
3. **`display:none` and `visibility:hidden` both remove a node** — and neither is visible to the
   compiler. This is the one part of the set that cannot be a compile-time table: a hidden subtree
   is a *layout* fact. dziri's out is that the engine already knows, because a node that is not
   laid out has no box; the walk skips what has no box, which costs nothing and is the same test
   `hit_test` makes.
4. **A `<select>` is one tab stop.** Its shadow `<button>` never appears in the walk, and
   `activeElement` reports the `<select>` itself. dziri builds that button as a real compile-time
   node in `ua-structure.ts`, so it would be a second stop by default — it has to be suppressed
   explicitly, and "the UA-generated parts of a control are not tab stops" is the rule to write
   rather than a special case for `select`.

### The order

Starting from a `<button>` in the middle of the document and pressing Tab past the end:

```
start -> a[href] -> button -> input -> input[readonly] -> textarea -> checkbox
      -> radio(g1 first) -> radio(g2 checked) -> select -> div[tabindex=0] -> last
      -> BODY -> div[tabindex=3] -> start -> …
```

- **Document order** for everything with `tabindex="0"` or none, exactly as claimed.
- **Positive `tabindex` sorts ahead of the whole group**, and it is reached *after* the wrap, not
  where it sits in the document — `div[tabindex="3"]` is the first stop of the next cycle. dziri
  has no reason to support positive `tabindex`, and this is the argument for saying so out loud:
  supporting it means the order is no longer a walk at all, it is a sort with a walk as its
  tiebreak.
- **One stop lands on `BODY`** at the end of the cycle. That is the document boundary — in a real
  browser it is where focus leaves for the address bar. dziri has no browser chrome to leave to,
  so it wraps directly; worth naming as a deliberate divergence rather than an oversight.
- **A radio group is one stop, and it is the checked member.** `g1` (nothing checked) stopped on
  its first radio; `g2` (middle one checked) stopped on the *checked* one, skipping the first.
  This is roving tabindex, and it is measured rather than assumed.
- **Shift+Tab is the same list reversed.** No separate order.

---

## When `:focus-visible` matches

**Measured 2026-08-06 · Chromium 151 (via Edge 151) · `probes/focus-visible.html`. Two identical
consecutive runs.** ROADMAP A3 wants `:focus-visible` as a bit distinct from `:focus` and never
said what the rule is.

| focused by | element | `:focus` | `:focus-visible` | UA `outline` |
|---|---|---|---|---|
| click | `<button>` | yes | **no** | `none` |
| click | `<input type=text>` | yes | **YES** | `auto 1px` |
| click | checkbox, radio | yes | **no** | `none` |
| click | `<a href>` | yes | **no** | `none` |
| click | `<div tabindex=0>` | yes | **no** | `none` |
| click | a `<select>`, focus lands on an `<option>` | yes | **no** | `none` |
| **keystroke on a mouse-focused div** | same `<div tabindex=0>` | yes | **YES** | `auto 1px` |
| ArrowDown inside a mouse-opened picker | `<option>` | yes | **YES** | `auto 1px` |
| Tab / Shift+Tab | every one of them | yes | **YES** | `auto 1px` |

So it is **not** "keyboard focus is visible and mouse focus is not". Three rules, and the third is
the one nobody states:

1. **Focus arriving from the keyboard is visible.** Every Tab arrival, no exceptions found.
2. **Focus arriving from a pointer is not — unless the control takes text.** A clicked text field
   is visible focus; a clicked button, checkbox, radio, link and `tabindex` div are not. The
   distinction is *does typing go here*, not *is it a form control*.
3. **Typing makes the current element visible, retroactively.** A div focused by mouse — not
   visible — became visible when a key was pressed, without focus moving. So the bit is not
   decided once at focus time; a keystroke re-evaluates it for whatever is focused now.

**Bearing on dziri.** `:focus-visible` is a live predicate bit like `:checked`, and it is set by
**modality**, not by the focus event: the engine keeps one "last input was a key" flag, sets the
bit when focus moves while that flag is on, and re-sets it for the currently focused node on any
keystroke. Clearing it is what a pointer press does. That is one bool and two assignments, and it
falls out of the fact that `Engine::mouse_down` and `Engine::key_down` are already the only two
entry points.

Rule 2 is the one that needs a per-kind answer, and dziri's `ControlKind` already has it: the kinds
that take text are exactly the ones a pointer press should mark visible.

**The UA ring hangs off `:focus-visible`, not `:focus`.** Unfocused-visible elements compute
`outline-style: none`; visible ones compute `outline: auto 1px`. So a default ring is a UA-sheet
rule keyed on the new predicate, not something the engine paints — which keeps it overridable by an
author in the ordinary cascade, the same argument `::placeholder`'s colour is in `ua-sheet.ts` for.
dziri has no `outline` property and no `auto` outline width, so the ring it draws will be a
divergence in *appearance*; the trigger is what this measures.

---

## What Enter and Space do to a focused control

**Measured 2026-08-06 · Chromium 151 (via Edge 151) · `probes/keyboard-activation.html`, with the
fixed runner. Two identical consecutive runs.** ROADMAP A3 claims Enter/Space is "wiring, not new
behaviour" because `Controls::activate` already dispatches on kind. Two of the three assumptions
under that claim turn out to hold and one does not.

Order within a row is the order the events fired. A `click` **before** `keyup` means the control
activated on press; after it means on release.

| control | key | events |
|---|---|---|
| `<button>` | Enter | `keydown, keypress, click(detail=0), keyup` — **press** |
| `<button>` | Space | `keydown, keypress, keyup, click(detail=0)` — **release** |
| checkbox | Enter | `keydown, keypress, keyup` — nothing |
| checkbox | Space | `keydown, keypress, keyup, click, input, change` — **release** |
| radio, unchecked | Space | `keydown, keypress, keyup, click, input, change` — **release**, and it selects |
| radio, already checked | Space | `keydown, keypress, keyup` — **no click at all** |
| radio | Enter | nothing |
| radio group | Arrow | `keydown, click, input, change, keyup` — **press**, moves focus *and* selects |
| `<a href>` | Enter | `keydown, click(detail=0), keyup` — **press**, and **no `keypress`** |
| `<a href>` | Space | `keydown, keypress, keyup` — nothing (it scrolls) |
| `<div tabindex=0>` | Enter | nothing |
| `<div tabindex=0>` | Space | nothing |
| text field in a form | Enter | `keydown, keypress,` **`submit-button click(detail=0), submit`**`, keyup` — **press** |
| text field in a form | Space | types a space (`input`) |

### Space activates on release, and dziri has no hook for it

**This is the finding that changes code.** `Engine::key_down` is the engine's only key entry point
— extracted during B1 precisely so keyboard behaviour could be tested at all — and *every* Space
activation in the table happens on `keyup`. A button, a checkbox and a radio all wait for the
release. Enter and the arrows do not: those fire on press.

So A3 needs `Engine::key_up` before Enter/Space wiring can be faithful, and the split is not
arbitrary trivia — it is what makes press-and-drag-away cancel an activation, the keyboard
equivalent of the mouse rule this repo already measured ("pressing a control and releasing away
from it focused it without toggling it"). Implementing Space on keydown would be a one-character
difference in the code and a different control.

### Activation is per-kind, and a focusable div gets nothing

Neither key activates `<div tabindex="0">`. So keyboard activation is a property of the control
kind, not of being focusable — which confirms the shape of `Controls::activate`'s dispatch and
means dziri's `ControlKind::NONE` nodes correctly do nothing. It also means ARIA's
`role="button"` + `tabindex` pattern gets keyboard support from *script*, never from the platform;
any framework offering it is implementing this table by hand.

### A keyboard activation really is a click

Every activation above dispatched a real `click`, and dziri can therefore route Enter/Space into
the same path as a pointer press — the claim A3 makes, now measured. `detail` is `0` for a
synthesised click and `1` for a pointer one, which is how libraries tell them apart; dziri's
`CLICK` event has no such field, so the two are **indistinguishable to a host** today. Worth naming
before someone needs the difference.

### Implicit submission crosses elements

Enter in a text field inside a `<form>` produced a `click` **on the submit button**, then `submit`,
all before `keyup`. Nothing touched that button. This is ROADMAP A3's `onSubmit` on `bind:value`,
and it is the only activation measured here where the key's target and the activated control are
different nodes — so it cannot be a row in the same per-kind dispatch; it is a lookup from the
focused field to its form's default button.

### Arrows in a radio group move focus and change the value in one press

`ArrowRight`/`ArrowDown` go forward, `ArrowLeft`/`ArrowUp` back, **wrapping at both ends**, and each
press fires `click, input, change` on the newly focused radio — on keydown. Two consequences for
A3's roving-tabindex generalisation: navigation inside a group is not merely focus movement for
this kind, and the wrap differs from a `<select>` picker, which clamps (measured above).

---

## Tab with a picker open is Escape

**Measured 2026-08-06 · Chromium 151 (via Edge 151) · `probes/select-picker.html`. Two identical
consecutive runs.** Asked because the engine has to do *something* and all three armchair answers
are defensible, which is the signature of a question that should not be answered from the armchair.

| step | `:open` | `value` | `activeElement` |
|---|---|---|---|
| picker open, highlight arrowed to `ent` | open | `pro` | `OPTION:ent` |
| **Tab** | **closed** | `pro` — unchanged | **the `<select>`** |
| Shift+Tab from there | closed | `pro` | `BODY` — the ordinary previous stop |

So Tab **closes the picker, discards the highlight, restores focus to the select, and does not
advance the tab order.** It is Escape with a different keycode, and the Tab is consumed.

The two rejected answers are worth naming, because each is what a plausible implementation order
gives you for free. Letting Tab through to the focus walk leaves a dropdown hanging over a page
whose focus has moved somewhere else — the visible one. Closing *and* advancing feels tidy and
costs a keystroke: a user tabbing out of a select they opened by accident ends up two stops from
where they think they are.

**Bearing on dziri.** One more keycode in `picker_key`'s Escape branch, and the ordering inside
`Engine::key_down` becomes load-bearing rather than incidental: the picker is offered the key
before the tab walk sees it, so an open picker claims Tab and a closed one does not.

---

## When focus moves: what fires, in what order, and what is focused during each

**Measured 2026-08-07 · Chromium 151 (via Edge 151) · `probes/focus-event-order.html`. Two
identical consecutive runs.** The one item on ROADMAP A3's "probe before writing Rust" list that
had been skipped — Tab order, `:focus-visible` and activation were all measured and this was not.

`A` and `B` are buttons, `field` a text input, `dead` a plain `<div>`. `active` is
`document.activeElement` sampled **inside** each handler; `rel` is `event.relatedTarget`.

| step | events, in order |
|---|---|
| click A, from nothing | `A focus(active=A, rel=BODY)`, `A focusin(…)` |
| click B | `A blur(active=BODY, rel=B)`, `A focusout(…)`, `B focus(active=B, rel=A)`, `B focusin(…)` |
| Tab to the field | `B blur(active=BODY, rel=field)`, `B focusout`, `field focus(active=field, rel=B)`, `field focusin` |
| Shift+Tab back to B | `field blur(active=BODY, rel=B)`, `field focusout`, `B focus(active=B, rel=field)`, `B focusin` |
| click a non-focusable `<div>` | `B blur(active=BODY, rel=BODY)`, `B focusout` — **and nothing arrives** |
| click B (from nothing) | `B focus`, `B focusin` |
| **click B again** | **nothing at all** |

### Four findings, each of which shapes the event

1. **Leaving fires entirely before arriving.** All of the old element's events precede all of the
   new one's. So a single ordered queue is enough, and a host replaying it in order sees a
   coherent story. Had they interleaved, an event kind would have needed a sequence number.

2. **During `blur`, `activeElement` is `BODY`.** Focus has already left the old element and has
   *not yet* arrived at the new one — there is a window in which nothing is focused, and both
   events fall inside it. So **neither event can name the other element from the focus state**;
   `relatedTarget` is the only way, and dziri needs a field for it or the question "who took my
   focus" is unanswerable.

3. **`focus` fires before `focusin`, and `blur` before `focusout`.** The non-bubbling pair is the
   primitive and the bubbling pair is derived. dziri has no bubbling, so it copies the primitive
   and the distinction does not arise — but it is worth knowing which one is being copied.

4. **Re-focusing what is already focused fires nothing.** No blur, no focus. This is the rule that
   keeps "validate on blur" from validating on every click of the field it is already in.

### Bearing on dziri

Two event kinds in the existing queue, in that order, each carrying the *other* node — which is
finding 2 turned into a field rather than a comment. `EventKind::FOCUS` is already the **window**'s
focus, so the element pair needs its own names.

**One measured divergence, and it is dziri's, not a gap.** A press on a non-focusable `<div>`
clears focus to nothing in Chromium. dziri focuses whatever `hit_test` returns, and `hit_test`
returns only `INTERACTIVE` nodes — so a plain div is not hit and focus clears the same way, but a
div with an `onClick` *is* interactive and would take focus where a browser would not. Named
rather than fixed: making it match means gating focus on the tab-stop set, which would also stop a
click focusing a `tabindex="-1"` element, and that is a behaviour worth keeping.

---

## Focus the user did not ask for: `autofocus` and script `focus()`

**Measured 2026-08-07 · Chromium 151 (via Edge 151) · `probes/focus-without-interaction.html`.
Two byte-identical consecutive runs.** ROADMAP A3 held `autofocus` back for exactly one
unmeasured question: focus arriving without an interaction has no modality, so does it match
`:focus-visible` or not? The answer turned out to be a property of the *bit*, not of `autofocus`.

`#auto` is a `<button>` on purpose. A text field matches `:focus-visible` under every modality
(measured 2026-08-06, `focus-visible.html`), so an autofocused `<input>` would answer YES for a
reason unrelated to autofocus. A button is the kind whose answer can vary.

| step | `activeElement` | `:focus-visible` | UA `outline` |
|---|---|---|---|
| module script runs (deferred, post-parse) | **BODY** | – | – |
| after a tick | **BODY** | – | – |
| after a frame | `button#auto` | **YES** | `auto 1px` |
| insert `<button autofocus>` after load | *unchanged* — `button#auto` | – | – |
| `focus()` start / div / check / text, **no interaction yet** | each | **YES** ×4 | `auto 1px` |
| click start | `button#start` | **no** | `none` |
| → `focus()` div, then `focus()` start | each | **no** | `none` |
| Tab | `button#auto` | **YES** | `auto 1px` |
| → `focus()` div, then `focus()` start | each | **YES** | `auto 1px` |
| `focus()` the already-focused element | unchanged | unchanged | unchanged |

### Four findings

1. **`autofocus` lands at the frame, not at the parse.** *(Partly superseded the same
   day — the timing half is a race. See "autofocus on something that cannot be focused".)* A deferred module script — which runs
   after parsing — sees `BODY`, and so does a tick later. Focus appears only after a rendering
   step, which is where the spec puts "flush autofocus candidates". (This says *by* the first
   frame, not *in* it; the probe cannot distinguish those.)

2. **`autofocus` is once per document.** Inserting an element carrying `autofocus` after load
   moved nothing. This is the cheap answer and it is the true one: a startup-only single-shot,
   not a property re-checked whenever a node appears.

3. **Script `focus()` inherits the ambient modality — it neither sets nor clears it.** The
   *identical* call yields a ring after Tab and no ring after a click. So `:focus-visible` is not
   a property of the focus change at all; the focus change simply carries the current bit along.

4. **Before any interaction, the bit is already set.** With nothing clicked and nothing typed,
   all four script-focused elements matched, including a `<div tabindex=0>`. So the initial state
   is *visible*, and finding 3 fully explains finding 1: **`autofocus` is not special-cased.** It
   inherits the startup bit like every other unrequested focus.

### Bearing on dziri

The design question ROADMAP A3 was holding this for is answered, and it costs one initializer.
dziri already implements the other three halves of the rule correctly: a keystroke sets the bit
(`engine.rs` `key_down`), a pointer press clears it unless it placed a caret, and `set_focus`
does not touch it — which is finding 3, already right.

What is wrong is `paint.rs`'s `focus_visible: false` at construction. Chromium's start value is
**true**. It is unobservable today, because `state.focused` starts at `-1` and a ring needs
something to sit on; it becomes observable the instant `autofocus` exists, and it is the whole
difference between an autofocused field opening with a ring and opening without one.

**One deliberate non-divergence.** dziri's `--focus` screenshot override sets `focus_visible =
focused >= 0` rather than carrying the live bit, so a golden is reproducible. That is a harness
rule, not a behaviour, and finding 3 does not touch it.

---

## `autofocus` on something that cannot be focused

**Measured 2026-08-07 · Chromium 151 (via Edge 151) · `probes/autofocus-hidden.html`.
Two runs, agreeing on the answer and disagreeing on the timing — see the correction below.**

Asked because the section above left it open and dziri's router makes it the common case, not
the corner: a page here is fourteen routes with thirteen `hidden` on the first frame, so "each
route's form focuses its own first field" produces fourteen claims of which one is showing.

One document, three claims, ordered so that each possible rule lands focus somewhere different:
`#hidden` inside `display:none`, `#inert` inside `<fieldset disabled>`, then `#visible`.

| | result |
|---|---|
| after a frame | `input#visible`, `:focus-visible` **YES** |
| `focus()` on `#hidden` | nothing — `activeElement` unchanged |
| `focus()` on `#inert` | nothing — `activeElement` unchanged |

1. **An unfocusable claim is walked past.** It does not win and it does not abort the
   feature: focus landed on the third element, so Chromium takes the first candidate it can
   actually focus.
2. **"Unfocusable" needs no autofocus-specific rule.** Neither element could be focused by
   script either, so the skip falls out of the ordinary focusability test. One rule, not two.

### Bearing on dziri

This is what made `autofocus` a per-node flag on a *set* of nodes rather than a single resolved
id. The compiler marks everyone who asked; `focus::autofocus_candidates` walks the tree — the
same walk, and literally the same function, as the tab order — and takes the first claim that is
not inside a hidden route, not `display:none`, and not disabled. Getting this wrong would have
put the keyboard on an invisible node on thirteen routes out of fourteen, with the ring drawn
somewhere the user cannot see, which is worse than focusing nothing.

The engine still spends the one chance on the first frame even when every claim is hidden. A
route appearing later does not pull focus into it — by then the user is somewhere, and moving
their caret is a worse failure than never having focused at all. That part is dziri's rule; a
browser has no equivalent situation.

> **Correction to the section above, same day.** It reported that `autofocus` "lands at the
> frame, not at the parse", on the strength of two runs in which a deferred module script saw
> `BODY`. This probe's two runs disagree on exactly that: the first saw `input#visible` already
> focused when the module script ran, the second saw `BODY` until a frame later. Both reached
> the same final state.
>
> So the sharp claim is wrong and the useful one survives: **focus is in place by the first
> rendered frame, but whether it beats a deferred script is a race.** The flush is a rendering
> step, and whether a rendering step has happened before the first script depends on load
> timing. Nothing built on this changed — dziri applies autofocus inside the frame either way —
> but "measured twice, identical" clearly did not mean "not racy", which is worth remembering
> the next time two runs agree.

---

## Implicit submission: the conditions, not just the headline

**Measured 2026-08-07 · Chromium 151 (via Edge 151) · `probes/implicit-submission.html`.
Two byte-identical consecutive runs.** The headline was measured on 2026-08-05 — Enter in a
text field inside a `<form>` clicks the submit button, then `submit` fires. That is the easy
half. These are the conditions, and each one changes how much dziri has to build. Every form
here cancels its own `submit`, or the first success would navigate the page away.

| form | Enter in its first field |
|---|---|
| submit button + 1 field | `click:submit, submit` |
| submit button + 2 fields | `click:submit, submit` |
| **no button, 1 field** | **`submit`** — and *no* click |
| **no button, 2 fields** | **nothing** |
| bare `<button>`, 2 fields | `click:submit, submit` |
| `type="button"` only, 2 fields | nothing |
| disabled submit, 2 fields | nothing |
| **disabled submit, 1 field** | **nothing** |
| no button, 1 text + a checkbox | `submit` |
| no button, 1 text + a `<select>` | `submit` |
| no button, 1 text + a `<textarea>` | `submit` |
| `<input type=submit>`, 2 fields | `click:submit, submit` |
| two submit buttons | `click:first, submit` |
| textarea (+ button, 2 fields) | nothing — `textarea.value === "\n"` |
| **checkbox focused** (+ button) | **`click:submit, submit`** |

### The whole algorithm, as measured

On Enter, with focus inside a `<form>`:

1. A `<textarea>` takes the key and types a newline. Nothing else happens.
2. Otherwise find the **default button** — the first `<button type=submit>` or
   `<input type=submit>` in tree order; `type` defaults to `submit` on a `<button>`, so a
   bare one counts, and `type="button"` does not.
   - It exists and is enabled → **click it**, and `submit` follows from the click.
   - It exists and is **disabled** → **nothing at all.** It is not skipped in favour of the
     next rule; a disabled default button blocks submission outright. The one-field case is
     what proves this — the fall-through rule would have submitted and it did not.
   - There is none → submit directly, with no click, **iff exactly one field blocks implicit
     submission.** Two text inputs block; a checkbox, a `<select>` **and a `<textarea>`**
     do not count, so "one text input plus a checkbox" still submits. The textarea is the
     surprising member of that list — it is a text field by every intuition, and the
     blocking set is written in terms of `input` *types*, which it is not one of.

Two more that are easy to get backwards. The submitting field does **not** have to be a text
field: a focused checkbox submits, even though Enter on a checkbox outside a form does nothing
(measured 2026-08-05) — so the earlier row said "Enter does nothing to a checkbox" when what it
had actually established was "there was no form to submit". And with two submit buttons it is the
**first in tree order**, not the last and not the nearest.

### Bearing on dziri

It confirms what ROADMAP A3 predicted from the headline and adds the part that costs: this is a
lookup from the focused field to its form, and then a second lookup from the form to a node
nothing touched. Neither is a row in the per-kind activation table, and both are pure
compile-time facts — which form each field is in, and which button each form would click, are
decided by the markup and cannot change at run time. The only runtime questions are whether the
button is disabled and whether the focused node is a text area.

`type="submit"` and `type="button"` have no meaning in dziri today, so the default-button rule
needs the attribute read before any of this can be faithful.
