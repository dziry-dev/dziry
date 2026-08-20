/**
 * The route at "active" — the open todos. The filter is a `computed` over the
 * same query signal, so this page costs no second read of the database.
 */
import { defineRoute } from "dziri";
import { viewActive } from "../state.ts";
import { TodoList } from "../TodoList.tsx";

const route = defineRoute("active")({
  component: Active,
});

export default route;

function Active() {
  return <TodoList view={viewActive} />;
}
