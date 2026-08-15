/** @jsxImportSource . */

/**
 * `bind:src` — a dynamic `src` on an `<img>`.
 *
 * The attribute path (`src="a.png"`) is static: the string is interned at compile
 * time and the row never moves. `bind:src` is the dynamic half — the signal's
 * current value is interned as the initial string, and the worker rewrites the
 * slot when the signal moves, which is how a file-picker answer becomes a
 * preview.
 *
 * The assertions are on the `CompileResult` (which has the binding with its ref)
 * and on the in-memory `CompiledUi` (which has the images row). The generated
 * module path is the one that resolves `ref` to a name; these tests run the
 * front half.
 */
import { expect, test } from "bun:test";

import { compileTree, toCompiledUi, type CompileResult } from "./compile.ts";
import { jsx, toDocument } from "./jsx-runtime.ts";
import { signal, setCompiling } from "../runtime/signal.ts";
import { ControlKind } from "../ir.ts";

/** Builds a document with the compiler's recording mode on, as the CLI does. */
function build(tree: () => unknown, css = ``): CompileResult {
  setCompiling(true);
  try {
    return compileTree(toDocument(tree() as never), css);
  } finally {
    setCompiling(false);
  }
}

test("bind:src emits an images row and an imageBinding", () => {
  const src = signal("photo.png");
  const result = build(() => <img bind:src={src} />);

  expect(result.images.length).toBe(1);
  expect(result.imageBindings.length).toBe(1);
  expect(result.imageBindings[0]!.node).toBe(result.images[0]!.node);
  expect(result.imageBindings[0]!.slot).toBe(result.images[0]!.src);
  expect(result.imageBindings[0]!.ref).toBe(src);
});

test("bind:src with no src attribute uses the signal's initial value", () => {
  const src = signal("initial.png");
  const result = build(() => <img bind:src={src} />);

  expect(result.images.length).toBe(1);
  expect(result.strings[result.images[0]!.src]).toBe("initial.png");
});

test("bind:src alongside src attribute: the binding owns the row", () => {
  const src = signal("dynamic.png");
  const result = build(() => <img src="static.png" bind:src={src} />);

  // One row, owned by the binding: the signal's value is the initial string,
  // and the worker rewrites the slot when the signal moves.
  expect(result.images.length).toBe(1);
  expect(result.imageBindings.length).toBe(1);
  expect(result.images[0]!.src).toBe(result.imageBindings[0]!.slot);
  expect(result.strings[result.images[0]!.src]).toBe("dynamic.png");
});

test("no bind:src means no imageBinding", () => {
  const result = build(() => <img src="a.png" />);
  expect(result.imageBindings.length).toBe(0);
});

test("a non-img element with bind:src gets no imageBinding", () => {
  const src = signal("x");
  const result = build(() => <div bind:src={src} />);
  expect(result.imageBindings.length).toBe(0);
});
