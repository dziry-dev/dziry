/**
 * Stage this platform's `dziry-engine-*` npm package.
 *
 * Each release ships the engine as one tiny package per platform —
 * `dziry-engine-win32-x64`, `dziry-engine-darwin-arm64`, … — which `dziry`
 * lists as `optionalDependencies`, so an installer keeps only the one whose
 * `os`/`cpu` match. This script builds the release engine and lays out a
 * publishable directory at `dist/engine-packages/<name>/`; the release
 * workflow runs it once per platform runner and `npm publish`es the result.
 *
 * The staged package carries no JavaScript: `host.ts::enginePackagePath`
 * resolves its `package.json` and opens the binary sitting next to it, which
 * is also why the manifest must not have an `exports` field — one would make
 * the manifest itself unresolvable.
 */
import { existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { libraryName } from "../src/engine/host.ts";

const repo = join(import.meta.dir, "..");
const root = await Bun.file(join(repo, "package.json")).json();
// "windows", not Node's "win32": npm's spam heuristic permanently rejected the
// name dziry-engine-win32-x64 (the other four landed), and the name is
// internal plumbing anyway. host.ts::enginePackagePath maps the same way.
const platformTag = process.platform === "win32" ? "windows" : process.platform;
const name = `dziry-engine-${platformTag}-${process.arch}`;
const binary = libraryName();
const built = join(repo, "native-src", "dziry-engine", "target", "release", binary);
const dest = join(repo, "dist", "engine-packages", name);

const build = Bun.spawnSync(["cargo", "build", "--release"], {
  cwd: join(repo, "native-src", "dziry-engine"),
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  console.error("  error: cargo build --release failed; nothing staged.");
  process.exit(1);
}
if (!existsSync(built)) {
  console.error(`  error: cargo succeeded but ${built} does not exist.`);
  process.exit(1);
}

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const manifest = {
  name,
  version: root.version,
  description:
    `The dziry native engine (SDL3 + Skia + Taffy), prebuilt for ` +
    `${process.platform}-${process.arch}. Installed automatically as an ` +
    `optional dependency of dziry — not something to depend on directly.`,
  license: root.license,
  homepage: root.homepage,
  repository: root.repository,
  bugs: root.bugs,
  os: [process.platform],
  cpu: [process.arch],
  files: [binary],
};

copyFileSync(built, join(dest, binary));
copyFileSync(join(repo, "LICENSE"), join(dest, "LICENSE"));
await Bun.write(join(dest, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
await Bun.write(
  join(dest, "README.md"),
  `# ${name}\n\n` +
    `The [dziry](https://dziry.dev) native engine, prebuilt for ` +
    `\`${process.platform}-${process.arch}\`.\n\n` +
    `This package is installed automatically as an optional dependency of ` +
    `[\`dziry\`](https://www.npmjs.com/package/dziry) — there is no reason to ` +
    `depend on it directly.\n`,
);

console.log(`staged ${name}@${root.version} -> dist/engine-packages/${name}/`);
