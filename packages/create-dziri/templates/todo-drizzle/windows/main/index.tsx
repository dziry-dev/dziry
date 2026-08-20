import "./app.css";
import { cn, Outlet, useRouter, Window } from "dziri";
import { isLight, remaining, setLight, total } from "./state.ts";
import { route } from "./router.ts";

const TAB =
  "tab rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 no-underline transition-colors hover:bg-zinc-700";

/**
 * The window: header, filter tabs, and the routed page under them.
 *
 * The tabs are real links — `href` is checked against the route table at build
 * time and a click writes the route signal, nothing here handles it. The theme
 * is one checkbox: `.light` on the window root, and `app.css` restyles the
 * semantic classes under it. Both states were compiled; toggling costs a
 * handful of style-table writes and nothing per frame.
 */
export default function Main() {
  const router = useRouter();
  return (
    <Window
      title="{{name}}"
      width={560}
      height={720}
      minWidth={440}
      minHeight={480}
      route={route}
      className={cn({ light: isLight })}
    >
      <div className="flex flex-col grow gap-4 p-6">
        <div className="card flex flex-col gap-3 rounded-2xl bg-zinc-900 p-5">
          <div className="flex flex-row items-center justify-between">
            <div className="flex flex-col gap-1">
              <div className="heading text-xl font-semibold text-zinc-50">{"{{name}}"}</div>
              <div className="muted text-xs text-zinc-400">
                {remaining} open · {total} total · SQLite via Drizzle
              </div>
            </div>
            <label className="muted flex flex-row items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" className="check" onChange={setLight} />
              light
            </label>
          </div>

          <div className="flex flex-row gap-2">
            <a href="/" className={cn(TAB, { active: router.matches("/") })}>
              All
            </a>
            <a href="active" className={cn(TAB, { active: router.matches("active") })}>
              Active
            </a>
            <a href="done" className={cn(TAB, { active: router.matches("done") })}>
              Done
            </a>
          </div>
        </div>

        <Outlet />
      </div>
    </Window>
  );
}
