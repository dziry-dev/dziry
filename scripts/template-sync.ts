/**
 * Keeps `create-dziri`'s template equal to the demo this repository develops
 * against.
 *
 *   bun run template:sync     copy windows/ into the template
 *   bun run template:check    fail if they have drifted
 *
 * # Why a copy rather than one directory used twice
 *
 * The scaffold has to ship the window sources inside its own npm package — a
 * published `create-dziri` cannot reach back into this repository. So there are
 * necessarily two copies, and the only question is whether the second one is
 * *derived* or maintained by hand. Derived: a template edited by hand rots
 * silently, and the failure is a scaffolded app that does not compile against the
 * framework it was scaffolded by. The check is what makes the copy honest, and it
 * belongs beside `characterize` in the same spirit.
 *
 * Generated artifacts are excluded. `ui.gen.ts`, `windows.gen.ts` and
 * `entry.gen.ts` are compiler output, and shipping them would mean a new project
 * starting life with someone else's stale IR in it — `dziri dev` writes all three
 * on the first run.
 */
import { Glob } from "bun";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SOURCE = join(ROOT, "windows");
const TARGET = join(ROOT, "packages", "create-dziri", "template", "windows");

const check = process.argv.includes("--check");

/**
 * What does not travel.
 *
 * `*.gen.ts` is compiler output — shipping it would mean a new project starting
 * life with someone else's stale IR in it, and `dziri dev` writes all three on the
 * first run.
 *
 * A window's own `README.md` is about *this* repository's demo: it talks about
 * coverage numbers having something to point at, and about which harness prints
 * which warning. The template has its own README aimed at somebody who just ran
 * `bun create`.
 */
function isExcluded(path: string): boolean {
  return path.endsWith(".gen.ts") || /(^|[\\/])README\.md$/.test(path);
}

async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const file of new Glob("**/*").scan({ cwd: SOURCE, onlyFiles: true })) {
    if (!isExcluded(file)) out.push(file.replaceAll("\\", "/"));
  }
  return out.sort();
}

async function targetFiles(): Promise<string[]> {
  if (!existsSync(TARGET)) return [];
  const out: string[] = [];
  for await (const file of new Glob("**/*").scan({ cwd: TARGET, onlyFiles: true })) {
    out.push(file.replaceAll("\\", "/"));
  }
  return out.sort();
}

const from = await sourceFiles();
const to = await targetFiles();

const drift: string[] = [];

for (const file of from) {
  const source = await Bun.file(join(SOURCE, file)).text();
  const destPath = join(TARGET, file);
  const current = existsSync(destPath) ? await Bun.file(destPath).text() : null;

  if (current === source) continue;

  drift.push(current === null ? `+ ${file}` : `~ ${file}`);
  if (!check) {
    mkdirSync(dirname(destPath), { recursive: true });
    await Bun.write(destPath, source);
  }
}

for (const file of to) {
  if (from.includes(file)) continue;
  drift.push(`- ${file}`);
  if (!check) rmSync(join(TARGET, file));
}

const where = relative(ROOT, TARGET).replaceAll("\\", "/");

if (drift.length === 0) {
  console.log(`template matches windows/ — ${from.length} file(s)`);
  process.exit(0);
}

for (const line of drift) console.log(`  ${line}`);

if (check) {
  console.error(
    `\n${drift.length} file(s) differ between windows/ and ${where}.\n` +
      `  Run \`bun run template:sync\`. The template is derived, not authored.`,
  );
  process.exit(1);
}

console.log(`\nsynced ${drift.length} file(s) into ${where}`);
