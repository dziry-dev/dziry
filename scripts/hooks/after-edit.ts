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
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

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

/**
 * One rule, and the list shrank to it twice.
 *
 * The test a check has to pass to live here: **can it be red simply because the
 * work is not finished yet?** If so it does not belong in a hook, because a hook
 * fires on intermediate states and an agent halfway through a change is producing
 * intermediate states on purpose.
 *
 * Three failed that test, each in the same way and each discovered by it firing
 * for real rather than by reasoning:
 *
 *  - `characterize` compiles the sample app. The first thing this hook ever caught
 *    was a half-written `var()` change referencing `EMPTY_VARS` a few lines above
 *    where it was about to be defined. The report was true and the "bug" fixed
 *    itself a minute later when the edit was finished.
 *  - `protocol-guard` is red after any `schema.ts` edit until `gen:protocol` runs.
 *    That is not a bug being caught, it is the second half of a two-step edit.
 *  - the engine-staleness note is red after any `.rs` edit until `cargo build`.
 *    During Rust work that is every single edit.
 *
 * All three are still worth running — their skills say when, and that is enough.
 * `golden` and `layout-diff` are the ones that actually care whether the engine
 * binary is current, so that check belongs at the top of those tools rather than
 * on the keystroke that made it briefly untrue.
 *
 * `doc-lint` survives because its failures are not a function of being unfinished:
 * a citation points at code that already exists, so breaking one means the code
 * moved, which is true whether you are halfway or done.
 */
const RULES: Rule[] = [
  // doc-lint walks the whole tree including `.claude`, so any .md can rot.
  { when: /\.md$/, run: ["doc-lint"] },
];

const tools = [...new Set(RULES.filter((r) => r.when.test(rel)).flatMap((r) => r.run))];

if (tools.length === 0) bail();

const failures: string[] = [];
for (const tool of tools) {
  const p = Bun.spawnSync(["bun", "run", tool], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    const out = [p.stdout.toString(), p.stderr.toString()].join("").trim();
    failures.push(`\`bun run ${tool}\` failed after editing ${rel}:\n${out}`);
  }
}

if (failures.length === 0) process.exit(0);

// Exit 2 is Claude Code's "feed stderr back to the model" channel.
for (const f of failures) console.error(f);
process.exit(2);
