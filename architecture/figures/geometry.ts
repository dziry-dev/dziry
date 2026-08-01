/**
 * Renders every figure at every step, outside a browser, and checks that the
 * drawing is actually inside its own frame.
 *
 * This exists because of a real bug: a `text-anchor: middle` rule in the CSS
 * silently outranked every `textAnchor="start"` in the figures, and the result
 * was labels sitting outside their boxes and two captions printed on top of
 * each other. Nothing failed. It rendered, it just read as nonsense, and it was
 * only caught by someone looking at it.
 *
 * Two properties are worth having a machine assert, and they are the two that
 * were broken:
 *
 *   · nothing is drawn outside the viewBox
 *   · no two pieces of text on the same baseline overlap
 *
 * `draw` is a pure function of `(step, progress)` and the part components are
 * hook-free, so the element tree can be walked directly — no DOM, no renderer,
 * and geometry that is exact rather than screenshotted. Text width is the one
 * estimate: the figures are set in a monospace face, so advance is close enough
 * to `chars × size × 0.62` for an overflow check.
 */
import { Fragment, isValidElement, type ReactNode } from "react";
import { FIGURE_WIDTH, type FigureSpec } from "./Figure.tsx";
import { FIGURES } from "./index.ts";

/** Matches the sizes in theme.css. */
const FONT_SIZE: Record<string, number> = { "t-xs": 10.5, "t-sm": 12 };
const ADVANCE = 0.62;
const DEFAULT_SIZE = 12;

/** Sub-pixel spill is rounding, not a bug. */
const EDGE_TOLERANCE = 2;
const OVERLAP_TOLERANCE = 1;

type Drawn = {
  kind: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Text content, for the overlap check and for readable failures. */
  text?: string;
  /** Baseline y, which is what "same line" means for text. */
  baseline?: number;
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

/** Flattens a node's children into the string it will render as. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function record(type: string, props: Record<string, unknown>, dx: number, dy: number): Drawn | null {
  switch (type) {
    case "rect": {
      const x = num(props.x) + dx;
      const y = num(props.y) + dy;
      return { kind: "rect", x0: x, y0: y, x1: x + num(props.width), y1: y + num(props.height) };
    }
    case "line": {
      const x1 = num(props.x1) + dx;
      const x2 = num(props.x2) + dx;
      const y1 = num(props.y1) + dy;
      const y2 = num(props.y2) + dy;
      return {
        kind: "line",
        x0: Math.min(x1, x2),
        y0: Math.min(y1, y2),
        x1: Math.max(x1, x2),
        y1: Math.max(y1, y2),
      };
    }
    case "circle": {
      const r = num(props.r);
      const cx = num(props.cx) + dx;
      const cy = num(props.cy) + dy;
      return { kind: "circle", x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
    }
    case "ellipse": {
      const rx = num(props.rx);
      const ry = num(props.ry);
      const cx = num(props.cx) + dx;
      const cy = num(props.cy) + dy;
      return { kind: "ellipse", x0: cx - rx, y0: cy - ry, x1: cx + rx, y1: cy + ry };
    }
    case "text": {
      const content = textOf(props.children as ReactNode).trim();
      const className = String(props.className ?? "");
      const size =
        Object.entries(FONT_SIZE).find(([c]) => className.split(/\s+/).includes(c))?.[1] ??
        DEFAULT_SIZE;
      const width = content.length * size * ADVANCE;
      const anchor = String(props.textAnchor ?? "middle");
      const x = num(props.x) + dx;
      const y = num(props.y) + dy;
      const x0 = anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2;
      // An invisible label is not a layout problem — a step that fades text in
      // starts at zero opacity and must not be reported while it is not there.
      if (props.opacity !== undefined && num(props.opacity) < 0.05) return null;
      return {
        kind: "text",
        x0,
        y0: y - size,
        x1: x0 + width,
        y1: y + size * 0.3,
        text: content,
        baseline: y,
      };
    }
    // `polygon` is only ever an arrowhead sitting on a line already checked, and
    // `path` only the payload's pointer. Neither can escape on its own.
    default:
      return null;
  }
}

function walk(node: ReactNode, dx: number, dy: number, out: Drawn[]): void {
  if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, dx, dy, out);
    return;
  }
  if (!isValidElement(node)) return;

  const props = node.props as Record<string, unknown>;
  // `unknown` on purpose: Fragment is an exotic object rather than a function,
  // and narrowing on `typeof === "function"` first makes the compiler believe
  // the Fragment branch is unreachable when it is the common case.
  const type = node.type as unknown;

  if (type === Fragment) {
    walk(props.children as ReactNode, dx, dy, out);
    return;
  }
  // A hook-free function component can just be called.
  if (typeof type === "function") {
    walk((type as (p: unknown) => ReactNode)(props), dx, dy, out);
    return;
  }
  if (typeof type !== "string") return;

  let tx = dx;
  let ty = dy;
  if (typeof props.transform === "string") {
    const m = props.transform.match(/translate\(\s*(-?[\d.]+)[ ,]+\s*(-?[\d.]+)\s*\)/);
    if (m) {
      tx += Number(m[1]);
      ty += Number(m[2]);
    }
  }

  // A group's own opacity hides everything under it.
  if (props.opacity !== undefined && num(props.opacity) < 0.05 && type === "g") return;

  const drawn = record(type, props, tx, ty);
  if (drawn) out.push(drawn);

  walk(props.children as ReactNode, tx, ty, out);
}

export type GeometryProblem = { figure: string; step: number; detail: string };

/** Three samples per step: the start, the middle of the motion, and the rest. */
const SAMPLES = [0, 0.5, 1];

function checkFigure(spec: FigureSpec): GeometryProblem[] {
  const problems: GeometryProblem[] = [];

  for (let step = 0; step < spec.steps.length; step++) {
    for (const progress of SAMPLES) {
      const drawn: Drawn[] = [];
      walk(spec.draw(step, progress), 0, 0, drawn);

      for (const d of drawn) {
        if (
          d.x0 < -EDGE_TOLERANCE ||
          d.x1 > FIGURE_WIDTH + EDGE_TOLERANCE ||
          d.y0 < -EDGE_TOLERANCE ||
          d.y1 > spec.height + EDGE_TOLERANCE
        ) {
          problems.push({
            figure: spec.id,
            step,
            detail:
              `${d.kind}${d.text ? ` "${d.text}"` : ""} runs outside the frame — ` +
              `x ${d.x0.toFixed(0)}…${d.x1.toFixed(0)}, y ${d.y0.toFixed(0)}…${d.y1.toFixed(0)} ` +
              `(frame is 0…${FIGURE_WIDTH} × 0…${spec.height})`,
          });
        }
      }

      // Same baseline, overlapping horizontally: this is the collision that
      // shipped, and it is invisible to a bounds check.
      const texts = drawn.filter((d) => d.kind === "text");
      for (let a = 0; a < texts.length; a++) {
        for (let b = a + 1; b < texts.length; b++) {
          const one = texts[a]!;
          const two = texts[b]!;
          if (Math.abs(one.baseline! - two.baseline!) > 3) continue;
          const overlap = Math.min(one.x1, two.x1) - Math.max(one.x0, two.x0);
          if (overlap > OVERLAP_TOLERANCE) {
            problems.push({
              figure: spec.id,
              step,
              detail: `"${one.text}" and "${two.text}" overlap by ${overlap.toFixed(0)}px on the same line`,
            });
          }
        }
      }
    }
  }

  // The same problem at three progress samples is one problem.
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.figure}|${p.step}|${p.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function checkFigureGeometry(): GeometryProblem[] {
  return FIGURES.flatMap(checkFigure);
}

export const FIGURE_STEP_COUNT = FIGURES.reduce((n, f) => n + f.steps.length, 0);
