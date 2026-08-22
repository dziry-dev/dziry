/**
 * Vendors MDN's CSS and HTML prose for offline grep.
 *
 *   bun run mdn:sync            # clone or update guards/vendor/mdn
 *   bun run mdn:sync --status   # what is checked out
 *
 * MDN's content is a public git repo of Markdown with YAML front matter, so a
 * sparse shallow clone of just the CSS and HTML trees is ~30 MB and takes about
 * six seconds. That beats a Dash/Zeal docset on every axis: Markdown instead of
 * HTML, one tenth the size, and pinnable to a commit — and Zeal's own CLI only
 * launches its GUI, so it was never usable from a script anyway.
 *
 * This is for *prose*: edge cases, examples, "note that…". The structured facts
 * (initial value, inherited, syntax) come from the `mdn-data` package, which is
 * what MDN itself renders those tables from — see `spec-audit`.
 *
 * `guards/vendor/mdn` is gitignored. MDN prose is CC-BY-SA; vendoring it into the repo
 * would put a share-alike obligation on a project that does not otherwise carry
 * one, so it stays a local tool.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIR = join(ROOT, "guards", "vendor", "mdn");
const STAMP = join(ROOT, "guards", "vendor", "mdn.json");
const REPO = "https://github.com/mdn/content.git";
const PATHS = ["files/en-us/web/css", "files/en-us/web/html", "LICENSE.md"];

const run = async (args: string[], cwd = DIR) => {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed:\n${err.trim()}`);
  return out.trim();
};

if (process.argv.includes("--status")) {
  if (!existsSync(DIR)) {
    console.log("not synced — run: bun run mdn:sync");
    process.exit(0);
  }
  console.log(await run(["log", "-1", "--format=%h %ad %s", "--date=short"]));
  process.exit(0);
}

if (!existsSync(DIR)) {
  await mkdir(DIR, { recursive: true });
  console.log("cloning mdn/content (sparse, shallow)…");
  // --filter=blob:none + --sparse is what keeps this at ~30 MB instead of gigabytes.
  await run(["clone", "--depth", "1", "--filter=blob:none", "--sparse", REPO, "."]);
  // Windows: MDN has paths longer than 260 chars, and git warns and skips them.
  await run(["config", "core.longpaths", "true"]);
  await run(["sparse-checkout", "set", ...PATHS]);
} else {
  console.log("updating…");
  await run(["fetch", "--depth", "1", "origin", "main"]);
  await run(["reset", "--hard", "origin/main"]);
}

const sha = await run(["rev-parse", "HEAD"]);
const when = await run(["log", "-1", "--format=%cI"]);
await writeFile(STAMP, JSON.stringify({ repo: REPO, commit: sha, committed: when, paths: PATHS }, null, 2) + "\n");

const count = async (sub: string) => {
  const p = Bun.spawn(["git", "ls-files", sub], { cwd: DIR, stdout: "pipe" });
  return (await new Response(p.stdout).text()).split("\n").filter((l) => l.endsWith("index.md")).length;
};

console.log(`  css   ${await count("files/en-us/web/css")} pages`);
console.log(`  html  ${await count("files/en-us/web/html")} pages`);
console.log(`  at    ${sha.slice(0, 9)}  (${when.slice(0, 10)})  -> guards/vendor/mdn.json`);
console.log(`\ngrep it: rg "min-width: auto" guards/vendor/mdn/files/en-us/web/css`);
