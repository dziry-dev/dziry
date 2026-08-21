/**
 * The LiveStore store — schema, events, and the store itself.
 *
 * Two things keep this off the compiler's path:
 *
 * 1. `makeSchema` / `queryDb` / the events are plain data — they build a schema
 *    object and a query description, with no side effects, so the compiler can
 *    import this module freely.
 * 2. The store is opened at *launch*, not at import. `createStorePromise` starts
 *    eagerly the moment it is called, so it sits behind `store()`, a thunk that
 *    creates it once and memoizes. `liveQuery` (in state.ts) calls it when the
 *    window starts, and the Effect layer below wraps the same store so it shuts
 *    down cleanly on quit.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { createStorePromise, Events, makeSchema, queryDb, State, type Store } from "@livestore/livestore";
import { makeAdapter } from "@livestore/adapter-node";

/** A todo row, exactly what the table holds. */
export type Todo = { id: string; title: string; done: boolean };

// --- schema: one table, three events, three materializers ----------------------

const todos = State.SQLite.table({
  name: "todos",
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    title: State.SQLite.text({ nullable: false }),
    done: State.SQLite.boolean({ default: false, nullable: false }),
  },
});

const tables = { todos };

export const events = {
  todoCreated: Events.synced({
    name: "todo.created",
    schema: Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean }),
  }),
  todoToggled: Events.synced({
    name: "todo.toggled",
    schema: Schema.Struct({ id: Schema.String, done: Schema.Boolean }),
  }),
  todoDeleted: Events.synced({
    name: "todo.deleted",
    schema: Schema.Struct({ id: Schema.String }),
  }),
};

const materializers = State.SQLite.materializers(events, {
  "todo.created": ({ id, title, done }) => tables.todos.insert({ id, title, done }),
  "todo.toggled": ({ id, done }) => tables.todos.update({ done }).where({ id }),
  "todo.deleted": ({ id }) => tables.todos.delete().where({ id }),
});

const state = State.SQLite.makeState({ tables, materializers });
const schema = makeSchema({ state, events });

// --- the live query ------------------------------------------------------------

/** Every todo, live. `liveQuery` in state.ts turns this into a signal. */
export const todosQuery = queryDb(tables.todos);

// --- the store, opened once at launch ------------------------------------------

// No annotation on purpose: `createStorePromise` infers `Store<typeof schema>`,
// and keeping that type is what makes `AppStore`'s `commit` accept only this
// schema's events.
let storePromise: Promise<Store<typeof schema>> | null = null;
export function store(): Promise<Store<typeof schema>> {
  storePromise ??= createStorePromise({
    schema,
    adapter: makeAdapter({ storage: { type: "fs", baseDirectory: "./.livestore" } }),
    storeId: "todo",
  });
  return storePromise;
}

// --- the window layer: Effect DI + lifecycle ------------------------------------

// Typed by the schema, not `Store<any, any>`: `commit` then rejects events this
// schema does not declare, which is the point of declaring them.
export const AppStore = Context.GenericTag<Store<typeof schema>>("AppStore");

export const layer = Layer.scoped(
  AppStore,
  Effect.acquireRelease(
    Effect.promise(store),
    (s) => Effect.promise(() => s.shutdownPromise()),
  ),
);
