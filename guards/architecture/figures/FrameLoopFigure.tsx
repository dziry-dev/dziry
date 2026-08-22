/**
 * Figure 4 — the loop, and how little of it runs on a quiet frame.
 *
 * Drawn as a ring because it is one: the engine's output becomes Bun's input.
 * The figure is careful about one thing — the schema tags every style field as
 * paint- or layout-affecting, but the engine does not yet gate on that tag, so
 * any change relayouts. The annotation says so rather than drawing the system
 * that is planned.
 */
import type { FigureSpec } from "./Figure.tsx";
import { at, easeOut, lerp, type Step } from "./timeline.ts";

const STEPS: Step[] = [
  {
    label: "Idle",
    caption:
      "Nothing changed. tick() pumps the event queue, the commit finds no differing span, and the function returns. No layout, no paint, no present — the window keeps the frame it already has, which is not the same as being handed a blank one.",
    ms: 3200,
  },
  {
    label: "A click lands",
    caption:
      "The engine owns input, so it is the thing that knows what was clicked. The hit test runs against the layout it just published, and the event comes back through the same shared memory — carrying focus with it, rather than leaving Bun to mirror it.",
    ms: 3200,
  },
  {
    label: "One signal",
    caption:
      "The handler assigns to a signal. Bindings, style patches and list arenas mutate the IR in place, and writes batch — one click costs one frame however many signals it touched.",
    ms: 3200,
  },
  {
    label: "One call",
    caption:
      "Upload is a store into the staged arena, not a call. tick() is the only FFI crossing in the whole frame, and everything the engine needs is already in memory when it happens.",
    ms: 3600,
  },
];

type Station = { title: string; sub: string; tone: string };

/** Clockwise from the top-left. Index n sits at 225° + n·45°. */
const STATIONS: Station[] = [
  { title: "signal", sub: "assigned", tone: "var(--layer-runtime)" },
  { title: "IR write", sub: "bindings · patches · lists", tone: "var(--layer-runtime)" },
  { title: "upload", sub: "→ staged arena", tone: "var(--layer-protocol)" },
  { title: "tick()", sub: "the only FFI call", tone: "var(--layer-protocol)" },
  { title: "commit", sub: "span diff", tone: "var(--layer-engine)" },
  { title: "Taffy → Skia", sub: "layout, then paint", tone: "var(--layer-engine)" },
  { title: "present", sub: "SDL3", tone: "var(--layer-engine)" },
  { title: "drain events", sub: "→ dispatch", tone: "var(--layer-runtime)" },
];

/** Cumulative degrees, so a step may run past 360 without wrapping backwards. */
const ARCS: { from: number; to: number; lit: number[] }[] = [
  { from: 360, to: 405, lit: [3, 4] },
  { from: 495, to: 540, lit: [6, 7] },
  { from: 540, to: 675, lit: [7, 0, 1, 2] },
  { from: 675, to: 855, lit: [2, 3, 4, 5, 6] },
];

const CX = 480;
const CY = 185;
const RX = 330;
const RY = 120;
const BW = 132;
const BH = 46;

const pointAt = (deg: number) => {
  const r = (deg * Math.PI) / 180;
  return { x: CX + RX * Math.cos(r), y: CY + RY * Math.sin(r) };
};
const stationAt = (n: number) => pointAt(225 + n * 45);

export const FRAME_LOOP: FigureSpec = {
  id: "fig-loop",
  title: "The frame loop",
  thesis:
    "Eight stations, one FFI call, and a quiet frame that costs a queue drain.",
  height: 380,
  steps: STEPS,
  files: ["src/app.ts", "native-src/dziry-engine/src/engine.rs"],
  draw: (i, p) => {
        const arc = ARCS[i]!;
        const pulse = pointAt(lerp(arc.from, arc.to, easeOut(at(p, 0, 0.85))));
        const lit = new Set(arc.lit);

        return (
          <>
            <ellipse
              cx={CX}
              cy={CY}
              rx={RX}
              ry={RY}
              fill="none"
              stroke="var(--rule)"
              strokeWidth={1.5}
            />

            {/* which half of the ring is whose */}
            <text className="t-xs t-muted" x={250} y={172} textAnchor="middle">
              Bun
            </text>
            <text className="t-xs t-muted" x={712} y={172} textAnchor="middle">
              engine
            </text>

            {/* the honest note about the one distinction that is not enforced */}
            {i === 3 && (
              <text
                className="t-xs"
                x={CX}
                y={CY + 8}
                textAnchor="middle"
                fill="var(--status-warning)"
                opacity={easeOut(at(p, 0.5, 0.9))}
              >
                the schema tags each field paint or layout —
              </text>
            )}
            {i === 3 && (
              <text
                className="t-xs t-muted"
                x={CX}
                y={CY + 24}
                textAnchor="middle"
                opacity={easeOut(at(p, 0.55, 0.95))}
              >
                the engine does not gate on it yet, so any change relayouts
              </text>
            )}

            {i === 0 && (
              <text
                className="t-xs t-muted"
                x={CX}
                y={CY + 8}
                textAnchor="middle"
                opacity={easeOut(at(p, 0.35, 0.8))}
              >
                no differing span → return before draw
              </text>
            )}

            {/* stations */}
            {STATIONS.map((s, n) => {
              const { x, y } = stationAt(n);
              const on = lit.has(n);
              return (
                <g key={s.title} opacity={on ? 1 : 0.38}>
                  <rect
                    x={x - BW / 2}
                    y={y - BH / 2}
                    width={BW}
                    height={BH}
                    rx={7}
                    fill="var(--raised)"
                    stroke={on ? s.tone : "var(--rule)"}
                    strokeWidth={on ? 1.6 : 1}
                  />
                  <text className="t-sm t-ink" x={x} y={y - 3}>
                    {s.title}
                  </text>
                  <text className="t-xs t-muted" x={x} y={y + 12}>
                    {s.sub}
                  </text>
                </g>
              );
            })}

            {/* the pulse */}
            <circle cx={pulse.x} cy={pulse.y} r={13} fill="var(--layer-protocol)" opacity={0.18} />
            <circle cx={pulse.x} cy={pulse.y} r={5.5} fill="var(--layer-protocol)" />

            {/* the boundary marker sits on tick() */}
            <text className="t-xs" x={810} y={CY + 44} textAnchor="middle" fill="var(--layer-protocol)">
              ── boundary ──
            </text>

            <text className="t-xs t-muted" x={CX} y={366} textAnchor="middle">
              Bun polls at 8 ms today; when the engine owns its own frame loop this becomes a blocking wait
            </text>
          </>
        );
  },
};
