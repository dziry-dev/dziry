/**
 * The application: a Tailwind-styled window, one route per utility family plus the
 * framework's own features and the routing demo.
 *
 * Every class on these pages is real Tailwind v4 output, resolved at build time into
 * a style table — `bun run tw:css` runs the actual CLI, and a utility that does not
 * compile makes the build say so. The pages are the coverage claim made concrete:
 * `bun run tailwind-coverage` reports a percentage, and this shows what is behind it.
 *
 * `route` is what makes the nav work. It is passed in rather than imported from the
 * framework because a route belongs to a window, and two windows on different routes
 * is the normal case.
 *
 * `light` is on `<Window>` because the theme rules are written `body.light …` and
 * `<Window>` *is* the body. `cn` keeps the signal visible to the compiler, which
 * turns the class into style-table writes rather than something the runtime resolves.
 */
import { cn, Outlet, Window } from "dziri";
import { Nav } from "./Nav.tsx";
import { route } from "./router.ts";
import { isLight } from "./state.ts";

export default function Main() {
  return (
    <Window
      title="dziri — compiled UI"
      width={1040}
      height={700}
      minWidth={520}
      minHeight={400}
      route={route}
      className={cn({ light: isLight })}
    >
      <div className="flex flex-col grow gap-6 p-6">
        <Nav />
        <div className="flex flex-col grow gap-6">
          <Outlet />
        </div>
      </div>
    </Window>
  );
}
