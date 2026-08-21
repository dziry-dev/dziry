/**
 * The list, shared by all three filter routes.
 *
 * A component is a compile-time function, so sharing one costs nothing at run
 * time — each page that calls it gets its own compiled nodes. The row is
 * captured once with a recording proxy; every visible row is a replica with its
 * own handlers, and the checkbox, edit and delete each receive the row's own
 * todo.
 *
 * Two pieces of per-row state come straight from the data, and both are one
 * predicate bit at run time (compiled both ways up front, protocol v45):
 * - `checked={done}` — the checkbox renders the row's own done-ness, re-seeded
 *   from data on every list change, and clicking it still fires `onChange`;
 * - `cn({ "done-row": done })` — a data-driven class, so a finished row can
 *   look finished while its neighbour does not. It dims via `opacity`, which
 *   composites over the whole subtree — a data-driven class styles the
 *   element's *own* box, and text runs do not follow predicates yet.
 */
import { cn, type Props, type ReadonlySignal } from "dziri";
import { deleteTodo, editTodo, toggleDone, type Todo } from "./state.ts";

function TodoRow({ title, done }: Props & Pick<Todo, "title" | "done">) {
  return (
    <div
      className={cn(
        "row flex flex-row items-center gap-3 rounded-xl bg-zinc-900 px-4 py-3 transition-colors hover:bg-zinc-800",
        { "done-row": done },
      )}
    >
      <input type="checkbox" className="check" checked={done} onChange={toggleDone} />
      <div className="rowtitle grow text-sm text-zinc-100">{title}</div>
      <button
        className="rowbtn rounded-md bg-transparent px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
        onClick={editTodo}
      >
        edit
      </button>
      <button
        className="rowbtn rounded-md bg-transparent px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-red-900 hover:text-red-200"
        onClick={deleteTodo}
      >
        ✕
      </button>
    </div>
  );
}

export function TodoList({ view }: Props & { view: ReadonlySignal<Todo[]> }) {
  return (
    <div className="flex flex-col gap-2">
      {view.map((t: Todo) => <TodoRow title={t.title} done={t.done} />, {
        key: (t: Todo) => t.id,
      })}
    </div>
  );
}
