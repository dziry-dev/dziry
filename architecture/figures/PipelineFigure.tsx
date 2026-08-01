/**
 * Figure 1 — one `<div>` from source text to lit pixels.
 *
 * The macro shot. Everything else on the page is a zoom into one of these six
 * hops, so this figure's only job is to establish where the boundary is and
 * that five of the six hops happen before the app ever runs.
 */
import { Arrow, Box, type FigureSpec } from "./Figure.tsx";
import { at, ease, easeOut, lerp, type Step } from "./timeline.ts";

const STEPS: Step[] = [
  {
    label: "You write",
    caption:
      "A div with a class, and a stylesheet somewhere that has opinions about that class. Ordinary JSX, ordinary CSS.",
  },
  {
    label: "Evaluate",
    caption:
      "Importing the module runs the components. There is no renderer and no virtual DOM — the tree that comes back is the tree that gets compiled, and it is built exactly once.",
  },
  {
    label: "Resolve",
    caption:
      "Selectors match, specificity sorts, inheritance applies, shorthands expand, units resolve. The answer is a set of numbers. This is the step a browser would be doing on every frame.",
  },
  {
    label: "Emit",
    caption:
      "The numbers are written out as a TypeScript module of typed arrays. Not serialized data that something will parse — the in-memory representation, already in memory.",
  },
  {
    label: "Write",
    caption:
      "Past the boundary. Bun holds typed-array views over memory the engine allocated, so uploading is a store instruction, not a call. Everything left of the dashed line has already happened.",
    ms: 3000,
  },
  {
    label: "Draw",
    caption:
      "Taffy lays the tree out, Skia paints it, SDL3 presents it. The engine reads the numbers straight out of shared memory — nothing was decoded on the way in.",
  },
];

type Station = { x: number; title: string; sub: string; tone: string };

const STATIONS: Station[] = [
  { x: 78, title: "app.tsx", sub: "+ app.css", tone: "var(--layer-authoring)" },
  { x: 236, title: "Element tree", sub: "evaluated once", tone: "var(--layer-compiler)" },
  { x: 394, title: "cascade", sub: "→ integers", tone: "var(--layer-compiler)" },
  { x: 552, title: "ui.gen.ts", sub: "typed arrays", tone: "var(--layer-compiler)" },
  { x: 748, title: "staged arena", sub: "shared memory", tone: "var(--layer-protocol)" },
  { x: 890, title: "frame", sub: "Taffy → Skia", tone: "var(--layer-engine)" },
];

/** What the payload *is* by the time it reaches each station. */
const PAYLOAD = [
  `<div class="card">`,
  "node #12",
  "pad 8 · bg #1b1b1f",
  "[12, 7, -1, 3, …]",
  "0c 07 ff ff 03",
  "▬ 240×64 at 16,96",
];

const BOUNDARY_X = 654;
const ROW_Y = 118;
const BOX_W = 122;
const BOX_H = 56;

export const PIPELINE: FigureSpec = {
  id: "fig-pipeline",
  title: "One div, end to end",
  thesis:
    "Six hops. Five of them happen before the app starts, and the sixth is the only one that repeats.",
  height: 250,
  steps: STEPS,
  files: ["src/compile.ts", "src/engine/upload.ts", "native-src/dziri-engine/src/engine.rs"],
  draw: (i, p) => {
        const from = STATIONS[Math.max(0, i - 1)]!;
        const to = STATIONS[i]!;
        const travel = ease(at(p, 0, 0.62));
        // The pill is wider than the station it sits over, so at the first and
        // last stations its centre has to be pulled inboard or it hangs off the
        // edge of the frame.
        const CHIP_HALF = 84;
        const chipX = Math.min(
          Math.max(lerp(from.x, to.x, i === 0 ? 1 : travel), CHIP_HALF + 4),
          960 - CHIP_HALF - 4,
        );
        // The label changes at the halfway point, so the payload is visibly a
        // different kind of thing on the far side of each hop.
        const label = PAYLOAD[travel < 0.5 && i > 0 ? i - 1 : i]!;

        return (
          <>
            {/* the build-time / run-time membrane */}
            <line
              x1={BOUNDARY_X}
              y1={46}
              x2={BOUNDARY_X}
              y2={192}
              stroke="var(--layer-protocol)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              opacity={0.75}
            />
            <text className="t-xs t-muted" x={BOUNDARY_X - 10} y={38} textAnchor="end">
              build time · runs once
            </text>
            <text
              className="t-xs"
              x={BOUNDARY_X + 10}
              y={38}
              textAnchor="start"
              fill="var(--layer-protocol)"
            >
              run time
            </text>
            <text className="t-xs t-muted" x={BOUNDARY_X} y={212} textAnchor="middle">
              one dlopen, then no calls
            </text>

            {/* rails */}
            {STATIONS.slice(0, -1).map((s, n) => (
              <Arrow
                key={s.title}
                x1={s.x + BOX_W / 2 + 4}
                y1={ROW_Y + BOX_H / 2}
                x2={STATIONS[n + 1]!.x - BOX_W / 2 - 4}
                y2={ROW_Y + BOX_H / 2}
                tone={n < i ? "var(--rule-strong)" : "var(--rule)"}
                opacity={n < i ? 1 : 0.5}
              />
            ))}

            {/* stations */}
            {STATIONS.map((s, n) => {
              const reached = n <= i;
              return (
                <g key={s.title}>
                  <Box
                    x={s.x - BOX_W / 2}
                    y={ROW_Y}
                    w={BOX_W}
                    h={BOX_H}
                    tone={s.tone}
                    lit={reached}
                    dim={!reached}
                  />
                  <text className="t-sm t-ink" x={s.x} y={ROW_Y + 24} opacity={reached ? 1 : 0.4}>
                    {s.title}
                  </text>
                  <text className="t-xs t-muted" x={s.x} y={ROW_Y + 40} opacity={reached ? 1 : 0.4}>
                    {s.sub}
                  </text>
                  {n === i && (
                    <rect
                      x={s.x - BOX_W / 2}
                      y={ROW_Y}
                      width={BOX_W}
                      height={BOX_H}
                      rx={7}
                      fill="none"
                      stroke={s.tone}
                      strokeWidth={2}
                      opacity={0.4 + 0.6 * easeOut(at(p, 0.55, 0.95))}
                    />
                  )}
                </g>
              );
            })}

            {/* the payload */}
            <g transform={`translate(${chipX}, 0)`}>
              <rect
                x={-84}
                y={ROW_Y - 42}
                width={168}
                height={28}
                rx={14}
                fill="var(--raised)"
                stroke={to.tone}
                strokeWidth={1.5}
              />
              <text className="t-sm t-ink" x={0} y={ROW_Y - 23}>
                {label}
              </text>
              <path
                d={`M -5 ${ROW_Y - 14} L 5 ${ROW_Y - 14} L 0 ${ROW_Y - 7} Z`}
                fill={to.tone}
              />
            </g>
          </>
        );
  },
};
