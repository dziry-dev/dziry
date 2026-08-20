/**
 * Reference resolution — identity to export name.
 *
 * form.test.tsx drives `resolveRefs` as a pipeline step on a happy path. These
 * pin the semantics a pipeline test cannot isolate: what the index keeps and
 * skips, which name wins a re-export, the collision error naming both
 * specifiers, and the unresolved-reference error that is the author's only
 * signal that a handler created inside a component has nowhere to live.
 */
import { expect, test } from "bun:test";
import type { CompileResult } from "./compile.ts";
import { RefError, buildRefIndex, resolveRefs, type RefSource } from "./resolve-refs.ts";

/** The CompileResult fields resolveRefs walks, empty except where a test fills one. */
function emptyResult(over: Partial<CompileResult> = {}): CompileResult {
  return {
    textBindings: [],
    handlers: [],
    editables: [],
    imageBindings: [],
    forms: [],
    disabled: [],
    lists: [],
    ...over,
  } as unknown as CompileResult;
}

const state = (exports: Record<string, unknown>, specifier = "./state.ts"): RefSource => ({
  specifier,
  exports,
});

// ---------------------------------------------------------------------------
// buildRefIndex
// ---------------------------------------------------------------------------

test("the index keeps objects and functions, and skips everything else", () => {
  const sig = { value: 1 };
  const fn = () => {};
  const index = buildRefIndex([
    state({ sig, fn, count: 42, name: "x", nil: null, missing: undefined }),
  ]);
  expect(index.get(sig)?.name).toBe("sig");
  expect(index.get(fn)?.name).toBe("fn");
  expect(index.size).toBe(2); // primitives and null are not nameable references
});

test("a re-exported object keeps the first module's name", () => {
  const shared = { value: 0 };
  const index = buildRefIndex([
    state({ shared }, "./a.ts"),
    state({ shared, own: {} }, "./b.ts"),
  ]);
  expect(index.get(shared)).toEqual({ specifier: "./a.ts", name: "shared" });
});

// ---------------------------------------------------------------------------
// resolveRefs
// ---------------------------------------------------------------------------

test("an interpolated signal becomes its export name and records the import", () => {
  const count = { value: 0 };
  const result = emptyResult({
    textBindings: [{ node: 3, parts: [{ source: count }] }],
  } as unknown as Partial<CompileResult>);
  const { imports } = resolveRefs(result, buildRefIndex([state({ count })]));

  expect((result.textBindings[0]!.parts[0] as { export: string }).export).toBe("count");
  expect(imports.get("./state.ts")).toEqual(new Set(["count"]));
});

test("a reference no module exports is an error naming the rule, not a dead binding", () => {
  const orphan = { value: 0 };
  const result = emptyResult({
    textBindings: [{ node: 7, parts: [{ source: orphan }] }],
  } as unknown as Partial<CompileResult>);
  expect(() => resolveRefs(result, buildRefIndex([state({})]))).toThrow(RefError);
  expect(() =>
    resolveRefs(
      emptyResult({
        textBindings: [{ node: 7, parts: [{ source: orphan }] }],
      } as unknown as Partial<CompileResult>),
      buildRefIndex([state({})]),
    ),
  ).toThrow("not a module-level export");
});

test("two modules exporting one name, both used, is an error naming both files", () => {
  const draftA = { value: "a" };
  const draftB = { value: "b" };
  const index = buildRefIndex([state({ draft: draftA }, "./pages/a.ts"), state({ draft: draftB }, "./pages/b.ts")]);
  // The index resolves each by identity; the collision surfaces only when both
  // are used, because the artifact imports by name.
  expect(index.get(draftA)!.name).toBe("draft");
  expect(index.get(draftB)!.name).toBe("draft");

  const result = emptyResult({
    textBindings: [
      { node: 1, parts: [{ source: draftA }] },
      { node: 2, parts: [{ source: draftB }] },
    ],
  } as unknown as Partial<CompileResult>);
  expect(() => resolveRefs(result, index)).toThrow('two modules export "draft"');
  expect(() =>
    resolveRefs(
      emptyResult({
        textBindings: [
          { node: 1, parts: [{ source: draftA }] },
          { node: 2, parts: [{ source: draftB }] },
        ],
      } as unknown as Partial<CompileResult>),
      index,
    ),
  ).toThrow("./pages/a.ts");
});

test("an HTML handler attribute is already a name — untouched, no import", () => {
  const result = emptyResult({
    handlers: [{ node: 1, ref: "clicked", name: "" }],
  } as unknown as Partial<CompileResult>);
  const { imports } = resolveRefs(result, buildRefIndex([]));
  expect(result.handlers[0]!.name).toBe("clicked");
  expect(imports.size).toBe(0);
});

test("a function handler is named by its export and imported", () => {
  const increment = () => {};
  const result = emptyResult({
    handlers: [{ node: 4, ref: increment, name: "" }],
  } as unknown as Partial<CompileResult>);
  const { imports } = resolveRefs(result, buildRefIndex([state({ increment })]));
  expect(result.handlers[0]!.name).toBe("increment");
  expect(imports.get("./state.ts")).toEqual(new Set(["increment"]));
});

test("a variant patch is named, and an expression would ride beside the name", () => {
  const enabled = { value: true };
  const patches = [{ source: enabled, className: "x-on", exportName: "" }];
  const { imports } = resolveRefs(emptyResult(), buildRefIndex([state({ enabled })]), { patches });
  expect(patches[0]!.exportName).toBe("enabled");
  expect(patches[0]!).not.toHaveProperty("exportExpression", expect.anything());
  expect(imports.get("./state.ts")).toEqual(new Set(["enabled"]));
});

test("the same signal used twice is one import and one name", () => {
  const count = { value: 0 };
  const result = emptyResult({
    textBindings: [
      { node: 1, parts: [{ source: count }] },
      { node: 2, parts: [{ source: count }] },
    ],
  } as unknown as Partial<CompileResult>);
  const { imports } = resolveRefs(result, buildRefIndex([state({ count })]));
  expect(imports.get("./state.ts")).toEqual(new Set(["count"]));
});
