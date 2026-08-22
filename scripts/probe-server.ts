/**
 * Static server for `guards/probes/` — the browser oracle's page host.
 *
 * `file://` is blocked for the Chrome extension and top-level `data:` navigation
 * is blocked by Chrome itself, so a probe needs a real http origin. This is that
 * origin, and nothing more: no bundling, no transform, no cache.
 *
 * A probe served here gets a clean document — no host page's stylesheet leaking
 * into a cascade or layout measurement, which is the whole reason this exists
 * rather than injecting into a live page.
 *
 *   bun run scripts/probe-server.ts          # serves guards/probes/ on :7391
 *   bun run scripts/probe-server.ts --port 0 # ephemeral port, printed
 *
 * `scripts/probe.ts` imports `startProbeServer` rather than spawning this, so a
 * probe run is one process. A1's Tailwind conformance harness wants the same
 * host, so this stays a plain file server with nothing probe-specific in it.
 */
import { file } from "bun";
import { readdir } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

export const PROBE_ROOT = join(import.meta.dir, "..", "guards", "probes");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// No-store on everything: a probe edited between runs must not be served stale,
// and that failure mode looks exactly like "the engine changed its behaviour".
const NO_CACHE = { "cache-control": "no-store, no-cache, must-revalidate" };

export function startProbeServer(port = 7391) {
  return Bun.serve({
    port,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);

      if (path === "/") {
        const names = (await readdir(PROBE_ROOT))
          .filter((n) => n.endsWith(".html"))
          .sort();
        const body =
          `<!doctype html><meta charset=utf-8><title>probes</title>` +
          `<style>body{font:13px ui-monospace,monospace;padding:24px}a{display:block;padding:2px 0}</style>` +
          `<h3>guards/probes/</h3>` +
          names.map((n) => `<a href="/${n}">${n}</a>`).join("");
        return new Response(body, {
          headers: { ...NO_CACHE, "content-type": TYPES[".html"]! },
        });
      }

      // normalize() collapses `..` so a probe cannot read outside guards/probes/.
      const rel = normalize(path).replace(/^([/\\])+/, "");
      const target = join(PROBE_ROOT, rel);
      if (!target.startsWith(PROBE_ROOT)) return new Response("no", { status: 403 });

      const f = file(target);
      if (!(await f.exists()))
        return new Response("not found", { status: 404, headers: NO_CACHE });

      const type = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
      return new Response(f, { headers: { ...NO_CACHE, "content-type": type } });
    },
  });
}

if (import.meta.main) {
  const i = process.argv.indexOf("--port");
  const s = startProbeServer(i > -1 ? Number(process.argv[i + 1]) : 7391);
  console.log(`probes  http://localhost:${s.port}/`);
}
