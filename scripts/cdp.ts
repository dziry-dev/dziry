/**
 * A minimal Chrome DevTools Protocol client, shared by `probe.ts` and
 * `conformance.ts`.
 *
 * Uses whatever Chromium browser is installed — Chrome or Edge, both Blink.
 * No download, no dependency, and it works headless so it can run in CI.
 *
 * `--user-data-dir` is not optional: with a shared profile an already-running
 * Chrome silently ignores `--remote-debugging-port` and the launch hangs.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function findChrome(): string {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("no Chrome/Edge found — set CHROME=/path/to/chrome");
  return found;
}

export const deadline = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${what}`)), ms)),
  ]);

/**
 * Windows releases locks inside the profile lazily, so a single rm right after
 * kill() fails — silently, if you let it, which leaked five profiles before
 * anyone looked.
 */
export async function rmProfile(dir: string) {
  for (let i = 0; i < 10; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      await Bun.sleep(100);
    }
  }
  return false;
}

/** Sweep profiles a crashed run left behind, so TEMP does not fill up forever. */
export async function sweepStaleProfiles() {
  const dir = tmpdir();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith("dziry-probe-")) await rmProfile(join(dir, name));
  }
}

class Wire {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  on: (method: string, params: any) => void = () => {};

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id != null) {
        const p = this.#pending.get(m.id);
        this.#pending.delete(m.id);
        if (!p) return;
        m.error ? p.err(new Error(m.error.message)) : p.ok(m.result);
      } else this.on(m.method, m.params);
    });
  }

  static connect(url: string) {
    return new Promise<Wire>((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => res(new (Wire as any)(ws)));
      ws.addEventListener("error", () => rej(new Error(`cannot connect: ${url}`)));
    });
  }

  send(method: string, params: any = {}, sessionId?: string) {
    const id = ++this.#id;
    return new Promise<any>((ok, err) => {
      this.#pending.set(id, { ok, err });
      this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.#ws.close();
  }
}

export type Session = {
  wire: Wire;
  /** Navigate a fresh tab and evaluate an expression, awaiting a promise result. */
  run(url: string, expression: string, timeout?: number): Promise<{ value: any; errors: string[] }>;
  /** Set inline HTML (no navigation) and read one computed property. */
  computed(css: string, selector: string, property: string): Promise<string>;
  /** Same, but you supply the whole document — use when the markup is the variable. */
  computedIn(html: string, selector: string, property: string): Promise<string>;
  setViewport(width: number, height: number, dpr: number): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
};

export async function chromeSession(opts: { headed?: boolean; width?: number; height?: number } = {}): Promise<Session> {
  await sweepStaleProfiles();
  const profile = await mkdtemp(join(tmpdir(), "dziry-probe-"));
  const w = opts.width ?? 1024;
  const h = opts.height ?? 768;

  const proc = Bun.spawn(
    [
      findChrome(),
      ...(opts.headed ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${w},${h}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "about:blank",
    ],
    { stderr: "pipe", stdout: "ignore" },
  );

  // Chrome prints `DevTools listening on ws://…` to stderr; port 0 means it picks.
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const url = await deadline(
    (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`Chrome exited before listening:\n${buf}`);
        buf += dec.decode(value, { stream: true });
        const m = buf.match(/ws:\/\/\S+/);
        if (m) return m[0];
      }
    })(),
    10_000,
    "Chrome startup",
  );
  reader.releaseLock();

  const wire = await Wire.connect(url);

  // One long-lived tab for content-setting work; `run` makes its own per call so
  // a probe never inherits another probe's document.
  const { targetId } = await wire.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await wire.send("Target.attachToTarget", { targetId, flatten: true });
  await wire.send("Runtime.enable", {}, sessionId);
  await wire.send("Page.enable", {}, sessionId);
  await wire.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);

  const evaluate = async (expr: string, sid: string, awaitPromise = true) => {
    const r = await wire.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  // Bound to `Session` rather than returned inline: the contextual type of a
  // literal returned straight out of an async function is `Session |
  // PromiseLike<Session>`, so `this.computedIn` inside `computed` does not
  // typecheck against the promise arm.
  const session: Session = {
    wire,

    async run(pageUrl, expression, timeout = 15_000) {
      const t = await wire.send("Target.createTarget", { url: "about:blank" });
      const s = await wire.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      const errors: string[] = [];
      wire.on = (method, params) => {
        if (method === "Runtime.exceptionThrown")
          errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "?");
      };
      await wire.send("Runtime.enable", {}, s.sessionId);
      await wire.send("Page.enable", {}, s.sessionId);
      await wire.send(
        "Emulation.setDeviceMetricsOverride",
        { width: w, height: h, deviceScaleFactor: 1, mobile: false },
        s.sessionId,
      );
      await wire.send("Page.navigate", { url: pageUrl }, s.sessionId);
      try {
        const value = await deadline(evaluate(expression, s.sessionId), timeout, pageUrl);
        return { value, errors };
      } finally {
        await wire.send("Target.closeTarget", { targetId: t.targetId });
      }
    },

    async computed(css, selector, property) {
      return this.computedIn(
        `<!doctype html><meta charset=utf-8><style>${css}</style><body><div class="probe">x</div></body>`,
        selector,
        property,
      );
    },

    /**
     * Same, but you supply the whole document.
     *
     * `computed()` hardcodes its markup, so passing a document as its `css`
     * argument used to *appear* to work: the HTML parser ends a `<style>` at the
     * first `</style>`, so the injected markup escaped into the document and
     * really did render — while the stylesheet you meant to apply was silently
     * swallowed as invalid CSS. Right answers for the wrong reason. Use this
     * when the markup is the variable.
     */
    async computedIn(html, selector, property) {
      const { frameTree } = await wire.send("Page.getFrameTree", {}, sessionId);
      await wire.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html }, sessionId);
      const expr =
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
        ` return el ? getComputedStyle(el).getPropertyValue(${JSON.stringify(property)}) : "\\u0000missing"; })()`;
      const v = String(await evaluate(expr, sessionId, false));
      if (v === " missing") throw new Error(`selector ${selector} matched nothing`);
      return v;
    },

    async setViewport(width, height, dpr) {
      await wire.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false }, sessionId);
    },

    async screenshot() {
      const { data } = await wire.send("Page.captureScreenshot", { format: "png" }, sessionId);
      return new Uint8Array(Buffer.from(data, "base64"));
    },

    async close() {
      wire.close();
      proc.kill();
      await proc.exited;
      await rmProfile(profile);
    },
  };
  return session;
}
