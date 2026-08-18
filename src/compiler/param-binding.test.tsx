/** @jsxImportSource . */

/**
 * `{args.id}` — a route parameter read, compiled to a param binding.
 *
 * The front half of §5.5: the JSX runtime turns a parameter recorder into a
 * `{ param }` text part, and `compileTree` routes it to `paramBindings` (not
 * `textBindings`, which is for signals). The back half — resolving it against
 * `matchRoute`'s params — is `applyParamBindings` in `runtime/bindings.ts`.
 */
import { expect, test } from "bun:test";

import { compileTree, type CompileResult } from "./compile.ts";
import { jsx, toDocument } from "./jsx-runtime.ts";
import { useRoute, withPage } from "./route.ts";
import { setCompiling } from "../runtime/signal.ts";

function build(tree: () => unknown, css = ``): CompileResult {
  setCompiling(true);
  try {
    return compileTree(toDocument(tree() as never), css);
  } finally {
    setCompiling(false);
  }
}

test("{args.id} compiles to a param binding, not a signal binding", () => {
  const result = withPage({ path: "products/$id", file: "products/$id.tsx" }, () => {
    const { args } = useRoute("products/$id");
    return build(() => <div>{args.id}</div>);
  });

  expect(result.textBindings).toEqual([]);
  expect(result.paramBindings.length).toBe(1);
  expect(result.paramBindings[0]!.parts).toEqual([{ param: "id" }]);
});

test("a literal beside a param shares the param run", () => {
  const result = withPage({ path: "products/$id", file: "products/$id.tsx" }, () => {
    const { args } = useRoute("products/$id");
    return build(() => <div>#{args.id}</div>);
  });

  expect(result.paramBindings.length).toBe(1);
  expect(result.paramBindings[0]!.parts).toEqual([{ literal: "#" }, { param: "id" }]);
});
