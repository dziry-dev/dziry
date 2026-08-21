/**
 * The route at "/" — the todo list, live from the store.
 *
 * There is no loader: `todos` is a live query, so the list repaints on every
 * commit. The header reads the same signals — `total`, `remaining`, `syncLabel` —
 * and the handlers return Effects that commit events.
 */
import { defineRoute, type Props } from "dziry";
import { addTodo, deleteTodo, draft, remaining, syncLabel, toggleDone, total, view, type Todo } from "../state.ts";

const route = defineRoute("/")({
  component: Todos,
});

export default route;

/** A row of the list. Called once, with a recording proxy, at build time. */
function Row({ mark, title }: Props & { mark: string; title: string }) {
  return (
    <div className="flex flex-row items-center gap-3 rounded-lg bg-zinc-800 px-3 py-2">
      <button
        className="rounded bg-zinc-700 px-2 py-1 text-xs text-emerald-300 hover:bg-zinc-600"
        onClick={toggleDone}
      >
        {mark}
      </button>
      <div className="grow text-sm text-zinc-100">{title}</div>
      <button
        className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-red-900 hover:text-red-200"
        onClick={deleteTodo}
      >
        ✕
      </button>
    </div>
  );
}

function Todos() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 rounded-xl bg-zinc-900 p-5">
        <div className="text-xl font-semibold text-zinc-50">{"{{name}}"}</div>
        <div className="text-xs text-zinc-400">
          <span>{total} todos</span> · {remaining} open · {syncLabel}
        </div>
      </div>

      <div className="flex flex-row gap-2">
        <input
          type="text"
          placeholder="What needs doing?"
          className="grow rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
          bind:value={draft}
        />
        <button
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-sky-50 hover:bg-sky-500"
          onClick={addTodo}
        >
          Add
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {view.map((t: Todo & { mark: string }) => <Row mark={t.mark} title={t.title} />, {
          key: (t: Todo) => t.id,
        })}
      </div>
    </div>
  );
}
