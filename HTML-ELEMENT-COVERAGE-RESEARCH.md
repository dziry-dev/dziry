# HTML element coverage — how many elements do we actually need?

*Research note, 2026-07-31. Every claim carries a `file:line` or a spec URL. Numbers that are
ambiguous are given both ways with the criterion. Spec counts were extracted by parsing the raw
spec HTML, not by reading a summary.*

---

## 1. Answer up front

**The question "how many elements" has the wrong shape. The honest answer is 4 new render
archetypes, not 113 elements — but you cannot get there without five engine features you do not
have.**

### The numbers

| Number | What it counts |
| --- | --- |
| **113** | conforming HTML elements in the WHATWG index (115 incl. the `math`/`svg` foreign roots; 142 incl. the 29 obsolete ones) |
| **22** | `input type=` states in the spec table — but they collapse to **12 render archetypes**, of which only **9** need rendering you do not already have |
| **6** | elements the spec says can have a **native appearance** at all: `button`, `input`, `meter`, `progress`, `select`, `textarea`. That is the real widget count. |
| **13** | Chromium `ThemePainter` paint entry points — the industry's maximal widget list. It is *shrinking*: Blink is migrating them to pure CSS via `appearance: base`. |
| **92** | lines of widget paint code in **all of Blitz** (Rust + Taffy + Vello) — checkbox and radio only |
| **0** | lines of widget paint code in **Servo** — every control is UA CSS + pseudo-elements |
| **1** | HTML elements implemented end-to-end in this repo today (`button`) |
| **0** | user-agent stylesheet rules in this repo. `<h1>` is not bold, `<p>` has no margin, `<ul>` has no bullet. |

### The tiers

| Tier | n | Cost |
| --- | --- | --- |
| **0a** never rendered (`display: none`) | 12 | one CSS rule each |
| **0b** pure UA-stylesheet box (`div`, `p`, `h1`–`h6`, `strong`, `a`, …) | **60** | ~40 lines of UA CSS + **10 missing CSS properties**. Zero engine code. |
| **1a** paint primitive or layout mode (`hr`, list markers, `details`, `progress`, `meter`, + 10 table elements) | 20 | 10 are tables (a committed non-goal). Of the other 10: `hr` is free, six ride on **one** list-marker feature, two are nested boxes. |
| **1b** replaced / external (`img`, `video`, `iframe`, `canvas`, …) | 10 | only `img` is in scope; already scheduled (A5) |
| **2** interactive form controls | **11 elements / 22 input types** | paint + hit-test + keyboard + state. The real work. |

### Recommended MVP

Ship **4 new render archetypes** and **12 of 22 input keywords**:

1. **A UA stylesheet for Tier 0** — ~40 lines of CSS. Fixes 60 elements at once and is by far the
   best ratio in this document. Needs 10 CSS properties added (`font-family`, `font-style`,
   `text-decoration`, `text-align`, `line-height`, `white-space`, `list-style`, `vertical-align`,
   `content`, heading `font-size` scale).
2. **`input[type=submit|reset|button]`** → button layout. One UA rule; `button` already works.
3. **`input[type=checkbox]`** — box + a `U+2713` glyph. Servo and new-Chromium both use exactly
   this; ~20 lines.
4. **`input[type=radio]`** — ring + bullet; ~20 lines.
5. **One text editor for `text`, `search`, `tel`, `url`, `email`, `password`** — Blitz routes all
   six to a single editor. This is the actual cost centre and it is a text-editing problem, not a
   painting one.
6. **`input[type=hidden]`** — one `display: none !important` rule.
7. **`label` with `for=`** — compile-time association, click forwarding. No paint.
8. **`form` + `onSubmit`** — a callback, no navigation, no entry-list serialisation.

**Defer `select`/`option`/`optgroup`/`datalist` to the overlay phase (B1).** Servo and Chromium
independently concluded the popup must leave the engine because it has to escape window bounds.
Blitz still has no `<select>` at all and stubs it with `option { display: none }`.
`ROADMAP.md:474-478` already cut Select from v1.

**Defer indefinitely:** `date`, `month`, `week`, `time`, `datetime-local`, `number`, `range`,
`color`, `file` — 9 keywords, 6 dedicated widgets. Blitz has none of them.

### The real blockers are not elements

Five engine features gate everything in Tier 2, and none is per-element work:

1. ~~**New state predicates**~~ — **done for `:checked` and `:disabled`**
   (`native-src/dziri-engine/src/protocol.rs:448-455`). It generalised even more cleanly than
   "cleanly": the compiler names a predicate in one table and the run and engine work in bits, so
   the two states cost two entries there, two in `SUPPORTED_PSEUDO` and two bits — protocol v9. The
   compiler resolves them; **no engine reads them yet**, so a `:checked` node wears its base style
   until A3 can say which nodes are checked. `:indeterminate` is deliberately still absent — same
   shape, same cost, but nothing can author it until a control can be in that state.
2. **Attribute selectors** (`[type=checkbox]`) — already scheduled for A1 (`ROADMAP.md:314-317`).
3. **Pseudo-elements or a UA shadow tree** — the mechanism all three reference engines use for
   widget internals. Highest-leverage missing piece: it is how you get sliders, meters and
   checkmarks with *no* engine code.
4. **Sub-node hit regions** — a slider thumb or a spin button has nowhere to live today
   (`paint.rs:314-368` returns whole nodes).
5. **Text editing** — caret, selection, IME, clipboard. `SDL_StartTextInput` is never called, so
   `TEXT_INPUT` never fires at all (`ARCHITECTURE-REVIEW.md:70`, §3 item 10 — already in the
   fix-order list).

`NOTES.md:861-864` already priced the widget set as "plausibly larger than the compiler and runtime
combined." **That is right about text editing and `select`, and wrong about everything else** —
checkbox, radio, `hr`, `progress`, `meter` and the entire Tier 0 baseline are a few hundred lines.

---

## 2. Ground truth: what this repo does today

### 2.1 There are three element tables, and they disagree

| Table | Location | Contents | Size |
| --- | --- | --- | --- |
| Void tags (parser) | `src/compiler/html.ts:109` | `br, hr, img, input, meta, link` | 6 |
| Transparent tags (parser) | `src/compiler/html.ts:116` | `html` | 1 |
| JSX intrinsic allowlist | `src/compiler/jsx-runtime.ts:491` | `body, div, span, p, label, button, input` | 7 |
| Tag → node kind | `src/compiler/compile.ts:303-305` | `button` | **1** |

The HTML parser accepts **any** tag — it has no allowlist at all. `parseHtml` lowercases the tag
name and stores it (`src/compiler/html.ts:182`, `:188-198`); the only tag-sensitive behaviour is
void-ness and `<html>` transparency. `<dvi>`, `<blink>` and `<my-widget>` all parse.

The JSX front-end *does* have an allowlist, and it is seven tags:

```ts
// src/compiler/jsx-runtime.ts:487-491
/**
 * Tags the compiler understands. Enumerated rather than open-ended so a typo like
 * `<dvi>` is a type error instead of an unstyled node.
 */
type Tag = "body" | "div" | "span" | "p" | "label" | "button" | "input";
```

Of those seven, **`button` is the only one with any behaviour attached**:

```ts
// src/compiler/compile.ts:303-305
const KIND_BY_TAG: Record<string, number> = {
  button: NodeKind.BUTTON,
};
```

Everything else takes the fallback at `src/compiler/compile.ts:532`:
`kind: KIND_BY_TAG[el.tag] ?? NodeKind.BOX`.

So `body`, `div`, `span`, `p`, `label` and `input` are **the same node** in the IR. `<p>` and
`<div>` are byte-for-byte identical downstream. `<input>` is a `BOX`.

### 2.2 The "empty box" is literally the default and is documented as such

The comment on the `type` / `name` props says it outright:

```ts
// src/compiler/jsx-runtime.ts:105-110
/**
 * Accepted and ignored. There are no form widgets yet, so `<input>` compiles to
 * an empty box — these exist so markup written against HTML habits typechecks.
 */
type?: string;
name?: string;
```

`Props` (`src/compiler/jsx-runtime.ts:87-139`) is the complete authored-attribute surface:
`class`/`className`, `id`, `onClick`, `type`, `name`, `bind:value`, `style`, `children`. There is no
`value`, `checked`, `disabled`, `placeholder`, `min`, `max`, `step`, `multiple`, `selected`,
`required`, `readonly`, `for`, `src`, `alt`, or `href`. `type` and `name` are parsed and discarded.

### 2.3 The IR has four node kinds, total

```rust
// src/protocol/schema.ts:264-268
{ name: "NodeKind", ty: "u8", values: { BOX: 0, TEXT: 1, BUTTON: 2, LIST: 3 } }
```

`LIST` is a structural wrapper for dynamic arenas, not a rendered thing (`src/ir.ts:363-376`). So
the **entire painted vocabulary is three primitives**: box, text run, button. Confirmed by the
debug dump's `KIND_NAMES = ["box", "text", "button"]` (`src/compiler/compile.ts:1191`).

### 2.4 The paint path can draw exactly three things

`Painter::node` (`native-src/dziri-engine/src/paint.rs:214-301`) is the whole renderer:

1. `bg` fill — `draw_rect` or `draw_round_rect` (`paint.rs:234-242`)
2. border — one inset `draw_round_rect` stroke, uniform width and colour (`paint.rs:244-253`)
3. text — one `draw_str`, centred if `kind == BUTTON`, baseline-aligned otherwise
   (`paint.rs:283-300`)

There is no image draw, no path draw, no clip, no gradient, no glyph run beyond `draw_str`, no
`SkParagraph` yet. **A form control has no drawing code to reach.** An `<input>` reaches
`paint.rs:234`, paints its background and border if the author gave it any, finds
`text_slot < 0` at `paint.rs:260`, and returns. That is the empty box, exactly.

### 2.5 There is no user-agent stylesheet — at all

Grepping the whole repo for `user-agent` / `UA stylesheet` / `default stylesheet` returns **zero
hits** in `src/`, `native-src/` and every root Markdown file.

The cascade starts from `INITIAL_STYLE` (`src/ir.ts:205-266`), which is *CSS initial values*, not
*browser defaults*: `fontWeight: 400`, `fontSize: 16`, no margins, no padding, transparent
background. `walk()` seeds the root with it directly (`src/compiler/compile.ts:731`) and each node
inherits and then applies **author rules only** (`src/compiler/compile.ts:475-476`).

Practical consequences, all verified from the tables above:

- `<h1>` is not bold and not larger — no rule sets it.
- `<p>` has no margin.
- `<ul>`/`<li>` have no markers and no indent. There is no `list-style` property (§2.6).
- `<strong>`/`<b>`/`<em>`/`<i>` are visually identical to `<span>` — there is no
  `font-style`/`italic` property and `font-weight` is only settable by an author rule.
- `<a>` is not blue, not underlined, not clickable.
- `<hr>` is a zero-height transparent box.
- `<br>` is a childless box in a column — it happens to force a line break only because the
  default `direction` is `COLUMN` (`src/ir.ts:222`), which is accidental, not implemented.

The only tag selector in the shipped sample stylesheet is `body` (`former windows/main/index.css line 5`).

### 2.6 The CSS surface is 51 property names, and the missing ones matter here

`expand()` in `src/compiler/css.ts:430-709` handles exactly 51 `case` labels (shorthands
included): background, background-color, color, border-radius, border, border-width, border-color,
padding{,-top,-right,-bottom,-left}, margin{,-top,-right,-bottom,-left}, flex-direction, flex-wrap,
justify-content, align-items, align-self, justify-items, justify-self, flex, flex-grow,
flex-shrink, flex-basis, gap, grid-gap, row-gap, column-gap, grid-template-columns,
grid-template-rows, grid-column, grid-row, aspect-ratio, position, top, right, bottom, left, width,
height, min-width, max-width, min-height, max-height, font-size, font-weight, display.

Those resolve into 46 style fields (`src/ir.ts:114-171`).

Absent and directly relevant to form controls: **`appearance`**, `font-family`, `font-style`,
`text-align`, `text-decoration`, `line-height`, `list-style`, `overflow`, `opacity`, `box-shadow`,
`outline`, `cursor`, `background-image`, `content`, and any pseudo-element (`::before`, `::after`,
`::marker`, `::placeholder`, `::selection`). Selector support is type / `.class` / `#id` /
descendant / `:hover` `:active` `:focus` only (`src/compiler/css.ts:10-11`, `:29`) — no
`:checked`, `:disabled`, `:indeterminate`, `:invalid`, `[attr=…]`.

That is the deeper problem: even a **pure-CSS** UA stylesheet for form controls cannot be
expressed today, because the properties and the state selectors it needs do not exist.

### 2.7 What "interactive" means today

- Five predicates exist: `HOVER`, `ACTIVE`, `FOCUS`, and — since protocol v9 — `CHECKED` and
  `DISABLED` (`native-src/dziri-engine/src/protocol.rs:448-455`). The compiler resolves all five;
  the engine only *sets* the first three, so the last two are compiled and never live.
  Nothing at all for selected, indeterminate, expanded, invalid.
- Ten event kinds exist: `NONE, QUIT, RESIZE, MOUSE_MOVE, MOUSE_DOWN, MOUSE_UP, CLICK, KEY_DOWN,
  TEXT_INPUT, FOCUS` (`native-src/dziri-engine/src/protocol.rs:295-306`). No wheel, no drag, no
  double-click, no composition/IME events.
- A node is interactive if it is a `BUTTON`, has a state style, or has a click handler
  (`src/compiler/compile.ts:884`).
- Hit-testing is a rectangle containment walk of the live tree (`paint.rs:314-368`). Correct, but
  there are no sub-node hit regions — a `<select>` arrow or a slider thumb has nowhere to live.
- Keyboard was a click-and-type stopgap when this was written: `typeInto` appended text and deleted
  on Backspace, and the doc comment on `bindValue` said so — *"No caret, no selection."* **Both of
  those are now out of date.** The engine owns a caret and an `(anchor, focus)` selection, every
  editing key is one splice, and the movement and boundary rules all came from probes rather than
  from assumption (BROWSER-FACTS.md). Still true: no Tab order and no Enter/Space activation, which
  `ROADMAP.md` A3 lists as unbuilt.
- `SDL_StartTextInput` was never called when this was written, so `TEXT_INPUT` never fired. Fixed —
  and fixing it alone changed nothing, because the events it unblocked arrived addressed to a node
  that could not hold focus: `buildInteractive` had no clause for an editable. Two bugs stacked, and
  the outer one hid the inner one.

The sample app's own "text field" is not an `<input>` — it is
`<div bind:value={draft} />` (`windows/main/pages/features.tsx:125`). That is also why the field
could not be focused for as long as it could not: a `<div>` with a binding and no other reason to be
interactive was in no clause of `buildInteractive`, and `hit_test` returns only interactive nodes.

### 2.8 What the project's own docs already decided

These are authoritative for direction and they point *away* from implementing HTML elements.

**`ROADMAP.md:237-238` — the current status line:**
> **Not started**: text clipping and editing, scrolling, images, SVG, animation, widgets,
> windowing, packaging, hot reload, CLI, diagnostics.

**`NOTES.md:861-864` — P6, Widgets:**
> The set that has to be built rather than installed, because npm UI libraries need a DOM:
> dropdown, select, combobox, dialog, tooltip, scroll area, text input. **Plausibly larger than the
> compiler and runtime combined.** Depends on P3.

**`NOTES.md:564-565`:**
> That means the widget set — every dropdown, combobox, dialog, focus ring — is ours to build.

**`ROADMAP.md:387-395` — A5 is where the first real control lands:**
> **Single-line text input**, moved forward from B4: selection, IME, clipboard (text only for v1).
> You cannot build a login form without it… *Rich* editing — multi-line, undo, word navigation —
> stays deferred indefinitely.

**`ROADMAP.md:437-447` — B4, rich text editing, is explicitly not scheduled.**

**`ROADMAP.md:470-478` — the delivery unit is a shadcn-style component, not an HTML element:**
> - **Tier 0** — Button, Badge, Card, Separator, Alert, Label, Skeleton, static Table. No
>   primitives; ships after A1.
> - **Tier 1** — Input, Checkbox, Radio, Switch, Tabs, Toggle. Needs A3 and A5's text input.
> - **Tier 2 — cut from v1.** Dropdown, Select, Combobox, Popover, Tooltip, Dialog, Sheet, Command…
>   **A desktop app with working forms and no dropdowns is shippable; one with a broken Dialog is
>   not.**

**`ROADMAP.md:213-214` — committed non-goals:**
> **floats, tables, writing modes, fragmentation, multi-column, print.** Those are document-layout
> features. This is a UI framework.

**`ROADMAP.md:218-220` — the CSS denominator is Tailwind, not CSS:**
> "Full CSS" cannot be finished and would destroy the pitch. Tailwind's utility surface is a
> curated subset people actually ship products with — and unlike "CSS support" it is finite,
> enumerable and testable.

**`ARCHITECTURE-REVIEW.md` §3 (the fix-order authority, lines 95-118)** contains **no element- or
widget-coverage item**. The only adjacent entry is #10, `SDL_StartTextInput` — a prerequisite for
any text control, not element coverage itself. Element coverage is a Phase A/B/C roadmap concern,
and nothing in §3 or §4 blocks it or claims it.

### 2.9 Summary of local status

| Element | Parses? | Distinct behaviour? | Renders as |
| --- | --- | --- | --- |
| `div`, `span`, `body` | yes | n/a (this *is* the box) | correct box |
| `p` | yes | none | box with no margin |
| `label` | yes (allowlisted) | **none** — no `for` association | plain box |
| `button` | yes | `NodeKind.BUTTON`: centred label, always interactive | works |
| `input` | yes (allowlisted, void) | **none**; `type`/`name` discarded | **empty box** |
| `br`, `hr`, `img`, `meta`, `link` | yes (void) | none | empty / zero box |
| everything else (HTML path) | yes, silently | none | box |
| everything else (JSX path) | **type error** | — | — |

Declared-but-unimplemented, precisely: **`input` and `label`** are in the JSX allowlist with no
implementation; `img` and `hr` are in the void list with no implementation. **`button` is the only
HTML element implemented end-to-end.**

---

## 3. What the specs say the denominator is

All counts in this section were extracted by parsing the raw spec HTML, not by reading a summary.
Where a number is ambiguous, both are given with the criterion.

### 3.1 How many HTML elements are there? — 113, 115, or 142

| Number | Criterion | Source |
| --- | --- | --- |
| **111** | physical `<tr>` rows in the index table (`h1…h6` share one row) | [Index — Elements](https://html.spec.whatwg.org/multipage/indices.html#elements-3) |
| **113** | **conforming HTML elements**, expanding `h1…h6`, excluding the two foreign-namespace roots and the "autonomous custom elements" row | same |
| **115** | 113 + `math` (MathML root) + `svg` (SVG root), i.e. every name in column 1 | same |
| **29** | obsolete / non-conforming elements — *"entirely obsolete, and must not be used by authors"* | [§16.2 Non-conforming features](https://html.spec.whatwg.org/multipage/obsolete.html#non-conforming-features) |
| **142** | **every element name the spec knows**: 113 conforming + 29 obsolete | derived |

The index is explicitly *non-normative* and lists **only conforming** elements; obsolete ones live
solely in §16. Some obsolete elements still carry *implementation* requirements even though authors
must not use them — `marquee`, `frame`/`frameset`, `dir`, `basefont`
([§16 Obsolete features](https://html.spec.whatwg.org/multipage/obsolete.html)).

The 29 obsolete elements: `applet, acronym, bgsound, dir, frame, frameset, noframes, isindex,
keygen, listing, menuitem, nextid, noembed, param, plaintext, rb, rtc, strike, xmp, basefont, big,
blink, center, font, marquee, multicol, nobr, spacer, tt`. Note **`param` is now non-conforming**,
and **`selectedcontent`** (the customizable-`<select>` element) is new in the conforming index.

**For this project the working denominator is 113.** Nobody is implementing `<marquee>`.

### 3.2 Void elements — 13, this repo has 6

> **Void elements** … `area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `link`, `meta`,
> `source`, `track`, `wbr`
> — [§13.1.2](https://html.spec.whatwg.org/multipage/syntax.html#void-elements)

`src/compiler/html.ts:109` has `br, hr, img, input, meta, link` — **missing `area`, `col`, `embed`,
`source`, `track`, `wbr`**. Today that is a latent parse bug, not a rendering one: `<source>` inside
`<video>` would throw `unclosed <source>` from `src/compiler/html.ts:205`. Cheap to fix (one line)
and worth fixing regardless of widget work.

### 3.3 Form-control categories — the exact membership lists

From [§4.10.2 Categories](https://html.spec.whatwg.org/multipage/forms.html#categories):

| Category | n | Members |
| --- | --- | --- |
| **Form-associated** | 9 | `button`, `fieldset`, `input`, `object`, `output`, `select`, `textarea`, `img`, form-associated custom elements |
| **Listed** | 8 | `button`, `fieldset`, `input`, `object`, `output`, `select`, `textarea`, FACE |
| **Submittable** | 5 | `button`, `input`, `select`, `textarea`, FACE |
| **Resettable** | 5 | `input`, `output`, `select`, `textarea`, FACE |
| **Autocapitalize/autocorrect-inheriting** | 6 | `button`, `fieldset`, `input`, `output`, `select`, `textarea` (no custom elements) |
| **Labelable** | 8 | `button`, `input` *(unless `type=hidden`)*, `meter`, `output`, `progress`, `select`, `textarea`, FACE |

Asymmetries worth encoding rather than rediscovering: `img` is form-associated but **not** listed;
`object` is listed but not submittable or resettable; `fieldset` is listed but not
submittable/resettable/labelable; `meter` and `progress` are labelable but **not** form-associated.

### 3.4 Replaced elements — 8; embedded content — 10

> The following elements **can be** replaced elements: `audio`, `canvas`, `embed`, `iframe`, `img`,
> `input`, `object`, `video`.
> — [§15.4 Replaced elements](https://html.spec.whatwg.org/multipage/rendering.html#replaced-elements)

`canvas`, `object`, `audio`, `img` and `input` are replaced only *conditionally*. The separate
**embedded content** content-model category has 10 members and diverges:
`audio, canvas, embed, iframe, img, MathML math, object, picture, SVG svg, video`
([§3.2.5.2.6](https://html.spec.whatwg.org/multipage/dom.html#embedded-content-2)). `picture`,
`math`, `svg` are embedded content but not replaced; `input` is replaced but not embedded content.

### 3.5 Native appearance — only 6 elements are "widgets" per the spec

> The following elements can have a **native appearance** for the purpose of the CSS `appearance`
> property: `button`, `input`, `meter`, `progress`, `select`, `textarea`.
> — [§15.5.1](https://html.spec.whatwg.org/multipage/rendering.html#native-appearance-2)

**Six.** That is the spec's own answer to "how many elements need custom widget rendering", and it
is the number that should anchor the estimate. Everything else in HTML is a styled box.

The spec further splits them into **devolvable** widgets (degrade gracefully to CSS boxes) and
**non-devolvable** ones. Non-devolvable: `input[type=range]`, `input[type=checkbox]`,
`input[type=radio]`. Everything else devolves.

### 3.6 The `input` type= table — exactly 22 states

[§4.10.5.1 States of the type attribute](https://html.spec.whatwg.org/multipage/input.html#attr-input-type)
— 23 `<tr>` rows = 1 header + **22 data rows**. (`missing value default` and `invalid value default`
both map to Text and are not separate rows.)

| # | Keyword | State | Control type (spec's own words) | Implicit ARIA role |
| --- | --- | --- | --- | --- |
| 1 | `hidden` | Hidden | n/a | *no role* |
| 2 | `text` | Text | A text control | `textbox` |
| 3 | `search` | Search | Search control | `searchbox` |
| 4 | `tel` | Telephone | A text control | `textbox` |
| 5 | `url` | URL | A text control | `textbox` |
| 6 | `email` | Email | A text control | `textbox` |
| 7 | `password` | Password | A text control that **obscures data entry** | *no role* |
| 8 | `date` | Date | A date control | *no role* |
| 9 | `month` | Month | A month control | *no role* |
| 10 | `week` | Week | A week control | *no role* |
| 11 | `time` | Time | A time control | *no role* |
| 12 | `datetime-local` | Local Date and Time | A date and time control | *no role* |
| 13 | `number` | Number | A text control or **spinner** control | `spinbutton` |
| 14 | `range` | Range | A **slider** control or similar | `slider` |
| 15 | `color` | Color | A **color picker** | *no role* |
| 16 | `checkbox` | Checkbox | A checkbox | `checkbox` |
| 17 | `radio` | Radio Button | A radio button | `radio` |
| 18 | `file` | File Upload | A label and a button | *no role* |
| 19 | `submit` | Submit Button | A button | `button` |
| 20 | `image` | Image Button | A clickable image, or a button | `button` |
| 21 | `reset` | Reset Button | A button | `button` |
| 22 | `button` | Button | A button | `button` |

Roles from [ARIA in HTML §doc conformance](https://www.w3.org/TR/html-aria/#docconformance).
Override: `text|search|tel|url|email` **with a `list` attribute** become `combobox`, not
textbox/searchbox.

**22 keywords collapse to 12 render archetypes**, which is the number that actually drives work:

| Archetype | Keywords | n |
| --- | --- | --- |
| Not rendered (`display: none !important`) | `hidden` | 1 |
| Single-line text entry | `text`, `search`, `tel`, `url`, `email` | 5 |
| Obscured text entry | `password` | 1 |
| Button layout | `submit`, `reset`, `button` | 3 |
| Checkbox | `checkbox` | 1 |
| Radio | `radio` | 1 |
| Slider | `range` | 1 |
| Spinner | `number` | 1 |
| Colour well + picker | `color` | 1 |
| File name span + picker button | `file` | 1 |
| Clickable image | `image` | 1 |
| Date/time field editors | `date`, `month`, `week`, `time`, `datetime-local` | 5 |
| **Total** | | **22 keywords / 12 archetypes** |

Only **9 archetypes need genuinely new rendering** beyond box+text+button: obscured text, checkbox,
radio, slider, spinner, colour well, file control, image button, date/time editors.

### 3.7 What the Rendering section actually demands

All from [§15.5 Widgets](https://html.spec.whatwg.org/multipage/rendering.html). These are
non-normative "expected rendering", which is the closest thing to a normative look.

| Element / state | Spec's expected rendering |
| --- | --- |
| **Button layout** (§15.5.3) | Establishes a new formatting context; `inline-size: auto` → **fit-content**; an **anonymous button content box** that is *"centered horizontally"* and *"centered vertically"* when it does not overflow. Spec has an open issue: *"Need to define the primitive appearance."* |
| **Text entry** (§15.5.6) | Intrinsic inline size = *converting a character width to pixels* = `(size − 1) × avg + max`, with `size` from the `size` attribute or defaulting to **20**. *"Expected to be scroll containers and support scrolling in the inline axis, but not the block axis."* `line-height` has a floor of the `normal` used value. |
| **Domain-specific** (§15.5.7) | Date/month/week/time/datetime-local: *"about one line high, and about as wide as necessary to show the widest possible value."* |
| **Range** (§15.5.8) | Non-devolvable slider. Lowest value on the right under `direction: rtl`, left otherwise. *"Predefined suggested values (provided by the `list` attribute) are expected to be shown as tick marks on the slider, which the slider can snap to."* |
| **Colour well** (§15.5.9) | Uses **button layout with no child boxes**; the anonymous content box has *"a presentational hint setting the `background-color` property to the element's value."* Picker opens on activation. |
| **Checkbox / radio** (§15.5.10) | *"inline-block box containing a single checkbox control, **with no label**"* (same wording for radio). Both carry the open issue *"Need to detail the native appearance and primitive appearance."* — **the spec does not say what a checkbox looks like.** |
| **File upload** (§15.5.11) | *"a span of text giving the filename(s) of the selected files, if any, followed by a button"*; the button uses button layout and matches `::file-selector-button`; its text is implementation-defined, e.g. *"Choose file"*. |
| **Input as button** (§15.5.12) | Button layout; content is the `value` attribute, else implementation-defined locale-specific text. |
| **`meter`** (§15.5.14) | `appearance: auto`; inline-block, **`block-size: 1em`, `inline-size: 5em`, `vertical-align: -0.2em`**, depicting a gauge. |
| **`progress`** (§15.5.15) | `appearance: auto`; inline-block, **`1em` × `10em`**, `vertical-align: -0.2em`. *"different presentations for determinate and indeterminate."* |
| **`select`** (§15.5.16) | List box vs drop-down chosen by `multiple` × display size. List-box intrinsic block size = **four rows** if `size` is absent. Inline size = widest `option`/`optgroup` label **including indent**, plus a scrollbar for list boxes. Base-appearance shadow tree is `select button slot` + `select popover` (`::picker(select)`). |
| **`textarea`** (§15.5.17) | Effective width = `size × avg + scrollbar`; effective height = `rows` lines + scrollbar. `white-space: pre-wrap`; `wrap=off` is a presentational hint for `white-space: pre`. |

Two things stand out:

1. **The spec deliberately refuses to say what a checkbox looks like.** §15.5.10 and §15.5.6 both
   carry open issues saying the native/primitive appearance still needs defining. So there is no
   spec-conformance bar to clear on visual design — pick something and move on.
2. **`meter` and `progress` are fully specified as boxes with fixed intrinsic sizes.** `1em × 5em`
   and `1em × 10em`. That is why Chromium can `return true` on `<meter>` and paint it with CSS only.

### 3.8 The UA-stylesheet baseline for form controls

The spec's own default CSS
([§15.3.10 Form controls](https://html.spec.whatwg.org/multipage/rendering.html#form-controls)) is
short enough to quote entirely:

```css
input, button, textarea { letter-spacing: initial; word-spacing: initial; line-height: initial; }
input, select, button, textarea { text-transform: initial; text-indent: initial;
                                  text-shadow: initial; appearance: auto; }
input:not([type=range i],[type=checkbox i],[type=radio i]) { overflow: clip !important;
                                                             overflow-clip-margin: 0 !important; }
input, select, textarea { text-align: initial; }
input:is([type=reset i],[type=button i],[type=submit i]), button { text-align: center; }
input, button { display: inline-block; }
input[type=hidden i], input[type=file i], input[type=image i] { appearance: none; }
input:is([type=radio i],[type=checkbox i],[type=reset i],[type=button i],[type=submit i],
         [type=color i],[type=search i]), select, button { box-sizing: border-box; }
textarea { white-space: pre-wrap; }
input[type=hidden i] { display: none !important; }
```

> For `input` elements whose `type` is not Hidden or Image Button … **the inner display type is
> always `flow-root`.**

Plus `details`/`summary` ([§15.5.5](https://html.spec.whatwg.org/multipage/rendering.html#the-details-and-summary-elements)):

```css
details, summary { display: block; }
details > summary:first-of-type { display: list-item; counter-increment: list-item 0;
                                  list-style: disclosure-closed inside; }
details[open] > summary:first-of-type { list-style-type: disclosure-open; }
```

The disclosure triangle is a **list marker**, not paint code — `list-style: disclosure-closed`.

And `fieldset`/`legend`
([§15.3.12](https://html.spec.whatwg.org/multipage/rendering.html#the-fieldset-and-legend-elements)) —
the only genuinely unrepresentable-in-CSS layout in the whole form system: *the border is not
painted behind the rendered legend's rectangle*.

### 3.9 State the engine must track — from HTML-AAM

[HTML-AAM §3.6 attribute mappings](https://www.w3.org/TR/html-aam-1.0/#x3-6-html-attribute-state-and-property-mappings)
is the authoritative list of what state a control has, because every accessibility property has to
come from somewhere in the engine.

| ARIA state/property | Source | Applies to |
| --- | --- | --- |
| `aria-checked="true"/"false"` | `checked` present/absent | `input[type=checkbox\|radio]` |
| `aria-checked="mixed"` | **`indeterminate` IDL attribute** | `input[type=checkbox]` |
| `aria-disabled="true"` | `disabled` | `button`, `input`, `optgroup`, `option`, `select`, `textarea`, `fieldset` |
| `aria-readonly="true"` | `readonly` | `input`, `textarea` |
| `aria-required` | `required` | `input`, `select`, `textarea` |
| `aria-placeholder` | `placeholder` | `input`, `textarea` |
| `aria-invalid` | `pattern` match result | `input` |
| `aria-valuemin` / `aria-valuemax` | `min` / `max` | `input`, `meter`, `progress` |
| `aria-valuenow` | `value` | `input[type=date\|datetime-local\|email\|month\|number\|password\|range\|search\|tel\|text\|url\|week]`, `meter`, `progress` |
| `aria-valuenow` + `aria-valuetext` | `value` | `input[type=color]` |
| `aria-selected="true"` | `selected` | `option` |
| `aria-expanded="true"/"false"` | **`open`** | `details` — *the only HTML-attribute source of `aria-expanded` in AAM* |
| `aria-multiselectable="true"` | `multiple` | `select` |
| `aria-controls` | `list` | `input` |
| `aria-setsize` / `aria-posinset` | radio group membership | `input[type=radio]` |
| `aria-multiline="true"` | **baked into the role mapping, no attribute** | `textarea` |

Notable: **`progress` exposes `aria-valuemin = 0` implicitly** and exposes *no* value triple when
indeterminate ([AAM §3.5.105](https://www.w3.org/TR/html-aam-1.0/#el-progress)). **`datalist` is only
mapped when linked to a real `input`** ([§3.5.28](https://www.w3.org/TR/html-aam-1.0/#el-datalist)).
`select` as a combobox gets no `aria-expanded` from any attribute — the popup state is the widget's
own.

`ROADMAP.md:461-464` already commits to emitting a semantics table at compile time (C1) with
"`role`, state, label, relationships, plus keyboard interaction contracts". **This table is exactly
that schema**, and it is available now rather than after C1.

---

## 4. How real engines solved this — and how little paint code it took

Three engines were read at source level. The headline: **the custom-paint surface is tiny and
shrinking**, and all three converge on the same split.

### 4.1 Blitz (DioxusLabs/blitz) — the closest analogue: Rust + Taffy + Vello

**The entire widget theme is 92 lines.**
[`packages/blitz-paint/src/render/form_controls.rs`](https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-paint/src/render/form_controls.rs)
has one entry point and a two-arm match:

```rust
match type_attr {
    Some("checkbox") => draw_checkbox(scene, checked, frame, self.transform, accent_color, scale),
    Some("radio")    => draw_radio_button(scene, checked, center, self.transform, accent_color, scale),
    _ => {}
}
```

`draw_checkbox` = a filled rounded rect plus a 3-point Bézier tick. `draw_radio_button` = three
concentric circles. That is all the custom painting in the engine.

Tag-name special-casing lives in exactly one place —
[`packages/blitz-dom/src/layout/construct.rs:353-373`](https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/layout/construct.rs):

```rust
if matches!(tag_name, "input" | "textarea") {
    if tag_name == "textarea" { create_text_editor(doc, container_node_id, true); return; }
    else if matches!(type_attr, None | Some("text"|"password"|"email"|"number"|"search"|"tel"|"url")) {
        create_text_editor(doc, container_node_id, false); return;
    } else if matches!(type_attr, Some("checkbox"|"radio")) {
        create_checkbox_input(doc, container_node_id); return;
    }
}
```

Seven `type=` values plus bare `<input>` all get the *same* Parley editor — `password` is not
masked, `number` has no spinner, `search` has no cancel button.

Widget state is a payload enum, not a class hierarchy
([`blitz-dom/src/node/element.rs:263-288`](https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/node/element.rs)):
`TextInput(TextInputData)`, **`CheckboxInput(bool)`**, `FileInput(FileData)`, `Image`, `Canvas`,
`TableRoot`, `SubDocument`, `CustomWidget`, `Stylesheet`, `None`. The whole checkbox is one bool.

Status per its own tracking issue
([DioxusLabs/blitz#258 "Tracking: Form controls"](https://github.com/DioxusLabs/blitz/issues/258),
opened 2025-09-12, **still open**): `button`, `input[type=submit]`, `text`, `textarea`, `checkbox`,
`radio`, `file`, `hidden` done; **`select` not implemented at all**; `color`, `meter`, `progress`,
`output`, `password`, `email`, `url`, `reset` unticked.

Its UA sheet
([`blitz-dom/assets/default.css`](https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/assets/default.css),
928 lines, forked from Gecko) spends **~70 lines** on form controls. Two rules are worth stealing
outright:

```css
button, input[type="submit"], input[type="reset"], input[type="button"] {
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid #999; border-radius: 1px; padding: 1px 6px;
    color: black; background-color: #EFEFEF; text-align: center;
}
option { display: none; }
```

`<button>` costs **zero paint code** — it is flexbox. And `option { display: none }` is how "we have
no `<select>` yet" is spelled honestly: the select paints as a bordered box; the options generate no
boxes at all.

Note the ratio: `blitz-dom/src/form.rs` (submission, entry lists, urlencoded/multipart) is **424
lines — 4.6x all widget paint code combined.**

### 4.2 Servo — *zero* lines of custom widget paint

Servo splits UA CSS into
[`components/layout/stylesheets/user-agent.css`](https://github.com/servo/servo/blob/main/components/layout/stylesheets/user-agent.css)
(353 lines, spec rules) and
[`servo.css`](https://github.com/servo/servo/blob/main/components/layout/stylesheets/servo.css)
(471 lines, actual widget appearance). Every control is CSS boxes and pseudo-elements:

```css
input[type="checkbox"]:checked::before       { content: "✔"; }
input[type="checkbox"]:indeterminate::before { content: "—"; }
input[type="radio"]::before { /* ring   */ border: 2px solid grey; border-radius: 50%; }
input[type="radio"]::after  { /* bullet */ border-radius: 50%; }
input[type="radio"]:checked::after { background: black; }

input[type="range"]::slider-track { height: 4px; background-color: ButtonFace; }
input[type="range"]::slider-fill  { height: 4px; background-color: #007aff; }
input[type="range"]::slider-thumb { width: 16px; height: 16px; border-radius: 50%; }

input::color-swatch { border: 1px solid grey; border-radius: 2px; height: 100%; width: 100%; }
input[type="file"]::file-selector-button { /* shared button rule */ }
```

Text controls use private pseudo-elements that generate real boxes:
`::-servo-text-control-inner-container`, `::-servo-text-control-inner-editor`, `::placeholder`.

Servo's own TODO in that file says pseudo-elements are the hacky option and **a UA shadow tree is
the correct one** — it shipped pseudo-elements anyway.

**`<select>` popups, colour pickers and file pickers leave the engine entirely.**
[`components/shared/embedder/embedder_controls.rs`](https://github.com/servo/servo/blob/main/components/shared/embedder/embedder_controls.rs):

```rust
pub struct SelectElementRequest { pub options: Vec<SelectElementOptionOrOptgroup>,
                                  pub selected_options: Vec<usize> }
pub enum EmbedderControlResponse { SelectElement(Vec<usize>), ColorPicker(Option<RgbColor>),
                                   FilePicker(Option<Vec<SelectedFile>>), ContextMenu(...) }
```

The engine ships a flattened option list to the host and gets back selected indices; the dropdown is
drawn by `ports/servoshell`. Servo considers its own form styling substandard —
[servo/servo#33168 "Improve the default styling of HTML form controls"](https://github.com/servo/servo/issues/33168)
is open.

### 4.3 Chromium/Blink — 13 themed widgets, and it is deleting them

`forms.css` **no longer exists**; all form UA CSS is merged into
[`third_party/blink/renderer/core/html/resources/html.css`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/resources/html.css)
(2718 lines), plus `input_multiple_fields.css` for date/time field editors.

The canonical widget list is
[`core/paint/theme_painter.h`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/paint/theme_painter.h),
whose class comment states the design rule exactly:

> This method is called to paint the widget as a **background** of the LayoutObject. A widget's
> foreground, e.g. the text of a button, is **always rendered by the engine itself**.

**13 virtual paint entry points — the canonical "needs custom paint" list:**

| # | Method | Appearance value |
| --- | --- | --- |
| 1 | `PaintCheckbox` | `kCheckbox` |
| 2 | `PaintRadio` | `kRadio` |
| 3 | `PaintButton` | `kPushButton`, `kSquareButton`, `kButton` |
| 4 | `PaintInnerSpinButton` | `kInnerSpinButton` (number) |
| 5 | `PaintTextField` | `kTextField` |
| 6 | `PaintTextArea` | `kTextArea` |
| 7 | `PaintMenuList` | `kMenulist` (select, closed) |
| 8 | `PaintMenuListButton` | `kMenulistButton` (the arrow) |
| 9 | `PaintProgressBar` | `kProgressBar` |
| 10 | `PaintSliderTrack` | `kSliderHorizontal/Vertical` |
| 11 | `PaintSliderThumb` | `kSliderThumbHorizontal/Vertical` |
| 12 | `PaintSearchField` | `kSearchField` |
| 13 | `PaintSearchFieldCancelButton` | `kSearchFieldCancelButton` |

Plus `PaintCapsLockIndicator` and `PaintSliderTicks` (datalist ticks). All 13 default to
`{ return true; }` — the fallback is *pure CSS*.

Explicitly **not** themed (`return true` in the `ThemePainter::Paint` switch in
[`theme_painter.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/paint/theme_painter.cc)):
`kMeter`, `kMenulistButton`, `kListbox`, and all four media-slider values. **`<meter>` has no custom
paint in Chromium** — UA CSS + shadow DOM only (`::-webkit-meter-bar`,
`::-webkit-meter-optimum-value`, … at `html.css:1439-1512`). Same for `<select multiple>`.

There is **no `layout_button.h`, `layout_slider.h`, `layout_meter.h`, `layout_menu_list.h` or
`layout_list_box.h`** any more. `core/layout/forms/` contains only fieldset and four text-control
files; `layout_progress.{h,cc}` survives in `core/layout/`. Only two things genuinely need custom
layout: **fieldset/legend** (the legend cuts the border) and **text controls** (inner editor,
scrolling, placeholder overlay).

Blink is actively migrating off native paint: `html.css` is saturated with
`-internal-auto-base(legacy, base)`, selecting a pure-CSS value under `appearance: base`:

```css
input[type="checkbox" i] {
  display: -internal-auto-base(inline-block, inline-flex);
  align-items: -internal-auto-base(unset, center);
  border: -internal-auto-base(initial, 1px solid currentColor);
}
input[type="checkbox" i]::checkmark { content: -internal-auto-base(unset, '\2713' / ''); }
input[type="checkbox" i]:indeterminate::checkmark { content: -internal-auto-base(unset, '\2500' / ''); }
```

That is byte-for-byte Servo's present technique. **Chromium's future checkbox is Servo's current
checkbox.** Buttons likewise become `inline-flex` — matching Blitz.

The `<select>` popup is the one documented case in Chromium where a `RenderWidget` exists without a
`RenderView`, because it must be a native window escaping the frame bounds
([How Chromium Displays Web Pages](https://www.chromium.org/developers/design-documents/displaying-a-web-page-in-chrome/)).
Servo reached the identical conclusion independently.

### 4.4 Cross-engine matrix

| Element / type | Blitz | Servo | Chromium legacy | Chromium `appearance: base` |
| --- | --- | --- | --- | --- |
| `button`, `input[type=submit\|reset\|button]` | **UA CSS** (`inline-flex`) | **UA CSS** | `PaintButton` | **UA CSS** (`inline-flex`) |
| `input[type=checkbox]` | custom paint ~35 LOC | **UA CSS** `::before "✔"` | `PaintCheckbox` | **UA CSS** `::checkmark` |
| `input[type=radio]` | custom paint ~20 LOC | **UA CSS** `::before`+`::after` | `PaintRadio` | **UA CSS** `::checkmark` |
| `text/password/email/number/search/tel/url` | one Parley editor, no per-type behaviour | `::-servo-text-control-inner-editor` | `PaintTextField` + `LayoutTextControlSingleLine` | UA CSS |
| `textarea` | Parley editor (multiline) | same inner editor | `PaintTextArea` + `LayoutTextControlMultiLine` | UA CSS |
| `input[type=range]` | not implemented | **UA CSS** `::slider-track/-fill/-thumb` | `PaintSliderTrack/Thumb/Ticks` | UA CSS |
| `input[type=color]` | not implemented | **UA CSS** `::color-swatch` + embedder picker | native picker | UA CSS |
| `input[type=file]` | feature-gated | **UA CSS** `::file-selector-button` + embedder | `::-webkit-file-upload-button` | UA CSS |
| `select` (closed) | **not impl — `option{display:none}`** | **UA CSS** (button rule) | `PaintMenuList` + `PaintMenuListButton` | **UA CSS** `> button:first-child` |
| `select` popup | not impl | **embedder** (`SelectElementRequest`) | **native `WebPagePopup`** | `::picker(select)` in-page |
| `select multiple` (listbox) | not impl | [unverified] | **UA CSS only** (`return true`) | UA CSS |
| `progress` | not impl | [unverified] | `PaintProgressBar` + `LayoutProgress` | UA CSS |
| `meter` | not impl | [unverified] | **UA CSS only** (`return true`) | UA CSS |
| `fieldset`/`legend` | UA CSS | UA CSS | `LayoutFieldset` + custom algorithm | same |
| `details`/`summary` | implemented | **UA CSS** `::details-content` | UA CSS | same |

### 4.5 The eight transferable lessons

1. **Budget ~100 lines of paint code, not a toolkit.** Blitz ships a usable HTML renderer with 92.
2. **`display: inline-flex` + centring in the UA sheet gets `<button>` for free.** All three engines
   do this. Zero paint code when you already have flex layout — and this repo has Taffy.
3. **Prefer a glyph over vector paint for check/bullet marks.** Servo ships `content: "✔"`;
   Chromium's *new* model ships `content: '\2713'`. Blitz's hand-built Bézier tick is the outlier.
4. **Pseudo-elements — or better, a UA shadow tree — are the universal mechanism for widget
   internals.** Slider track/fill/thumb, colour swatch, meter bar, file-selector button, checkmark.
   If UA-private pseudo-elements generate real boxes, sliders and meters need **no engine code** —
   Chromium literally `return true`s on `<meter>`. Both Servo's TODO and Chromium's implementation
   say shadow trees beat pseudo-elements long-term.
5. **`<select>` popups leave the engine.** Servo and Chromium arrived there independently for the
   same reason: the popup must escape window bounds and paint above everything. Servo's
   `SelectElementRequest → Vec<usize>` shape is directly copyable, and it matches this repo's
   planned overlay layer (`ROADMAP.md:411-418`, B1).
6. **`option { display: none }` is the honest one-line stub** before `<select>` exists.
7. **Only fieldset/legend and text controls genuinely need custom layout.** Blink deleted every
   other widget LayoutObject. Do not build a widget layout-object hierarchy — that is something
   Chromium spent years removing.
8. **Text input is the real cost centre, and it is a text-editing problem, not a painting one.**
   All three engines have a dedicated inner-editor concept. `ROADMAP.md:392-394` already scheduled
   it (A5); `NOTES.md:861-864` already priced it ("plausibly larger than the compiler and runtime
   combined").

---

## 5. The tiered implementation list

The 113 conforming HTML elements partition into five buckets. Counts sum to 113 exactly.

| Tier | n | What it costs |
| --- | --- | --- |
| **0a. Never rendered** | 12 | one `display: none` rule each |
| **0b. Tier 0 — UA-stylesheet default box** | 60 | ~40 lines of UA CSS, zero engine code |
| **1a. Tier 1 — needs a paint primitive or a layout mode** | 20 | list markers, a rule, disclosure triangles, gauges, table layout |
| **1b. Tier 1 — replaced / external content** | 10 | image decode, media, sub-surfaces |
| **2. Tier 2 — interactive form controls** | 11 | paint + hit-test + keyboard + state |

### Tier 0a — never rendered (12)

`area`, `base`, `datalist`, `head`, `link`, `meta`, `noscript`, `rp`, `script`, `style`, `template`,
`title`
([§15.3.1 Hidden elements](https://html.spec.whatwg.org/multipage/rendering.html#hidden-elements)).
Two carry hidden functionality: `area` is an image-map hit region, and `datalist` drives combobox
suggestions even though its box is suppressed.

### Tier 0b — pure UA-stylesheet box (60)

`a, abbr, address, article, aside, b, bdi, bdo, blockquote, body, br, cite, code, data, dd, del,
dfn, div, dl, dt, em, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hgroup, html, i,
ins, kbd, main, map, mark, nav, p, pre, q, rt, ruby, s, samp, search, section, selectedcontent,
slot, small, span, strong, sub, sup, time, u, var, wbr`

**Nothing to "implement" beyond default styles** — but that is only true if the CSS engine has the
properties. It does not (§2.6). The 60 need these ten missing properties:

| Missing property | Unlocks |
| --- | --- |
| `font-family` (monospace) | `code`, `kbd`, `samp`, `pre` |
| `font-style: italic` | `em`, `i`, `cite`, `dfn`, `var`, `address` |
| `font-weight: bolder` | `strong`, `b`, `h1`–`h6` (already have `font-weight`, needs the UA rule) |
| `text-decoration` | `a`, `del`, `ins`, `s`, `u`, `abbr[title]` |
| `font-size: smaller/larger` + heading scale | `small`, `h1`–`h6` |
| `vertical-align` | `sub`, `sup` |
| `white-space: pre` | `pre` |
| `text-align` | `caption`, `th`, centred content |
| `line-height` | everything textual |
| `content` / `quotes` | `q` |

A further six of the 60 need machinery that does not exist and is not cheap: `bdi`/`bdo` (bidi —
comes free with SkParagraph, `ROADMAP.md:354`), `ruby`/`rt` (ruby layout), `map` (image maps),
`slot`/`selectedcontent` (shadow DOM). Realistically **~54 of the 60 are genuinely free** once the
ten properties land.

`br` and `wbr` need inline layout to be correct. Today `<br>` works by accident, because a box with
no `display` defaults to `COLUMN` (`src/ir.ts:222`).

### Tier 1a — needs a paint primitive or a layout mode (20)

| Element(s) | n | What it needs | Evidence it is cheap |
| --- | --- | --- | --- |
| `hr` | 1 | a 1px line | Spec CSS is `border-style: inset; border-width: 1px` — **this repo already has `border-width`/`border-color`**. Effectively free. |
| `ul`, `ol`, `menu`, `li` | 4 | `display: list-item` + `::marker` + a `list-item` counter | Blitz bundles `moz-bullet-font.otf` and renders markers as glyphs. Needs `list-style`. |
| `details`, `summary` | 2 | disclosure triangle + collapse | Spec renders the triangle as `list-style: disclosure-closed` — **a marker, not paint code**. Needs the same list-marker machinery. |
| `dialog` | 1 | top layer + `::backdrop` | Maps onto the planned overlay layer (`ROADMAP.md:411-418`, B1). |
| `progress` | 1 | a determinate/indeterminate bar, `1em × 10em` | Two nested boxes. Chromium themes it; Servo/Blitz do not have it. |
| `meter` | 1 | a gauge, `1em × 5em` | **Chromium `return true`s on it** — UA CSS + shadow DOM only. Two nested boxes. |
| `table`, `caption`, `colgroup`, `col`, `tbody`, `thead`, `tfoot`, `tr`, `td`, `th` | 10 | table layout | **A committed non-goal** (`ROADMAP.md:213-214`). Taffy has no table algorithm. Grid covers the "static Table" component in `ROADMAP.md:470-471`. |

Excluding the 10 table elements (out of scope by decision), **Tier 1a is 10 elements**, and of those
`hr` is free, four are one list-marker feature, two more (`details`/`summary`) ride on the same
feature, and two (`progress`/`meter`) are two nested boxes each. That is **one feature (list
markers) plus four boxes**.

### Tier 1b — replaced / external content (10)

`audio`, `canvas`, `embed`, `iframe`, `img`, `object`, `picture`, `source`, `track`, `video`

Only **`img`** is realistically in scope, and it is already scheduled: *"Image decode, async load,
cache, eviction. Decode off the main thread."* (`ROADMAP.md:388`). `svg` is handled by the planned
baked icon set (`ROADMAP.md:389-391`) rather than a general SVG parser. `iframe`/`embed`/`object`
require nested documents; `audio`/`video` require a media stack. All are out of scope for a desktop
UI framework.

### Tier 2 — interactive form controls (11 elements, 22 input types)

`button`, `fieldset`, `form`, `input`, `label`, `legend`, `optgroup`, `option`, `output`, `select`,
`textarea`

Per item: what must be tracked and what must be handled. State column from
[HTML-AAM §3.6](https://www.w3.org/TR/html-aam-1.0/#x3-6-html-attribute-state-and-property-mappings);
events from the HTML activation-behavior sections.

| Element / type | State to track | Input to handle | New paint? |
| --- | --- | --- | --- |
| `button` | `disabled`, pressed | click, **Enter, Space**, focus ring | **none** — `inline-flex` + centring. Already works (`NodeKind.BUTTON`). |
| `input[type=submit\|reset\|button]` | `value` (label), `disabled` | as `button`; submit/reset triggers form behaviour | none — button layout |
| `input[type=checkbox]` | **`checked`, `indeterminate`**, `disabled`, group name | click, **Space**, focus | **yes** — box + tick. A glyph (`U+2713`) beats a Bézier path; Servo and new-Chromium both use `content: "✔"`. Indeterminate is `U+2500`. |
| `input[type=radio]` | `checked`, `disabled`, **radio group membership** (`aria-setsize`/`aria-posinset`) | click, **Arrow keys move selection within the group**, Space, focus | **yes** — ring + bullet. Two circles, or a glyph. |
| `input[type=text\|search\|tel\|url\|email]` | value, selection range, caret, scroll offset, `placeholder`, `readonly`, `required`, `disabled`, `pattern` validity | text input, Backspace/Delete, arrows, Home/End, Shift-selection, **IME composition**, clipboard, double-click word select | **yes** — caret, selection highlight, placeholder, clip + inline scroll |
| `input[type=password]` | same + masking | same, minus clipboard read | same + glyph substitution |
| `textarea` | same + line wrap, `rows`/`cols`, block scroll | same + Enter inserts newline, vertical arrows | same, multiline (`ROADMAP.md:441-447` defers this) |
| `input[type=range]` | value, `min`/`max`/`step`, `list` ticks, dragging | **drag**, click-to-position, arrows, PageUp/Down, Home/End | **yes** — track + fill + thumb (Servo does it in 3 CSS rules) |
| `input[type=number]` | value, `min`/`max`/`step` | text input + **spinner buttons** + arrow keys + wheel | **yes** — inner spin button (a sub-node hit region) |
| `input[type=color]` | value | activation → **picker** | **yes** — swatch (background-color hint) + an external picker |
| `input[type=file]` | file list | activation → **file dialog** | filename span + button; delegate the dialog to the host |
| `input[type=date\|month\|week\|time\|datetime-local]` | per-field values, focused sub-field | per-field arrows, digit entry, Tab between sub-fields, calendar popup | **yes** — 5 multi-field editors. The single largest sub-project. |
| `input[type=image]` | `src`, click coordinate | click (submits `x`/`y`) | needs `img` |
| `input[type=hidden]` | value only | none | **`display: none`** — one line |
| `select` (drop-down) | selected index, `disabled`, **open/closed**, hover index, typeahead buffer | click, **Enter/Space to open, Arrows, Escape, typeahead, click-outside** | **yes** — closed box + arrow + **a popup that escapes window bounds** |
| `select` (list box) | selection set, scroll, anchor for shift-range | click, Arrows, Shift/Ctrl-click, Home/End | scrolling container + row highlight |
| `option` | `selected`, `disabled`, `label` | hover, click | row box + `::checkmark` |
| `optgroup` | `label`, `disabled` | none | indented group header, `font-weight: bolder` |
| `datalist` | suggestion list | drives the combobox popup | `display: none` + reuse the select popup |
| `label` | **`for` → labelable element association**, or implicit by containment | **click forwards activation to the control** | none |
| `form` | entry list, `novalidate` | **submit / reset**, Enter-in-a-text-field submits | none |
| `output` | value | none (live region) | none |
| `fieldset` / `legend` | `disabled` cascades to descendants | none | **yes** — the border must not paint behind the legend. Genuinely unrepresentable in CSS; Blink keeps a dedicated `LayoutFieldset` for exactly this. |

**Engine-level prerequisites** that no amount of per-element work substitutes for, and that this
repo does not have (§2.7):

| Prerequisite | Status here |
| --- | --- |
| New predicates: `:checked`, `:disabled`, `:indeterminate`, `:required`, `:invalid`, `:placeholder-shown` | `:checked` and `:disabled` **compile** as of protocol v9 (`protocol.rs:448-455`), and are never live because nothing sets them — that half is A3. The mask table generalised as predicted; bits 5–7 are still free per-node under `FIRST_GLOBAL = 256`. The other four are unstarted. |
| Attribute selectors `[type=checkbox]` | not in the parser; **already scheduled** for A1 (`ROADMAP.md:314-317`) |
| Pseudo-elements (`::before`, `::marker`, `::placeholder`, `::checkmark`) *or* a UA shadow tree | neither exists. This is the single highest-leverage missing mechanism — it is how all three reference engines build widget internals. |
| Sub-node hit regions | `hit_test` returns whole nodes (`paint.rs:314-368`). A slider thumb or spin button needs a child node, which pseudo-elements/shadow trees would supply. |
| Tab order, Enter/Space activation, `:focus-visible` | none; scheduled A3 (`ROADMAP.md:364-378`) |
| Working `TEXT_INPUT` | **broken** — `SDL_StartTextInput` never called (`ARCHITECTURE-REVIEW.md:70`, §3 item 10) |
| Caret, selection, clipboard, IME | none; scheduled A5 (`ROADMAP.md:392-394`) |
| Overlay layer for popups | none; scheduled B1 (`ROADMAP.md:411-418`) |
| Drag (mouse-move while pressed) | `MOUSE_MOVE`/`MOUSE_DOWN`/`MOUSE_UP` exist, no drag gesture |

---

## 6. Recommended minimum viable set

The MVP is picked from what the reference engines actually shipped, intersected with what this
repo's ROADMAP already committed to. Blitz — a working HTML renderer on the same Rust + Taffy stack
— ships **8 form controls and no `<select>`**. That is the calibration point.

### MVP: 4 new render archetypes, 6 elements, 12 of 22 input keywords

| # | Item | Keywords covered | Work |
| --- | --- | --- | --- |
| 1 | UA stylesheet for Tier 0 | — | ~40 lines of CSS + 10 CSS properties. Fixes `<h1>`, `<p>`, `<strong>`, `<a>`, `<code>` all at once. |
| 2 | `button` + `input[type=submit\|reset\|button]` | `submit`, `reset`, `button` | **already done** for `button`; the three input keywords are one UA rule mapping them to button layout |
| 3 | `input[type=checkbox]` | `checkbox` | box + `U+2713` glyph; ~20 lines |
| 4 | `input[type=radio]` | `radio` | ring + bullet; ~20 lines |
| 5 | `input[type=text]` + 4 aliases + `password` | `text`, `search`, `tel`, `url`, `email`, `password` | **one** text editor for all six, as Blitz does. The real cost centre. |
| 6 | `input[type=hidden]` | `hidden` | one `display: none !important` rule |
| 7 | `label` with `for=` association | — | compile-time: resolve `for` to a node id, forward clicks |
| 8 | `form` + `onSubmit` | — | no navigation, no entry-list serialisation — just a callback. `ROADMAP.md:373` already lists `onSubmit`. |
| | **Total** | **12 of 22 keywords** | |

Deferred, in order:

| Defer to | Items | Why |
| --- | --- | --- |
| After list markers | `ul`/`ol`/`li` markers, `details`/`summary` | one feature unlocks six elements |
| After A5 (images) | `img`, `input[type=image]` | needs decode + cache |
| After B1 (overlay) | `select`, `option`, `optgroup`, `datalist` | the popup must escape window bounds — Servo and Chromium both concluded this independently. `ROADMAP.md:474-478` already cut Select from v1. |
| After A4 (scrolling) | `select` list box, `textarea` | need scroll containers |
| Indefinitely | `date`, `month`, `week`, `time`, `datetime-local`, `number`, `range`, `color`, `file` | 9 keywords, 6 dedicated widgets. Blitz has none of them after ~2 years. |
| Never | 10 table elements, `audio`/`video`/`iframe`/`embed`/`object`, `marquee` and the other 28 obsolete | committed non-goals (`ROADMAP.md:213-214`) |

### MVP versus full spec coverage

| Scope | Elements | Input keywords | Render archetypes |
| --- | --- | --- | --- |
| **Today** | 1 of 113 (`button`) | 0 of 22 | 3 (box, text, button) |
| **MVP above** | ~76 of 113 (60 Tier 0 + 12 never-rendered + `button`, `input`, `label`, `form`) | 12 of 22 | 6 (+ checkbox, radio, text editor) |
| **+ list markers, `img`, `hr`, `progress`, `meter`, `details`** | ~84 | 12 | 8 |
| **+ overlay: `select`, `option`, `optgroup`, `datalist`, `dialog`** | ~89 | 12 | 10 |
| **Full conforming HTML** | 113 | 22 | 12 |
| **Full spec incl. obsolete** | 142 | 22 | 12 |

**The MVP is 4 new render archetypes and roughly 200 lines of paint code**, on the evidence that
Blitz ships a usable HTML renderer with 92. What it is *not* is 113 elements of work — and it is not
even 22 input types of work. The dominant cost is not element count at all; it is the five engine
prerequisites in §5 (predicates, attribute selectors, pseudo-elements/shadow tree, sub-node hit
regions, text editing), and of those, **text editing is the one that is genuinely large**, exactly
as `NOTES.md:861-864` already said.

### One caveat about the direction

`ROADMAP.md:466-478` frames the delivery unit as a **shadcn-compatible component** (`Input`,
`Checkbox`, `Radio`, `Switch`), not an HTML element. Those are markup-plus-Tailwind compositions.
That strategy still needs the same underlying machinery — a `Checkbox` component still needs
somewhere to put the checked state, a tick to paint, and Space to toggle — so the work in §5 is a
prerequisite either way. The choice is only whether `<input type="checkbox">` is *also* spelled that
way, or whether the HTML tag stays an empty box forever and authors must use `<Checkbox>`. Worth
deciding explicitly, because `src/compiler/jsx-runtime.ts:105-110` currently promises the HTML
spelling will eventually work.

---

## 7. Sources

### Primary — this repository

| Path | Used for |
| --- | --- |
| `src/compiler/html.ts:109`, `:116`, `:182`, `:188-205` | void tags, transparent tags, the no-allowlist parser |
| `src/compiler/jsx-runtime.ts:87-139`, `:105-110`, `:487-491` | attribute surface, the "empty box" comment, the 7-tag allowlist |
| `src/compiler/compile.ts:303-305`, `:475-476`, `:532`, `:555-558`, `:731`, `:884`, `:1191` | `KIND_BY_TAG`, cascade root, node-kind fallback, button label, interactivity |
| `src/compiler/css.ts:10-11`, `:29`, `:430-709` | supported selectors, supported pseudo-classes, the 51 properties |
| `src/ir.ts:114-171`, `:205-266`, `:222`, `:363-376` | 46 style fields, `INITIAL_STYLE`, the COLUMN default, `ListTable` |
| `src/protocol/schema.ts:264-268` | `NodeKind { BOX, TEXT, BUTTON, LIST }` |
| `src/runtime/bindings.ts:71-95` | `typeInto` — append + backspace only |
| `native-src/dziri-engine/src/paint.rs:214-301`, `:314-368` | the whole renderer; hit-testing |
| `native-src/dziri-engine/src/protocol.rs:215-217`, `:287-291`, `:295-306` | flags, predicates, event kinds |
| `native-src/dziri-engine/src/window.rs:72-82` | `SDL_StartTextInput` never called |
| `windows/main/pages/features.tsx:125`, `former windows/main/index.css line 5` | the sample's "text field" is a `div`; the only tag selector is `body` |
| `ARCHITECTURE-REVIEW.md:70`, `:95-118` (§3), `:120-131` (§4) | fix-order authority; contains no element-coverage item |
| `ROADMAP.md:213-214`, `:218-220`, `:237-238`, `:314-317`, `:354`, `:364-378`, `:388-394`, `:411-418`, `:437-447`, `:461-464`, `:466-478` | non-goals, Tailwind denominator, "not started", attribute selectors, A2/A3/A4/A5, B1, B4, semantics table, C2 tiers |
| `NOTES.md:561-566`, `:846-849`, `:861-864` | "no accessibility", P3 input, P6 widgets |
| `framework-design.md` | searched; contains **no** form-control or element-coverage material |

### Primary — WHATWG HTML Living Standard

- [Index — Elements](https://html.spec.whatwg.org/multipage/indices.html#elements-3) — 111 rows / 113 conforming elements / 115 names
- [§16.2 Non-conforming features](https://html.spec.whatwg.org/multipage/obsolete.html#non-conforming-features) — 29 obsolete elements
- [§13.1.2 Void elements](https://html.spec.whatwg.org/multipage/syntax.html#void-elements) — 13
- [§4.10.2 Categories](https://html.spec.whatwg.org/multipage/forms.html#categories) — form-associated / listed / submittable / resettable / labelable
- [§4.10.5.1 States of the type attribute](https://html.spec.whatwg.org/multipage/input.html#attr-input-type) — the 22-state table
- [§3.2.5.2.6 Embedded content](https://html.spec.whatwg.org/multipage/dom.html#embedded-content-2) — 10 members
- [§15.4 Replaced elements](https://html.spec.whatwg.org/multipage/rendering.html#replaced-elements) — 8
- [§15.5.1 Native appearance](https://html.spec.whatwg.org/multipage/rendering.html#native-appearance-2) — **the 6 widget elements**
- [§15.5.3 Button layout](https://html.spec.whatwg.org/multipage/rendering.html#button-layout)
- [§15.5.6 Text entry widget](https://html.spec.whatwg.org/multipage/rendering.html#the-input-element-as-a-text-entry-widget)
- [§15.5.7 Domain-specific widgets](https://html.spec.whatwg.org/multipage/rendering.html#the-input-element-as-domain-specific-widgets)
- [§15.5.8 Range control](https://html.spec.whatwg.org/multipage/rendering.html#the-input-element-as-a-range-control)
- [§15.5.9 Colour well](https://html.spec.whatwg.org/multipage/rendering.html#the-input-element-as-a-colour-well)
- [§15.5.10 Checkbox and radio](https://html.spec.whatwg.org/multipage/rendering.html#the-input-element-as-a-checkbox-and-radio-button-widgets)
- [§15.5.11 File upload control](https://html.spec.whatwg.org/multipage/rendering.html#the-input-element-as-a-file-upload-control)
- [§15.5.12 Input as a button](https://html.spec.whatwg.org/multipage/rendering.html#the-input-element-as-a-button)
- [§15.5.14 meter](https://html.spec.whatwg.org/multipage/rendering.html#the-meter-element-2) · [§15.5.15 progress](https://html.spec.whatwg.org/multipage/rendering.html#the-progress-element-2)
- [§15.5.16 select](https://html.spec.whatwg.org/multipage/rendering.html#the-select-element-2) · [§15.5.17 textarea](https://html.spec.whatwg.org/multipage/rendering.html#the-textarea-element-2)
- [§15.3.1 Hidden elements](https://html.spec.whatwg.org/multipage/rendering.html#hidden-elements) · [§15.3.10 Form controls](https://html.spec.whatwg.org/multipage/rendering.html#form-controls) · [§15.3.11 hr](https://html.spec.whatwg.org/multipage/rendering.html#the-hr-element-2) · [§15.3.12 fieldset and legend](https://html.spec.whatwg.org/multipage/rendering.html#the-fieldset-and-legend-elements)
- [§15.5.5 details and summary](https://html.spec.whatwg.org/multipage/rendering.html#the-details-and-summary-elements)

### Primary — accessibility mappings

- [ARIA in HTML §Document conformance](https://www.w3.org/TR/html-aria/#docconformance) — 139-row implicit-role table
- [HTML-AAM §3.5 Element role mappings](https://www.w3.org/TR/html-aam-1.0/#x3-5-html-element-role-mappings) — 146 sections
- [HTML-AAM §3.6 Attribute state and property mappings](https://www.w3.org/TR/html-aam-1.0/#x3-6-html-attribute-state-and-property-mappings) — the state-tracking table in §3.9
- Specific rows cited: [`#el-input-checkbox`](https://www.w3.org/TR/html-aam-1.0/#el-input-checkbox), [`#el-input-radio`](https://www.w3.org/TR/html-aam-1.0/#el-input-radio), [`#el-option`](https://www.w3.org/TR/html-aam-1.0/#el-option), [`#el-progress`](https://www.w3.org/TR/html-aam-1.0/#el-progress), [`#el-textarea`](https://www.w3.org/TR/html-aam-1.0/#el-textarea), [`#el-datalist`](https://www.w3.org/TR/html-aam-1.0/#el-datalist)

### Primary — reference implementations

**Blitz** (Rust + Taffy + Vello — the closest analogue)
- [`packages/blitz-paint/src/render/form_controls.rs`](https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-paint/src/render/form_controls.rs) — 92 lines, the entire widget theme
- [`packages/blitz-dom/src/layout/construct.rs`](https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/layout/construct.rs) L353-373 — the only tag-name special-casing
- [`packages/blitz-dom/src/node/element.rs`](https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/node/element.rs) L263-288 — `SpecialElementData`
- [`packages/blitz-dom/assets/default.css`](https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/assets/default.css) — UA sheet, 928 lines
- [`packages/blitz-dom/src/form.rs`](https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/form.rs) — 424 lines of submission logic
- [Issue #258 "Tracking: Form controls"](https://github.com/DioxusLabs/blitz/issues/258) — the support matrix, still open

**Servo**
- [`components/layout/stylesheets/servo.css`](https://github.com/servo/servo/blob/main/components/layout/stylesheets/servo.css) — 471 lines, a complete CSS-only widget theme
- [`components/layout/stylesheets/user-agent.css`](https://github.com/servo/servo/blob/main/components/layout/stylesheets/user-agent.css) — 353 lines
- [`components/shared/embedder/embedder_controls.rs`](https://github.com/servo/servo/blob/main/components/shared/embedder/embedder_controls.rs) — the engine↔host popup protocol
- [Issue #33168 "Improve the default styling of HTML form controls"](https://github.com/servo/servo/issues/33168) — open

**Chromium / Blink**
- [`core/paint/theme_painter.h`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/paint/theme_painter.h) — the canonical 13-widget list
- [`core/paint/theme_painter.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/paint/theme_painter.cc) — the dispatcher; `return true` for meter/listbox
- [`core/html/resources/html.css`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/resources/html.css) — 2718 lines; `forms.css` no longer exists
- [`core/layout/layout_theme.h`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/layout/layout_theme.h) — style adjustment only
- [`core/layout/forms/`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/layout/forms/) — only fieldset + text controls survive
- [How Chromium Displays Web Pages](https://www.chromium.org/developers/design-documents/displaying-a-web-page-in-chrome/) — the `<select>` popup as a native window

### Unverified / could not confirm

- **CSS UI Level 4 `appearance` §7.2** — [w3.org/TR/css-ui-4](https://www.w3.org/TR/css-ui-4/#appearance-switching)
  and [drafts.csswg.org/css-ui-4](https://drafts.csswg.org/css-ui-4/#appearance-switching) both
  truncated before §7.2 on fetch. The `<compat-auto>` / `<compat-special>` keyword lists and the
  element→primitive-appearance table were **not** read directly. The equivalent information is
  taken from the WHATWG §15.5.1 native-appearance list (6 elements) and Chromium's
  `AppearanceValue` switch instead, both of which were read.
- **Servo's status on `<progress>` and `<meter>`** — no rules in `servo.css` or `user-agent.css`,
  but Servo's DOM/layout code was not searched. Absence from the UA sheets is suggestive, not proof.
- **Blitz `input[type=hidden]`** — ticked in issue #258 but no `display: none` rule was found in
  `default.css`; likely a stylo builtin.
- **Chromium `appearance: base` rollout status** — `html.css` shows `@supports blink-feature(...)`
  gating, so it is partially flag-gated; which parts have shipped was not determined.
- The number of lines quoted for Blitz's `draw_checkbox` (~35) and `draw_radio_button` (~20) are
  approximations within the verified 92-line file total.
