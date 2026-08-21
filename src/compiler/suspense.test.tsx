/**
 * `<Suspense>` — the compiled boundary, proven on real emitter output.
 *
 * The fixture pattern is `links.test.tsx`'s: a temp project with a junction to
 * this repo as `node_modules/dziri`, compiled with the real `compileProject`,
 * asserted by importing the artifact it wrote. What only this can prove is the
 * whole path — the marker dissolving before the cascade, the boundary's node ids
 * surviving the walk, the resource crossing as a named import, and the hidden
 * column shipping fallback-first.
 */
import { expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileProject, BuildError } from "./build.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "dziri-suspense-"));
  fixtures.push(dir);
  const mainDir = join(dir, "windows", "main");
  mkdirSync(join(mainDir, "pages"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(REPO, join(dir, "node_modules", "dziri"), "junction");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "suspense-e2e", type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "dziri" },
      include: ["windows"],
    }),
  );
  writeFileSync(
    join(mainDir, "state.ts"),
    state ??
      `import { resource } from "dziri";
export const stats = resource(() => Promise.resolve("42 users"), "");
`,
  );
  writeFileSync(
    join(mainDir, "index.tsx"),
    `import { Outlet, Window } from "dziri";
export default function Main() {
  return (
    <Window title="suspense">
      <Outlet />
    </Window>
  );
}
`,
  );
  writeFileSync(
    join(mainDir, "pages", "index.tsx"),
    `import { Suspense } from "dziri";
import { stats } from "../state.ts";
export default function Home() {
  return ${pageBody};
}
`,
  );
  return dir;
}

test("a boundary compiles: sibling trees, fallback-first hidden bytes, a named resource", async () => {
  const dir = project(
    `<Suspense fallback={<div className="skeleton">loading</div>}>
      <div className="stats">{stats}</div>
    </Suspense>`,
  );
  await compileProject({ projectDir: dir, hot: new Map() });

  const ui = (await import(join(dir, "windows", "main", "ui.gen.ts"))) as {
    boundaries: { content: number[]; fallback: number[]; resources: unknown[] }[];
    nodes: { hidden: Uint8Array; parent: Int32Array };
    strings: string[];
  };

  expect(ui.boundaries).toHaveLength(1);
  const [b] = ui.boundaries;
  expect(b!.content).toHaveLength(1);
  expect(b!.fallback).toHaveLength(1);

  // The resource crossed the file boundary as the live object, not a copy: it is
  // the very export the page read, so the worker subscribes to what the app sees.
  const state = (await import(join(dir, "windows", "main", "state.ts"))) as { stats: unknown };
  expect(b!.resources).toEqual([state.stats]);

  // Fallback-first: content ships hidden, fallback visible — a resource is
  // pending at launch by definition, so the first frame needs no boundary write.
  expect(ui.nodes.hidden[b!.content[0]!]).toBe(1);
  expect(ui.nodes.hidden[b!.fallback[0]!]).toBe(0);

  // No wrapper: both trees are siblings under the same parent — the route rule.
  expect(ui.nodes.parent[b!.content[0]!]).toBe(ui.nodes.parent[b!.fallback[0]!]);
});

test("a boundary whose bindings read no resource is refused in the design doc's words", async () => {
  const dir = project(
    `<Suspense fallback={<div>wait</div>}>
      <div className="static">nothing async here</div>
    </Suspense>`,
  );
  expect(compileProject({ projectDir: dir, hot: new Map() })).rejects.toThrow(BuildError);
  await compileProject({ projectDir: dir, hot: new Map() }).catch((e: Error) => {
    expect(e.message).toContain("nothing under this");
    expect(e.message).toContain("boundary can pend");
    expect(e.message).toContain("on={[");
  });
});

test("the on prop names a resource a computed() would hide from collection", async () => {
  const dir = project(
    `<Suspense fallback={<div>wait</div>} on={[stats]}>
      <div className="static">the read is indirect</div>
    </Suspense>`,
  );
  await compileProject({ projectDir: dir, hot: new Map() });
  const ui = (await import(join(dir, "windows", "main", "ui.gen.ts"))) as {
    boundaries: { resources: unknown[] }[];
  };
  const state = (await import(join(dir, "windows", "main", "state.ts"))) as { stats: unknown };
  expect(ui.boundaries[0]!.resources).toEqual([state.stats]);
});

test("on={…} with a plain signal is refused — it has no pending state to watch", async () => {
  const dir = project(
    `<Suspense fallback={<div>wait</div>} on={[stats]}>
      <div>static</div>
    </Suspense>`,
    `import { signal } from "dziri";\nexport const stats = signal("not a resource");\n`,
  );
  expect(compileProject({ projectDir: dir, hot: new Map() })).rejects.toThrow(BuildError);
  await compileProject({ projectDir: dir, hot: new Map() }).catch((e: Error) => {
    expect(e.message).toContain("not a resource");
  });
});

test("bare text at a boundary's top level is refused — it cannot be hidden", async () => {
  const dir = project(`<Suspense fallback={<div>wait</div>}>just words {stats}</Suspense>`);
  expect(compileProject({ projectDir: dir, hot: new Map() })).rejects.toThrow(SuspenseError);
});

test("a bare boundary directly inside a boundary is refused", async () => {
  const dir = project(
    `<Suspense fallback={<div>w1</div>}>
      <Suspense fallback={<div>w2</div>}>
        <div>{stats}</div>
      </Suspense>
    </Suspense>`,
  );
  expect(compileProject({ projectDir: dir, hot: new Map() })).rejects.toThrow(SuspenseError);
});
