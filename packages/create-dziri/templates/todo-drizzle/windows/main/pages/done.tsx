/**
 * The route at "done" — what's finished, from the same query signal.
 */
import { defineRoute } from "dziri";
import { viewDone } from "../state.ts";
import { TodoList } from "../TodoList.tsx";

const route = defineRoute("done")({
  component: Done,
});

export default route;

function Done() {
  return <TodoList view={viewDone} />;
}
