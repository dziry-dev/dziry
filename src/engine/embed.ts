/**
 * The engine, carried inside a standalone binary and unpacked on first run.
 *
 * `bun build --compile` can embed a file, but what it hands back at run time is a
 * path into Bun's virtual filesystem — `B:/~BUN/root/dziry_engine-*.dll` on
 * Windows. That is not a file any loader can open: measured, `dlopen` on it fails,
 * and on macOS code signing needs a real path too. So the bytes are written out
 * once, to a cache directory, and the loader is pointed at the copy.
 *
 * The copy is keyed by a hash the *build* computed, not one taken here. Two
 * reasons. Hashing 18 MB on every launch would be ~20 ms of startup spent
 * confirming something the build already knew; and keying on anything cheaper —
 * byte length, a version string — cannot tell two engines of the same size apart,
 * which is exactly the case that produces a schema mismatch nobody can explain.
 *
 * Extraction is skipped when a file of the right size is already there. Not "of
 * the right hash": the path *contains* the hash, so a file at that path with that
 * length is the file, and re-reading 18 MB to prove it would give the startup cost
 * back.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { libraryName, useEngineLibrary } from "./host.ts";

/**
 * Where unpacked engines live.
 *
 * Per-user rather than beside the executable: an app installed into Program Files
 * or /Applications cannot write next to itself, and a per-user cache is what every
 * other single-file runtime does for the same reason.
 */
function cacheRoot(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "dziry", "engine");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "dziry", "engine");
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "dziry",
    "engine",
  );
}

/**
 * Unpacks the embedded engine if needed and tells the loader where it went.
 *
 * Call before the first `Engine.open`. The generated build entry does exactly
 * that, and nothing else, before importing the app.
 */
export async function useEmbeddedEngine(embedded: string, hash: string): Promise<string> {
  const source = Bun.file(embedded);
  const dir = join(cacheRoot(), hash);
  const dest = join(dir, libraryName());

  if (!existsSync(dest) || statSync(dest).size !== source.size) {
    mkdirSync(dir, { recursive: true });

    /* Written beside the target and renamed, so two copies of the app starting at
       once cannot leave a half-written library for the other to `dlopen`. The
       rename is atomic when both paths share a directory, which is why the
       temporary is here rather than in the system temp dir.

       On Windows a rename over an existing file fails, and an existing file here
       means another process won the race — in which case its copy is the same
       bytes and dropping ours is the right move. */
    const partial = join(dir, `.${process.pid}-${libraryName()}`);
    await Bun.write(partial, source);
    try {
      renameSync(partial, dest);
    } catch {
      if (!existsSync(dest)) throw new Error(`could not unpack the dziry engine to ${dest}`);
    } finally {
      try {
        rmSync(partial, { force: true });
      } catch {
        /* Already renamed away, which is the happy path. */
      }
    }
  }

  useEngineLibrary(dest);
  return dest;
}

/** Where a given engine build would be unpacked. For diagnostics. */
export function cachePathFor(hash: string): string {
  return join(cacheRoot(), hash, libraryName());
}
