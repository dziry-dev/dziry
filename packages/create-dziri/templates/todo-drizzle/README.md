# {{name}}

A [dziri](https://github.com/dziri/dziri) app: HTML, CSS and TypeScript compiled to a
native UI — no browser engine, no DOM, no webview. This template is a todo app backed
by **Drizzle** over `bun:sqlite`, with multiple routes, a validated add form, real
checkboxes whose ticks come from the data, per-row edit/delete, and a dark/light
theme — styled with **Tailwind**.

```sh
bun run dev      # compile and open the window; edits hot-reload
bun run build    # one native executable in dist/
bun run check    # typecheck
```

## Where react-query would sit

There is no React here, so there is no react-query — but the mapping is one-to-one
and smaller. The **query** is a `source()` in `windows/main/state.ts`: a signal fed
from outside, started at launch. **Invalidation** is re-running it. A **mutation**
is a plain exported handler — write through Drizzle, invalidate, done:

```ts
export const todos = source<Todo[]>((set) => {
  refetch = () => set(listTodos());
  refetch();
  return () => {};
}, []);

export const toggleDone = (item: Todo): void => {
  setDone(item.id, !item.done);
  invalidate();
};
```

There is no cache to configure because the signal *is* the cache, and no staleness
window because the only writer is this window.

## The database

`windows/main/db.ts` defines the schema with Drizzle and opens `todos.sqlite` in the
project directory — **lazily**, on first use. That is load-bearing: the compiler
imports every window module at build time, so module scope must not touch the
filesystem. The one table is applied with `CREATE TABLE IF NOT EXISTS` on open;
when the schema grows past that, `drizzle-kit` picks up from the same definition.

## The routes

| path | shows |
| --- | --- |
| `/` | every todo, plus the validated add form |
| `active` | the open ones — a `computed` over the same query |
| `done` | the finished ones |
| `todo/$id` | the edit page: a route `loader` reads the row, an unknown id renders `errorComponent` |

The filter tabs are `<a href>` links: the path is checked against this table at
build time — a typo is a compile error, not a dead click — and the click handler is
synthesized by the compiler. A row's *edit* button navigates from a handler instead,
because the destination depends on the row: `navigate(`todo/${item.id}`)`.

## The theme

Dark is the default. The header checkbox drives a `light` conditional class on the
window root, and `app.css` restyles the semantic classes under `body.light`. Both
themes are compiled up front; toggling writes a handful of style-table entries and
costs nothing per frame.

## Per-row state, from data

Three things in each row come straight from its data, and each costs one
predicate bit at run time (both looks are compiled up front):

```tsx
<input type="checkbox" checked={done} onChange={toggleDone} />
<div className={cn("row …", { "done-row": done })}>
<div className={cn("rowtitle …", { "done-title": done })}>{title}</div>
```

`checked={t.done}` renders the row's own done-ness and is re-seeded on every list
change; clicking still fires `onChange`. The data-driven classes style one row
while its neighbour keeps the other look: `done-row` dims the card (`opacity`
composites over the subtree) and `done-title` strikes the title — an element's
predicates reach its own text runs, so the class goes on the element whose text
it styles.

## Validation

The add form declares `validate` and `validateOn="change"`. An issue lands beside
the field (`<span error/>`), the wrapper wears `errorClassName`, and the control
wears `:invalid` — the error path is CSS, with no JavaScript of yours in it.
