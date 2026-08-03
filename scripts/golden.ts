/**
 * Visual regression: render each scenario headlessly and compare with a blessed
 * PNG.
 *
 *   bun run golden             # render + compare, exit 1 on any change
 *   bun run golden light       # one scenario
 *   bun run golden --accept    # bless current output
 *   bun run golden --keep      # keep .actual.png even for passing scenarios
 *
 * The pieces for this existed and were never wired together: the host already
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

type Scenario = { name: string; args: string[] };

/**
 * `--patch light,compact` flips conditional classes on by name: `light` is
 * paint-only and `compact` forces a relayout. Covering both separately and together
 * is deliberate — together is where a patch-ordering bug would show.
 *
 * The route scenarios cover what the patch ones cannot. `base` is the home route
 * with five routes resident and hidden, so it already proves the emitted `hidden`
 * column; `route-nested` and `route-param` prove the parent chain, where the
 * `products` layout stays visible because the active route renders inside it while
 * its sibling does not.
 */
const SCENARIOS: Scenario[] = [
  { name: "base", args: [] },

  // The utility families. Real Tailwind output through the compiler, so a
  // regression in the cascade, in oklch conversion, or in one property shows up as
  // pixels rather than as a coverage number nobody re-derives.
  { name: "layout", args: ["--route", "layout"] },
  { name: "spacing", args: ["--route", "spacing"] },
  { name: "typography", args: ["--route", "typography"] },
  { name: "colors", args: ["--route", "colors"] },
  { name: "borders", args: ["--route", "borders"] },

  // The framework's own features, and the two conditional classes: `light`
  // (paint-only) and `compact` (relayout). Covering them separately and together
  // is deliberate — together is where a patch-ordering bug would show. They need
  // the route that carries them, since it is not the one the window opens on.
  { name: "features", args: ["--route", "features"] },
  { name: "features-light", args: ["--route", "features", "--patch", "light"] },
  { name: "features-compact", args: ["--route", "features", "--patch", "compact"] },
  { name: "features-light-compact", args: ["--route", "features", "--patch", "light,compact"] },

  // Nesting and parameters: the `products` layout stays visible because the active
  // route renders inside it, while its sibling does not.
  { name: "route-nested", args: ["--route", "products/new"] },
  { name: "route-param", args: ["--route", "products/$id"] },

  // Hover, which is a predicate bit and an escaped selector — and which was
  // silently dropped for every Tailwind `hover:` utility until `@media (hover:
  // hover)` stopped being skipped.
  { name: "hover-nav", args: ["--hover", "11"] },

  /**
   * `transform` and `opacity`, which are the only styles here that change *what
   * the matrix is* rather than what gets filled — so a regression in them is
   * invisible to every other scenario.
   *
   * Tall enough for the whole page on purpose. Each block is a different way to
   * be wrong: the origin block is four identical rotations that must land in four
   * different places, and the opacity block must fade each label *with* its box
   * rather than separately, which is the difference between a layer and a
   * per-draw alpha.
   */
  { name: "transforms", args: ["--route", "transforms", "--size", "1040x1500"] },

  /**
   * A transform that lives in a variant slot, which nothing else covers.
   *
   * Node 900 is the `hover:scale-110` button. It matters because the transform is
   * only reachable through the *resolved* style — and because hit-testing has to
   * agree, or the pointer leaves the box the moment it grows.
   *
   * Same tall size as above, and not incidentally: that button is near the bottom
   * of the page, so at the default 700px the scenario captured only the header and
   * proved nothing.
   */
  {
    name: "transform-hover",
    args: ["--route", "transforms", "--hover", "900", "--size", "1040x1500"],
  },

  /**
   * Transitions and `@keyframes`, sampled at an exact `t`.
   *
   * **`--advance` is not optional on this route, it is what makes a golden possible.**
   * `tick()` normally reads the wall clock, so a plain screenshot of an animating page
   * is a different fraction of the way through on every run — the scenario would be
   * flaky in the one way a visual test must not be. `--advance` fixes the frame length
   * instead, so `0.25` means exactly a quarter of a second and the picture is the same
   * picture forever.
   *
   * Three samples, because each covers something the others cannot:
   *
   *   - `0` is every animation at its first keyframe and every transition at rest. It
   *     is the frame that would be *wrong* if the implicit `from` of a `@keyframes`
   *     with no `0%` were a synthesised value rather than the element's own row —
   *     `animate-spin` and `animate-ping` are both that shape.
   *   - `0.25` has all four of Tailwind's animations and both hand-written `drift`
   *     boxes mid-flight, at four different durations and on five different curves.
   *     A wrong bezier solve, a wrong segment boundary or a mask that lost a field
   *     all move a box here.
   *   - the hover one is a transition caught *halfway*: 150 ms of a 300 ms
   *     `transition-colors`, which is the frame no other scenario can produce. Node
   *     72 is the `scale-110` button in the transform block, chosen because a
   *     transform in a variant slot is only reachable through the resolved style and
   *     hit-testing has to follow it.
   */
  { name: "animations", args: ["--route", "animations", "--size", "1040x1700", "--advance", "0"] },
  {
    name: "animations-quarter",
    args: ["--route", "animations", "--size", "1040x1700", "--advance", "0.25"],
  },
  {
    name: "animation-hover",
    args: ["--route", "animations", "--size", "1040x1700", "--hover", "72", "--advance", "0.15"],
  },

  /**
   * Form controls, at rest and after a real press.
   *
   * The route had no golden at all until controls became interactive, which is worth
   * naming rather than quietly fixing: while every control was frozen in its authored
   * state there was nothing here a `--patch` scenario did not already cover. Three
   * pictures now, and each one covers something no other scenario can.
   *
   * **`--click` is not `--hover` with a different verb.** `--hover` *declares* an input
   * state; `--click` runs the press — hit-testing, the disabled swallow, a label
   * forwarding to the box beside it, and the activation behaviour itself. Every one of
   * those is a place the feature can fail while every predicate still resolves
   * correctly, and none of them is reachable by asserting the state a click would have
   * left behind.
   *
   *   - `controls` is the resting page: `:checked` and `:disabled` live from the
   *     authored attributes, which is the *seed* rather than a fixed style.
   *   - `controls-checked` presses node 264 — the **text** "unchecked", not the 18px
   *     box. It is the label-forwarding case, and it is the one the pointer actually
   *     hits most of the time. It fails if `activates` stops propagating to a label's
   *     descendants, or if `buildInteractive` stops marking a node that operates a
   *     control, which would leave `hit_test` walking straight past the span.
   *   - `controls-radio` presses node 282 ("free"), which must check it *and clear*
   *     "pro". Without the group clear both would be filled and the picture would look
   *     like two checkboxes — a wrong frame that a per-control test cannot produce.
   *
   * Node ids rather than coordinates, as the hover scenarios above already do, so the
   * scenario keeps pointing at the thing it names when the layout moves. They still
   * shift if the *page* gains elements before them, which is what blessing a golden is
   * for.
   */
  { name: "controls", args: ["--route", "controls", "--size", "1040x1400"] },
  {
    name: "controls-checked",
    args: ["--route", "controls", "--size", "1040x1400", "--click", "264"],
  },
  {
    name: "controls-radio",
    args: ["--route", "controls", "--size", "1040x1400", "--click", "282"],
  },

  /**
   * The reactive rewrite, rendered.
   *
   * Every value on this page is derived from one signal through an operator that a
   * bare signal used to break — `*`, `>`, `===`, a ternary, a template literal. The
   * page reads `true` beside `tick === 3` and `odd` beside the ternary, so a
   * regression in the rewrite shows up as text rather than as a passing build. Taller
   * than the rest because the point is the whole list.
   */
  { name: "reactivity", args: ["--route", "reactivity", "--size", "1040x1400"] },
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

// One compile for all scenarios — they differ only in runtime state, and
// recompiling per scenario would hide a compile that is itself nondeterministic.
const build = Bun.spawn(["bun", "run", "src/compile-window.ts"], {
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
});
if ((await build.exited) !== 0) {
  console.log("FAILED to compile:\n" + (await new Response(build.stderr).text()).trim());
  process.exit(1);
}

let changed = 0;
let broke = 0;
let blessed = 0;

for (const s of list) {
  const tmp = join(tmpdir(), `dziri-golden-${s.name}-${process.pid}.png`);
  // The generated entry, which is what `dziri dev` and `dziri build` both run —
  // so a golden proves the app, not a second way of starting it.
  const proc = Bun.spawn(["bun", "run", "windows/entry.gen.ts", "--screenshot", tmp, ...s.args], {
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
