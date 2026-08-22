/**
 * Dev server for the architecture view.
 *
 *   bun run arch
 *
 * Bun bundles `index.html` and everything it references; `/api/metrics` is
 * recomputed per request, so an edit to the tree is visible on reload without a
 * build step.
 */
import index from "./index.html";
import { collectMetrics } from "./metrics.ts";

const port = Number(process.env.PORT ?? 4321);

const server = Bun.serve({
  port,
  development: true,
  routes: {
    "/": index,
    "/api/metrics": () => Response.json(collectMetrics()),
  },
});

console.log(`architecture view → ${server.url}`);
