/**
 * Characterization tests for the compiler.
 *
 *   bun run characterize            # compile every case, diff against golden
 *   bun run characterize --accept   # bless current output as the new golden
 *   bun run characterize app        # one case
 *
 * ~4,000 lines of compiler have no unit tests, and the review found bugs there
 * that "ship a wrong artifact and print a success line". Writing correctness
 * tests for all of it is a large job; freezing its *current* output is a small
 * one, and it is what makes M1-M5 refactors safe.
 *
 * This asserts the output does not CHANGE. It does not assert the output is
 * correct — a blessed golden can encode a bug. That is the deliberate trade: an
 * unexpected diff is a question ("did you mean to change this?"), not a verdict.
 *
 * Cases live in `characterize/cases/<name>.{tsx,html}` with a sibling
 * `<name>.css`; `app` is the real application, which exercises the most paths.
 */
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const CASES = join(ROOT, "characterize", "cases");
const GOLDEN = join(ROOT, "characterize", "golden");

const argv = process.argv.slice(2);
const ACCEPT = argv.includes("--accept");
const only = argv.filter((a) => !a.startsWith("--"));

type Case = {
  name: string;
  input: string;
  css: string;
  /**
   * How to compile it, when the single-entry CLI is not the thing under test.
   *
   * A window is many modules spliced into one tree, so it has its own driver — and
   * the part of its output worth freezing is the part the app case cannot have: the
   * `hidden` column and the route table.
   */
  command?: (tmp: string) => string[];
};

async function cases(): Promise<Case[]> {
  const out: Case[] = [];

  // The real application, which is the highest-value case: grid, flex, a keyed
  // list with per-row handlers, conditional classes, derived values, inline
  // styles — and, since it became a window, routes spliced by path prefix with
  // the inactive ones hidden on the first frame.
  if (existsSync(join(ROOT, "windows", "main", "index.tsx"))) {
    out.push({
      name: "window-main",
      input: join(ROOT, "windows", "main", "index.tsx"),
      css: join(ROOT, "windows", "main", "index.css"),
      command: (tmp) => ["bun", "run", "src/compile-window.ts", "main", "-o", tmp],
    });
  }
  if (existsSync(CASES)) {
    for (const f of (await readdir(CASES)).sort()) {
      if (![".tsx", ".jsx", ".html"].includes(extname(f))) continue;
      const name = basename(f, extname(f));
      const css = join(CASES, `${name}.css`);
      out.push({ name, input: join(CASES, f), css: existsSync(css) ? css : join(CASES, "_empty.css") });
    }
  }
  return only.length ? out.filter((c) => only.includes(c.name)) : out;
}

/** First differing region, with a little context. Generated files are long. */
function firstDiff(a: string, b: string, context = 2): string {
  const A = a.split("\n");
  const B = b.split("\n");
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  const from = Math.max(0, i - context);
  const lines: string[] = [];
  for (let k = from; k < i; k++) lines.push(`   ${k + 1}  ${A[k]}`);
  lines.push(`  -${i + 1}  ${A[i] ?? "(end of golden)"}`);
  lines.push(`  +${i + 1}  ${B[i] ?? "(end of output)"}`);
  const tail = Math.abs(A.length - B.length);
  if (tail) lines.push(`  … ${tail} line(s) difference in total length`);
  return lines.join("\n");
}

await mkdir(GOLDEN, { recursive: true });
const list = await cases();
if (!list.length) {
  console.log("no cases");
  process.exit(0);
}

let changed = 0;
let broke = 0;
let blessed = 0;

for (const c of list) {
  const tmp = join(tmpdir(), `dziri-char-${c.name}-${process.pid}.ts`);
  const command = c.command
    ? c.command(tmp)
    : ["bun", "run", "src/compile.ts", c.input, c.css, "-o", tmp];
  const proc = Bun.spawn(command, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;

  if (code !== 0) {
    broke++;
    const err = (await new Response(proc.stderr).text()).trim() || (await new Response(proc.stdout).text()).trim();
    console.log(`BROKE  ${c.name}  — compiler exited ${code}`);
    console.log(
      err
        .split("\n")
        .slice(0, 8)
        .map((l) => `       ${l}`)
        .join("\n"),
    );
    continue;
  }

  const output = await readFile(tmp, "utf8");
  await rm(tmp, { force: true });
  const goldenPath = join(GOLDEN, `${c.name}.gen.ts`);

  if (!existsSync(goldenPath)) {
    await writeFile(goldenPath, output);
    blessed++;
    console.log(`NEW    ${c.name}  — golden created (${output.split("\n").length} lines)`);
    continue;
  }

  const golden = await readFile(goldenPath, "utf8");
  if (golden === output) {
    console.log(`ok     ${c.name}`);
  } else if (ACCEPT) {
    await writeFile(goldenPath, output);
    blessed++;
    console.log(`BLESS  ${c.name}  — golden updated`);
  } else {
    changed++;
    console.log(`DIFF   ${c.name}`);
    console.log(firstDiff(golden, output));
  }
}

console.log("");
if (broke) console.log(`${broke} case(s) failed to compile`);
if (changed) console.log(`${changed} case(s) changed — review, then: bun run characterize --accept`);
if (blessed) console.log(`${blessed} golden(s) written`);
if (!broke && !changed) console.log("compiler output unchanged");
process.exit(broke || changed ? 1 : 0);
