/**
 * Visual regression: render each scenario headlessly and compare with a blessed
 * PNG.
 *
 *   bun run golden             # render + compare, exit 1 on any change
 *   bun run golden light       # one scenario
 *   bun run golden --accept    # bless current output
 *   bun run golden --keep      # keep .actual.png even for passing scenarios
 *
 * The pieces for this existed and were never wired together: `app.ts` already
 * renders one frame headlessly and exits, and `--patch/--hover/--focus` already
 * drive state without a window. What was missing was a blessed baseline and a
 * diff, which is the difference between a screenshot tool and a test.
 *
 * This catches the failure class the architecture review keeps naming — a
 * wrong-looking frame rather than a crash — which is the one nobody notices
 * until it ships.
 */
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const GOLDEN = join(ROOT, "golden");

const argv = process.argv.slice(2);
const ACCEPT = argv.includes("--accept");
const KEEP = argv.includes("--keep");
const only = argv.filter((a) => !a.startsWith("--"));

/**
 * `--patch 0,1` flips conditional classes on: 0 is `.light` (paint-only, 46
 * writes) and 1 is `.compact` (relayout, 6 writes). Covering both separately and
 * together is deliberate — together is where a patch-ordering bug would show.
 */
/**
 * What compiles a scenario and what renders it.
 *
 * Two now, because a window is not the single-entry app: it is many modules
 * spliced into one tree by its own driver, and its host picks a route rather than
 * flipping patches.
 */
const TARGETS = {
  app: { build: "src/compile.ts", host: "src/app.ts" },
  window: { build: "src/compile-window.ts", host: "src/window-host.ts" },
} as const;

type Scenario = { name: string; args: string[]; target?: keyof typeof TARGETS };

const SCENARIOS: Scenario[] = [
  { name: "base", args: [] },
  { name: "light", args: ["--patch", "0"] },
  { name: "compact", args: ["--patch", "1"] },
  { name: "light-compact", args: ["--patch", "0,1"] },

  // Routing. `route-home` proves the emitted `hidden` column — four routes are
  // resident and one shows. The other two prove the parent chain: the `products`
  // layout is visible because the active route renders inside it, while its
  // sibling route is not.
  { name: "route-home", args: [], target: "window" },
  { name: "route-nested", args: ["--route", "products/new"], target: "window" },
  { name: "route-param", args: ["--route", "products/$id"], target: "window" },
];

/** IHDR is always the first chunk: width and height are bytes 16..24, big-endian. */
function dimensions(png: Uint8Array): string {
  if (png.length < 24) return "?";
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return `${v.getUint32(16)}x${v.getUint32(20)}`;
}

function firstDifferingByte(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

await mkdir(GOLDEN, { recursive: true });
const list = only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
if (!list.length) {
  console.log(`no such scenario. known: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

// One compile per target, not per scenario — scenarios of a target differ only in
// runtime state, and recompiling per scenario would hide a compile that is itself
// nondeterministic.
for (const name of new Set(list.map((s) => s.target ?? "app"))) {
  const build = Bun.spawn(["bun", "run", TARGETS[name].build], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    console.log(`FAILED to compile ${name}:\n` + (await new Response(build.stderr).text()).trim());
    process.exit(1);
  }
}

let changed = 0;
let broke = 0;
let blessed = 0;

for (const s of list) {
  const tmp = join(tmpdir(), `dziri-golden-${s.name}-${process.pid}.png`);
  const host = TARGETS[s.target ?? "app"].host;
  const proc = Bun.spawn(["bun", "run", host, "--screenshot", tmp, ...s.args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;

  if (code !== 0 || !existsSync(tmp)) {
    broke++;
    const err = (await new Response(proc.stderr).text()).trim() || (await new Response(proc.stdout).text()).trim();
    console.log(`BROKE  ${s.name} — exited ${code}`);
    console.log(err.split("\n").slice(0, 6).map((l) => `       ${l}`).join("\n"));
    continue;
  }

  const actual = new Uint8Array(await readFile(tmp));
  await rm(tmp, { force: true });
  const goldenPath = join(GOLDEN, `${s.name}.png`);
  const actualPath = join(GOLDEN, `${s.name}.actual.png`);

  if (!existsSync(goldenPath)) {
    await writeFile(goldenPath, actual);
    blessed++;
    console.log(`NEW    ${s.name}  ${dimensions(actual)}  ${(actual.length / 1024).toFixed(1)} KiB`);
    continue;
  }

  const golden = new Uint8Array(await readFile(goldenPath));
  const same = golden.length === actual.length && firstDifferingByte(golden, actual) === golden.length;

  if (same) {
    console.log(`ok     ${s.name}  ${dimensions(actual)}`);
    if (KEEP) await writeFile(actualPath, actual);
    else await rm(actualPath, { force: true });
  } else if (ACCEPT) {
    await writeFile(goldenPath, actual);
    await rm(actualPath, { force: true });
    blessed++;
    console.log(`BLESS  ${s.name}`);
  } else {
    changed++;
    await writeFile(actualPath, actual);
    const dimChanged = dimensions(golden) !== dimensions(actual);
    console.log(`DIFF   ${s.name}`);
    console.log(`       expected ${dimensions(golden)} ${(golden.length / 1024).toFixed(1)} KiB`);
    console.log(`       actual   ${dimensions(actual)} ${(actual.length / 1024).toFixed(1)} KiB`);
    console.log(
      dimChanged
        ? "       DIMENSIONS CHANGED — a layout or window-size change, not a paint change"
        : `       same dimensions; first byte differs at ${firstDifferingByte(golden, actual)}`,
    );
    console.log(`       wrote ${join("golden", `${s.name}.actual.png`)} — compare by eye`);
  }
}

console.log("");
if (broke) console.log(`${broke} scenario(s) failed to render`);
if (changed) console.log(`${changed} scenario(s) changed — inspect the .actual.png, then: bun run golden --accept`);
if (blessed) console.log(`${blessed} golden(s) written`);
if (!broke && !changed) console.log("pixels unchanged");
process.exit(broke || changed ? 1 : 0);
