/**
 * `alert()` — the platform's own modal message box.
 *
 * The whole of it on this side is a message, because the dialog cannot be opened from here.
 * SDL requires a message box to be shown from the thread that initialised video, which is the
 * engine thread; app code runs on the worker. So this posts, `host/main.ts` shows, and the two
 * halves never share a stack.
 *
 * # Why this is not `window.alert`
 *
 * Bun defines a global `alert()` of its own that writes to stdout and waits for Enter on
 * stdin. An author who forgets the import gets that one, and it hangs the app thread on a
 * terminal nobody is looking at. Nothing here can prevent it — a module cannot shadow a global
 * for its consumers — but it is why the import is worth taking: `import { alert } from
 * "dziry"`.
 *
 * # Why it is fire-and-forget
 *
 * Nothing is returned and nothing is awaited. A modal that blocks *this* thread would need the
 * worker to sleep on a lock while the engine thread ran the dialog, which is the deadlock shape
 * this architecture exists to avoid — the engine thread is the one that would have to answer,
 * and it is busy showing the box. `confirm()` is the version that needs an answer, and it needs
 * a reply message rather than a return value; it is not built.
 */

/** How loud the box is. The names are SDL's three, which every platform maps to its own icon. */
export type AlertLevel = "info" | "warning" | "error";

export type AlertRequest = { message: string; title: string; level: 0 | 1 | 2 };

/**
 * Where a request goes. Installed by the host; absent everywhere else.
 *
 * A settable sink rather than an import of the host, for the reason `setListBuilder` and
 * `setCompiling` are: the runtime is loaded by the compiler as well as by the app, and a
 * runtime module that imported a host would drag a `dlopen` into the build.
 */
let sink: ((request: AlertRequest) => void) | null = null;

export function setAlertSink(next: ((request: AlertRequest) => void) | null): void {
  sink = next;
}

const LEVELS: Record<AlertLevel, 0 | 1 | 2> = { info: 0, warning: 1, error: 2 };

/**
 * Shows a native modal message box.
 *
 * ```ts
 * alert("Saved.");
 * alert("Could not reach the server.", { level: "error", title: "Offline" });
 * ```
 *
 * It is the platform's dialog, not one dziry draws — a Win32 task dialog, an `NSAlert`, the
 * GTK box. The window stops repainting while it is up, which is what a modal is.
 *
 * **With no window there is nobody to notify, so it prints instead.** That is the case every
 * screenshot, golden scenario and test runs in, and a build harness failing because a handler
 * ended in `alert("saved")` would be the tail wagging the dog. The line goes to stderr so it
 * cannot be mistaken for the app's own output.
 */
export function alert(
  message: string,
  options: { title?: string; level?: AlertLevel } = {},
): void {
  const request: AlertRequest = {
    message,
    title: options.title ?? "",
    level: LEVELS[options.level ?? "info"],
  };

  if (sink === null) {
    console.error(`alert: ${request.title ? `${request.title} — ` : ""}${request.message}`);
    return;
  }
  sink(request);
}
