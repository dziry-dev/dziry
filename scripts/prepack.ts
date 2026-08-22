/**
 * `npm pack` / `npm publish` lifecycle: stage the engine binary into `native/`.
 *
 * The published package carries `native/<platform>-<arch>/<library>` — the second
 * candidate in `host.ts::libraryPath`'s search — so a consumer's `bun install`
 * needs no Rust toolchain. This script builds the release engine and copies it
 * there for the platform it runs on; a multi-platform release is this script run
 * once per CI runner, each contributing its own directory.
 *
 * It also empties the directory first: `native/` is gitignored and once held the
 * deleted TS-runtime era's DLLs (SDL3, libSkiaSharp, taffy_ffi) — stale binaries
 * that must never ride into a tarball.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { libraryName } from "../src/engine/host.ts";

const repo = join(import.meta.dir, "..");
const name = libraryName();
const built = join(repo, "native-src", "dziry-engine", "target", "release", name);
const dest = join(repo, "native", `${process.platform}-${process.arch}`);

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

if (existsSync(dest)) {
  for (const stale of readdirSync(dest)) rmSync(join(dest, stale), { force: true });
} else {
  mkdirSync(dest, { recursive: true });
}
copyFileSync(built, join(dest, name));
console.log(`staged ${name} -> native/${process.platform}-${process.arch}/`);
