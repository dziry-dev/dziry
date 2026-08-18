/** @jsxImportSource . */

/**
 * `{data.title}` and `{error.message}` — a route object's cell reads, compiled to
 * data/error bindings.
 *
 * The front half of the data-cell/error-cell work: the JSX runtime turns a data or
 * error recorder into a `{ data }` / `{ error }` text part, and `compileTree` routes
 * it to `dataBindings` / `errorBindings` (not `textBindings`, which is for signals).
 * The back half is `applyDataBindings` / `applyErrorBindings` in `runtime/bindings.ts`.
 */
import { expect, test } from "bun:test";

import { compileTree, type CompileResult } from "./compile.ts";
import { toDocument } from "./jsx-runtime.ts";
import { dataRecorder, errorRecorder } from "./route-data.ts";
import { setCompiling } from "../runtime/signal.ts";

function build(tree: () => unknown): CompileResult {
  setCompiling(true);
  try {
    return compileTree(toDocument(tree() as never), "");
  } finally {
    setCompiling(false);
  }
}

// The recorder is typed Record<string, unknown>, so a read is `unknown`. Cast to a
// permissive object so the JSX child type-checks; the *runtime* value is still the
// recording proxy, which is what the JSX runtime recognises.
const data = dataRecorder() as any;
const error = errorRecorder() as any;

test("{data.title} compiles to a data binding, not a signal binding", () => {
  const result = build(() => <div>{data.title}</div>);

  expect(result.textBindings).toEqual([]);
  expect(result.paramBindings).toEqual([]);
  expect(result.dataBindings.length).toBe(1);
  expect(result.dataBindings[0]!.parts).toEqual([{ data: ["title"] }]);
});

test("{error.message} compiles to an error binding", () => {
  const result = build(() => <div>{error.message}</div>);

  expect(result.errorBindings.length).toBe(1);
  expect(result.errorBindings[0]!.parts).toEqual([{ error: ["message"] }]);
});

test("a literal beside a data read shares the data run", () => {
  const result = build(() => <div>#{data.title}</div>);

  expect(result.dataBindings[0]!.parts).toEqual([{ literal: "#" }, { data: ["title"] }]);
});

test("data and error are distinct kinds — one does not satisfy the other", () => {
  const result = build(() => <div>{error.code}</div>);

  expect(result.dataBindings).toEqual([]);
  expect(result.errorBindings.length).toBe(1);
  expect(result.errorBindings[0]!.parts).toEqual([{ error: ["code"] }]);
});
