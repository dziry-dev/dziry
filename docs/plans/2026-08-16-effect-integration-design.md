# dziry × Effect-TS — integration design

Date: 2026-08-16 · Status: design (no code) · Doubles as a short Effect-TS study aid

## Purpose

Two goals, one artifact:

1. Design dziry's Effect-TS integration up the concept ladder: types → layers → fibers → loaders → streams.
2. Serve as a dziry-anchored study aid for Effect-TS. Each section carries a one-line **Effect note** (skim or skip), then the dziry design that uses it.

The ladder is deliberately dziry's own trajectory: two rungs review code dziry already ships, three rungs design what is missing.

## The ruling that constrains everything

dziry never imports `effect` at module scope. It recognises Effect values **structurally** (`Symbol.for("effect/Effect")`) and lazy-imports the package only when an app hands one over — an app without `effect` in its manifest loads zero bytes of it. Every design below must keep this true.

The fragile point is the lazy-import dodge in `src/runtime/effects.ts`:

```ts
const EFFECT = { specifier: "effect" }; // a property read, not a literal — bundlers fold literals
```

It survives Bun today (measured: a folded const grew the bundle from 9,582 to 1,050,133 bytes; the property read stayed at 157). It is bundler-specific and is the one place this seam can break silently.

## Rung 1 — `Effect<A,E,R>` and running it

**Effect note:** an Effect is a lazy description of a computation — `A` success, `E` typed failure, `R` required services. It runs only via a runtime; `runPromiseExit` returns an `Exit` (`Success` | `Failure`) instead of throwing.

**dziry today — done.** `runDispatched` (`src/runtime/effects.ts`):

- detects an Effect by its registered symbol,
- runs `Effect.runPromiseExit` (or the window runtime's) without `await`ing an Effect (it is not a Promise),
- prints `Cause.pretty(cause)` on failure, silent on interruption.

**Design:** none — review-only. This is the first worked example: dziry already does "recognise an Effect, run it, read its Exit."

## Rung 2 — Layers and `ManagedRuntime`

**Effect note:** `Context.Tag` declares a service interface; a `Layer` provides it (`Layer.scoped` = an `acquireRelease` resource); `ManagedRuntime.make(layer)` builds a runtime that can satisfy the `R` channel; `runtime.dispose()` releases the layer.

**dziry today — done.** `<Window layer={…}>` → `provideWindowLayer` → `ManagedRuntime.make` → forced `rt.runtime()` acquisition at launch → `disposeWindowRuntime` on quit. Invariant: **one window = one layer = one runtime.** Tested against effect 3.22.

**Design:** none — review-only. The second worked example: dziry already does window-root DI with scoped finalizers.

## Rung 3 — Fibers and `Scope` (first gap)

**Effect note:** a fiber is a computation that has been *started*; a `Scope` owns a tree of fibers, and closing it interrupts them and runs their finalizers.

**dziry today — missing.** `runDispatched` wraps the run in a fire-and-forget `async () => { … await rt.runPromiseExit(value) … }`. The effect is an awaited promise, not a held fiber — nothing can interrupt it except process teardown.

**Design.** Give the window an explicit `Scope` beside its `ManagedRuntime`:

- `runDispatched` forks the effect into the window scope and keeps the fiber handle, instead of awaiting a promise inside an async closure.
- `disposeWindowRuntime` closes the scope **before** disposing the runtime, so quitting deterministically interrupts in-flight handlers and runs their `acquireRelease`.
- Handlers do **not** supersede each other — a re-click does not cancel the prior click. Supersede is a loader concept (rung 4); this scope is about lifecycle only.

**Rationale.** This is the difference between "the process is going away anyway" and "finalizers run, in order, before the window is gone." It is also the substrate rung 4 reuses with a second, per-navigation scope.

## Rung 4 — Loaders (designed, not built)

**Effect note:** a loader is the data-fetch that runs when you navigate to a route, before the screen renders — the one place typed errors, cancellation, and DI meet.

**dziry today — author surface only.** `data-layer-design.md` §4 specifies the contract — `export const loader` on a route file, three shapes (sync / async / Effect), `loading.tsx` (presence decides navigation timing), `failure.tsx` (per-error-tag views), a parent's `provides` feeding a child's `R`. `Redirect`/`Cancel` are already exported. No compiler or runtime code exists.

**Design — the missing half.**

*Compiler:* reverse-map `export const loader` on each route file by identity — the same mechanism `layer={…}` and `bind:value={sig}` use — and emit a `loaders` table: route → loader export name. Routes are already files (`src/compiler/routes.ts`), so this is one more export the route pass records.

*Router (runtime):* on navigate, run the matched loader in a **per-navigation scope**. Navigating again closes that scope → interrupt → finalizers run → the stale Exit is discarded.

*Shape detection (load-bearing order):* Effect first, then thenable, then plain value. Effect before thenable because an Effect is not a Promise and must not be `await`ed.

*Exit → screen:*

| Exit | screen |
| --- | --- |
| `Success<A>` | data lands in the screen's cell; screen renders |
| `Fail<E>` tagged | per-tag view from `failure.tsx`; unmatched → default export |
| `Fail<Redirect\|Cancel>` | navigation control flow (the already-exported tags) |
| defect | crash view |
| interruption | nothing |

**Prerequisite, named not designed:** "data lands in the screen's cell" requires the reactivity `Source`/`args` work (`REACTIVITY.md` §5.4 unify-on-Source, §5.5 `args.id` as a binding). Loaders are blocked on that, not on anything Effect-specific.

## Rung 5 — Stream → signal (the "open edge")

**Effect note:** a `Stream<A,E,R>` is Effect's sequence over time (its Observable/async-iterable); `Stream.runForEach` consumes it, calling your callback per emission.

**dziry today — missing.** `data-layer-design.md` §4 calls it "open edge, deliberately unresolved": nothing lets Effect's output over time flow into a dziry signal. The author writes the bridge by hand and owns its lifecycle:

```ts
export const todos = signal<Todo[]>([]);
// somewhere at startup:
Stream.runForEach(liveTodos(), (xs) => Effect.sync(() => todos.set(xs)));
```

**Design — a `source()` primitive.** Compile-time recognised, like `todos.map(…)` and `cn(…)`:

```tsx
// windows/main/state.ts
export const todos = source(
  () => liveTodos(),  // a factory returning Stream<Todo[]> — a live query, websocket, poller…
  [] as Todo[],       // initial value, shown before the first emission
);
```

`todos` is an ordinary `ReadonlySignal<Todo[]>` — bare reads, `.map`, `bind:value` all work, and markup reads `todos` directly.

**What the compiler does with it** (mirroring `local()` and form cells): declare a compiler-owned cell in the artifact and record that this cell is fed by a stream factory. The runtime wires the bridge and forks it into the window scope:

```ts
Stream.runForEach(stream, (emission) => cell.set(emission));
```

That one line **is** the link: everything upstream is Effect (retries, schedules, error handling, DI, interruption), everything downstream is dziry (signal → binding → paint). `source()` is the compiler owning that line so the author writes one instead of three plus cleanup.

**Why a factory `() => stream`, not the stream:** the stream needs the window layer's live services (rung 2), which do not exist at module-eval time. The factory runs once the `ManagedRuntime` is acquired — the same reason `provideWindowLayer` forces acquisition at launch; the "live service instances" ledger entry in `NOTES.md`.

**Errors, requirements, interruption:** `R` is satisfied by the window layer (rung 2); `E` is the author's to compose away (`Stream.catchAll`) before returning, or the runtime prints it like `runDispatched`; interruption is the window scope (rung 3).

**Reactivity model:** `source()` becomes one more `Source` kind in `REACTIVITY.md` §5.4 — `{ kind: "stream", factory, cell }` — beside signal / item / param / expr. It depends on rung 3 (scope) and on §5.4.

## Why this is what "Effect-compatible" means

| rung | today | after |
| --- | --- | --- |
| run an Effect | done | done |
| DI via a window layer | done | done |
| cancel in-flight work on quit | missing | rung 3 |
| loaders: typed failures, cancel-on-navigate, DI | design only | rung 4 |
| Effect streams drive reactive UI | open edge | rung 5 |

Rungs 1–2 are "dziry already does Effect correctly" (study aid). Rungs 3–5 are the work, and rung 5 is what makes "Effect drives the UI" true rather than "Effect runs in the background."

## Dependencies and order

- **Rung 3** is standalone — do it first; it is small and rungs 4–5 reuse it.
- **Rung 4** depends on rung 3 (per-navigation scope) **and** on `REACTIVITY.md` §5.4/§5.5 (where the loaded data lives).
- **Rung 5** depends on rung 3 (window scope) and on §5.4 (the `Source` kind).

## Open questions

1. **Rung 4** — is the loader's success cell one declared signal per route, or folded into the §5.4 `Source` work so a route's `data` is just another source? (Leaning: fold into §5.4; do not invent a second mechanism.)
2. **Rung 5** — does `source()` accept only a `Stream`, or also a `Subscription` / `@effect/store` query (which wraps a Stream plus ref-counting)? (Leaning: accept a `Stream`; keep the primitive narrow and let the author adapt.)
3. **Rung 3** — should a handler's fiber be interruptible per-node (re-dispatch cancels the prior), or only on quit? (Leaning: only on quit — supersede is a loader concept; per-node cancel makes double-clicks surprising.)
