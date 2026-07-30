/**
 * Development entry point for the JSX transform.
 *
 * Bun emits `jsxDEV` calls (with source-location arguments) unless building for
 * production, so this module exists purely to satisfy that import. The extra
 * arguments carry debug info we have no use for — the compiler reports errors
 * against selectors and tags, not JSX call sites — so it delegates straight to
 * the production runtime.
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
