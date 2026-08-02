/**
 * Running Tailwind, when a window asked for it.
 *
 * The convention is one file: a window with `in.css` beside its `index.tsx` gets
 * `index.css` generated from it before every compile. A window without one is
 * using plain CSS and nothing runs.
 *
 * It is a convention rather than configuration because the alternative is a config
 * file whose only job is to name two paths that are already determined by where
 * the window lives. `dziri compile --no-css` is the escape hatch when the
 * stylesheet is generated some other way.
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { scanWindows } from "../compiler/routes.ts";
import { dirname } from "node:path";

export type CssResult = { window: string; from: string; to: string };

/**
 * Builds every window's stylesheet. Returns what it built.
 *
 * Throws if the Tailwind CLI is missing while an `in.css` exists, because the
 * alternative is compiling against a stale `index.css` and reporting success —
 * which looks exactly like "my new class did nothing".
 */
export async function buildStylesheets(projectDir: string): Promise<CssResult[]> {
  const built: CssResult[] = [];

  for (const window of scanWindows(projectDir)) {
    const dir = join(projectDir, dirname(window.entry));
    const input = join(dir, "in.css");
    if (!existsSync(input)) continue;

    const output = join(dir, "index.css");
    const proc = Bun.spawn(["bunx", "@tailwindcss/cli", "-i", input, "-o", output], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
      throw new Error(
        `Tailwind failed for window ${window.id} (exit ${code}).\n` +
          `  ${relative(projectDir, input).replaceAll("\\", "/")} -> ` +
          `${relative(projectDir, output).replaceAll("\\", "/")}\n\n` +
          stderr.trim(),
      );
    }

    built.push({
      window: window.id,
      from: relative(projectDir, input).replaceAll("\\", "/"),
      to: relative(projectDir, output).replaceAll("\\", "/"),
    });
  }

  return built;
}
