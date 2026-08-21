# {{name}}

A [dziry](https://github.com/dziry/dziry) app: HTML, CSS and TypeScript compiled to a
native UI — no browser engine, no DOM, no webview. This template is a small todo app
backed by **LiveStore** (an embedded SQLite event store on disk) and **Effect** (typed
handlers and a window layer). `liveQuery` turns a store query into a signal; handlers
commit events. Styled with **Tailwind**.

```
bun run dev      # compile and run
bun run build    # one executable in dist/
bun run check    # tsc
```

## How the pieces connect

```
windows/main/
  store.ts        LiveStore: schema, events, the store (opened at launch), the layer
  state.ts        the live signals + Effect handlers that commit events
  index.tsx       <Window layer={layer}> — the chrome that stays put
  pages/index.tsx  the route: renders the live list, no loader
```

`todos` is `liveQuery(store, todosQuery)` — one line that subscribes to the store and
repaints on every commit. Handlers are Effects: they `yield* AppStore` (the layer's
service) and `commit` an event; LiveStore materializes the event into the table, the
query re-runs, and the signal updates. The list is never manually synced.

The store is opened **at launch**, not at import: `createStorePromise` starts eagerly,
so it sits behind a `store()` thunk that `liveQuery` and the layer both call once the
window is live. The layer shuts it down on quit.

## Three things that are not like the web

**A signal reads as its value.** No `.value`, no dependency arrays.

**Signals and handlers are module-level exports**, because the compiler names them —
a signal created inside a component has nowhere to live, since components are erased
at build time.

**A handler returns an Effect.** dziry runs it on the window's runtime; `yield* AppStore`
gives it the store from the layer. A plain function works too — an Effect is how a
handler asks for services.
