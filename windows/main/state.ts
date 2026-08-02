/**
 * Todo app state.
 *
 * Signals and handlers are module-level exports so the compiler can name them:
 * `{draft}` in JSX passes the signal object itself, and the compiler reverse-maps
 * it to the export it came from. A signal created inside a component would have
 * nowhere to live, since components are erased at build time.
 */
import { computed, signal } from "../../src/runtime/signal.ts";

export type Todo = { id: number; title: string; done: boolean };

/** What the text field holds. Typing writes here while it has focus. */
export const draft = signal("");

export const todos = signal<Todo[]>([
  { id: 1, title: "Compile the cascade", done: true },
  { id: 2, title: "Paint with Skia", done: false },
  { id: 3, title: "Bind some signals", done: false },
]);

let nextId = 4;

/**
 * The list actually rendered.
 *
 * A derived array rather than `todos` directly, because item templates cannot
 * contain conditionals — `{t.done ? "x" : ""}` would evaluate the recording proxy,
 * which is always truthy. Anything conditional per row has to be *data*, so the
 * mark is computed here where real values exist.
 */
export const view = computed(() =>
  todos.map((t) => ({
    ...t,
    mark: t.done ? "[x]" : "[ ]",
  })),
);

export const remaining = computed(() => todos.filter((t) => !t.done).length);
export const total = computed(() => todos.length);

export function addTodo(): void {
  const title = draft.trim();
  if (title === "") return;
  todos.set([...todos, { id: nextId++, title, done: false }]);
  draft.set("");
}

export function clearDraft(): void {
  draft.set("");
}

// --- per-row handlers -------------------------------------------------------
// These receive the item their row is currently rendering. The runtime turns the
// clicked node back into (slot, offset), then looks up which item that slot holds.

export function toggleDone(item: Todo): void {
  todos.set((ts) => ts.map((t) => (t.id === item.id ? { ...t, done: !t.done } : t)));
}

export function deleteTodo(item: Todo): void {
  todos.set((ts) => ts.filter((t) => t.id !== item.id));
}

// --- appearance -------------------------------------------------------------

export const isLight = signal(false);
export const isCompact = signal(false);

export function toggleTheme(): void {
  isLight.set((on) => !on);
}

export function toggleDensity(): void {
  isCompact.set((on) => !on);
}
