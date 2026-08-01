/** @jsxImportSource ../../src/compiler */

/**
 * The window: chrome that stays put, and an `<Outlet/>` where the route goes.
 *
 * `Nav.tsx` sits beside this file rather than under `pages/`, which is the whole
 * point of the split — `pages/` contains routes and nothing else, so a component
 * shared by every route lives here and nothing scans it.
 *
 * The theme toggle is on `<Window>` because that is where it has to be: the
 * stylesheet's dark/light rules are written `body.light .card`, and `<Window>` *is*
 * the body. `cn` keeps the signal visible to the compiler, which turns the class
 * into style-table writes rather than something the runtime resolves. Density is
 * per page, on `.app`, for the same reason — `.app.compact .card` is where that
 * cascade starts.
 */
import { cn } from "../../src/compiler/jsx-runtime.ts";
import { Outlet, Window } from "../../src/compiler/window.ts";
import { Nav } from "./Nav.tsx";
import { isLight } from "./state.ts";

export default function Main() {
  return (
    <Window
      title="dziri — compiled UI"
      width={1040}
      height={620}
      minWidth={480}
      minHeight={360}
      className={cn({ light: isLight })}
    >
      <div className="shell">
        <Nav />
        <div className="page">
          <Outlet />
        </div>
      </div>
    </Window>
  );
}
