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
| per-row conditional classes — `cn({ done: t.done })` | **done** (2026-08-21, protocol v45) — a recorder-valued `cn()` entry compiles like a pseudo-state: both cascades are interned behind `Predicate.ROW`, the element gets a control row to carry the bit, and `updateLists` writes `ControlFlags.ROW` per replica from the row's data. One data-driven class per element (one bit). `row-state.test.tsx` | — |
| text runs follow their element's predicates | **done** (2026-08-21) — a run's variant rows are the *projection* of its element's onto inherited text fields (`textRunVariants` in compile.ts keeps only the bits that move the projection, so a ring or hover background costs a run nothing), and the engine resolves a TEXT node's predicates against its parent — the redirect `GENERATED` boxes already had, two hops for a pseudo-element's own text. So `.done { color; text-decoration }`, `.field:invalid { color }` and `a:hover { color }` reach the text the element shows. Scope: an element's predicates reach its **own** runs; a deeper descendant binds the class itself. Fixed four goldens where a picker/listbox option's text had not been taking `:focus`/`:checked` colour | — |
| `checked={t.done}` in list rows | **done** (2026-08-21, v45) — `ControlFlags.DATA_CHECKED` marks the row's checkedness as data-owned; rescan re-reads `CHECKED` from the table for exactly those rows, `updateLists` writes it from the recorded path, and a user's click still flips optimistically until the data catches up. `:checked` styling rides the existing predicate. A *signal*-valued `checked` outside a row is still refused with the dropped-signal warning | — |
| `ref()` | partial — `resolve-refs.ts` | C3 |
| `bind:value` | **done** for text-entry fields, and it is two-way — typing writes the signal, and a signal write repaints the field (so a loader can seed an edit form). The display half is a text binding jsx() inserts as the field's child; a launch-ordering gap that swallowed writes from an initial route's sync loader was fixed 2026-08-21 and is pinned by a test. This row previously said "append + backspace" — caret, selection, word-select and Home/End all landed with A5. Still missing: clipboard and IME (A5's remainder) | M12 |
| form controls — `<Checkbox>` `<Switch>` `<Radio>` `<Toggle>` `<Tabs>` `<Input>` | planned — see **Form controls** below | C2 |
| `<form>` — payload by `name`, `onSubmit`, `validate`, `onInvalid` | **done** — see **Form controls** below | A3 |
| `alert()` — the platform's modal message box | **done** — `SDL_ShowSimpleMessageBox` behind the FFI, so it is a Win32 task dialog, an `NSAlert` or the GTK box and not something dziri draws. Nothing was vendored: SDL3 is already linked. Shown on the engine thread, because SDL requires the thread that initialised video, so app code posts a message; headless is a no-op so screenshots and goldens are unaffected | — |
| `confirm()` / `prompt()` | planned — the same call with an answer, which needs a reply message rather than a return value: the thread that would answer is the one the dialog is blocking | — |
| `effect` `untrack` `peek` cleanup, `createScope` disposal scopes | **done** (2026-08-20) — `src/runtime/signal.ts`: `effect(fn)` (cleanup via return, dispose via handle, batched), `untrack(fn)`, `sig.peek()`, `createScope()` with transitive disposal. Includes the dep-set fix: re-capturing subscribers leave sets they no longer read | M6 |
| `Show` | planned | M3 |
| `source` | **done** — `source(subscribe, initial)`: a signal fed from outside. The subscribe is handed `set`, and what it returns decides the shape — an unsubscribe (callback, no `effect`), or an Effect `Stream` run with `Stream.runForEach` after a lazy import. `src/runtime/source.ts` | — |
| `resource` / `<Suspense>` / error boundaries | **done** (2026-08-21) — `resource(fetcher, initial)` (`src/runtime/resource.ts`): the data **is the signal** (one export, one import name), with `status`/`error` signals and `refetch()` riding on it; registered at import, started by the worker at launch, so the compiler's import of app modules never fetches. Status walks `pending → ready \| error`; `refetch()` sets **`stale`, never `pending`**, so revalidation cannot flash a fallback. `<Suspense fallback={…}>` (`src/compiler/suspense.ts`) compiles both trees as co-resident siblings — the route mechanism — and the worker flips `hidden` bytes when a watched resource's status crosses `pending` (`applyBoundaries`, `src/host/window-state.ts`). Watched resources are collected from the bindings under the content; reads hidden inside a `computed` need `on={[stats]}` (the pending bit does not propagate through derived cells). An empty boundary is a compile error: *nothing under this boundary can pend*. Error boundaries are the route object's `errorComponent` (shipped 2026-08-18); a resource error keeps content up and lands in `stats.error`/`stats.status` for the app to render | M8 |
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
| `navigate` / `back` | **done** (2026-08-20) — `src/runtime/navigate.ts`, exported from `dziri`. The host installs the window's route signal at launch; `navigate(path)` writes it (same-path early-out), `back()` reads the one-entry history — one entry by decision, so a second `back()` oscillates. `navigate("…")` literals in captured handler sources are checked against the route table like hrefs (`deadNavigations` in build.ts); module-level handler bodies cross the boundary as names and are the `Href` type's to check. Before the window is up, `navigate()` warns and does nothing — modules are also imported by the compiler | M7 |
| `useRoute` params as bindings | **done** (2026-08-18) — recorders (`route-args.ts`) reach the emitter through the param sentinel; `$id` binds as a signal the router writes on navigation. The demo's `products/$id.tsx` renders `{id}` live | M7 |
| `href` checked against the route table | **done** (2026-08-20) — `matchHref` in `src/compiler/routes.ts` (first hit over the match-ordered table, so static-beats-param is the existing sort), `auditLinks` in `src/compiler/build.ts`. A dead link fails the build naming the window's routes; a checked link's click is synthesized as a write to the window's route signal, and an authored `onClick` wins over synthesis. Refused by name rather than half-working: interpolated hrefs, links inside list templates without an `onClick`, and external URLs | M7 |
| `defineScreen` | superseded — `defineRoute()` route objects (2026-08-18) carry what `defineScreen` was for: `args` had already moved to `useRoute`, and `data` is the loader's success value | M8 |
| route `loader` — sync fn \| async fn \| Effect; exits drive navigation | **done** (2026-08-18) — `defineRoute()` route objects: loader as sync fn \| async fn \| Effect, `Redirect`/`Cancel` exits navigate, Effect recognised by its registered symbol and imported lazily. Failure renders the route's `errorComponent` and in-flight its `loadingComponent` — the design's `failure.tsx` tag-named exports did **not** ship; the route object carries the views instead. Demo: `products/$id.tsx` | M7/M8 |
| `<Window layer={…}>` — Effect Layer as the window's DI root | **done** (2026-08-15) — `src/compiler/window.ts` captures it, `src/compiler/build.ts` resolves it to an export name, `src/runtime/effects.ts` builds the ManagedRuntime at launch and disposes it on quit so `Layer.scoped` finalizers run. Launch-failure *view* still rides M8; today a failed layer prints at launch | — |
| handlers may return an `Effect` — run on the window's runtime | **done** (2026-08-15) — every dispatch path (`click`/`change`/`focus`/`blur`, list items, form `submit`/`invalid`) hands the return to `runDispatched`; failures print the full Cause, interruption is silent. `effect` recognised structurally and imported lazily; apps without it load none of it | — |
| `Redirect` / `Cancel` navigation tags | **done** (2026-08-15) — exported from `dziri`, dependency-free classes failable from Effects and throwable from plain functions; the router that *interprets* them rides M7/M8 with `loader` | — |
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
effect(fn: () => void | (() => void)): () => void      // no dep array; cleanup via return; returns dispose
batch<T>(fn: () => T): T
untrack<T>(fn: () => T): T
createScope(): DisposalScope                           // .run(fn) .own(fn) .dispose() — owns effects created inside

source<T>(subscribe: (set: (v: T) => void) => unknown, initial: T): Cell<T>
resource<T>(fetcher: () => Promise<T> | T, initial: T): Resource<T>
                                                       // the data cell itself, plus .status .error .refetch()
ref(): Ref                                             // .node .bounds() .focus() .on()
token<T>(defaultValue: T): Token<T>                    // build-time lexical scope, no runtime
onFrame(fn: (dt: number) => void): void
```

`source` = push, from outside the process. `resource` = pull, async, drives a boundary.
The subscribe's return decides the shape: an unsubscribe, or an Effect `Stream` (recognised
structurally and run with `Stream.runForEach` — the one place `source` touches `effect`).
A resource's `status`/`error`/`refetch` sit on the signal object itself so the resource is
**one** module export; the reactive rewrite routes those three members to the signal only
when it actually owns them, so a plain signal holding `{ status: "shipped" }` still resolves
`order.status` to the value's key (`RESOURCE_MEMBERS` in `src/runtime/signal.ts`).

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

The two planned ones are now *less* urgent than they read, and it is worth saying why rather than
leaving the row alone. Inside a `<form>`, a named checkbox or radio already has live state and
already reaches app code — through the payload, from a cell the compiler declared. What
`bind:checked` and `bind:group` would add is reading that state *outside* a submit, which is a
narrower job than "checkboxes do not work yet".

**A bound value is always a string**, including for `number` and `range`. That matches the DOM,
where an input's value *is* a string and `valueAsNumber` is a separate accessor, and it keeps the
engine out of the business of deciding what an empty field or a lone `-` parses to. An author who
wants a number writes `derived(() => Number(volume))`.

### `field` wrappers: nesting by structure, and the one piece of error state

`field` on any element that wraps a control names a **group**, and the wrapper chain is the
path:

```tsx
<form validateOn="change" validate={Login} onSubmit={save}>
  <div field="name" errorClassName="group/error">
    <input className="error:border-red-500" />
    <span error className="hidden error:block" />
  </div>
  <div field="position" errorClassName="group/error">
    <input name="x" /><input name="y" />
    <span error className="hidden error:block" />
  </div>
</form>
```

gives `{ name: string, position: { x: string, y: string } }`. A wrapper holding one bare
control **is** that field; named controls inside become its properties; wrappers nest; an
element without `field` is transparent. There is no leaf-or-branch rule to remember, because
the path *is* the answer — and a path claimed as both (`<div field="a"><input><input name="x">`)
is a build error rather than an arbitrary winner.

**No browser does any of this**, and that is measured rather than assumed:
`name="user[email]"` is the literal key `"user[email]"` in `FormData`, at both the API and the
wire layer, and `enctype="application/json"` — the W3C proposal that standardised the bracket
syntax — is not even reflected (BROWSER-FACTS.md, "A nested-looking `name` is just a string").
So nesting belongs to server-side parsers, each with its own dialect. dziri nests by structure
instead, because a compiler can see structure: no path is parsed, and a conflict is reported.
`tags[]` needed no equivalent — two controls sharing a name already give an array, which is
what the brackets were hinting at.

**A radio inside a wrapper is the one exception, and it has to be.** A radio set must share a
`name` — the engine interns a group on `(form, name)` — so counting that name as a path segment
turned the obvious markup into `plan.plan`, which is what the demo produced the first time it
compiled. Inside a wrapper the `name` **groups** and the wrapper **names**, which is the same
reason a radio set's shape is `one`: many elements, a single answer. Outside a wrapper the name
is still the key, so a flat form is unchanged. Two *different* radio groups under one wrapper is
a build warning, because both would claim the wrapper's key.

**A wrapper holding a `map()` is an array field**, and its value is the array the rows came
from — `<div field="experience">` around a keyed list gives `{ experience: Job[] }`, one entry
per live row. It is the only field whose state the compiler does not declare, and the reason is
structural rather than a shortcut: a row's controls are `capacity` interchangeable replicas of
one template, so there is nothing stable to hang a per-row cell on, while the array already has
a keyed entry per row. So the array *is* the state — `bind:value={job.title}` inside the
template writes back into it (the item is replaced, not mutated, so an ordinary `signal.set`
publishes), and adding a row is `signal.set` rather than a call into a form API. Reordering
reorders the payload, a removed row is gone rather than blank, and the entry is the item **as
authored**, `key` property included: dropping it would mean the compiler deciding which
properties are "really" fields, and every rule for that is a guess. Two lists under one wrapper,
or a named control beside one, is a build warning — one key cannot be an array and an object.

**`errorClassName` is the only error state, and it is a class.** A wrapper wears it while any
issue's `path` has the wrapper's path as a *prefix*, so `position` lights up for an issue at
`position.x` and a nested `field="x"` wrapper lights up for that one alone. It compiles to the
same style-table patches a conditional class does — measured at 5 writes for a border plus a
message — so the input's border and the message's visibility both come from a class on the
wrapper and none of it is JavaScript. Two wrappers sharing the class string stay independent:
patches are keyed on the driving cell, and style slots intern over the whole variant vector.

With Tailwind, define the variant in its **prefix** form. This is not a preference:

```css
@custom-variant error (.group\/error &);   /* emits `.group\/error .error\:block` — parses */
```

Tailwind's default form emits `.error\:block:is(:where(.group\/error) *)`, and the `*` inside
`:is()` is not a selector dziri parses. Both spellings were generated with the real Tailwind
CLI and fed to the compiler.

**`<span error />`** marks where the message goes: its text becomes a run bound to a cell the
compiler declares, the same mechanism as a field's value cell, and its authored children are
dropped so placeholder prose never ships.

**`validateOn="submit" | "change" | "blur"`**, `submit` by default. Two rules are behaviour
rather than knobs, because neither is a preference: after a failed submit a form always
re-validates as its fields change (React Hook Form spells this `reValidateMode: onChange`), and
before any submit a field may only show an error once its value has *moved* off the one it was
compiled with. That second gate is what other libraries store as `touched`; here it costs no
state, because the initial value is a constant the compiler wrote down. Per field the runtime
stores exactly two things: a boolean and a message.

*Vocabulary checked against the shipped types of React Hook Form 7 (`mode`, `reValidateMode`,
`criteriaMode`, `delayError`; `formState` with `isDirty`/`dirtyFields`/`touchedFields`),
TanStack Form (`onMount`/`onChange`/`onBlur`/`onSubmit`/`onDynamic` + async variants; field meta
`isTouched`/`isBlurred`/`isDirty`/`isDefaultValue`) and Formik 2 (`validateOnChange`/
`validateOnBlur`/`validateOnMount`). None has an `onDirty` trigger — dirty is state in all
three — which is why it is internal here.*

### `<form>`: the payload, and who declares a field's state

A form is collected by `name`, the way a browser collects one, and `onSubmit` receives the result:

```tsx
<form onSubmit={save} validate={Login} onInvalid={showErrors}>
  <input name="email" />
  <input name="age" type="number" />
  <input name="terms" type="checkbox" />
  <select name="plan"><option>free</option><option>pro</option></select>
  <button>Save</button>
</form>
```

**No state module.** A named field with no `bind:value` gets a cell the *compiler* declares in
`ui.gen.ts` — `const field_0 = signal("")` — seeded from its `value`/`checked`/`selected`
attributes, which is what a browser calls the default value. Nothing outside the artifact can name
one, so a form's fields do not become a second, undocumented state API; the payload is the only
way to read them. A field that *does* carry `bind:value` keeps the author's signal, because two
cells for one field could disagree with each other.

**The payload is typed by kind, not stringly.** The compiler knows what each control is, so
`data.age` is a number and `data.terms` is a boolean. That is the one deliberate divergence from
`FormData`, and it is a divergence in the value's *type* rather than in which values are there:
the inclusion rules are the browser's, measured (BROWSER-FACTS.md, "What a form actually
submits"). Nameless controls are out, disabled ones are out — **including via an enclosing
`<fieldset disabled>`, which is inherited, with the first `<legend>` escaping it** — an unticked
box contributes nothing, an option with no `value` submits its trimmed text, and two controls
sharing a name give an array in document order.

| markup | `data.x` |
|---|---|
| `<input name=x>` `<textarea name=x>` | `string` |
| `<input type=number\|range name=x>` | `number \| undefined` — `undefined` when empty or unparseable, never `NaN` |
| `<input type=checkbox name=x>` | `boolean` |
| `<input type=checkbox name=x value=v>` | `string \| undefined` — the `value` keeps the browser's meaning |
| `<input type=radio name=x>` × n | `string \| undefined` — the checked one's value |
| `<select name=x>` | `string` — always, since a dropdown falls back to its first option |
| `<select name=x multiple>`, or two controls sharing `x` | `string[]`, possibly empty |

**Key shapes are fixed at build time**, which is the reason the table above is a table and not a
runtime decision. A schema — and the type an author reads — needs `tags` to be an array on every
submit, not an array when two boxes are ticked and a string when one is. A browser never had this
problem because `FormData` is a multimap with no shape to keep stable.

**`validate={…}` takes a schema, and names no library.** Anything carrying `~standard` — the
Standard Schema interop spec, which Zod 4, Valibot and ArkType implement natively — is used
through it. An **Effect** schema does not carry it (measured, effect 3.22), so it is recognised by
its `ast` and converted with Effect's own `Schema.standardSchemaV1` behind a lazy import: `effect`
is a dependency of the app that passed one and never of dziri. A plain
`(data) => issues | null` is the third accepted shape. A schema **narrows what `onSubmit`
receives** — its output, so `z.coerce.date()` hands over a `Date` — and a rejected payload runs
`onInvalid(issues)` instead, with issues normalised to `{ path, message }[]` whichever validator
produced them.

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
selection range are a NOTES.md ledger entry**, in the same terms as the ones already there — and
that entry is **still owed**: both are built, the argument for both is in `caret.rs`'s header, and
nothing has been written into NOTES.md yet. The caret blink is an engine-side timer flipping one bit,
never JS at frame rate.

`bind:value` is a working text field today — insert, Backspace and Delete at the caret **or over the
selection**, through the `editables` table (`src/compiler/compile.ts:801`). What is left before it is
*finished* is the clipboard and IME; the rest of what a browser field does is here.

The selection is engine state for the same reason the caret is, and its shape is a measurement
rather than a preference: `(anchor, focus)` rather than `(start, end)`. From a collapsed caret at
5, Shift+ArrowLeft walks `5..6`, `5..5`, then `4..5 backward` — the anchor stays at 5 *through*
the reversal, and an ordered pair has no way to know which end to move once the two have crossed.
It crosses to Bun as two numbers beside a keystroke and nowhere else, so nothing in the app can
observe it, which is what keeps a drag from costing a round trip per pointer move.

The caret index and the selection are both engine-owned, and one detail of that is worth writing
down: the engine moves the caret **optimistically**, before Bun has written the signal. It has to —
the alternative is a round trip per keystroke — and the consequence is that the caret can be ahead of
the string in the tables for a frame. So nothing on the engine side may clamp the caret against that
string. Doing exactly that made typing quickly move the caret *backwards*: two keystrokes in one
frame both measured the same pre-edit length and the second clamped to it. See `caret.rs::shift`.

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

A `<select>` **opens**, as of protocol v18. This paragraph used to end by saying it could not, and
that the missing piece was the overlay layer rather than this machinery — which was right, and the
layer turned out to be one node flag. A `::picker(select)` box is an ordinary child of its select, so
it inherits, cascades and lays out with no special case; `NodeFlags.OVERLAY` moves only its *turn* in
the walk, painted after the tree and hit-tested before it.

Almost none of it is new state, and that is the part worth reading. The picker opens on the **press**
rather than the click — the opposite of a checkbox, and measured. The committed choice is `:checked`
on an `<option>`, because committing one *is* a radio set, so `Controls::clear_group` is the code
that runs. And the *pending highlight* — the thing a browser's Escape throws away — is **focus**,
because while a picker is open Chromium's `activeElement` is an `<option>` rather than the select.
That is measured, and it is why `option:focus` draws the highlight, Escape discards it by doing what
closing always does, and the "two pieces of state" the design called for cost no fields at all. What
is genuinely new: one integer for which select is open, and one per-node label redirect so the closed
button can read the chosen option's string without the engine writing into Bun's tables.

Still missing, and named rather than implied: `:indeterminate` has no way to be reached, and a
control inside a `map()` row is still not collected **by `name`** — a name in a template is the
same string in every row, so there is nothing to tell two rows' entries apart. Rows reach the
payload the other way instead: a `field` wrapper holding a `map()` is an **array field** whose
value is the array the rows came from, and a row's inputs edit that array through
`bind:value={row.title}`. That is what the "one entry or one per row" question resolved to — the
array is the state, because an arena of interchangeable replicas has nothing stable to hang a
per-row cell on and the array has a keyed entry per row already.
For the picker specifically: no collision handling — one near the window's bottom edge hangs off it
rather than flipping above its select, which is ROADMAP B2's job — no scroll-outside dismissal, no
`<optgroup>` label rendering, and no type-to-select.

| API | Status | Milestone |
|---|---|---|
| `<Checkbox>` `<Switch>` `<Radio>` `<Toggle>` `<Tabs>` | planned | C2 · Tier 1a (needs A3) |
| `:checked` / `:disabled` variants | **done** — live, and a click changes them. `controls.rs` owns the state; `nodes.activates` + the `controls` table are the compile-time half | A3 |
| checkbox and radio activation, radio groups, label forwarding | **done** — protocol v13. A radio group is keyed on `(form, name)`, measured | A3 |
| `:indeterminate` | planned — same shape and cost, held back until a control can be in that state | A3 |
| `::before` / `::after` + `content` | **done** — generated boxes are real emitted nodes; this is what replaces a UA shadow tree | A1 |
| `::picker(select)` | **done** — protocol v18, and the first *functional* pseudo-element. `::picker` bare is refused: the spec defines the argument so a future control can name a picker of its own, and a shorthand no browser has is a divergence someone copies out of dziri | C2 |
| `::picker-icon` `::checkmark` `::marker` | planned — same machinery as `::before`, refused by name until the parts they draw exist. The demo's arrow is `select button::after` today, which is the same node either way | C2 |
| attribute selectors — `[a]` `=` `~=` `\|=` `^=` `$=` `*=`, `i` flag | **done** — `input[type=checkbox]` is how a UA sheet names one control among twenty-two | A1 |
| `<input>` `<select>` `<option>` `<textarea>` `<label>` … as real tags | **done** — they compile to ordinary boxes; being a tag is not being a widget | C2 |
| `<select>` closed, with UA-supplied `<button>` + `<selectedcontent>` | **done** — `ua-structure.ts`; the parts a browser builds in a shadow tree, built as nodes. The `<selectedcontent>`'s text follows the committed option, through a per-node redirect rather than a string write: Bun owns the tables, so the engine repoints *which* node's slot the run reads | C2 |
| `select > option`, `option:first-child` | **done** — the picker is spliced in at the *node* level, so the options' selector path still ends at the select. A browser's picker is a pseudo-element the light-DOM options render into, not a wrapper they move under, and this keeps that true. `option:first-child` matches the first option now: `positionOf` used to count the UA-supplied `<button>`, which shifted every option by one | A1 |
| `<select>` picker (open state) | **done** — protocol v18. Opens on the press (measured; the opposite of a checkbox), commits on the release or Enter, dismisses on Escape or an outside press — and that press **still activates what it hit**, which is a second measured rule and not the same as "the overlay consumes its own presses" | B1 |
| the overlay layer — paint after, hit-test before | **done** — `NodeFlags.OVERLAY`, and it is a flag rather than a second tree because the subtree is already in the right place: only its turn in the walk moves. Both halves are load-bearing and for different reasons — in tree order a picker draws *under* what follows its select, and `hit_test` prunes on the parent's box, which a picker hangs below | B1 |
| opening a picker costs no relayout | **done** — the box is `position: absolute` and laid out whether or not it shows, so showing it is a pure paint decision. The same split `::placeholder` uses. Committing *does* relayout, once, because the closed button's width comes from the chosen label | B1 |
| `:open` | **done** — one integer for the document, because only one popover can be open at a time (measured). Reaches `select::picker(select)` through `GENERATED`, so it means "the picker of an open select" | B1 |
| anchor positioning, collision handling | **half done** — the engine offsets a picker onto its select's bottom edge from the two rects layout produced, because the spec's `top: anchor(bottom)` has no dziri spelling (`top: 100%` would be it, and percentage lengths are refused). It does **not** flip or shift near a window edge; that is B2's `@floating-ui/core` adapter | B2 |
| a picker as wide as its select | **done** — `left: 0; right: 0` in the UA sheet, which stretches an absolute box to its containing block. That is the spec's `min-inline-size: anchor-size(self-inline)` reached with two plain lengths, and unlike a width in a theme it cannot drift out of step. It is a *fixed* size rather than a minimum: an option longer than the select will not widen the picker, which needs `min-inline-size` with a value dziri cannot yet express | B2 |
| keyboard: which keys open a closed select | **done** — ArrowDown, ArrowUp, **Space**, **F4** and **Alt+ArrowDown**, all measured 2026-08-06. **Enter does not open one** — measured, and it was asserted to: Enter is the *commit* key, and one that also opened would make Down-then-Enter ambiguous. The belief comes from a legacy select in a `<form>`, where Enter submits, and from macOS | B1 |
| keyboard: reaching a select at all | **not done, and this is the gap that matters** — there is no Tab order, so a `<select>` cannot be focused without a pointer. Every keyboard behaviour above is therefore only available to someone who can already use a mouse, which is not keyboard accessible however correct the arrow handling is | A3 |
| `<optgroup>` | **half done** — its options are the select's own: they arrow, highlight and commit like any other, and the group is descended into rather than scanned past. The `label` attribute is accepted, selectable by `[label]`, and **not rendered** — that wants a generated box whose text comes from an attribute, which is exactly what `::placeholder` already does | C2 |
| scroll-outside dismissal, type-to-select | planned — click-outside and Escape both work; a wheel over the page leaves the picker up | B1 |
| `accent-color` `caret-color` `appearance` | **done** — `STYLE_FIELDS`, checked in `conformance` and `spec-audit` | A1 |
| `resize`, `field-sizing: content` | **non-goal** — see ROADMAP C2; in `css-coverage`'s `OUT_OF_SCOPE_NAMES` | — |
| `<Input>` | planned | C2 · Tier 1b (needs A5) |
| `onSubmit` receives the form's payload | **done** — collected by `name` from the form's subtree, typed by control kind, with the browser's inclusion rules (measured, `probes/form-data.html`). `src/compiler/fields.ts` decides the shape, `src/runtime/forms.ts` reads the cells | A3 |
| a named field with no `bind:value` | **done** — the compiler declares its cell in the artifact, so a browser-shaped form needs no state module. Typing reaches it through the same `editables` table a bound field uses | A3 |
| `validate={schema}` — Zod, Valibot, ArkType, Effect | **done** — through Standard Schema's `~standard`, plus one lazy-import branch for a raw Effect schema, which carries no `~standard` of its own (measured, effect 3.22). dziri depends on none of them | A3 |
| `onInvalid` | **done** — issues normalised to `{ path, message }[]` from all three validator shapes | A3 |
| `field="…"` — nesting by wrapper | **done** — the wrapper chain is the path, so `{ position: { x, y } }` needs no bracket syntax. No browser nests anything (measured); a path claimed as both a value and a group is a build error | A3 |
| `errorClassName` + `<span error />` | **done** — a class on the wrapper, compiled to style-table patches, so the error story is CSS. Independent per wrapper even when the class string is shared | A3 |
| `<span error="city" />` — a named message inside a group | **done** — the name is relative to the wrapper, as `name` is, so a group stays movable. Each marker shows the first issue under its own path that no *more specific* marker would show, which divides a group's complaints between its leaves and its own line with nothing said twice. The class stays singular: "something here is wrong" is one fact however many messages describe it. A name no field produces is a build warning, because a marker that can never fill looks exactly like a field that is never wrong | A3 |
| `validateOn="submit\|change\|blur"` | **done** — plus two rules that are behaviour rather than knobs: re-validate on change after a failed submit, and no error before a field has moved off its compiled value | A3 |
| per-field `touched` / `dirty` as styling hooks | **refused by name** — `touched` exists in other libraries to gate error display, which `validateOn` does; per-field `dirty` styling is a need nobody has demonstrated. Reversible: each would be one more class toggle | — |
| the submitter's own `name`/`value` entry | **not done** — measured (a named `<button type=submit>` contributes only when it is the button that submitted) and deliberately left out: it is the one entry that is not a property of the markup, and a two-button form in dziri would use two `onClick`s | — |
| `form="id"` association | **done** — ownership rather than ancestry, resolved once and read by all three questions a form asks: its payload, its default button, and its blocking-field count. Measured (`probes/form-owner.html`), including that a `form=` naming no form **orphans** the control rather than falling back to its ancestor | A3 |
| a `field` wrapper holding a `map()` — repeating rows | **done** — the wrapper's value is the list's array, so the payload gains `Job[]` with one entry per live row. The only field whose state the compiler does not declare: an arena of interchangeable replicas has nothing stable to hang a per-row cell on, and the array has a keyed entry per row already. `bind:value={job.title}` writes back into it | A3 |
| a *named* control inside a `map()` row | **refused by name** — a `name` in a template is the same string in every row, so two rows' entries would be indistinguishable. The array field above is the way rows reach a payload | — |
| a row's own error message — `<span error />` in the template | **done** — matched by *data position*, so a reorder cannot carry a message to the wrong row. The section's own message then shows only issues at its own path, while its `errorClassName` still goes on for anything under it: the class and the message part company exactly here | A3 |
| a row's own error **styling** — `:invalid` | **done** — protocol v39. A predicate rather than a class, because a class *is* a style row and replicas share one: `:invalid` is a control flag Bun writes after validation and the engine re-reads on rescan, resolved per node, so one row can be red and its neighbour not. Every text-entry `<input>` now carries a control row so the flag has somewhere to live | A3 |
| a submit button switched off by `disabled={signal}` | **done** — and the Enter path had to be told: a *literal* `disabled` makes the compiler emit `button: -1`, which blocks outright (measured), but a signal cannot be seen at build time. `submitForm` now reads the live flag, so a greyed-out button is unsubmittable by press *and* by Enter. `bind:checked` would remove the duplicate signal a gated button needs today | A3 |
| an `alert()` raised from a handler shows the frame that caused it | **done** — the request is queued until the app thread's next commit and the engine paints once more before blocking. It is raised inside the submit `batch()`, so nothing had reacted to the error cells yet: the box went up over the pre-submit picture, listing complaints that were invisible behind it | A3 |
| `:user-invalid` | **refused by name** — it differs from `:invalid` only in when a browser lets it match, and that timing is already `validateOn` plus the pristine-field gate. Two spellings would put one rule in two places | — |
| `<input type=file>` in a payload | **refused by name** — there is no file picker, so there is no file to submit; a named one warns rather than contributing an empty entry | — |
| a **disabled** `<option>` that is selected | **known divergence** — measured to make its whole `<select>` contribute nothing; dziri submits its value | — |
| `onChange` vs `onInput` | planned | A3 |
| a click focusing a bound field | **done** — editables are `INTERACTIVE`, so `hit_test` can return one | A3 |
| an empty field is still one line high | **done** — `NodeFlags.EDITABLE`, protocol v14. Measured: a field's height is its *font*, not its content | A5 |
| `::placeholder` | **done** — protocol v15. An ordinary generated box, like `::before`, with two differences: its text comes from the attribute rather than `content`, and paint draws it only while the field is empty | C2 |
| a disabled field refuses focus | **done** — a disabled form control now gets a `controls` row, so the engine can see it. A press on one produces no `mousedown`, `mouseup` or `click` at all, as measured | A3 |
| `<input type=number\|range>` is typeable | **done** — it was in the payload's kind table before it had an editor, so it compiled to a box with no line height: four pixels of border, which is what the forms demo drew where its age field should have been. A browser routes both to the same text editor and adds chrome dziri has no equivalent for (a spinner, a slider track), so being typeable is the part that transfers. The implicit-submission **blocking** set stays the six text keywords it was measured over — widening it here would have changed a measured rule as a side effect of a layout fix, and whether a `number` blocks is unmeasured | A5 |
| a field's **width** from `size` | planned — `29 + 7 × size` px is measured (BROWSER-FACTS.md), and unimplemented: `size="20"` does nothing, so an `<input>` with no width class fills its container instead of being 169px | A5 |
| caret — position, blink, `caret-color` | **done** — a click resolves to the nearest character boundary (measured); the blink is an engine timer, so it survives a busy Bun | A5 |
| arrow keys, Home/End | **done** — consumed by the engine, never forwarded, so a caret move costs one rect and no round trip | A5 |
| insert and delete *at* the caret | **done** — the engine reports the index beside the text; `typeInto` splices there, clamped, by characters rather than UTF-16 units. Backspace erases behind and moves the caret; **Delete** erases in front and does not | A5 |
| `box-shadow` — the ring subset | **done** — protocol v16. No offset and no blur, a solid spread, stored as three concentric bands, which is exactly what `ring-*`, `inset-ring-*` and `ring-offset-*` compile to (measured, BROWSER-FACTS.md). `shadow-md` warns and draws nothing rather than being approximated | A1 |
| `currentcolor` | **done** — the element's computed `color`, substituted textually before the expander. Not dynamic: the cascade already resolves `color` per node. Needed because bare `ring-2` reaches it through a `var()` fallback | A1 |
| `outline` / `outline-offset` | planned — a ring is what Tailwind reaches for and what landed; `outline`'s own fields are still absent, so `outline-*` utilities warn | A1 |
| selection — drag, Shift+Arrow, Shift+click | **done** — the engine holds `(anchor, focus)`, not an ordered range, because that is the only shape a Shift reversal survives: from a caret at 5, Shift+Left walks `5..6`, `5..5`, `4..5 backward` with the anchor still at 5 (measured) | A5 |
| double click for a word, triple click / Ctrl+A for all | **done** — the segment at the *nearest boundary* plus its trailing whitespace run, which is one rule over thirteen measured rows. A double click does **not** use the character under the pointer: at 9.55 in `quick-brown` it selects `brown ` | A5 |
| editing over a selection | **done** — one splice replaces the range. Backspace and Delete are *identical* once a range is live, so the direction only widens a collapsed caret; insertion leaves the caret after what it inserted | A5 |
| `::selection` | **done** — protocol v17. Two inherited colours on the originating element's row, not a node: a selection is a range inside a box rather than a box. The default is a **stated convention** in dziri's UA sheet, because Chromium does not expose its own highlight colour to script | A1 |
| clipboard — Ctrl+C/X/V, ⌘ on macOS | **done** (2026-08-21) — the *decision* lives in the engine beside Ctrl+A, because the forwarded `KEY_DOWN` deliberately carries no modifier mask. Copy never crosses the boundary; a cut arrives as the Backspace-over-a-range it is; a paste is a new `PASTE` event whose text waits in the engine (`Event.text` is 32 bytes) and is fetched beside the drain. Line breaks become spaces, one per break — measured, BROWSER-FACTS.md "Newlines in a single-line input". Headless engines get a process-local fallback clipboard, which is what makes `tests/clipboard.rs` possible | A5 |
| IME, double-click-then-drag by word | planned — a drag after a double click extends by character | A5 |
| a `<label>` click focusing a text field | planned — `activates` forwards to control kinds only, and a text field is not one | A3 |
| the caret, selection and open picker as ledger entries | **half done** — the state is built and each argument is in its own module header (`caret.rs`, `select.rs`); the NOTES.md entries ROADMAP A5 and B1 ask for are still owed, and the picker has now made it two. All of them fail the compile-time gate at question 3: nothing declares them and none is bounded, so they are engine-owned interaction state beside `hovered` and `focused`. The picker's is the narrowest of the three — one integer for the whole document, because only one can be open | A5 · B1 |

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

Not built: `navigate`/`back` as framework API — the pieces all exist (`showRoute` and
`matchRoute` on the host, `matchHref` in the compiler, and links that navigate); what is
missing is only the importable surface and the one-entry history, which the demo hand-rolls in
`windows/main/router.ts` typed against the generated `Href` union. `href` checking landed
2026-08-20: a dead `<a href>` fails the build and a checked one navigates by writing the route
signal. Parameter recorders in text bindings landed 2026-08-18 (`products/$id.tsx` renders
`{id}` live), and `routes.gen.ts` is consumed: the demo's router imports `Href`.

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
  (...args: A): R;                       // execute — loader(), handlers, tests
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
