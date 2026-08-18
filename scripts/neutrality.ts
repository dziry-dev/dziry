/**
 * Did this change alter the output? Compares against a frame you took yourself,
 * minutes ago, rather than against a reference committed to the repo.
 *
 *   bun run neutral --save             # record what the tree produces right now
 *   bun run neutral                    # produce it again and compare
 *   bun run neutral --save --label pre-matcher
 *   bun run neutral --artifacts        # skip rendering; compare emitted IR only (fast)
 *
 * `golden` cannot answer this question, and the difference is not a detail. Its
 * references are PNGs in the repo, so they are a claim about *the demo* — which means
 * a deliberate demo edit turns all 22 red and destroys the signal a refactor needs,
 * and getting the signal back first requires deciding, by eye, whether 22 changed
 * frames are a fix or a regression. That ordering is backwards: proving a refactor
 * changed nothing should not depend on the demo having been frozen, and it should not
 * require blessing anything.
 *
 * Here both sides render the same working tree, so the demo can be anything at all.
 * What it compares:
 *
 *   * every scenario in `lib/scenarios.ts`, as PNG bytes — what the engine draws
 *   * the emitted artifacts, as text — what the compiler actually produced. The
 *     stronger of the two: it is upstream of the pixels, a diff in it is readable,
 *     and it catches a changed style id that happens to paint the same.
 *
 * It also records what the tree looked like when the baseline was taken, and uses
 * that to say what a difference *means* rather than only that there is one. A demo
 * edit and a compiler edit produce the same red output and want opposite responses.
 *
 * What it does *not* do, stated here because a green run reads stronger than it is:
 * this compares output, so its reach is whatever the scenarios happen to exercise.
 * Measured, not supposed — deleting the re-insertion in `collectDecls` leaves all 22
 * frames and all 3 artifacts byte-identical and fails two unit tests, because the demo
 * never authors a shorthand that outranks a longhand it already set. `bun test` is the
 * other half and neither replaces the other.
 *
 * This is the harness that was being hand-rolled — screenshots into a temp
 * directory, `md5sum` by hand, once per candidate — throughout the refactor that
 * prompted writing it.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SCENARIOS } from "./lib/scenarios.ts";
import { compileSnippet } from "../src/compiler/single.ts";
import { emit } from "../src/compiler/compile.ts";

const ROOT = join(import.meta.dir, "..");
const BASE = join(ROOT, ".baseline");
const RENDERS = join(BASE, "renders");
const ARTIFACTS = join(BASE, "artifacts");
const MANIFEST = join(BASE, "manifest.json");

const argv = process.argv.slice(2);
const SAVE = argv.includes("--save");
const ARTIFACTS_ONLY = argv.includes("--artifacts");
const labelIdx = argv.indexOf("--label");
const LABEL = labelIdx > -1 ? argv[labelIdx + 1]! : "";

type Manifest = {
  label: string;
  savedAt: string;
  head: string;
  /** `windows/**` minus generated output — the demo as authored. */
  demoHash: string;
  /** `src/**` and the engine's Rust — everything that decides what the demo becomes. */
  codeHash: string;
};

/**
 * Which trees decide the answer, split by who is to blame for a difference.
 *
 * The split is the whole point of recording them. A changed demo and a changed
 * compiler both make every scenario differ, and the correct response to each is the
 * opposite of the other: one means re-bless the goldens, the other means the change
 * is not neutral and needs looking at.
 *
 * Generated files are excluded because they are the output, not the input — hashing
 * `ui.gen.ts` would report the compiler's own product as a cause of its changing.
 */
const TREES = {
  demo: { roots: ["windows"], skip: [/\.gen\.ts$/, /\.png$/] },
  code: {
    roots: ["src", "native-src/dziri-engine/src"],
    skip: [/\.gen\.ts$/, /\.test\.ts$/, /\.test\.tsx$/],
  },
} as const;

async function hashTree(roots: readonly string[], skip: readonly RegExp[]): Promise<string> {
  const files: string[] = [];
  for (const root of roots) {
    const dir = join(ROOT, root);
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const abs = join(entry.parentPath, entry.name);
      const rel = relative(ROOT, abs).replaceAll("\\", "/");
      if (skip.some((re) => re.test(rel))) continue;
      files.push(rel);
    }
  }
  // Sorted, so the hash is about content and not about directory iteration order.
  files.sort();
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update(await readFile(join(ROOT, rel)));
  }
  return h.digest("hex").slice(0, 12);
}

function gitHead(): string {
  const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT });
  return p.exitCode === 0 ? p.stdout.toString().trim() : "(no git)";
}

/** One compile for every scenario, exactly as `golden` does it — see the note there. */
async function compileWindow(): Promise<void> {
  const build = Bun.spawn(["bun", "run", "src/compile-window.ts"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    console.log("FAILED to compile:\n" + (await new Response(build.stderr).text()).trim());
    process.exit(1);
  }
}

/**
 * Where artifacts are always emitted, whichever half of the comparison is running.
 *
 * Fixed, and that is load-bearing rather than tidy. An emitted module imports the
 * app's state module by a specifier *relative to its own location*, so emitting the
 * baseline into `.baseline/artifacts/` and the comparison into a temp directory makes
 * every artifact differ on that one line — a diff about paths dressed up as a diff
 * about compilation. The first run of this tool reported exactly that and called it
 * nondeterminism.
 *
 * Keyed by checkout so two working trees do not overwrite each other, but constant
 * within one, so both halves genuinely emit from the same place.
 */
const STAGE = join(tmpdir(), `dziri-neutral-${createHash("sha256").update(ROOT).digest("hex").slice(0, 8)}`);

/**
 * The emitted artifacts, as text, written to {@link STAGE}.
 *
 * The window is the demo's whole output. The fixture cases beside it reach compiler
 * paths the demo does not, and they come from a directory rather than a list here so
 * that adding a case is adding a file.
 */
async function emitArtifacts(): Promise<string[]> {
  const into = STAGE;
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  const names: string[] = [];

  const win = join(into, "window-main.gen.ts");
  const w = Bun.spawn(["bun", "run", "src/compile-window.ts", "main", "-o", win], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await w.exited) !== 0) {
    console.log("FAILED to emit window-main:\n" + (await new Response(w.stderr).text()).trim());
    process.exit(1);
  }
  names.push("window-main");

  // The fixture cases compile in this process. `.html` only, which is what they all
  // are — the JSX front-end has to `import()` its input and is a driver rather than a
  // function, so `compileSnippet` deliberately does not cover it.
  const cases = join(ROOT, "characterize", "cases");
  if (existsSync(cases)) {
    for (const f of (await readdir(cases)).sort()) {
      if (!f.endsWith(".html")) continue;
      const name = f.replace(/\.html$/, "");
      const cssPath = existsSync(join(cases, `${name}.css`))
        ? join(cases, `${name}.css`)
        : join(cases, "_empty.css");
      const { result } = compileSnippet({
        html: await readFile(join(cases, f), "utf8"),
        css: existsSync(cssPath) ? await readFile(cssPath, "utf8") : "",
        label: `characterize/cases/${f}`,
      });
      await writeFile(
        join(into, `${name}.gen.ts`),
        emit(result, { html: `characterize/cases/${f}`, css: `characterize/cases/${name}.css` }).source,
      );
      names.push(name);
    }
  }
  return names;
}

/** Renders every scenario into `into`, returning the ones that failed to render. */
async function render(into: string): Promise<string[]> {
  await mkdir(into, { recursive: true });
  const broke: string[] = [];
  for (const s of SCENARIOS) {
    const out = join(into, `${s.name}.png`);
    const proc = Bun.spawn(["bun", "run", "windows/entry.gen.ts", "--screenshot", out, ...s.args], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await proc.exited) !== 0 || !existsSync(out)) broke.push(s.name);
  }
  return broke;
}

const WIDTH = 150;

/** A generated line, clipped to something a terminal can show. */
function clip(line: string): string {
  return line.length <= WIDTH ? line : `${line.slice(0, WIDTH)}… (+${line.length - WIDTH} chars)`;
}

/**
 * First differing line, with its neighbours.
 *
 * The window around the differing *character* is not a nicety. `strings` in an
 * emitted artifact is one line holding every string literal in the app — 20 KB of it
 * for the demo — so printing the differing line whole prints it twice and says
 * nothing. The first draft of this function did exactly that.
 */
function firstDiff(a: string, b: string): string {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] === lb[i]) continue;
    const x = la[i] ?? "(end of file)";
    const y = lb[i] ?? "(end of file)";
    const out: string[] = [];
    for (let k = Math.max(0, i - 2); k < i; k++) out.push(`     ${k + 1}  ${clip(la[k] ?? "")}`);

    if (x.length > WIDTH || y.length > WIDTH) {
      // Both are long, so locate the change within the line and show only that.
      let c = 0;
      while (c < x.length && c < y.length && x[c] === y[c]) c++;
      const from = Math.max(0, c - 50);
      const win = (s: string) =>
        `${from > 0 ? "…" : ""}${s.slice(from, c + 70)}${c + 70 < s.length ? "…" : ""}`;
      out.push(`    line ${i + 1}, first differing at character ${c} of ${x.length}/${y.length}:`);
      out.push(`    -   ${win(x)}`);
      out.push(`    +   ${win(y)}`);
    } else {
      out.push(`    -${i + 1}  ${x}`);
      out.push(`    +${i + 1}  ${y}`);
    }

    if (la.length !== lb.length) {
      out.push(`     … ${Math.abs(la.length - lb.length)} line(s) difference in length`);
    }
    return out.join("\n");
  }
  return "    (identical by line; the bytes differ — check line endings)";
}

// ---------------------------------------------------------------------------

if (SAVE) {
  await rm(BASE, { recursive: true, force: true });
  await mkdir(BASE, { recursive: true });

  await compileWindow();
  const names = await emitArtifacts();
  await mkdir(ARTIFACTS, { recursive: true });
  for (const name of names) {
    await writeFile(join(ARTIFACTS, `${name}.gen.ts`), await readFile(join(STAGE, `${name}.gen.ts`)));
  }
  const broke = ARTIFACTS_ONLY ? [] : await render(RENDERS);

  const manifest: Manifest = {
    label: LABEL,
    savedAt: new Date().toISOString(),
    head: gitHead(),
    demoHash: await hashTree(TREES.demo.roots, TREES.demo.skip),
    codeHash: await hashTree(TREES.code.roots, TREES.code.skip),
  };
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`baseline saved${LABEL ? ` as "${LABEL}"` : ""} at ${relative(ROOT, BASE)}/`);
  console.log(`  ${names.length} emitted artifact(s)`);
  if (!ARTIFACTS_ONLY) console.log(`  ${SCENARIOS.length - broke.length}/${SCENARIOS.length} scenario(s) rendered`);
  if (broke.length) console.log(`  FAILED to render: ${broke.join(", ")}`);
  console.log(`  demo ${manifest.demoHash} · code ${manifest.codeHash} · HEAD ${manifest.head}`);
  console.log(`\nMake your change, then: bun run neutral`);
  process.exit(broke.length ? 1 : 0);
}

if (!existsSync(MANIFEST)) {
  console.log(`no baseline. Take one before making the change:\n\n  bun run neutral --save\n`);
  process.exit(1);
}

const saved = JSON.parse(await readFile(MANIFEST, "utf8")) as Manifest;
const nowDemo = await hashTree(TREES.demo.roots, TREES.demo.skip);
const nowCode = await hashTree(TREES.code.roots, TREES.code.skip);

const tmp = join(tmpdir(), `dziri-neutral-frames-${process.pid}`);
await compileWindow();
const names = await emitArtifacts();
const broke = ARTIFACTS_ONLY ? [] : await render(join(tmp, "renders"));

let differ = 0;
let missing = 0;

console.log(`against baseline${saved.label ? ` "${saved.label}"` : ""} taken at ${saved.savedAt} (HEAD ${saved.head})\n`);

for (const name of names) {
  const was = join(ARTIFACTS, `${name}.gen.ts`);
  if (!existsSync(was)) {
    missing++;
    console.log(`NEW    ${name}  — not in the baseline`);
    continue;
  }
  const a = await readFile(was, "utf8");
  const b = await readFile(join(STAGE, `${name}.gen.ts`), "utf8");
  if (a === b) {
    console.log(`ok     ${name}  (emitted, ${(b.length / 1024).toFixed(1)} KiB)`);
  } else {
    differ++;
    console.log(`DIFF   ${name}  (emitted)`);
    console.log(firstDiff(a, b));
  }
}

if (!ARTIFACTS_ONLY) {
  for (const s of SCENARIOS) {
    if (broke.includes(s.name)) {
      console.log(`BROKE  ${s.name}  — failed to render`);
      continue;
    }
    const was = join(RENDERS, `${s.name}.png`);
    if (!existsSync(was)) {
      missing++;
      console.log(`NEW    ${s.name}  — not in the baseline`);
      continue;
    }
    const a = new Uint8Array(await readFile(was));
    const b = new Uint8Array(await readFile(join(tmp, "renders", `${s.name}.png`)));
    const same = a.length === b.length && a.every((v, i) => v === b[i]);
    if (same) console.log(`ok     ${s.name}`);
    else {
      differ++;
      console.log(
        `DIFF   ${s.name}  ${(a.length / 1024).toFixed(1)} -> ${(b.length / 1024).toFixed(1)} KiB`,
      );
    }
  }
}

await rm(tmp, { recursive: true, force: true });

/**
 * What a difference means, which depends on what moved underneath it.
 *
 * Reported rather than left to be remembered, because the two interesting cases are
 * easy to misread in opposite directions: a demo-only change makes a green refactor
 * look broken, and an unchanged tree producing different output looks like a passing
 * run of the wrong test.
 */
const demoChanged = nowDemo !== saved.demoHash;
const codeChanged = nowCode !== saved.codeHash;

console.log("");
if (broke.length) console.log(`${broke.length} scenario(s) failed to render`);
if (missing) console.log(`${missing} output(s) had nothing to compare against — retake the baseline`);

if (differ === 0 && !broke.length) {
  console.log(`output unchanged — ${names.length} artifact(s), ${ARTIFACTS_ONLY ? 0 : SCENARIOS.length} frame(s)`);
  if (codeChanged) {
    console.log(`  the code did change (${saved.codeHash} -> ${nowCode}), and none of it reached the output.`);
    // Said explicitly, because "green" here is narrower than it reads and the gap was
    // measured rather than guessed: deleting the cascade's re-insertion in
    // `collectDecls` leaves all 22 frames and all 3 artifacts byte-identical while
    // failing two unit tests. The demo simply never authors a shorthand that outranks
    // a longhand it already set. So this proves the output did not move for what these
    // scenarios exercise — it is not a proof that the change preserves behaviour.
    console.log(`  That is not the same as behaviour-preserving: this covers only what these`);
    console.log(`  scenarios reach. Run \`bun test\` for the rest — it catches changes this cannot.`);
  }
  process.exit(0);
}

console.log(`${differ} output(s) differ.`);
if (demoChanged && codeChanged) {
  console.log(`  Both the demo (${saved.demoHash} -> ${nowDemo}) and the code (${saved.codeHash} -> ${nowCode})`);
  console.log(`  changed, so a difference cannot be attributed to either. Stash the demo edit and`);
  console.log(`  re-run, or retake the baseline and redo the code change on its own.`);
} else if (demoChanged) {
  console.log(`  The demo changed (${saved.demoHash} -> ${nowDemo}) and the code did not.`);
  console.log(`  So every difference here is the demo's, which is what you asked for —`);
  console.log(`  regenerate the committed references: bun run golden --accept`);
} else if (codeChanged) {
  console.log(`  The code changed (${saved.codeHash} -> ${nowCode}) and the demo did not.`);
  console.log(`  So every difference here belongs to the change. Not neutral.`);
} else {
  console.log(`  Neither the demo nor the code changed, and the output did.`);
  console.log(`  That is nondeterminism in the compiler or the renderer, not a refactor —`);
  console.log(`  and it means every golden is unreliable until it is found.`);
}
process.exit(1);
