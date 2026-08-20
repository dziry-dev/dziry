/**
 * The route at "todo/$id" — editing, as navigation.
 *
 * The loader runs on the way in: it reads the row through Drizzle, seeds the
 * edit signals, and its return is the `data` the component binds. An unknown id
 * throws, and `errorComponent` is what shows instead of the page. Save writes
 * through Drizzle, invalidates the query, and `navigate("/")`s home; Cancel is
 * a plain link.
 */
import { defineRoute, type ComponentProps } from "dziri";
import { editTitle, loadTodoForEdit, saveEdit } from "../../state.ts";

const route = defineRoute("todo/$id")({
  loader: loadTodoForEdit,
  component: Edit,
  errorComponent: NotFound,
});

export default route;

function Edit({ data }: ComponentProps<typeof route>) {
  return (
    <div className="card flex flex-col gap-3 rounded-2xl bg-zinc-900 p-5">
      <div className="heading text-sm font-semibold text-zinc-50">Edit todo</div>
      {/* The current title comes from the loader as a data-cell binding. The
          field below starts empty rather than seeded: writing a signal into a
          text field's *display* is the half of bind:value that is not built
          yet (API.md, M12) — when it lands, seed `editTitle` in the loader and
          this comment goes away. */}
      <div className="muted text-xs text-zinc-400">
        currently: {data.title}
      </div>
      <input
        type="text"
        placeholder="a new title"
        className="field rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
        bind:value={editTitle}
      />
      <div className="flex flex-row gap-2">
        <button
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-emerald-50 transition-colors hover:bg-emerald-500"
          onClick={saveEdit}
        >
          Save
        </button>
        <a
          href="/"
          className="tab rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 no-underline transition-colors hover:bg-zinc-700"
        >
          Cancel
        </a>
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="card flex flex-col gap-2 rounded-2xl bg-zinc-900 p-5">
      <div className="heading text-sm font-semibold text-red-400">No such todo</div>
      <div className="muted text-xs text-zinc-400">
        It may have been deleted. <a href="/">Back to the list.</a>
      </div>
    </div>
  );
}
