# dziri — API surface & status

Planning + tracking file for the authoring API. Snippets are the spec; prose is kept out.
Update the status column when something lands.

**Build status:** `done` verified in code · `partial` exists but incomplete · `planned` not built

**Provenance:** everything here is a **proposal** unless listed under Decided below. Proposals are
Claude's output from a brainstorm session, not agreed design. Do not treat them as settled.

### Decided (by Med)

- **Routing.** *Supersedes the 2026-07-31 version of this bullet, which had file-path-as-module
  identity (`href="about.tsx"`), `args={{}}`, literal-string-only hrefs and a non-recursive
  `<Outlet dir>`. All four are withdrawn.*
  - **A window is `windows/<name>/index.tsx`** returning `<Window>`. The folder name is the
    window's id. There is no flat form and no `id` override.
  - **Its routes are `windows/<name>/pages/**`**, recursively. The route path *is* the file path
    under `pages/`; `$segment` is a parameter. `.tsx`, `.html` and (later) `.mdx` all become
    routes. There is no `route()` declaration function — file location determines the route,
    which reverses the previous bullet deliberately.
  - **Links are concrete paths**, as on the web: `<a href="products/1">` and
    `` href={`products/${id}`} ``. Not pattern + args.
  - **Params come from a typed hook**, `useRoute("products/$id")`. The path string is repeated
    from the filename because TypeScript cannot know which file a call is in; the compiler
    verifies it against the file path, so drift is a build error. See Routing below.
  - **History is the previous route only**, per window. `back()` returns to it.
  - **One route is resident at a time.** Navigation swaps the page's nodes and text; the style
    table stays global and interned.
- **Route matching is the only routing logic in the engine.** The compiler emits the route table;
  Rust matches a concrete path against it to bind params, next to the media-query evaluator.
  Everything else — which routes exist, what each takes, whether a link is dead — is compile-time.
- **Styling.** A stylesheet is reached by importing it from a module — `import "./app.css"` — and
  several imports cascade in module-graph order, as a bundler would order them. Tailwind is an
  ordinary project dependency: if a sheet asks for it, the project's own copy runs during the
  compile, and nothing is generated onto disk. dziri ships a **full UA stylesheet**, unconditionally
  — same as a browser. Tailwind
  is not the only supported way to write CSS; plain CSS is first-class. A Tailwind user gets a
  reset because Preflight is author CSS that undoes the UA sheet, exactly as in a browser. No
  template switch, no opt-in/opt-out sheets.
- **Browser-compatibility rule.** The audience is web devs, so: **match the browser's observable
  contract; do not match its known defects.** Diverge only when all three hold — the behaviour is
  obscure enough that devs have not formed an expectation, every major library works around it,
  and it is an accessibility defect. Every divergence gets a numbered entry in a
  *differences from the browser* list. Measurements go in `BROWSER-FACTS.md`, never recollection.
- **Focus clears when a node becomes unreachable** — collapsed, `<Show>` closed, navigated away,
  removed. Focus lands on the window root, so Tab restarts from the top (matching `BODY`).
  **Retained** across scroll-out, because the item still exists and only its row was recycled.

  Divergence from Chromium — **one**, deliberate, passing the three-part test:
  1. Chromium leaves focus on a `display:none` element (measured — `BROWSER-FACTS.md`). We clear.
     Theirs is a WCAG 2.4.3/2.4.7 defect that Radix, React Aria and Reach all work around by
     managing focus manually.

  *A second divergence was recorded here and then withdrawn: Chromium does fire `blur`/`focusout`
  on removal. The earlier "fires nothing" measurement came from a backgrounded tab, where Chrome
  suppresses focus events. So we match the browser and emit the events — matching is free here.*

  Not a divergence, despite appearances: dziri's collapse is a `hidden` byte, but the developer
  wrote *"collapse this node"*, not `display:none`. The browser's contract for **the thing went
  away** is `activeElement === BODY`, which is what we do.

### Agreed (Claude — robustness only, low risk)

Marked agreed because each makes the system *harder to get wrong* and none expands scope.
Anything that trades robustness for capability stays a proposal.

- **Recursion detector.** A component re-entered during build expansion must produce a named
  compile error. Today recursive JSX stack-overflows or hangs the build — this is strictly
  better regardless of whether pooled templates ever ship.
- **No `flattenVisible` helper in the framework API.** A tree today is *a list with a depth
  field* and needs no new surface. Shipping a helper makes it the de-facto tree API and
  manufactures a migration later.
- **If pooled templates are ever built, instances use keyed slot assignment, never a free
  list.** Node ids carry focus, `ref`s, and the sparse hover/active/focus table; a free list
  changes a logical node's id across collapse→expand and silently drops focus and dangles
  refs. List arenas already do keyed slots with never-invalidated ids — reuse that path.
- **Sequencing is a dependency, not a preference.** Pooled templates need M6 (disposal scopes)
  underneath and M10 (virtualization) to bound the pool to viewport size.

> Last brainstorm: 2026-08-01 (routing rewritten — windows, file-path routes, `useRoute` params,
> concrete-path links, per-route text residency). Supersedes 2026-07-31's routing.
> Earlier: 2026-07-31 (routing, data fetching, `source`, UA CSS, trees).
> Rationale lives in `data-layer-design.md`. This file is the surface.
> (`framework-design.md` was pre-A0 research and was deleted on 2026-08-02 — too much had
> changed for it to be read safely. It is at `12b3903^` if a rejected alternative needs
> looking up.)

---

## Status

| API | Status | Milestone |
|---|---|---|
| `signal` `computed` `batch` `isSignal` | **done** — `src/runtime/signal.ts` | — |
| `cn(...)` conditional classes | **done** | — |
| `.map(fn, { key })` keyed lists | **done** | — |
| inline `style=` (string + object) | **done** | — |
| `ref()` | partial — `resolve-refs.ts` | C3 |
| `bind:value` | partial — append + backspace, and a click now focuses the field | M12 |
| form controls — `<Checkbox>` `<Switch>` `<Radio>` `<Toggle>` `<Tabs>` `<Input>` | planned — see **Form controls** below | C2 |
| `effect` `untrack` `peek` cleanup, disposal scopes | planned | M6 |
| `Show` | planned | M3 |
| `source` | planned | M8 |
| `resource` / Suspense / error boundaries | planned | M8 |
| `token()` (context) | planned | — |
| `onFrame(dt)` | planned | — |
| `<Overlay>` | planned | M11 |
| route table from `windows/*/pages/**` | **done** — `src/compiler/routes.ts`, `bun run routes` | M7 |
| `Href` union codegen | **done** — emitted per window into `routes.gen.ts` | M7 |
| `useRoute` typing + path check | **done** — `src/compiler/route.ts` | M7 |
| `useRouter().path` | **done** — the window's route signal, read-only | M7 |
| bare signal reads — `{count * 2}`, `computed(() => count === 7)` | **done** — source rewrite, `src/compiler/reactive-transform.ts`; see REACTIVITY.md | M7 |
| `signal.set(value \| fn)` | **done** — one method; `.value` remains for framework code only | M7 |
| `useRouter().matches(path)` | **done** — prefix-aware cell, compiled to a `computed` in the artifact | M7 |
| `<Window>` / `<Outlet>` | **done** — `src/compiler/window.ts`, spliced by `bun run window` | M7 |
| one table set per window, inactive routes `hidden` | **done** — emitted `hidden` column, `routeChain` | M7 |
| `navigate` / `back` | partial — `showRoute` in `src/window-host.ts`; no matcher, no history | M7 |
| `useRoute` params as bindings | planned — recorders exist; the emitter does not read them yet | M7 |
| `href` checked against the route table | planned — needs `<a>` as a tag the compiler accepts | M7 |
| `defineScreen` | planned — `args` moved to `useRoute`; only `data` remains | M8 |
| `defineQuery` / `defineMutation` | planned | — |
| `import "./app.css"` from a window module | **done** — module-graph order, `src/compiler/css-imports.ts` | — |
| Tailwind as an ordinary project dependency | **done** — the project's `tailwindcss`, run in-process, `src/compiler/stylesheet.ts` | — |
| `<style>` in an `.html` document | **done** — raw text, extracted before the cascade; refused in JSX | — |
| default stylesheet | planned | — |

---

## Reactivity

A read is the identifier — in markup, in a `computed` body, and in a handler alike. There is no
`.value` to write and no dependency array. A build-time source rewrite unwraps every read
(`src/compiler/reactive-transform.ts`), and `Signal<T>` is `T & Ops<T>` so the same expressions
type-check. See REACTIVITY.md.

```ts
const count = signal(0);
const doubled = computed(() => count * 2);   // ✓ so do ===, ternaries, !, templates
count.set(5);
count.set((n) => n + 1);                     // one method, value or function
```

```ts
signal<T>(initial: T): Signal<T>                       // .set(value | fn), .subscribe()
computed<T>(fn: () => T): Cell<T>
effect(fn: () => void | (() => void)): void            // no dep array; cleanup via return
batch<T>(fn: () => T): T
untrack<T>(fn: () => T): T

source<T>(subscribe: (set: (v: T) => void) => () => void, initial: T): Cell<T>
ref(): Ref                                             // .node .bounds() .focus() .on()
token<T>(defaultValue: T): Token<T>                    // build-time lexical scope, no runtime
onFrame(fn: (dt: number) => void): void
```

`source` = push, from outside the process. `resource` = pull, async, drives a boundary.

OS/window state (theme, focus, DPI) ships as **built-in cells** — it arrives via the engine
event ring, not a user `source`. `source` is for Bun-side externals:

```ts
export const configOnDisk = source<Config>(
  (set) => { const w = fs.watch("config.json", async () => set(await readConfig())); return () => w.close(); },
  readConfigSync(),
);
```

---

## Form controls

Native-*looking* and native-*behaving*, drawn by us in Skia. Not OS widgets — Tailwind cannot style
an `HWND` and Taffy cannot lay one out, so child windows would contradict the thesis rather than
merely cost more. Sequencing and the full reasoning live in ROADMAP under A3 and C2.

**A control's internals are ordinary nodes, and there is no shadow DOM.** Every part is styleable
with plain CSS — Tailwind is one way to write it, not the surface itself. This is not a dziri
invention: the customizable-`<select>` model MDN documents *is* light-DOM children —
`<select><button><selectedcontent></selectedcontent></button><option>…</option></select>` — with
`appearance: base-select` as the opt-in and `::picker(select)` defined as "all descendants except
the first `<button>`", which is a structural grouping a compiler computes. So there is nothing to
pierce: no `::part`, no `::-webkit-*`, no `:host` (which dziri parses and matches nothing, by
design). A generated box — `::before` today, `::picker-icon` later — is a real emitted node, so it
lays out in Taffy, paints in the ordinary pass, and has a hit region, none of which a shadow tree or
a paint-time rect would give. Its per-node predicates come from its originating element, so
`.check:hover::before` means what it says.

The authoring surface is deliberately not a new concept. A control's state is a `state()` value, and
its styling is the variant machinery that already backs `:hover`:

```tsx
const done  = state(false);
const draft = state("");

<Checkbox checked={done} />                     {/* :checked is a variant, not a computation */}
<Switch checked={done} disabled={locked} />
<Radio name="plan" value="pro" checked={plan} />

<Input bind:value={draft} onSubmit={save} />    {/* onChange fires on commit, onInput per keystroke */}
```

**Two-way binding is a `bind:` namespace, and the colon is real syntax.** TypeScript parses a
namespaced JSX attribute, lowers it to a quoted key — `bind:value={draft}` becomes
`{ "bind:value": draft }` — and typechecks that key against the props type, so a misspelling is an
error that names the property it meant. Bun's transform emits the identical key. Both halves were
measured before the spelling was adopted, because a syntax the checker merely tolerated would have
been worse than a camelCased prop.

The namespace exists because two-way is a different *kind* of prop. Every other prop flows one way
into a build artifact; these are the only place the engine writes back into app state, and the
family reads as one idea instead of four unrelated names:

| binding | holds | status |
|---|---|---|
| `bind:value` | `State<string>` — `input`, `textarea`, `select` | **live**, append + backspace |
| `bind:checked` | `State<boolean>` — one checkbox or switch | planned · A3 |
| `bind:group` | `State<string>` — the selected `value` in a radio set | planned · A3 |

**A bound value is always a string**, including for `number` and `range`. That matches the DOM,
where an input's value *is* a string and `valueAsNumber` is a separate accessor, and it keeps the
engine out of the business of deciding what an empty field or a lone `-` parses to. An author who
wants a number writes `derived(() => Number(volume))`.

Why this costs almost nothing for everything except `Input`: `:checked`, `:disabled` and
`:indeterminate` are enumerable booleans, so they pass the compile-time gate at question 3 — a second
style id and an int write.

**One correction to the paragraph that used to be here**, because it was wrong in a way worth naming
rather than editing away. It said "no new ledger entry, because checked-ness is a `state()` value".
That holds for `<Checkbox checked={done} />`, where the app declared the answer — but not for the
element the compiler actually has to support. An `<input type="checkbox">` with no binding still ticks
when you click it, and there is no signal to be the authority. So checkedness is **engine-owned
interaction state**, in the same category as `hovered` and `focused`, and it is a ledger entry after
all. `controls.rs` opens with the gate answered in those terms. The cost is still one bit per control
and nothing per frame; what changed is who owns it, not how much it costs.

`Input` is the exception and the only part that fails the gate. It fails at question 3 because the set
of strings a user can type is unbounded, so there are no variants to emit. Its **caret index and
selection range become a new NOTES.md ledger entry** when A5 lands. The caret blink is an engine-side
timer flipping one bit, never JS at frame rate.

`bind:value` exists in partial form today — append and backspace only, through the `editables` table
(`src/compiler/compile.ts:801`).

**Until now it did nothing at all, and the reason is worth recording** because the artifact was
correct throughout. Focus is acquired by clicking, `hit_test` returns only `INTERACTIVE` nodes, and
`buildInteractive` had no clause for an editable — so a `<div bind:value>` with no `hover:` class and
no `onClick`, which is exactly what both demo pages authored, could never become `state.focused`, and
the host's `typeInto` never found a target for the keystroke. Nothing reported it: the text binding
rendered, the signal was real, and an empty field looks identical to a working one in a screenshot.
The layer beneath it had the same class of bug — `SDL_StartTextInput` was never called — and fixing
that changed nothing, because the events it unblocked arrived addressed to a node that could not hold
focus. Both halves are fixed; a click now focuses a field, asserted through the engine's own
`hit_test` in `src/engine/upload.test.ts`.

Both halves are in for checkbox and radio, as of protocol v13. A stylesheet writes `:checked` and
`:disabled` and the compiler resolves them like `:hover`, merging combinations per property; the engine
owns the live state, so clicking one changes what is drawn. The three CSS properties are ordinary style
fields. What a press reaches comes from `nodes.activates`, which is the compiler's answer to the second,
synthetic click a browser dispatches at a control when a *label* was clicked — so clicking the words
beside a checkbox ticks it, and a `<button>` inside that label does not.

Still missing, and named rather than implied: nothing can make a control *become* disabled at run time
(`disabled` is seeded from the attribute, which is also what a browser does with it), `:indeterminate`
has no way to be reached, a control inside a `map()` list gets no controls row, and `<select>` still
cannot open — that one needs the overlay layer, not this machinery.

| API | Status | Milestone |
|---|---|---|
| `<Checkbox>` `<Switch>` `<Radio>` `<Toggle>` `<Tabs>` | planned | C2 · Tier 1a (needs A3) |
| `:checked` / `:disabled` variants | **done** — live, and a click changes them. `controls.rs` owns the state; `nodes.activates` + the `controls` table are the compile-time half | A3 |
| checkbox and radio activation, radio groups, label forwarding | **done** — protocol v13. A radio group is keyed on `(form, name)`, measured | A3 |
| `:indeterminate` | planned — same shape and cost, held back until a control can be in that state | A3 |
| `::before` / `::after` + `content` | **done** — generated boxes are real emitted nodes; this is what replaces a UA shadow tree | A1 |
| `::picker(select)` `::picker-icon` `::checkmark` `::marker` | planned — same machinery as `::before`, refused by name until the controls exist | C2 |
| attribute selectors — `[a]` `=` `~=` `\|=` `^=` `$=` `*=`, `i` flag | **done** — `input[type=checkbox]` is how a UA sheet names one control among twenty-two | A1 |
| `<input>` `<select>` `<option>` `<textarea>` `<label>` … as real tags | **done** — they compile to ordinary boxes; being a tag is not being a widget | C2 |
| `<select>` closed, with UA-supplied `<button>` + `<selectedcontent>` | **done** — `ua-structure.ts`; the parts a browser builds in a shadow tree, built as nodes | C2 |
| `<select>` picker (open state) | planned — a popover with anchor positioning; needs the overlay layer | B1 |
| `accent-color` `caret-color` `appearance` | **done** — `STYLE_FIELDS`, checked in `conformance` and `spec-audit` | A1 |
| `resize`, `field-sizing: content` | **non-goal** — see ROADMAP C2; in `css-coverage`'s `OUT_OF_SCOPE_NAMES` | — |
| `<Input>` | planned | C2 · Tier 1b (needs A5) |
| `onSubmit` on `bind:value`; `onChange` vs `onInput` | planned | A3 |
| a click focusing a bound field | **done** — editables are `INTERACTIVE`, so `hit_test` can return one | A3 |
| an empty field is still one line high | **done** — `NodeFlags.EDITABLE`, protocol v14. Measured: a field's height is its *font*, not its content | A5 |
| `::placeholder` | **done** — protocol v15. An ordinary generated box, like `::before`, with two differences: its text comes from the attribute rather than `content`, and paint draws it only while the field is empty | C2 |
| a disabled field refuses focus | **done** — a disabled form control now gets a `controls` row, so the engine can see it. A press on one produces no `mousedown`, `mouseup` or `click` at all, as measured | A3 |
| a field's **width** from `size` | planned — `29 + 7 × size` px is measured (BROWSER-FACTS.md), and unimplemented: `size="20"` does nothing, so an `<input>` with no width class fills its container instead of being 169px | A5 |
| caret — position, blink, `caret-color` | **done** — a click resolves to the nearest character boundary (measured); the blink is an engine timer, so it survives a busy Bun | A5 |
| arrow keys, Home/End | **done** — consumed by the engine, never forwarded, so a caret move costs one rect and no round trip | A5 |
| insert and delete *at* the caret | **done** — the engine reports the index beside the text; `typeInto` splices there, clamped, by characters rather than UTF-16 units | A5 |
| Shift+Arrow, drag-to-select, `::selection` | planned — the rules are measured, and `(anchor, focus)` is the shape they imply | A5 |
| a `<label>` click focusing a text field | planned — `activates` forwards to control kinds only, and a text field is not one | A3 |
| caret, selection, IME, clipboard | planned — new ledger entry | A5 |

*The Milestone column above uses ROADMAP's phase labels. The table under Status uses `M`-numbers,
and the two vocabularies have no mapping anywhere in the repo — worth reconciling, but inventing one
here would be worse than naming the gap.*

---

## Transform and animation

`transform` is stored **decomposed** — `translateX/Y` (px and percentage kept apart), `rotate`,
`scaleX/Y`, `skewX/Y`, plus a `transform-origin` pair — and never as a matrix. That is a
measurement, not a preference: `rotate(0deg)` and `rotate(360deg)` have identical matrices, so
interpolating six floats between them cannot move, where Chromium is at 180° halfway. Decomposed
scalars keep the winding; a matrix throws it away. `probes/transition-sampling.html`, recorded in
BROWSER-FACTS.md.

The cost is that decomposed storage holds exactly one order — translate, rotate, skew, scale — so a
list written in another order is **refused with an error** rather than quietly reordered. That is
not pedantry: `rotate(90deg) translateX(100px)` puts the box 100px *below* where the reverse puts
it, measured. Tailwind and the individual `translate`/`rotate`/`scale` properties are always in
canonical order, so this only bites hand-written lists.

| API | Status | Milestone |
|---|---|---|
| `opacity` | **done** — a style field, painted as a *layer* so the subtree composites as one | A1 |
| `transform` — `translate*` `rotate` `scale*` `skew*` | **done** — decomposed into `STYLE_FIELDS`, protocol v11, composed in `paint.rs` | A1 |
| `translate` / `rotate` / `scale` as their own properties | **done** — they compose in that fixed order regardless of source order, measured | A1 |
| `transform-origin` | **done** — px and percentage per axis; the `50% 50%` default is a percentage, so the *engine* resolves it against the laid-out box | A1 |
| hit-testing a transformed node | **done** — the pointer is mapped by the inverse on the way down the tree, so a parent's transform moves its children's hit areas as it moves their pixels | A1 |
| a transform in a variant — `hover:scale-110` | **done** — reachable only through the resolved style, so hit-testing resolves variants too | A1 |
| `transform: matrix()`, any 3D function | **refused by name** — a matrix would have to be decomposed back, and the decomposition is lossy for exactly the cases transitions care about | — |
| a `transform` list outside translate · rotate · skew · scale | **refused by name** — the two orders are genuinely different matrices, measured, so reordering would render what no browser does | — |
| `calc()` mixing a length and a percentage in one transform value | **refused by name** — the percentage needs the laid-out box and the length does not, and one field cannot hold both | — |
| `transition-*` — property, duration, delay, timing function | **done** — one interned `tweens` row and a `u16` on the style row, protocol v12 | B3 |
| `@keyframes` and the `animation` shorthand | **done** — the *same* tween row, with the endpoints coming from a keyframe list instead of two style rows | B3 |
| per-keyframe `animation-timing-function` | **done** — it governs the segment *leaving* the keyframe, measured; a column on the keyframe row, which is what makes Tailwind's `bounce` expressible | B3 |
| easing — keywords, `cubic-bezier()`, `steps()` | **done** — solved by Newton with a bisection fallback, checked against the measured progress table | B3 |
| interrupting a transition | **done** — a reversal is the same pair of rows *rewound*, so it takes the distance still to travel and starts from the value already reached, measured | B3 |
| `transition` on a layout-affecting property | **refused by name**, with a build warning naming the property — only paint reads an interpolated value, so honouring it would ease a colour while the geometry jumped | — |
| per-property timing — `transition: opacity 1s, transform 2s` | **warned by name** — CSS really does compute two durations, measured; dziri carries one timing per node and uses the first entry's. Tailwind never emits this shape | — |
| `animation-direction: alternate`, `animation-fill-mode`, two animations on one element | **warned by name** — each runs forwards, once through, one at a time | — |
| a transition retargeted mid-flight to a *third* row | approximated, and said so here: it restarts from the row it was heading to, which is exact whenever the previous tween had settled (hover then press) and jumps by the residual when it had not. The value it is leaving is an interpolation, and there is no interned row holding one | — |
| `prefers-reduced-motion` | planned — **disables** animation rather than slowing it, and it wants a global predicate bit rather than a media *threshold*, which is what the `media` table currently holds | B3 |
| `transition-behavior: allow-discrete` | parsed and ignored — it only governs properties dziri refuses to transition anyway, so honouring it would change nothing | — |

`@property` came with this and was not optional. Tailwind compiles `translate-x-4` to
`--tw-translate-x: 1rem; translate: var(--tw-translate-x) var(--tw-translate-y)` and never sets
`--tw-translate-y` — its value is the `initial-value` of an `@property` registration. With the
at-rule ignored the `var()` did not resolve, CSS drops a declaration whose `var()` cannot resolve,
and every Tailwind transform utility compiled cleanly while rendering nothing. `inherits: false` is
honoured too, and also load-bearing: without it a translated card would shift a translated badge
inside it by its own offset.

### What a transition costs, and why it is that little

dziri resolves *both endpoints of a transition at compile time*. A node with `:hover` carries a
predicate mask and a run of fully-resolved style slots — base and hover, both interned — and
`style_for` already picks one per frame. So a transition is interpolation between two rows the
compiler already computed, and what stays at runtime is the clock and the current `t`.

`@keyframes` is the same thing with the rows named differently: a keyframe block is a fixed set of
style rows at fixed offsets, each one the element's own computed style with the keyframe's
declarations over it, so interpolating between two of *those* is the identical operation. One
`tweens` table serves both, and `firstSegment < 0` is the only thing that tells them apart.

What that buys, in numbers rather than adjectives:

- **Two style fields**, not sixteen. A transition is a mask over 25 animatable fields plus a
  duration, a delay and four bezier control points. Interned it is one 39-byte row and a `u16`;
  spelt out per style row it would be a sixth of the style table again to say something identical
  on every node wearing one class.
- **Zero runtime bytes.** `runtime-surface` reads 7333 bytes before and after. Nothing in
  `src/runtime/` knows animation exists — the clock, the tween state, the easing and the
  interpolation are all engine-side.
- **One FFI call per frame**, which is the `engine.tick()` the host was already making. No JS
  closure runs per frame, no style object is allocated per frame, and no colour or curve is decided
  in TypeScript.
- **No allocation per frame** on the engine side either. The live-tween vector changes when a
  *predicate* changes, not when a frame passes, and a finished tween is dropped rather than kept.

The one thing not free is the scope boundary itself: paint is the only stage that reads an
interpolated value, so only paint-only fields are animatable. A `transition` on `width` is a Taffy
pass per frame that nothing here is wired for, and it is refused by name. That still covers every
transition and animation utility Tailwind ships, all of which are transform and opacity — which is
why they were the right slice.

`dt` is a **parameter** everywhere rather than read from a clock: `tick` samples it once and passes
it to both `advance_scrolls` and `advance_animations`. That is what makes a frame reproducible, and
`--advance 0.25` plus `dziri_engine_set_time_step` is what turns "an animation" into a golden
screenshot at an exact `t`. Without it the same scenario is a different picture every run — measured
the hard way, three renders and three files.

Transform is also a coverage lever rather than only an animation prerequisite: it moved Tailwind
from 41.2% to 43.0% on its own, and `property: translate` left the blocker list entirely. The
transition and animation utilities added another 34 classes on top, to 43.1%, and four properties to
the CSS corpus — 61.1% to 64.3%.

One caveat on that figure, recorded because it cuts against the number. `tailwind-coverage` had an
`@property` blocker whose pattern was matched against declaration *values* while describing a
property *name*, so it never fired — which means `translate-x-4` counted as working for as long as
it rendered nothing. Implementing `@property` did not move the percentage; it made it true. The
dead entry is gone and the reason is recorded where it was.

---

## Routing

```
windows/
  main/
    index.tsx                 the window
    Header.tsx                an ordinary component — imported, not routed
    Sidebar.tsx               "
    pages/
      index.tsx               → "/"
      about.tsx               → "about"
      products.tsx            → "products"        (a layout — it renders <Outlet/>)
      products/
        new.tsx               → "products/new"
        $id.tsx               → "products/$id"
      docs/
        get-started.mdx       → "docs/get-started"
```

Only two names are special: **`index.tsx` is the window**, and **`pages/` holds the routes**.
Every other file in the window folder is a normal module — colocated components, imported the
usual way. Nothing scans them and nothing infers anything from them.

**`pages/` contains routes and nothing else.** Every file under it is a route, with no marker
filename and no opt-out prefix — which is why a page's own components live in the window folder
rather than beside it. Next's `page.tsx` and SvelteKit's `+page.svelte` exist to make the other
files in a route folder ordinary; here there are no other files.

```tsx
// windows/main/index.tsx
export default function Main() {
  return (
    <Window title="dziri">
      <Outlet />
    </Window>
  );
}
```

`windows/*/index.tsx` is a window; `windows/*/pages/**` are its routes. The route path is the
file path under `pages/`, recursively; `$segment` is a parameter.

**Reading the active route** is `useRouter()`, and it is read-only:

```tsx
const router = useRouter();
<div>You are at {router.path}</div>
```

**Write it as a bare brace.** `{router.path}` is resolved by *identity* — the compiler
recognises the signal object and emits a binding. An *expression* is compiled into a cell
instead, and a cell reaches `ui.gen.ts` as text, which can only name module exports:

```tsx
{router.path}                    // ✓ identity
{`You are at ${router.path}`}    // ✗ build error — `router` is a local from useRouter()
```

That error names the export the text should have used. It is the general rule for the reactive
rewrite, not a routing quirk: an inline expression may only read signals it can name.

For comparisons, `matches` is prefix-aware and compiles to style-table writes:

```tsx
router.matches("layout")   // holds on "layout/anything" too
```

Anything *derived* from the route — "is this tab active", "which section am I in" — is a
`computed` in the window's own module, beside the signal it reads:

```ts
export const onNewProduct = computed(() => route === "products/new");
<button className={cn("tab", { active: onNewProduct })}>New</button>
```

Not a style preference: a `computed()` created inside a component has nowhere to live once
components are erased, so a hook that manufactured one per call could not be resolved to a name
the generated module imports. It is also where per-window state belongs, for the same reason the
route signal is passed to `<Window>` rather than owned by the framework.

**Params come from a typed hook.**

```tsx
// windows/main/pages/products/$id.tsx
export default function Product() {
  const { args } = useRoute("products/$id");   // args: { id: string }
  return <h1>{args.id}</h1>;
}
```

`args` is typed from the string alone, by template literal types — no generated module, no import.
A page with no parameters calls nothing.

The string repeats the filename, and that is deliberate: **TypeScript cannot know which file a
call is in**, so a bare `useRoute()` has nothing to infer from. The repetition is what makes the
type work, and the compiler checks the string against the file's own path — a rename that is not
mirrored is a build error, not silent drift. (TanStack repeats it for the same reason, and needs
an editor plugin to keep the two in sync; here the compiler simply refuses.)

**Links are concrete paths.**

```tsx
<a href="products/new">New</a>
<a href={`products/${p.id}`}>{p.name}</a>

navigate("docs/get-started");
back();                                  // the previous route; there is no deeper stack
```

Checked against a generated union, so a typo is a type error:

```ts
// routes.gen.ts
export type Href = "/" | "about" | "products" | "products/new" | `products/${string}`
                 | "docs/get-started";
```

A fully dynamic href (`href={computed}`) stays a build error: nothing can be verified. A static
prefix with interpolated params is fine — the compiler reads the literal's static parts and
matches them against the route table.

> `${string}` also accepts `products/a/b/c`, since `string` spans slashes. The editor allows it;
> the compiler rejects it. TypeScript catches typos, the compiler catches shape.

**Nesting is by path prefix.** A page that renders `<Outlet/>` is a layout, and anything whose
path extends it renders inside. No directory convention, no layout declaration.

---

### Built

```
bun run dev               # compile every window, open the first
bun run run --window tailwind --route colors
bun run routes --list     # the route table, with parameters and nesting
bun run window            # compile only; -o diverts the artifact
```

- `src/compiler/routes.ts` — the scan, the route table, the `Href` union, and every rejection:
  a non-route file under `pages/`, two files claiming one route, two routes of one shape.
- `src/compiler/route.ts` — `useRoute`, `Args<P>`, and the check that the string matches the
  file. Zero runtime bytes; it runs during compilation and returns recorders.
- `src/compiler/route-args.ts` — `args.id` as a recorder, deliberately parallel to
  `item-path.ts`. Computing with a parameter produces an un-internable sentinel and a named
  error, never a constant frozen into the page.
- `src/compiler/window.ts`, `window-tree.ts` — `<Window>` (the window's root box, a `body`)
  and `<Outlet>`; pages spliced into one tree by path prefix, recursively. A layout with no
  outlet and an outlet with no routes are both build errors: nesting by prefix and being a
  layout are independent facts that have to agree.
- `src/compile-window.ts` — every module imported, each page called inside `withPage`,
  spliced, compiled **once**. One table set per window, so styles intern across every route.
- `hidden` is emitted, not computed at startup: routes off the initial chain start excluded
  from layout, paint and hit-testing. `routeChain` in `ir.ts` is the one definition of what is
  visible together, shared by the emitter and the host so frame 1 and every frame after agree.

**The application is a window.** `windows/main/` is the demo that used to be `app/`: the feature
demo is the route at `/`, with a layout route, a parameter route, and shared components in the
window folder. `windows/tailwind/` is a second window, one route per Tailwind utility family.
Thirteen golden scenarios render the two of them.

One host serves any window — `windows/windows.gen.ts` is a generated registry of statically
imported artifacts, so `--window <id>` costs no type safety. Opening two at *once* still needs one
SDL event pump.

Not built: `navigate`/`back` (the host has `showRoute`, which is the mechanism; what is missing
is the matcher and the one-entry history), the emitter reading parameter recorders into text
bindings, and `href` checking — `<a>` is not yet a tag the compiler accepts, so the demo's links
are inert. Nothing consumes `routes.gen.ts` yet.

### Proposed, not decided

Everything above is Decided. These are open:

- `<Window>` props carrying window config — `title`, `width`, `height`, `minWidth`, `minHeight`.
  All compile-time constants except `title`, which needs a binding for document windows.
  *Implemented as proposed, because a window entry cannot compile without knowing what it
  accepts. `title` is required and the four sizes are optional integers; `minWidth` is emitted
  but not yet on the wire, so `window.rs` still hardcodes its 564x320 floor. Awaiting a ruling.*
- `openWindow("main", "products/2")`, and windows as *kinds* rather than instances — two document
  windows of the same folder, each with its own route and history. *Deferred, not decided: the
  compiler emits one table set per window **folder**, and nothing assumes there is only one of
  it. Settling this before the host grows a second window is still the cheaper order.*
- Precedence when a static path and a parameter path both match: **static wins**, so
  `products/new` beats `products/$id`. Two routes of the same shape (`$id` vs `$slug`) are a
  build error. *Both are implemented as proposed, because the route table has to have an order
  and an unresolvable pair has to do something. Static-wins is the emitted sort order, so a
  matcher that stops at the first hit gets it for free — `compareRoutes` is the whole rule, and
  reversing it is reversing that comparator. Still awaiting a ruling.*
- `<Outlet fallback error notFound grace>` — boundaries, from the previous draft, unrevisited.
- `defineScreen({ load })`, parallel ancestor loads, and hover-prefetch — deferred to the data
  layer. `args` no longer comes from here; only `data` would.
- Sharing one `pages/` tree between two windows. Additive later via an explicit `from`.

### Prerequisites

- **Multi-window needs one SDL event pump.** `Window::new` creates an `EventPump` per engine and
  SDL's queue is process-global, so two windows would fight over events. One pump dispatching by
  window id is an engine refactor, independent of everything above.
- **Text unloading needs a split string arena** — a shell region written once, a page region
  swapped per navigation, both sized to the largest route. Node blocks rebase on load the way list
  arenas already do. Styles are unaffected: measured, two pages in one design system shared 6 of
  8 style rows, so global interning already holds close to the minimum.

---

## Data

```ts
defineQuery<A extends unknown[], R>(fn: (...a: A) => R, opts?: QueryOptions): Query<A, R>
defineMutation<A extends unknown[], R>(fn: (...a: A) => R, opts?: MutationOptions<A>): Mutation<A, R>

interface Query<A extends unknown[], R> {
  (...args: A): R;                       // execute — load(), handlers, tests
  live(...args: Cellish<A>): Bound<R>;   // reactive cell — construction scope only
  peek(...args: A): R | undefined;
  refetch(...args: A): void;             // -> "stale", never "pending"
  patch(...args: [...A, (prev: R) => R]): void;
}

interface Mutation<A extends unknown[], R> {
  (...args: A): R;
  readonly pending: Cell<boolean>;
  readonly error: Cell<Error | null>;
}

type QueryOptions = {
  keepAlive?: number;   // LRU capacity, default 1
  staleMs?: number;     // default Infinity (local) | 0 (network)
  page?: number;        // rows/fetch -> arena-backed Rows
  retry?: number;       // default 0 (local) | 3 (network)
  worker?: true;        // sync Drizzle off-thread
  reads?: Table[];      // REQUIRED when the fetcher has no analysable AST
};
type MutationOptions<A> = {
  optimistic?: (...a: A) => void;   // compile error on a sync mutation
  writes?: Table[];
};

type Bound<R> = R extends readonly (infer Row)[] ? Rows<Row> : Reactive<R>;

interface Rows<T> {
  map(render: (row: T) => Element, opts?: { key?: (row: T) => string }): Element;
  readonly length: Cell<number>;
  readonly isEmpty: Cell<boolean>;
  readonly status: Cell<"fresh" | "stale" | "pending" | "error">;
  readonly error: Cell<Error | null>;
  more(): void;
}
```

```ts
export const projectById = defineQuery(
  (id: string) => db.select().from(projects).where(eq(projects.id, id)).get(),
  { keepAlive: 8 },
);

export const renameProject = defineMutation(
  (id: string, name: string) => db.update(projects).set({ name }).where(eq(projects.id, id)).run(),
);
```

```tsx
const results = searchFiles.live(q, { debounce: 120 });   // debounce = only call-site option

<span>{results.length} matches</span>
<Show when={results.isEmpty}><p>Nothing found</p></Show>
{results.map((f) => <FileRow name={f.name} size={f.size} />)}

<button disabled={publishProject.pending} onClick={() => publishProject(id)}>Publish</button>
```

Key facts: query key is `(queryId, args)` from module identity — never written, never hashed.
Invalidation is derived from the Drizzle AST (`reads & writes`), not declared.
`bun:sqlite` is sync → no promise cell, no boundary, and sync queries resolve during the
construction pass so frame 1 has real data. No screen-level cache; the query cache is the only one.

---

## Trees / recursive structures

Recursion over **build-time** data unrolls into static nodes — fine, zero runtime cost:

```tsx
const MENU = {…} as const;
function MenuItem({ item }) {                    // fully unrolled by the compiler
  return <div>{item.label}{item.children.map((c) => <MenuItem item={c} />)}</div>;
}
```

Recursion over **runtime** data cannot compile. `.map` captures a template via the recording
proxy, so a self-referential template recurses forever at build time; and arenas are flat with
fixed stride, so nesting them C deep at capacity N is N^C nodes.

**Supported today — flatten to visible rows with a depth field.** Composes directly with
`dataOffset` virtualization; `flatten` is user-written (~15 lines), not framework API.

```tsx
const rows = computed(() => flatten(tree.value, expanded.value));

<div className="tree" overflow="auto">
  {rows.map(
    (r) => (
      <div className={cn("row", depthClass(r.depth))} onClick={() => toggle(r.id)}>
        <span className="twisty">{r.open ? "▾" : "▸"}</span>
        <span className="label">{r.name}</span>
      </div>
    ),
    { key: (r) => r.id },
  )}
</div>
```

Indent via **bounded compiled variants** (`.depth-0 … .depth-15`, clamped) — one int swap per
row — rather than a tier-4 `bind()` per slot, which would need a de-interned style slot per row.

**What this accepts:** a flat list cannot express a background/border on an intermediate
container, guide lines spanning a subtree, a nested scroll region, or clipping scoped to a
branch. Those need real parent/child in the node table.

### DECIDED (Med) — recursive templates + keyed instances

Committed, with performance treated as a requirement rather than a follow-up. Own milestone,
after M6 + M10.

**Built as an extension of the list arena, not a new subsystem.** The arena already has fixed
stride, keyed slot assignment, never-invalidated ids, append-only growth, per-row handlers and
relink-on-reorder. It lacks exactly two things: a row linking as a child of another *row* rather
than the container, and a template containing a self-reference.

Detection is a cycle check on the expansion stack. The compiler emits the template **once**,
with a self-reference where children splice in:

```ts
export const templates = [{
  id: 0, nodeCount: 4, root: 0,
  kind: …, style: …, parent: …, firstChild: …, nextSibling: …,   // RELATIVE to instance base
  childMount: 3,                                                  // where child instances link
  bindings: [{ node: 2, plane: TEXT, read: (r) => r.name }],
  handlers: [{ node: 0, fn: 0 }],
}];
```

```ts
const inst = pool.alloc(T.TreeNode, key);   // keyed slot, NOT a free list
pool.link(parent.childMount, inst);         // depth is free — links are just ints
pool.bind(inst, row);
```

Structure, style slots, binding shapes and handler sites stay compiled. Only instantiation and
linking are runtime — a generalization of what list arenas already do from "N siblings" to
"a tree of instances." `shapeHash` still covers the template; pooled regions are outside it.
(`shapeHash` does not exist — see the note under Cross-cutting rules. This design assumed the
construction pass, so whatever replaces that check inherits this requirement.)

**Capacity is pre-sized at the viewport bound and never grows during scroll.** ROADMAP records
that a full Taffy rebuild is "reserved for the first tick and a **capacity change**" — so pool
growth mid-scroll is a frame-time cliff. Growth is a rare amortized event (mount, window resize),
never expand/collapse or scroll.

Acceptance criteria:

- expand a 10-child folder → 10 allocs, O(delta) relinks, one frame, **zero** full Taffy rebuilds
  (assert via the compute counter exposed through `describe`)
- scroll a 100k-node tree at 120 Hz with instance count fixed at visible + overscan
- collapse → expand preserves focus and scroll (the keyed-slot payoff)
- `commit()` cost proportional to **live** instances, not pool capacity
- zero JS allocation in alloc/link/bind: index free-list, no per-instance closures, rebasing
  O(bindings-per-template)

Hard prerequisites — correctness, not polish:

- **M6 dep-set fix.** `signal.ts:86,159` add subscribers on read and never remove them. With
  instances churning this leaks without bound.
- **M2.** `Diff` answering a `hidden` change with `apply_all_styles()` makes every expand/collapse
  an O(n) restyle.

Open questions:

- ~~**`nodes.style` immutability.**~~ **CLOSED 2026-07-31 — no design change needed.**
  `nodes.style` is already runtime-mutable: `tables.rs:551` routes `STYLE|HIDDEN|FLAGS` changes
  into `diff.changed_nodes`, which `resync` feeds to `apply_styles_of`. Per-node, incremental.
  The `engine.rs:401` comment claiming style is "immutable by design" is inaccurate — 393-397
  says the opposite — and only justifies scanning the STYLE column instead of keeping a reverse
  index. **Reword it.**

  The constraint that *does* bind the pool is `layout.rs:304-312`: `relink_nodes` links rows
  **without styling them**, which is only safe because `apply_all_styles` walks **capacity**
  (not the reachable tree) and pre-styles spare slots. A row appended into a slot that already
  held the same style value produces no diff, so nothing restyles it — and if it was never
  styled while spare, it lays out with Taffy's `Style::default()` and no write to blame.
  → **`apply_all_styles` must keep walking capacity.** Belongs on `ARCHITECTURE-REVIEW.md` §4's
  do-not-clean-up list.
- **Disposal.** Freeing an instance must drop binding subscriptions and handler entries with no
  dangling edges.
- **State table + interactive set** updates as instances come and go. *Behaviour is decided —
  see the focus rule under Decided; what is open is the mechanism: focus is held as an item key
  and resolved to a node id on materialization, so the engine still receives a plain int via
  `setInputState`. Hover/active need the same treatment.*

---

## Cross-cutting rules

**Anything touching the outside world registers during the build pass and connects during
construction.** The compiler evaluates your modules, so:

```ts
if (!compiling) { const unsub = subscribe(set); currentScope().onDispose(unsub); }
```

`defineQuery` must not execute · `source` must not subscribe · `effect` must not run.

**That guard only protects framework primitives — user code at module scope runs at build time
too.** The rule for user code: reads are fine (compile-time constants, on-thesis); *persistent
handles and writes* are the bug.

| Class | Caught by |
|---|---|
| non-deterministic (`Date.now`, random, env) | **nothing today.** See below — the mechanism this row used to name no longer exists |
| build-time reads | nothing needed — this is a feature |
| persistent handles (timer, socket, watcher) | **planned:** active-handle diff per import |
| writes (fs, network, db) | framework wrappers only; **planned:** global stubs |

**On that first row.** It read "`shapeHash` divergence → hard abort. Already covered" until
2026-08-02, and it was wrong in both columns. `shapeHash` was never implemented — `git log -S`
over `src/` and `native-src/` finds nothing — and it belongs to the **construction pass** in
framework-design.md: a second evaluation of the components at startup, harvesting signals by
*ordinal*, aborting when the shape diverges from the build.

That design did not ship. What shipped is `src/compiler/resolve-refs.ts`, which harvests signals
by **identity, mapped to an export name** — which is why signals must be module-level exports.
So there is no second shape to compare against, and `shapeHash` is not merely unbuilt: it guards
a mechanism this architecture does not have. ROADMAP carries no construction pass either.

A replacement has to be a different mechanism — most plausibly throwing stubs for `Date.now`,
`Math.random` and `process.env` in the compile process, alongside the handle diff below. Until
one exists, a `Date.now()` at module scope silently bakes the build timestamp into the app and
nothing reports it.

Planned diagnostics, one mechanism two phases:
```ts
const before = process.getActiveResourcesInfo();   // verify Bun implements this
await import(fileURL);                             // compiler imports sequentially -> exact attribution
// leaked -> "pages/x.tsx left 1 Timeout open during compilation"
```
Same diff per component during construction (dev only) →
`"Counter created a Timeout outside effect() — it will never be disposed."`
Plus throwing stubs for `fetch`/timers/`WebSocket` in the compile process.
A module-scope lint is the real fix but is blocked — the TSX AST isn't available (same
blocker as TSX source locations).

Compile errors that are part of the surface:

```
const rows = projectList()          at module scope -> a query ran during compilation
<a href="prodcuts/1">               -> not in the Href union (typo), then not a route (shape)
navigate(someComputedString)        -> nothing static to verify; dead links are a build failure
useRoute("about") in $id.tsx        -> the string must match the file's own path
{`#${args.id}`}                     -> a parameter is recorded, not computed with
pages/helpers.ts                    -> pages/ contains routes and nothing else
products.tsx + products/index.tsx   -> two files, one route
$id.tsx + $slug.tsx                 -> same shape; a concrete path matches both
defineQuery(() => db.run(sql`…`))   -> unanalysable; declare reads: []
defineMutation(syncFn, {optimistic})-> sync commits before the next frame; dead code
<Suspense> over only-sync queries   -> nothing here can pend
q.live(x) outside a component body  -> .live registers by ordinal; construction only
{data.name.toUpperCase()}           -> leaves are cells; wrap in computed()
```

---

## Open questions

- **UA stylesheet prerequisites.** The decision is made (see Decided); what's open is the parser
  work it implies. `css.ts` today has no `*`, no `:where()`, no `::before`/`::after`, and skips
  at-rules (`css.ts:127`). Real Preflight needs all four plus `box-sizing`. Also blocked behind
  the known nested-block bug: a `@media` body is dropped *and* the next rule fails to parse, so
  `@layer` handling must fix that first or importing Preflight corrupts the following rule.
  Needed for Tailwind at all, not just the reset — lands in A1 either way.
  Still to write: the UA sheet itself (~40 lines) + the ~10 missing properties (`font-style`,
  `text-decoration`, `list-style`, `font-family`, `line-height`, `text-align`, `white-space`,
  `vertical-align`, `content`, heading scale).
- **Screens root.** Root-relative + `<Outlet dir="pages">` means typing `pages/` everywhere.
  Either put screens at root or declare the base once (`<App screensRoot="pages">`).
- **Unmatched CSS selectors** — provably dead here (whole tree known at build). Warn, don't error.
- **Row-level invalidation** — table granularity over-invalidates; matters more as `async` grows.
- `Reactive<T>` over deep Drizzle relational types — measure `tsc` before committing.
