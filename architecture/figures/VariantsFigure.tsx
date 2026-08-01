/**
 * Figure 5 — hover, with no cascade at run time.
 *
 * The thing worth showing is that combinations are not special-cased. A node
 * that reads two predicates has four entries in its run, and `hover ∧ focus` is
 * simply the entry at index 3 — resolved by the compiler as a full cascade,
 * exactly like the base was.
 */
import { Cell, type FigureSpec } from "./Figure.tsx";
import { at, easeOut, type Step } from "./timeline.ts";

const STEPS: Step[] = [
  {
    label: "Predicates",
    caption:
      "The compiler defines the predicates the sheet actually mentions — a fixed, numbered set. Nothing here is a string to be matched later.",
  },
  {
    label: "Live",
    caption:
      "At any instant the world has some of them true. The pointer is over this card, and nothing is focused.",
  },
  {
    label: "The mask",
    caption:
      "This node carries a mask of the predicates its own styling reads. It reads self:hover and its group's hover; whether something is focused cannot change how it looks, so those bits are not in the mask.",
    ms: 3200,
  },
  {
    label: "AND",
    caption:
      "Live AND mask. Two bits survive as candidates, one of them set. A node that reads nothing lands on zero and never leaves its base style.",
  },
  {
    label: "One u16",
    caption:
      "Compact the surviving bits to a dense index, add it to the run start, read one u16. Four entries because two predicates — and hover ∧ focus is not a merge, it is entry 3, resolved by the compiler as a full cascade like every other entry.",
    ms: 3800,
  },
];

const PREDICATES = [
  { name: "self:hover", bit: 0, live: true, inMask: true },
  { name: "self:active", bit: 1, live: false, inMask: false },
  { name: "self:focus-visible", bit: 2, live: false, inMask: false },
  { name: "group-card:hover", bit: 3, live: false, inMask: true },
];

const COL_W = 200;
const COL_X = (n: number) => 56 + n * (COL_W + 16);
const cx = (n: number) => COL_X(n) + COL_W / 2;

const BIT_W = 46;
const BIT_H = 32;

const RUN = [
  { bits: "00", slot: "styles[7]", note: "base" },
  { bits: "01", slot: "styles[8]", note: "hovered" },
  { bits: "10", slot: "styles[9]", note: "group hovered" },
  { bits: "11", slot: "styles[10]", note: "both, cascaded" },
];

export const VARIANTS: FigureSpec = {
  id: "fig-variants",
  title: "Hover costs one u16",
  thesis:
    "Interaction state is a bitmask indexed into a precompiled run. There is no selector matching at run time, and combinations are not a special case.",
  height: 400,
  steps: STEPS,
  files: ["src/protocol/schema.ts", "src/compiler/variant-compile.ts", "native-src/dziri-engine/src/paint.rs"],
  draw: (i, p) => {
        const activeIndex = 1; // live & mask, compacted
        const fade = (from: number) => (i >= from ? (i === from ? easeOut(at(p, 0.1, 0.6)) : 1) : 0);

        return (
          <>
            {/* predicates */}
            <text className="t-xs t-muted" x={56} y={28} textAnchor="start">
              predicates the compiler defined
            </text>
            {PREDICATES.map((pred, n) => (
              <g key={pred.name} opacity={fade(0)}>
                <rect
                  x={COL_X(n)}
                  y={38}
                  width={COL_W}
                  height={34}
                  rx={6}
                  fill="var(--raised)"
                  stroke="var(--rule)"
                />
                <text className="t-sm t-ink" x={cx(n)} y={59}>
                  {pred.name}
                </text>
                <text className="t-xs t-muted" x={COL_X(n) + 10} y={59} textAnchor="start">
                  {pred.bit}
                </text>
              </g>
            ))}

            {/* live */}
            <text className="t-xs t-muted" x={56} y={112} textAnchor="start">
              live right now
            </text>
            {PREDICATES.map((pred, n) => (
              <g key={pred.name} opacity={fade(1)}>
                <Cell
                  x={cx(n) - BIT_W / 2}
                  y={120}
                  w={BIT_W}
                  h={BIT_H}
                  label={pred.live ? "1" : "0"}
                  fill={pred.live ? "var(--layer-runtime)" : undefined}
                  stroke={pred.live ? "var(--layer-runtime)" : undefined}
                />
              </g>
            ))}

            {/* mask */}
            <text className="t-xs t-muted" x={56} y={190} textAnchor="start">
              node 12's mask — what its styling reads
            </text>
            {PREDICATES.map((pred, n) => (
              <g key={pred.name} opacity={fade(2)}>
                <Cell
                  x={cx(n) - BIT_W / 2}
                  y={198}
                  w={BIT_W}
                  h={BIT_H}
                  label={pred.inMask ? "1" : "0"}
                  fill={pred.inMask ? "var(--layer-protocol)" : undefined}
                  stroke={pred.inMask ? "var(--layer-protocol)" : undefined}
                />
              </g>
            ))}

            {/* and */}
            <text className="t-xs t-muted" x={56} y={268} textAnchor="start">
              live &amp; mask
            </text>
            {PREDICATES.map((pred, n) => {
              const on = pred.live && pred.inMask;
              const kept = pred.inMask;
              return (
                <g key={pred.name} opacity={fade(3) * (kept ? 1 : 0.28)}>
                  <Cell
                    x={cx(n) - BIT_W / 2}
                    y={276}
                    w={BIT_W}
                    h={BIT_H}
                    label={on ? "1" : "0"}
                    fill={on ? "var(--layer-engine)" : undefined}
                    stroke={on ? "var(--layer-engine)" : kept ? "var(--rule-strong)" : undefined}
                  />
                  {i >= 3 && !kept && (
                    <text className="t-xs t-muted" x={cx(n)} y={324}>
                      dropped
                    </text>
                  )}
                </g>
              );
            })}

            {/* compaction + the run */}
            {i >= 4 && (
              <g opacity={fade(4)}>
                <text className="t-xs t-muted" x={56} y={350} textAnchor="start">
                  compacted to 2 bits → 01 → variantSlots[runStart + 1]
                </text>
                {RUN.map((entry, n) => {
                  const x = 470 + n * 118;
                  const chosen = n === activeIndex;
                  return (
                    <g key={entry.bits}>
                      <rect
                        x={x}
                        y={330}
                        width={110}
                        height={44}
                        rx={6}
                        fill={chosen ? "var(--layer-engine)" : "var(--surface)"}
                        fillOpacity={chosen ? 0.22 : 1}
                        stroke={chosen ? "var(--layer-engine)" : "var(--rule)"}
                        strokeWidth={chosen ? 1.8 : 1}
                      />
                      <text className="t-sm t-ink" x={x + 55} y={348}>
                        {entry.bits} · {entry.slot}
                      </text>
                      <text className="t-xs t-muted" x={x + 55} y={363}>
                        {entry.note}
                      </text>
                    </g>
                  );
                })}
              </g>
            )}
          </>
        );
  },
};
