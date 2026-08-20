/**
 * The list, shared by all three filter routes.
 *
 * A component is a compile-time function, so sharing one costs nothing at run
 * time — each page that calls it gets its own compiled nodes. The row is
 * captured once with a recording proxy; every visible row is a replica with its
 * own handlers, and the ✓ toggle, edit and delete each receive the row's own
 * todo.
 *
 * Two deliberate shapes worth knowing about:
 * - the done mark is precomputed **data** (`mark`), because replicas of one
 *   template share their style rows — a row cannot wear a class its siblings
 *   don't, so "done-ness" is expressed as text, not styling;
 * - the mark is a styled button rather than an `<input type="checkbox">`,
 *   because a checkbox's checkedness is live control state the user owns, not
 *   something replicas re-seed from row data. The theme checkbox in the header
 *   is the real element, used where its semantics fit.
 */
import type { Props, ReadonlySignal } from "dziri";
import { deleteTodo, editTodo, toggleDone, type Todo } from "./state.ts";

type Row = Todo & { mark: string };

function TodoRow({ mark, title }: Props & Pick<Row, "mark" | "title">) {
  return (
    <div className="row flex flex-row items-center gap-3 rounded-xl bg-zinc-900 px-4 py-3 transition-colors hover:bg-zinc-800">
      <button
        className="mark flex size-6 items-center justify-center rounded-md border border-zinc-600 bg-transparent text-xs text-emerald-400 transition-colors hover:border-emerald-500"
        onClick={toggleDone}
      >
        {mark}
      </button>
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

export function TodoList({ view }: Props & { view: ReadonlySignal<Row[]> }) {
  return (
    <div className="flex flex-col gap-2">
      {view.map((t: Row) => <TodoRow mark={t.mark} title={t.title} />, {
        key: (t: Row) => t.id,
      })}
    </div>
  );
}
