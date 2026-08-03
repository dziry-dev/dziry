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

