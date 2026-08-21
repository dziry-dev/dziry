import "./app.css";
import { Outlet, Window } from "dziry";
import { layer } from "./store.ts";

/**
 * The window. Its Effect layer opens the LiveStore store at launch and shuts it
 * down on quit; handlers commit events, and `liveQuery` re-renders the list.
 */
export default function Main() {
  return (
    <Window title="{{name}}" width={560} height={680} minWidth={420} minHeight={480} layer={layer}>
      <div className="flex flex-col grow gap-4 p-6">
        <Outlet />
      </div>
    </Window>
  );
}
