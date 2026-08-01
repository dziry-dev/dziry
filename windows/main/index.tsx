/** @jsxImportSource ../../src/compiler */

/**
 * The window: chrome that stays put, and an `<Outlet/>` where the route goes.
 *
 * `Nav.tsx` sits beside this file rather than under `pages/`, which is the whole
 * point of the split — `pages/` contains routes and nothing else, so a component
 * shared by every route lives here and nothing scans it.
 */
import { Outlet, Window } from "../../src/compiler/window.ts";
import { Nav } from "./Nav.tsx";

export default function Main() {
  return (
    <Window title="dziri — routing" width={900} height={560} minWidth={420} minHeight={320}>
      <div className="shell">
        <Nav />
        <div className="page">
          <Outlet />
        </div>
      </div>
    </Window>
  );
}
