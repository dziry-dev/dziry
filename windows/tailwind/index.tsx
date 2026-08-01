/** @jsxImportSource ../../src/compiler */

/**
 * The Tailwind coverage window: one page per utility family.
 *
 * Every class on these pages is real Tailwind v4 output, resolved at build time
 * into a style table. Nothing here is a mock-up of Tailwind — `bun run tw:css` runs
 * the actual CLI, and if a utility does not compile the build says so.
 *
 * The pages are the coverage claim made concrete. `bun run tailwind-coverage`
 * reports a percentage; this shows which utilities are behind it, and grows as that
 * number does.
 */
import { Outlet, Window } from "../../src/compiler/window.ts";
import { Nav } from "./Nav.tsx";

export default function Tailwind() {
  return (
    <Window title="dziri — Tailwind" width={980} height={680} minWidth={520} minHeight={400}>
      <div className="flex flex-col grow gap-6 bg-zinc-950 p-6">
        <Nav />
        <div className="flex flex-col grow gap-6">
          <Outlet />
        </div>
      </div>
    </Window>
  );
}
