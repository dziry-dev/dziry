/**
 * PostToolUse dispatcher: run the verification tool that the edited file implies.
 *
 * The 14 tools in `scripts/` each document, in their `SKILL.md`, exactly when they
 * apply — "after any edit to `src/protocol/schema.ts`", "after changing anything in
 * paint.rs, layout.rs or text.rs". Until now that trigger depended on whoever was
 * editing having read the skill and remembered. This makes it unconditional.
 *
 * Reads Claude Code's hook payload on stdin, resolves the edited path, and runs the
 * matching tools. Exit 2 hands stderr back to the model as blocking feedback, which
 * is the whole point: the failure arrives attached to the edit that caused it,
 * rather than hours later when someone runs the tool by hand.
 *
 * **Only fast tools belong here.** Measured 2026-08-01: protocol-guard 628ms,
 * spec-audit 466ms, doc-lint 694ms, characterize 687ms. Worst case below is ~1.2s.
 * `conformance` (5s) and the Chrome-driven `layout-diff` / `html-coverage` (far
 * more) are deliberately absent — a hook people wait on is a hook people disable,
 * and those belong in CI or a hand-run check.
 *
 * **Why `.rs` edits do not run `golden` or `layout-diff`.** Both measure the
 * *compiled* engine, not the source. Running them straight after a Rust edit reports
 * the state of the last build, which is worse than reporting nothing: on 2026-08-01
 * `layout-diff` reported a `w 424 vs 400` box-sizing divergence that `layout.rs` had
 * already fixed, and the stale `.dll` was the reason. So a Rust edit gets a staleness
 * warning instead — instant, and it names the trap directly.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const ENGINE_SRC = join(ROOT, "native-src", "dziri-engine", "src");
const ENGINE_DLL = join(ROOT, "native-src", "dziri-engine", "target", "release", "dziri_engine.dll");

/** A hook that throws is a hook that blocks every edit, so nothing here may throw. */
function bail(): never {
  process.exit(0);
}

const payload = await (async () => {
  try {
    return JSON.parse((await Bun.stdin.text()) || "{}");
  } catch {
    bail();
  }
})();

/**
 * Belt and braces, because `matcher` alone does not filter.
 *
 * Measured 2026-08-01 by logging `tool_name` on every invocation: with only
 * `"matcher": "Edit|Write"` in settings.json this hook was spawned for a plain
 * `Bash` call too. Adding `"if": "Edit"` / `"if": "Write"` to the hook entries
 * fixed that — 6 subsequent firings, all `Edit`, no `Bash` — and `if` is the
 * documented way to avoid spawning at all, which matters because the spawn costs
 * ~320ms of Bun startup and would otherwise be charged to *every* tool call.
 *
 * The guard stays anyway. `Read`'s payload also carries a `file_path`, so if `if`
 * is ever dropped from the config, reading a file under `src/compiler/` would
 * silently start running `characterize`. Cheap insurance, and it keeps the script
 * correct on its own terms rather than depending on the config being right.
 */
const EDITING_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
if (!EDITING_TOOLS.test(String(payload?.tool_name ?? ""))) bail();

const raw: unknown = payload?.tool_response?.filePath ?? payload?.tool_input?.file_path;
if (typeof raw !== "string" || raw.length === 0) bail();

// Repo-relative, forward-slashed, so one set of patterns works on Windows too.
const rel = relative(ROOT, resolve(raw)).split(sep).join("/");
// `..` means the edit landed outside the repo — a scratchpad file, most often.
if (rel.length === 0 || rel.startsWith("..")) bail();

type Rule = { when: RegExp; run: string[] };

const RULES: Rule[] = [
  // The symptom this catches is Rust failing to find a constant that plainly
  // exists in schema.ts, which is otherwise a genuinely confusing hour.
  { when: /^src\/protocol\/schema\.ts$/, run: ["protocol-guard"] },
  // STYLE_FIELDS lives here, and changing it changes every compiled module.
  //
  // `spec-audit` belongs on this line too and is deliberately not on it: it exits
  // non-zero today on a known, already-written-up border divergence (`borderColor`
  // initial: spec `currentcolor`, dziri 0). Wiring a tool whose baseline is red
  // means the first edit anyone makes to ir.ts is blocked by something they did not
  // do, and the hook gets switched off that afternoon. A tool becomes hookable the
  // day it can distinguish a new failure from a known one -- which is the argument
  // for the known-divergence ledger, not a reason to lower the bar here.
  { when: /^src\/ir\.ts$/, run: ["characterize"] },
  { when: /^src\/compiler\//, run: ["characterize"] },
  // doc-lint walks the whole tree including `.claude`, so any .md can rot.
  { when: /\.md$/, run: ["doc-lint"] },
];

const tools = [...new Set(RULES.filter((r) => r.when.test(rel)).flatMap((r) => r.run))];

/** Newest mtime under the engine's `src/`, or 0 if it cannot be read. */
function newestRustMtime(dir: string): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestRustMtime(p));
    else if (e.name.endsWith(".rs")) {
      try {
        newest = Math.max(newest, statSync(p).mtimeMs);
      } catch {
        /* raced with a write; not worth failing an edit over */
      }
    }
  }
  return newest;
}

const notes: string[] = [];

if (/^native-src\/.*\.rs$/.test(rel)) {
  if (!existsSync(ENGINE_DLL)) {
    notes.push(
      "engine is not built — `golden`, `layout-diff` and `boundary-diff --live` cannot run.\n" +
        "  Run `bun run engine`.",
    );
  } else if (newestRustMtime(ENGINE_SRC) > statSync(ENGINE_DLL).mtimeMs) {
    notes.push(
      "engine binary is older than its Rust source. `golden` and `layout-diff` load the\n" +
        "  compiled engine, so until you run `bun run engine` they measure the previous\n" +
        "  build — which reads as a real divergence and is not one.",
    );
  }
}

const failures: string[] = [];
for (const tool of tools) {
  const p = Bun.spawnSync(["bun", "run", tool], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    const out = [p.stdout.toString(), p.stderr.toString()].join("").trim();
    failures.push(`\`bun run ${tool}\` failed after editing ${rel}:\n${out}`);
  }
}

if (failures.length === 0 && notes.length === 0) process.exit(0);

// Exit 2 is Claude Code's "feed stderr back to the model" channel.
for (const n of notes) console.error(`${rel}: ${n}`);
for (const f of failures) console.error(f);
process.exit(2);
