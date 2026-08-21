/**
 * App state — the query, the mutations, and the theme.
 *
 * If you are arriving from react-query, the mapping is one-to-one and smaller:
 * the **query** is a `source()` — a signal fed from outside, started at launch,
 * never at module eval (the compiler imports this file) — and **invalidation**
 * is re-running it. A mutation is a plain exported handler: write through
 * Drizzle, invalidate, done. There is no cache to configure because the signal
 * *is* the cache, and no staleness because the only writer is this window.
 *
 * Handlers are module-level exports on purpose: the generated artifact imports
 * them by name, which is how a function survives the compile-time / run-time
 * boundary.
 */
import { computed, navigate, signal, source } from "dziri";
import { getTodo, insertTodo, listTodos, removeTodo, setDone, setTitle, type Todo } from "./db.ts";

export type { Todo };

// --- the query -----------------------------------------------------------------

let refetch: () => void = () => {};

/** Every todo, live. Mutations call `invalidate()` and this signal repaints. */
export const todos = source<Todo[]>((set) => {
  refetch = () => set(listTodos());
  refetch();
  return () => {
    refetch = () => {};
  };
}, []);

const invalidate = (): void => refetch();

// --- derived views ---------------------------------------------------------------

export const remaining = computed(() => todos.filter((t) => !t.done).length);
export const total = computed(() => todos.length);

export const viewAll = computed(() => [...todos]);
export const viewActive = computed(() => todos.filter((t) => !t.done));
export const viewDone = computed(() => todos.filter((t) => t.done));

// --- mutations -------------------------------------------------------------------

/** The validated add form's payload, by field name. */
export const addTodo = (data: { title: string }): void => {
  insertTodo(data.title.trim());
  invalidate();
};

export const toggleDone = (item: Todo): void => {
  setDone(item.id, !item.done);
  invalidate();
};

export const deleteTodo = (item: Todo): void => {
  removeTodo(item.id);
  invalidate();
};

/** A row's edit button: the edit page is a route, so editing is navigation. */
export const editTodo = (item: Todo): void => {
  navigate(`todo/${item.id}`);
};

// --- the edit page ---------------------------------------------------------------

/**
 * The edit page's state. The loader runs on navigation: it reads the row, notes
 * which id is being edited, and seeds the field — `bind:value` is two-way, so
 * writing the signal here is what puts the current title *in* the field, and
 * typing then edits it in place.
 */
export const editingId = signal("");
export const editTitle = signal("");

export const loadTodoForEdit = (args: Record<string, string>): Todo => {
  const todo = getTodo(args.id ?? "");
  if (todo === undefined) throw new Error(`no todo with id ${args.id}`);
  editingId.set(todo.id);
  editTitle.set(todo.title);
  return todo;
};

export const saveEdit = (): void => {
  const title = editTitle.trim();
  if (title === "" || editingId === "") return;
  setTitle(editingId, title);
  invalidate();
  navigate("/");
};

// --- the theme -------------------------------------------------------------------

/** Dark is the default; the header checkbox flips this. */
export const isLight = signal(false);

export const setLight = (on: boolean): void => isLight.set(on);
