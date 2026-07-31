/**
 * Shared probe harness. Keeps each probe to the cases it is actually testing.
 *
 * A probe reports three ways, because the reader differs by situation:
 *   - into <pre id="out">      -> get_page_text
 *   - console.log("[PROBE] …") -> read_console_messages, pattern "\[PROBE\]"
 *   - document.title           -> "done N" signals completion without polling text
 */
const lines = [];
export const log = (s = "") => lines.push(s);

/** Short, stable description of document.activeElement. */
export const active = () => {
  const a = document.activeElement;
  if (!a) return "null";
  if (a === document.body) return "BODY";
  if (a === document.documentElement) return "HTML";
  return a.tagName + (a.id ? "#" + a.id : "");
};

/** One macrotask. Some focus/layout effects are not synchronous. */
export const tick = () => new Promise((r) => setTimeout(r, 0));
/** One paint. Use when the question involves layout or style resolution. */
export const frame = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

let host;
/** Fresh markup per case, so no case inherits the previous one's state. */
export function mount(html) {
  host ??= document.body.appendChild(document.createElement("div"));
  host.innerHTML = html;
  return host;
}
export const unmount = () => host?.replaceChildren();

/**
 * Run one case. Records state synchronously AND after a tick — reporting only
 * one hides whether an effect is deferred, which has been the interesting part
 * more than once.
 */
export async function measure(name, { setup, mutate, read = active, events = [] }) {
  const el = setup();
  const seen = [];
  for (const n of events) el.addEventListener(n, () => seen.push(n));
  const before = read();
  await mutate(el);
  const sync = read();
  await tick();
  log(
    name.padEnd(34) +
      " before=" + String(before).padEnd(12) +
      " sync=" + String(sync).padEnd(12) +
      " tick=" + String(read()).padEnd(12) +
      (events.length ? " events=[" + (seen.join(",") || "none") + "]" : ""),
  );
}

/** Engine and version — these are engine behaviours, not "browser" behaviours. */
export function engine() {
  const b = navigator.userAgentData?.brands ?? [];
  const real = b.filter((x) => !/Not.?A.?Brand/i.test(x.brand));
  return real.map((x) => `${x.brand} ${x.version}`).join(" / ") || navigator.userAgent;
}

export function report() {
  const head = [
    engine(),
    `viewport ${innerWidth}x${innerHeight} · dpr ${devicePixelRatio}`,
    "",
  ];
  const text = head.concat(lines).join("\n");
  let out = document.getElementById("out");
  if (!out) {
    out = document.createElement("pre");
    out.id = "out";
    document.body.appendChild(out);
  }
  out.textContent = text;
  console.log("[PROBE]\n" + text);
  document.title = "done " + lines.length;
  return text;
}
