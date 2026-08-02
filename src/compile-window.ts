/**
 * `bun run window` — this repository compiling its own demo.
 *
 *   bun run window                 # every window under ./windows
 *   bun run window main            # just that one
 *   bun run window --dump          # also print the IR
 *   bun run window -o out.ts       # divert the artifact, for `characterize`
 *
 * The work is in `compiler/build.ts`; this is the argv in front of it. Kept as a
 * separate entry from `dziri compile` because the harnesses call it by path and
 * because it always compiles *this* repository, whereas the CLI compiles whatever
 * directory it was run in.
 */
import { compileProject, describe, formatBuildError } from "./compiler/build.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));

const outIndex = argv.indexOf("-o");
const outOverride = outIndex !== -1 && argv[outIndex + 1] ? argv[outIndex + 1]! : null;

const only = argv.find((a, i) => !a.startsWith("--") && a !== "-o" && argv[i - 1] !== "-o");

try {
  const compiled = await compileProject({
    projectDir: ROOT,
    only,
    dump: flags.has("--dump"),
    outOverride,
  });
  for (const one of compiled) console.log(describe(one, ROOT));
} catch (e) {
  const message = await formatBuildError(e, ROOT);
  if (message === null) throw e;
  console.error(message);
  process.exit(1);
}
