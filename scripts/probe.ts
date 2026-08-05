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

/**
 * Dispatches the pointer moves and clicks a probe asked for, if it asked for any.
 *
 * **Real input, because `:hover` cannot be reached any other way.** A synthesised
 * `MouseEvent` does not set it, `element.focus()` has no pointer equivalent, and
 * DevTools' `CSS.forcePseudoState` forces the state on *one* element — which measures
 * the tool rather than the browser, and the question here is precisely which *other*
 * elements come along. So the hover chain, `:active`, and anything reached by pointing
 * at something were simply unmeasurable until this existed.
 *
 * The handshake is deliberately the smallest thing that works, and it reuses the title
 * the harness already drives:
 *
 *   1. the page builds its DOM, fills `window.__probeMouse` with real coordinates it
 *      read off real rects, and sets `document.title = "ready"`;
 *   2. this dispatches each step and waits a frame between them, so the page's own
 *      listeners observe each one separately, then calls `window.__probeStep(i)` so
 *      the page can record *that* step's outcome under the right name;
 *   3. the page's `report()` sets `done` as usual.
 *
 * Coordinates come from the page rather than from a flag because only the page knows
 * where its boxes ended up, and a hardcoded pair in a script is a probe that silently
 * stops pointing at the thing it names the day the layout changes.
 *
 * # Keys travel in the same list
 *
 * A step carrying `key` is dispatched as a keyboard event instead of a mouse one, in
 * the same ordered plan, because the questions that need keys need them *interleaved*
 * with clicks: "click to open the picker, then ArrowDown, then Enter" is one sequence
 * and two lists could not express it.
 *
 * It has to be CDP rather than `dispatchEvent` for the same reason the mouse does, and
 * more sharply: a synthetic `KeyboardEvent` is untrusted, so it runs listeners and
 * performs **no default action**. Escape does not close anything, an arrow key does not
 * move a selection, and Enter does not commit one — so every question about what a key
 * *does* is unmeasurable from page script. `Input.dispatchKeyEvent` produces a trusted
 * event, which is the only way to observe the behaviour rather than the listener.
 *
 * `windowsVirtualKeyCode` is set because Chrome ignores `key` alone for non-printable
 * keys: without it, Escape arrives as a keydown that closes nothing, which looks
 * exactly like a finding.
 */

/** Virtual key codes for the non-printable keys probes ask about. */
const VK: Record<string, number> = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  " ": 32,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  Backspace: 8,
  // Windows VK_DELETE is 46, *not* the ASCII 127 SDL reports for the same key. The two
  // numbering schemes are unrelated and both are in this repo — `host/worker.ts` matches
  // SDL's 127 — so getting them the wrong way round is easy and silent: a probe step that
  // dispatched 127 would send an unrelated key and measure nothing.
  Delete: 46,
  // For select-all, which needs a printable key *with* a modifier. `a` is its own virtual
  // key code (0x41), and the runner suppresses `text` when a modifier other than Shift is
  // held — see `driveMouse`.
  a: 65,
};
async function driveMouse(cdp: Cdp, sessionId: string, name: string): Promise<void> {
  const ready = `new Promise((res) => {
    let waited = 0;
    (function poll() {
      // A probe that wants no input never sets "ready", and must not be delayed by
      // this — so give up quickly and let the ordinary "done" wait take over.
      if (document.title.startsWith("ready") || document.title.startsWith("done")) return res(true);
      if (++waited > 120) return res(false);
      requestAnimationFrame(poll);
    })();
  })`;

  const got = await cdp.send(
    "Runtime.evaluate",
    { expression: ready, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (got.result?.value !== true) return;

  const declared = await cdp.send(
    "Runtime.evaluate",
    { expression: "JSON.stringify(window.__probeMouse ?? [])", returnByValue: true },
    sessionId,
  );
  const steps = JSON.parse((declared.result?.value as string) ?? "[]") as Array<{
    x?: number;
    y?: number;
    down?: boolean;
    up?: boolean;
    key?: string;
    /** CDP's bitmask: 1 alt, 2 ctrl, 4 meta, 8 shift. */
    modifiers?: number;
    /** 2 for a double click. Chrome derives word selection from this, not from timing. */
    clickCount?: number;
    label?: string;
  }>;

  for (const [index, step] of steps.entries()) {
    if (step.key !== undefined) {
      const code = VK[step.key];
      const key = {
        key: step.key,
        ...(code === undefined ? {} : { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }),
        // A printable key needs `text` or it inserts nothing; a named key must NOT have
        // it, or Chrome treats "Escape" as five characters of input.
        //
        // **Except under a non-Shift modifier**, where `text` is what turns Ctrl+A back
        // into typing the letter "a": Chrome takes the presence of `text` as "this
        // keystroke produced a character" and inserts it over the selection instead of
        // selecting all. Shift is exempt because Shift+A really does produce a character.
        ...(step.key.length === 1 && ((step.modifiers ?? 0) & ~8) === 0
          ? { text: step.key }
          : {}),
        ...(step.modifiers === undefined ? {} : { modifiers: step.modifiers }),
      };
      await cdp.send("Input.dispatchKeyEvent", { ...key, type: "keyDown" }, sessionId);
      await cdp.send("Input.dispatchKeyEvent", { ...key, type: "keyUp" }, sessionId);
    } else {
      const common = {
        x: step.x,
        y: step.y,
        button: "left",
        clickCount: step.clickCount ?? 1,
        buttons: 0,
        ...(step.modifiers === undefined ? {} : { modifiers: step.modifiers }),
      };
      await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mouseMoved" }, sessionId);
      if (step.down) {
        await cdp.send(
          "Input.dispatchMouseEvent",
          { ...common, type: "mousePressed", buttons: 1 },
          sessionId,
        );
      }
      if (step.up) {
        await cdp.send("Input.dispatchMouseEvent", { ...common, type: "mouseReleased" }, sessionId);
      }
    }
    // One frame, so style resolution has run before the page reads it back. Two
    // `requestAnimationFrame`s rather than one for the reason `_harness.js` already
    // documents: the first is *before* style and layout for the frame.
    //
    // Then tell the page which step just finished. **Only the runner knows where a
    // step boundary is**, and a page trying to infer them cannot: the first version of
    // the select probe watched for changes on every frame and assigned each one to the
    // next label, which slid the whole table by one as soon as a step changed nothing
    // — `Enter to commit` was captioning the row for the click that reopened the
    // picker. A misattributed table is worse than no table, because it reads as a
    // finding. So attribution comes from here, where it is known, rather than from a
    // heuristic there.
    await cdp.send(
      "Runtime.evaluate",
      {
        expression:
          `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))` +
          `.then(() => window.__probeStep && window.__probeStep(${index}))`,
        awaitPromise: true,
      },
      sessionId,
    );
    void name;
  }

  // Hands control back to the page, which knows what it wanted to measure.
  await cdp.send(
    "Runtime.evaluate",
    { expression: "window.__probeMouseDone && window.__probeMouseDone()", awaitPromise: true },
    sessionId,
  );
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

  await driveMouse(cdp, sessionId, name);

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
