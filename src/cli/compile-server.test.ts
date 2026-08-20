/**
 * The warm compile server, end to end: a real spawned process over a real
 * fixture project, because the regression this guards lived exactly in the
 * parts a unit test mocks away.
 *
 * The ae8390b bug: `versionedHref` returned a `file:` URL with a version query,
 * Bun normalised the query away, and the *unversioned cached module* answered —
 * a text edit recompiled (the messages all flowed) with the old contents. Every
 * module-cache unit test passed throughout; they test `bustSet`, which was
 * never wrong. What was wrong is only observable as "a second compile of a
 * changed file carries the change", which is what this file asserts.
 *
 * The fixture is a minimal scaffolded project: `dziri` reaches it through a
 * junction in its node_modules, the way `create-dziri --local` links it.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");

const fixture = mkdtempSync(join(tmpdir(), "dziri-warm-e2e-"));
const mainDir = join(fixture, "windows", "main");
const pagesDir = join(mainDir, "pages");
mkdirSync(pagesDir, { recursive: true });
mkdirSync(join(fixture, "node_modules"));
symlinkSync(REPO, join(fixture, "node_modules", "dziri"), "junction");

writeFileSync(
  join(fixture, "package.json"),
  JSON.stringify({ name: "warm-e2e", type: "module" }),
);
writeFileSync(
  join(fixture, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "dziri" },
    include: ["windows"],
  }),
);

writeFileSync(
  join(mainDir, "index.tsx"),
  `import { Outlet, Window } from "dziri";

export default function Main() {
  return (
    <Window title="warm">
      <Outlet />
    </Window>
  );
}
`,
);

// The marker lives in the *page*: the ae8390b bug was specifically that the
// compiler's own dynamic page imports never picked up edits.
const pagePath = join(pagesDir, "index.tsx");
const page = (text: string) => `export default function Home() {
  return <div className="x">{${JSON.stringify(text)}}</div>;
}
`;
writeFileSync(pagePath, page("VERSION_ONE"));

let proc: ReturnType<typeof Bun.spawn> | null = null;

afterAll(() => {
  proc?.kill();
  try {
    rmSync(fixture, { recursive: true, force: true });
  } catch {
    // The server's watcher can hold a handle briefly after kill; the temp dir is
    // an OS temp dir, so a straggler is litter, not state.
  }
});

test("a second compile of an edited file carries the edit", async () => {
  const compiled: { cssOnly: boolean }[] = [];
  let failed = false;
  proc = Bun.spawn([process.execPath, resolve(REPO, "src/cli/compile-server.ts"), fixture], {
    stdout: "inherit",
    stderr: "inherit",
    ipc(message: unknown) {
      const m = message as { t: string; cssOnly?: boolean };
      if (m.t === "compiled") compiled.push({ cssOnly: m.cssOnly ?? false });
      if (m.t === "failed") failed = true;
    },
  });

  const waitFor = async (n: number): Promise<void> => {
    const started = performance.now();
    while (compiled.length < n) {
      if (failed) throw new Error("the server reported a failed compile");
      if (performance.now() - started > 45_000) {
        throw new Error(`saw ${compiled.length} compiles in 45s, wanted ${n}`);
      }
      await Bun.sleep(50);
    }
  };

  await waitFor(1); // the cold compile

  writeFileSync(pagePath, page("VERSION_TWO"));
  await waitFor(2); // the watcher sees the save, the warm compile lands

  const artifact = readFileSync(join(mainDir, "ui.gen.ts"), "utf8");
  expect(artifact).toContain("VERSION_TWO");
  expect(artifact).not.toContain("VERSION_ONE");
}, 90_000);
