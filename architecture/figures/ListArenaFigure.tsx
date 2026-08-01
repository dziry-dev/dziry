/**
 * Figure 6 — a dynamic list, without invalidating anything.
 *
 * The distinction the figure exists to draw is storage versus order. A keyed
 * row keeps its slot — and therefore its node id — for as long as it is in the
 * list; sorting rewrites the sibling chain and touches no storage at all. Get
 * that backwards and you have described a system where a sort moves every row's
 * identity, which is exactly the system this one was built to avoid.
 */
import type { FigureSpec } from "./Figure.tsx";
import { at, ease, easeOut, lerp, type Step } from "./timeline.ts";

const STEPS: Step[] = [
  {
    label: "An arena",
    caption:
      "A list is one subtree shape repeated at a fixed stride. Three rows are live, the rest of the arena is allocated and waiting, and each row's node id is decided when the row first appears. You are focused in node 42.",
  },
  {
    label: "Sort it",
    caption:
      "Nothing moves in storage. A keyed row keeps its slot, and sorting rewrites the sibling chain — the engine is handed which links changed, not a new tree. Focus is keyed by node id, so it does not even notice.",
    ms: 3800,
  },
  {
    label: "Insert",
    caption:
      "A new row takes the next spare slot and the next id, and is spliced into the chain wherever it sorts. No existing row is touched, so no existing row can lose state.",
    ms: 3400,
  },
  {
    label: "Outgrow it",
    caption:
      "Past capacity the arena grows by appending. Existing slots keep their ids and their contents; new ids continue upward. Growth never renumbers — an id that could be reused is a stale reference waiting to be dereferenced, and focus, hover and caret position are all keyed by id.",
    ms: 4200,
  },
];

/** Content is a property of the id, and never changes hands. */
const CONTENT: Record<number, string> = {
  40: "milk",
  41: "bread",
  42: "eggs",
  43: "jam",
  44: "tea",
  45: "rice",
  46: "salt",
};

type Frame = { active: number[]; order: number[]; capacity: number };

const FRAMES: Frame[] = [
  { active: [40, 41, 42], order: [40, 41, 42], capacity: 6 },
  { active: [40, 41, 42], order: [41, 42, 40], capacity: 6 },
  { active: [40, 41, 42, 43], order: [41, 42, 43, 40], capacity: 6 },
  {
    active: [40, 41, 42, 43, 44, 45, 46],
    order: [41, 42, 43, 40, 45, 46, 44],
    capacity: 9,
  },
];

const FOCUSED = 42;

const SLOT_W = 90;
const SLOT_GAP = 8;
const SLOT_Y = 96;
const SLOT_H = 72;
const slotX = (n: number) => 56 + n * (SLOT_W + SLOT_GAP);

const PILL_W = 66;
const PILL_GAP = 8;
const PILL_Y = 232;
const PILL_H = 34;
const pillX = (k: number) => 56 + k * (PILL_W + PILL_GAP);

export const LIST_ARENA: FigureSpec = {
  id: "fig-lists",
  title: "Lists grow by appending, and never renumber",
  thesis:
    "Storage and order are separate things. Sorting rewrites the order; the storage — and every id in it — stays exactly where it was.",
  height: 320,
  steps: STEPS,
  files: ["src/runtime/list-runtime.ts", "src/protocol/schema.ts"],
  draw: (i, p) => {
        const frame = FRAMES[i]!;
        const previous = FRAMES[Math.max(0, i - 1)]!;
        const settle = easeOut(at(p, 0.2, 0.8));

        const capacityX = lerp(
          slotX(previous.capacity - 1) + SLOT_W,
          slotX(frame.capacity - 1) + SLOT_W,
          i === 3 ? ease(at(p, 0.1, 0.65)) : 1,
        );

        return (
          <>
            {/* ---------- storage ---------- */}
            <text className="t-xs t-muted" x={56} y={40} textAnchor="start">
              storage — one arena, fixed stride, ids assigned once and never reused
            </text>

            <line
              x1={slotX(0) - 6}
              y1={SLOT_Y - 16}
              x2={capacityX + 6}
              y2={SLOT_Y - 16}
              stroke="var(--layer-protocol)"
              strokeWidth={1.5}
            />
            <text
              className="t-xs"
              x={(slotX(0) + capacityX) / 2}
              y={SLOT_Y - 22}
              fill="var(--layer-protocol)"
            >
              capacity {frame.capacity}
            </text>

            {Array.from({ length: 9 }, (_, n) => {
              const id = 40 + n;
              if (n >= frame.capacity) return null;

              const live = frame.active.includes(id);
              const isNew = live && !previous.active.includes(id);
              const focused = id === FOCUSED;

              return (
                <g key={id} opacity={isNew ? settle : 1}>
                  <rect
                    x={slotX(n)}
                    y={SLOT_Y}
                    width={SLOT_W}
                    height={SLOT_H}
                    rx={7}
                    fill={live ? "var(--raised)" : "var(--surface)"}
                    stroke={live ? "var(--layer-runtime)" : "var(--rule)"}
                    strokeWidth={live ? 1.5 : 1}
                    strokeDasharray={live ? undefined : "4 3"}
                    opacity={live ? 1 : 0.55}
                  />
                  <text
                    className="t-xs"
                    x={slotX(n) + SLOT_W / 2}
                    y={SLOT_Y + 20}
                    fill={live ? "var(--layer-protocol)" : "var(--ink-muted)"}
                  >
                    node {id}
                  </text>
                  <line
                    x1={slotX(n) + 10}
                    y1={SLOT_Y + 28}
                    x2={slotX(n) + SLOT_W - 10}
                    y2={SLOT_Y + 28}
                    stroke="var(--rule)"
                  />
                  <text
                    className={live ? "t-sm t-ink" : "t-xs t-muted"}
                    x={slotX(n) + SLOT_W / 2}
                    y={SLOT_Y + 51}
                  >
                    {live ? CONTENT[id] : "spare"}
                  </text>

                  {focused && (
                    <>
                      <rect
                        x={slotX(n) - 4}
                        y={SLOT_Y - 4}
                        width={SLOT_W + 8}
                        height={SLOT_H + 8}
                        rx={9}
                        fill="none"
                        stroke="var(--status-warning)"
                        strokeWidth={2}
                      />
                      <text
                        className="t-xs"
                        x={slotX(n) + SLOT_W / 2}
                        y={SLOT_Y + SLOT_H + 22}
                        fill="var(--status-warning)"
                      >
                        ▲ focus — never moves
                      </text>
                    </>
                  )}
                </g>
              );
            })}

            {/* ---------- order ---------- */}
            <text className="t-xs t-muted" x={56} y={214} textAnchor="start">
              order — the sibling chain, and the only thing a sort rewrites
            </text>

            {frame.order.map((id, k) => {
              const was = previous.order.indexOf(id);
              // A row that changed position slides there; one that is new fades in.
              const x = was === -1 ? pillX(k) : lerp(pillX(was), pillX(k), settle);
              const appearing = was === -1;
              const moved = was !== -1 && was !== k;

              return (
                <g key={id} opacity={appearing ? settle : 1}>
                  {k > 0 && (
                    <text className="t-xs t-muted" x={pillX(k) - PILL_GAP / 2} y={PILL_Y + 22}>
                      ›
                    </text>
                  )}
                  <rect
                    x={x}
                    y={PILL_Y}
                    width={PILL_W}
                    height={PILL_H}
                    rx={17}
                    fill="var(--raised)"
                    stroke={
                      id === FOCUSED
                        ? "var(--status-warning)"
                        : moved
                          ? "var(--layer-runtime)"
                          : "var(--rule)"
                    }
                    strokeWidth={moved || id === FOCUSED ? 1.6 : 1}
                  />
                  <text className="t-sm t-ink" x={x + PILL_W / 2} y={PILL_Y + 22}>
                    {CONTENT[id]}
                  </text>
                </g>
              );
            })}

            {i === 1 && (
              <text
                className="t-xs"
                x={700}
                y={PILL_Y + 22}
                fill="var(--status-good)"
                opacity={easeOut(at(p, 0.45, 0.9))}
              >
                3 link writes · 0 bytes of storage touched
              </text>
            )}

            {i === 3 && (
              <text
                className="t-xs"
                x={700}
                y={PILL_Y + 22}
                fill="var(--status-good)"
                opacity={easeOut(at(p, 0.55, 0.95))}
              >
                40–45 unchanged · 46 appended · none reused
              </text>
            )}

            <text className="t-xs t-muted" x={480} y={306}>
              the engine is told which links changed — it is never handed a new tree
            </text>
          </>
        );
  },
};
