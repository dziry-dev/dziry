/**
 * Runs a probe in headless Chrome over the DevTools Protocol and prints its table.
 *
 *   bun run probe focus-removal
 *   bun run probe focus-removal --size 1280x800 --dpr 2
 *   bun run probe focus-removal --headed --shot out.png
 *   bun run probe --all
 *
 * Why CDP rather than the OS webview: the webview is a *different engine per
 * platform* (WebView2=Blink, WKWebView/WebKitGTK=WebKit), so the same probe would
 * silently produce WebKit answers on a Mac and Blink answers on Windows. For a
 * file whose whole value is "this is what the engine does", wrong-without-saying-so
 * is the worst failure available. CDP pins one engine and reports its version.
 *
 * Why not Playwright: no install, and this uses the Chrome already on the machine.
 * Reach for Playwright only if you want *deliberate* cross-engine comparison — it
 * ships WebKit and Firefox builds, which is the honest way to get that.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProbeServer, PROBE_ROOT } from "./probe-server.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? (argv[i + 1] ?? "") : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

const names = argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
const [w, h] = (flag("size", "1024x768") as string).split("x").map(Number);
const dpr = Number(flag("dpr", "1"));
const TIMEOUT = Number(flag("timeout", "15000"));

/**
 * Windows holds locks inside the profile until the process is fully gone, and it
 * releases them lazily, so a single rm right after kill() fails. Silently, if you
 * let it — which leaked five profiles before anyone looked.
 */
async function rmProfile(dir: string) {
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

/** Sweep profiles a previous run failed to remove — a crash or a kill -9 leaves
 *  one behind, and without this they accumulate forever in TEMP. */
async function sweepStaleProfiles() {
  const dir = tmpdir();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith("dziri-probe-")) await rmProfile(join(dir, name));
  }
}

/** `--user-data-dir` is not optional: with a shared profile an already-running
 *  Chrome silently ignores `--remote-debugging-port` and the launch hangs. */
function findChrome(): string {
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

/** Minimal CDP client. Flat sessions, so every page command carries a sessionId. */
class Cdp {
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
    return new Promise<Cdp>((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => res(new (Cdp as any)(ws)));
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

const deadline = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${what}`)), ms)),
  ]);

/** Chrome prints `DevTools listening on ws://…` to stderr; port 0 means it picks. */
async function launch() {
  const profile = await mkdtemp(join(tmpdir(), "dziri-probe-"));
  const proc = Bun.spawn(
    [
      findChrome(),
      ...(has("headed") ? [] : ["--headless=new"]),
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
  return { proc, url, profile };
}

async function runOne(cdp: Cdp, origin: string, name: string) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  const errors: string[] = [];
  cdp.on = (method, params) => {
    if (method === "Runtime.exceptionThrown")
      errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "?");
  };

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: w, height: h, deviceScaleFactor: dpr, mobile: false },
    sessionId,
  );
  await cdp.send("Page.navigate", { url: `${origin}/${name}.html` }, sessionId);

  // The harness sets document.title to "done N" and fills #out. Waiting on that
  // beats a fixed sleep, and surfaces a hung probe as a timeout naming the probe.
  const wait = `new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("probe never called report()")), ${TIMEOUT - 1000});
    (function poll() {
      if (document.title.startsWith("done")) { clearTimeout(t); res(document.getElementById("out").textContent); }
      else requestAnimationFrame(poll);
    })();
  })`;

  const r = await deadline(
    cdp.send("Runtime.evaluate", { expression: wait, awaitPromise: true, returnByValue: true }, sessionId),
    TIMEOUT,
    name,
  );

  if (has("shot")) {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    await writeFile(flag("shot", `${name}.png`)!, Buffer.from(data, "base64"));
  }

  await cdp.send("Target.closeTarget", { targetId });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "probe threw");
  return { text: r.result.value as string, errors };
}

await sweepStaleProfiles();
const server = startProbeServer(0);
const origin = `http://localhost:${server.port}`;
const { proc, url, profile } = await launch();
const cdp = await Cdp.connect(url);

let failed = false;
try {
  const list = has("all")
    ? (await readdir(PROBE_ROOT)).filter((n) => n.endsWith(".html")).map((n) => n.replace(/\.html$/, ""))
    : names.length
      ? names
      : ["--help"];

  if (list[0] === "--help") {
    console.log("usage: bun run probe <name> [--size WxH] [--dpr N] [--headed] [--shot f.png] [--all]");
    console.log("probes:", (await readdir(PROBE_ROOT)).filter((n) => n.endsWith(".html")).join(", ") || "(none)");
  }

  for (const name of list.filter((n) => n !== "--help")) {
    console.log(`\n──── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
    try {
      const { text, errors } = await runOne(cdp, origin, name);
      console.log(text);
      if (errors.length) console.log("\npage errors:\n  " + errors.join("\n  "));
    } catch (e) {
      failed = true;
      console.error(`FAILED: ${(e as Error).message}`);
    }
  }
} finally {
  cdp.close();
  proc.kill();
  await proc.exited; // locks are only released once it is really gone
  server.stop(true);
  if (!(await rmProfile(profile))) console.error(`warn: could not remove ${profile}`);
}
process.exit(failed ? 1 : 0);
