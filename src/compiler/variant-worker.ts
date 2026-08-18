/**
 * One variant compile, off the main thread.
 *
 * `compileVariants` runs one full `compileTree` per conditional class, and those
 * compiles are independent — each gets a cloned tree with its toggle applied.
 * This worker owns exactly one of them. It answers with only the fields
 * `compileVariants` reads (nodes' masks and runs, styles, tweens, keyframes):
 * the full `CompileResult` is not structured-cloneable, and nothing out there
 * needs the rest.
 */
import { compileTree } from "./compile.ts";
import type { Element } from "./html.ts";

/* Diagnostics belong to the parent: its baseline compile prints every warning
   once. Each pool member re-deriving the same lines would print them once per
   worker (measured: a 14-worker compile repeated the demo's `@supports` warning
   14 times). Errors are not swallowed — they ride back in the {ok:false} reply. */
console.warn = () => {};
console.error = () => {};

export type VariantRunResult = {
  nodes: { mask: number; run: number[] }[];
  styles: import("../ir.ts").ComputedStyle[];
  tweens: import("./computed.ts").BuiltTween[];
  keyframes: import("./computed.ts").BuiltKeyframe[];
};

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ tree: Element; css: string }>) => void) | null;
  postMessage(message: { ok: true; result: VariantRunResult } | { ok: false; error: string }): void;
};

scope.onmessage = (event) => {
  try {
    const { tree, css } = event.data;
    const result = compileTree(tree, css);
    scope.postMessage({
      ok: true,
      result: {
        nodes: result.nodes.map((n) => ({ mask: n.mask, run: n.run })),
        styles: result.styles,
        tweens: result.tweens,
        keyframes: result.keyframes,
      },
    });
  } catch (e) {
    // The parent rejects with this message — an ErrorEvent's is useless.
    scope.postMessage({ ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
};
