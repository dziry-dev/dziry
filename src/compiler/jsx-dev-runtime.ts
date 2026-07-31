/**
 * Development entry point for the JSX transform.
 *
 * Bun emits `jsxDEV` calls unless building for production, so this module exists
 * purely to satisfy that import and delegates straight to the production runtime.
 *
 * # Why `_source` is not used, which is not the reason it looks like
 *
 * The signature suggests a free source location for compiler diagnostics — this
 * is, after all, the only channel by which a build-time-erased JSX tree could
 * carry one. **Bun does not populate it.** Measured against 1.3.14: the
 * transpiler emits the six-argument call shape with a literal `undefined` in
 * that position —
 *
 *     jsxDEV_7x81h0kn("div", { id: "x" }, undefined, false, undefined, this)
 *
 * — and the same holds through the real `bun run compile` path, not just the
 * `Bun.Transpiler` API. So there is nothing here to thread anywhere, and adding
 * `Element.loc` today would add a field that is null for every node the JSX
 * front end produces.
 *
 * Getting locations would mean owning the TSX transform, which `ROADMAP.md`
 * rules out for a different reason ("we would also need to parse TSX ourselves;
 * today Bun transpiles JSX and we never see the AST"). Recheck this if Bun
 * starts emitting it: the cost then really is one field and one argument.
 *
 * Stylesheet diagnostics do not depend on any of this — `CssError` carries a
 * byte offset into the source, which is where the position was always available.
 */
import { jsx, Fragment, type Props, type Component, type Child, type JSX } from "./jsx-runtime.ts";
import type { Node } from "./html.ts";

export function jsxDEV(
  type: string | Component<never>,
  props: Props,
  key?: unknown,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown,
): Node {
  return jsx(type, props, key);
}

export { Fragment };
export type { Props, Component, Child, JSX };
