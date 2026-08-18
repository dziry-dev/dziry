/**
 * Todo app state — a LiveStore query as a signal, plus Effect handlers.
 *
 * `todos` is `liveQuery(store, todosQuery)`: a live signal that repaints on every
 * commit — no stream, no manual subscribe. `sync` tracks LiveStore's sync status for
 * the header. Handlers return Effects, so dziri runs them on the window's runtime;
 * each `yield* AppStore` (the layer's service) and commits an event.
 */
import { computed, signal } from "dziri";
import { liveQuery, useSyncStatus } from "dziri/livestore";
import { Effect } from "effect";
import { AppStore, events, store, todosQuery, type Todo } from "./store.ts";

export type { Todo };

/** What the text field holds. */
export const draft = signal("");

/** The todo list — live, from the store. */
export const todos = liveQuery(store, todosQuery);

/** Sync status, for the header. */
export const sync = useSyncStatus(store);

export const remaining = computed(() => todos.filter((t) => !t.done).length);
export const total = computed(() => todos.length);
export const syncLabel = computed(() => (sync.isSynced ? "synced" : "syncing…"));

/** The list as rendered: each row carries its check mark. */
export const view = computed(() => todos.map((t) => ({ ...t, mark: t.done ? "✓" : "○" })));

// --- handlers: Effects that commit events --------------------------------------

export const addTodo = () =>
  Effect.gen(function* () {
    const title = draft.trim();
    if (title === "") return;
    const s = yield* AppStore;
    yield* Effect.sync(() => s.commit(events.todoCreated({ id: crypto.randomUUID(), title, done: false })));
    draft.set("");
  });

export const toggleDone = (item: Todo) =>
  Effect.gen(function* () {
    const s = yield* AppStore;
    yield* Effect.sync(() => s.commit(events.todoToggled({ id: item.id, done: !item.done })));
  });

export const deleteTodo = (item: Todo) =>
  Effect.gen(function* () {
    const s = yield* AppStore;
    yield* Effect.sync(() => s.commit(events.todoDeleted({ id: item.id })));
  });
