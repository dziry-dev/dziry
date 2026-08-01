/**
 * The frame around every animated figure: title, thesis, canvas, caption, and
 * the step rail that doubles as the progress indicator and the scrubber.
 *
 * The canvas is a render prop rather than children, because a figure is a pure
 * function of `(step, progress)` — that is what makes it scrubbable, and what
 * keeps `prefers-reduced-motion` honest rather than a special case.
 */
import type { ReactNode } from "react";
import { useOnScreen, useTimeline, type Step } from "./timeline.ts";

/**
 * A figure is data plus one pure function of `(step, progress)`.
 *
 * Keeping `draw` free of hooks is what lets `figures/geometry.ts` render every
 * figure at every step outside a browser and check that nothing lands outside
 * the viewBox — the class of bug that otherwise ships as "some text looks off".
 */
export type FigureSpec = {
  id: string;
  title: string;
  thesis: string;
  steps: Step[];
  /** SVG viewBox height. Width is always 960. */
  height: number;
  files?: string[];
  draw: (index: number, progress: number) => ReactNode;
};

/** Width is fixed so every figure shares one coordinate space. */
export const FIGURE_WIDTH = 960;

export function Figure({ id, title, thesis, steps, height, files, draw }: FigureSpec) {
  const timeline = useTimeline(steps);
  const ref = useOnScreen(timeline.setVisible);
  const step = steps[timeline.index] ?? steps[0]!;

  return (
    <figure className="fig" id={id} ref={ref as React.Ref<HTMLElement>}>
      <div className="fig-head">
        <h3>{title}</h3>
        <p>{thesis}</p>
      </div>

      <div className="fig-canvas">
        {/* textAnchor on the root so it inherits — see the note in theme.css */}
        <svg
          viewBox={`0 0 ${FIGURE_WIDTH} ${height}`}
          textAnchor="middle"
          role="img"
          aria-label={`${title}. ${step.caption}`}
        >
          {draw(timeline.index, timeline.progress)}
        </svg>
      </div>

      <div className="fig-rail">
        <button
          className="fig-play"
          onClick={timeline.toggle}
          aria-label={timeline.playing ? "Pause" : "Play"}
          disabled={timeline.reduced}
          title={timeline.reduced ? "Animation off — reduced motion is set" : undefined}
        >
          {timeline.playing ? "❚❚" : "▶"}
        </button>
        {steps.map((s, i) => (
          <button
            key={s.label}
            className="fig-step"
            aria-current={i === timeline.index}
            onClick={() => timeline.goto(i)}
          >
            <span
              className="fig-step-fill"
              style={{
                width:
                  i < timeline.index
                    ? "100%"
                    : i === timeline.index
                      ? `${timeline.progress * 100}%`
                      : "0%",
              }}
            />
            <span className="fig-step-label">
              {i + 1}. {s.label}
            </span>
          </button>
        ))}
      </div>

      <figcaption className="fig-caption">{step.caption}</figcaption>

      {files && files.length > 0 && (
        <div className="fig-files">
          {files.map((f) => (
            <code key={f}>{f}</code>
          ))}
        </div>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Small SVG parts the figures share
// ---------------------------------------------------------------------------

/** A labelled box. `tone` picks the accent; `lit` is the on/off state. */
export function Box({
  x,
  y,
  w,
  h,
  tone,
  lit = true,
  dim = false,
  radius = 7,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  tone?: string;
  lit?: boolean;
  dim?: boolean;
  radius?: number;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={radius}
      fill={lit ? "var(--raised)" : "var(--surface)"}
      stroke={tone && lit ? tone : "var(--rule)"}
      strokeWidth={tone && lit ? 1.5 : 1}
      opacity={dim ? 0.32 : 1}
    />
  );
}

/** An arrow between two points, drawn as a line plus a solid head. */
export function Arrow({
  x1,
  y1,
  x2,
  y2,
  tone = "var(--rule-strong)",
  dashed = false,
  opacity = 1,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tone?: string;
  dashed?: boolean;
  opacity?: number;
}) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 5;
  const head = [
    `${x2},${y2}`,
    `${x2 - size * Math.cos(angle - 0.42)},${y2 - size * Math.sin(angle - 0.42)}`,
    `${x2 - size * Math.cos(angle + 0.42)},${y2 - size * Math.sin(angle + 0.42)}`,
  ].join(" ");

  return (
    <g opacity={opacity}>
      <line
        x1={x1}
        y1={y1}
        x2={x2 - size * 0.8 * Math.cos(angle)}
        y2={y2 - size * 0.8 * Math.sin(angle)}
        stroke={tone}
        strokeWidth={1.5}
        strokeDasharray={dashed ? "4 3" : undefined}
      />
      <polygon points={head} fill={tone} />
    </g>
  );
}

/** A memory cell. The workhorse of the boundary figures. */
export function Cell({
  x,
  y,
  w,
  h,
  fill,
  stroke,
  label,
  sub,
  opacity = 1,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  label?: string;
  sub?: string;
  opacity?: number;
}) {
  return (
    <g opacity={opacity}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={3}
        fill={fill ?? "var(--surface)"}
        stroke={stroke ?? "var(--rule)"}
        strokeWidth={1}
      />
      {label && (
        <text className="t-sm t-ink" x={x + w / 2} y={y + h / 2 + (sub ? -2 : 3.5)}>
          {label}
        </text>
      )}
      {sub && (
        <text className="t-xs t-muted" x={x + w / 2} y={y + h / 2 + 11}>
          {sub}
        </text>
      )}
    </g>
  );
}
