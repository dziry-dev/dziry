/**
 * One variant compile, off the main thread.
 *
 * `compileVariants` runs one full `compileTree` per conditional class, and those
 * compiles are independent — each gets a cloned tree with its toggle applied.
 * This worker owns a share of them. The document crosses **once**, as the first
 * message; every job after that is a bare toggle index. The worker clones the
 * tree locally per job and applies the toggle by walking the `toggleSites`
 * annotations — signal identity does not survive structured clone, which is why
 * sites cross as indices rather than as the `classWhen` objects themselves.
 *
 * It answers with only the fields `compileVariants` reads (nodes' masks and
 * runs, styles, tweens, keyframes): the full `CompileResult` is not
 * structured-cloneable, and nothing out there needs the rest.
 */
import { compileTree } from "./compile.ts";
import type { Element, Node } from "./html.ts";
import type { ToggleSite } from "./variant-compile.ts";

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

type SitedElement = Element & { toggleSites?: ToggleSite[] };

/** Mirrors `applyToggle`, matching sites by index instead of signal identity. */
function applyToggleByIndex(el: SitedElement, toggle: number): void {
  if (el.toggleSites) {
    for (const [className, index] of el.toggleSites) {
      if (index === toggle && !el.classes.includes(className)) {
        el.classes.push(className);
      }
    }
  }
  for (const child of el.children as Node[]) {
    if (child.type === "element") applyToggleByIndex(child, toggle);
    // Item templates are part of the document for styling purposes.
    else if (child.type === "dynlist" && child.template.type === "element") {
      applyToggleByIndex(child.template, toggle);
    }
  }
}

const scope = globalThis as unknown as {
  onmessage:
    | ((event: MessageEvent<{ tree: Element; css: string } | { toggle: number }>) => void)
    | null;
  postMessage(message: { ok: true; result: VariantRunResult } | { ok: false; error: string }): void;
};

let doc: Element | null = null;
let css = "";

scope.onmessage = (event) => {
  if ("tree" in event.data) {
    doc = event.data.tree;
    css = event.data.css;
    return;
  }
  try {
    if (doc === null) throw new Error("a toggle job arrived before the document");
    // A fresh clone per job: the toggle mutates `classes`, and jobs share the
    // held tree. The tree is already transport-sanitized plain data, so the
    // native clone is exact.
    const tree = structuredClone(doc);
    applyToggleByIndex(tree, event.data.toggle);
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
