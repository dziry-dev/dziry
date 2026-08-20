/**
 * The route at "/" — every todo, and the add form.
 *
 * The form is validated at the framework level: `validate` runs over the
 * payload, an issue lands beside the field (`<span error/>`), the wrapper wears
 * `errorClassName`, and the offending control wears `:invalid` — no JavaScript
 * of yours in the error path. `validateOn="change"` checks as you type, but a
 * field stays quiet until its value has moved, so the page does not open red.
 * Submitting valid calls `addTodo` with the payload by field name; Enter in the
 * field submits, because the form has a submit button.
 */
import { defineRoute } from "dziri";
import { addTodo, viewAll } from "../state.ts";
import { TodoList } from "../TodoList.tsx";

const route = defineRoute("/")({
  component: All,
});

export default route;

export function checkTodo(data: { title: string }): { path: string[]; message: string }[] | null {
  const title = data.title.trim();
  if (title === "") return [{ path: ["title"], message: "write something to do" }];
  if (title.length < 3) return [{ path: ["title"], message: "three characters or more" }];
  return null;
}

function All() {
  return (
    <div className="flex flex-col gap-4">
      <form
        className="card flex flex-col gap-2 rounded-2xl bg-zinc-900 p-4"
        validateOn="change"
        validate={checkTodo}
        onSubmit={addTodo}
      >
        <div field="title" errorClassName="invalid-wrap" className="flex flex-col gap-1.5">
          <div className="flex flex-row gap-2">
            <input
              type="text"
              placeholder="What needs doing?"
              className="field grow rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
            />
            <button
              type="submit"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-emerald-50 transition-colors hover:bg-emerald-500"
            >
              Add
            </button>
          </div>
          <span error className="note text-xs text-red-400" />
        </div>
      </form>

      <TodoList view={viewAll} />
    </div>
  );
}
