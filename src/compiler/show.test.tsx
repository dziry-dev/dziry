/**
 * `<Show>` — compiled conditional rendering, proven on real emitter output.
 *
 * The fixture pattern is `suspense.test.tsx`'s: a temp project with a junction
 * to this repo as `node_modules/dziry`, compiled with the real `compileProject`,
 * asserted by importing the artifact it wrote. What only this can prove is the
 * whole path — the marker dissolving, the condition crossing the file boundary
 * as a live cell (by name or as a re-created inline computed), the hidden
 * column shipping the build-time answer, and a constant condition costing the
 * losing tree its existence.
 */
import { expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileProject } from "./build.ts";
import { ShowError } from "./show.ts";
import { SuspenseError } from "./suspense.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // OS temp dir; a straggler is litter, not state.
    }
  }
});

function project(pageBody: string, state?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dziry-show-"));
  fixtures.push(dir);
  const mainDir = join(dir, "windows", "main");
  mkdirSync(join(mainDir, "pages"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(REPO, join(dir, "node_modules", "dziry"), "junction");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "show-e2e", type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "dziry" },
      include: ["windows"],
    }),
  );
  writeFileSync(
    join(mainDir, "state.ts"),
    state ??
      `import { $, computed, signal } from "dziry";
export const open = signal(false);
export const closed = computed(() => $(open) === false);
`,
  );
  writeFileSync(
    join(mainDir, "index.tsx"),
    `import { Outlet, Window } from "dziry";
export default function Main() {
  return (
    <Window title="show">
      <Outlet />
    </Window>
  );
}
`,
  );
  writeFileSync(
    join(mainDir, "pages", "index.tsx"),
    `import { Show } from "dziry";
import { closed, open } from "../state.ts";
export default function Home() {
  return ${pageBody};
}
`,
  );
  return dir;
}

type Artifact = {
  shows: { content: number[]; fallback: number[]; when: unknown }[];
  nodes: { hidden: Uint8Array; parent: Int32Array };
  strings: string[];
};

test("a signal condition compiles: sibling trees, the losing side hidden, the cell live", async () => {
  const dir = project(
    `<Show when={open} fallback={<div className="closed">closed</div>}>
      <div className="open">open</div>
    </Show>`,
  );
  await compileProject({ projectDir: dir, hot: new Map() });

  const ui = (await import(join(dir, "windows", "main", "ui.gen.ts"))) as Artifact;
  expect(ui.shows).toHaveLength(1);
  const [s] = ui.shows;
  expect(s!.content).toHaveLength(1);
  expect(s!.fallback).toHaveLength(1);

  // The condition crossed the file boundary as the very object the page read,
  // so the worker subscribes to what the app writes.
  const state = (await import(join(dir, "windows", "main", "state.ts"))) as { open: unknown };
  expect(s!.when).toBe(state.open);

  // `open` starts false, and the compiled column already says so: content
  // hidden, fallback visible — the first frame needs no write.
  expect(ui.nodes.hidden[s!.content[0]!]).toBe(1);
  expect(ui.nodes.hidden[s!.fallback[0]!]).toBe(0);

  // No wrapper: both trees are siblings under the same parent — the route rule.
  expect(ui.nodes.parent[s!.content[0]!]).toBe(ui.nodes.parent[s!.fallback[0]!]);
});

test("a derived condition crosses live, and a truthy start ships content visible", async () => {
  // The fixture harness compiles from this repo's cwd, so the reactive rewrite
  // does not fire for temp-dir pages (`isAuthored` is cwd-scoped) — the inline
  // `when={open === false}` spelling is covered at the resolve-refs seam in
  // `show.test.ts`. What this proves is the derived-cell path end to end.
  const dir = project(
    `<Show when={closed}>
      <div className="closed-msg">nothing selected</div>
    </Show>`,
  );
  await compileProject({ projectDir: dir, hot: new Map() });

  const ui = (await import(join(dir, "windows", "main", "ui.gen.ts"))) as Artifact;
  const state = (await import(join(dir, "windows", "main", "state.ts"))) as { closed: unknown };
  const [s] = ui.shows;
  expect(s!.when).toBe(state.closed);

  // `closed` is true at build time, so content ships visible and there is no
  // fallback to hide.
  expect(ui.nodes.hidden[s!.content[0]!]).toBe(0);
  expect(s!.fallback).toHaveLength(0);
});

test("a constant condition is resolved at build time — the loser never becomes nodes", async () => {
  const dir = project(
    `<Show when={false} fallback={<div className="kept">the fallback stays</div>}>
      <div className="dropped">the content goes</div>
    </Show>`,
  );
  await compileProject({ projectDir: dir, hot: new Map() });

  const ui = (await import(join(dir, "windows", "main", "ui.gen.ts"))) as Artifact;
  expect(ui.shows).toHaveLength(0);
  expect(ui.strings).toContain("the fallback stays");
  expect(ui.strings).not.toContain("the content goes");
});

test("bare text at a Show's top level is refused — it cannot be hidden", async () => {
  const dir = project(`<Show when={open}>just words <div>and a box</div></Show>`);
  expect(compileProject({ projectDir: dir, hot: new Map() })).rejects.toThrow(SuspenseError);
});

test("a bare Show directly inside a Show is refused", async () => {
  const dir = project(
    `<Show when={open}>
      <Show when={open}>
        <div>inner</div>
      </Show>
    </Show>`,
  );
  expect(compileProject({ projectDir: dir, hot: new Map() })).rejects.toThrow(SuspenseError);
});

test("when={() => …} is refused — the condition, not a function returning one", async () => {
  const dir = project(`<Show when={() => open}><div>x</div></Show>`);
  expect(compileProject({ projectDir: dir, hot: new Map() })).rejects.toThrow(ShowError);
});

test("a missing when is refused by name", async () => {
  const dir = project(`<Show fallback={<div>y</div>}><div>x</div></Show>`);
  expect(compileProject({ projectDir: dir, hot: new Map() })).rejects.toThrow(ShowError);
  await compileProject({ projectDir: dir, hot: new Map() }).catch((e: Error) => {
    expect(e.message).toContain("needs a when");
  });
});
