/**
 * Figure 3 — why the boundary is memory, and why it is struct-of-arrays.
 *
 * This is the load-bearing figure. The shared-memory bet is easy to state and
 * easy to disbelieve, and the usual justification given for SoA — monomorphic
 * reads — is not actually the strong one. The strong one is what this figure
 * draws: because a field is a contiguous span, a diff over spans turns "some
 * bytes changed" into a named, narrow patch. Under array-of-structs the same
 * change is scattered and the same diff tells you nothing.
 */
import { Cell, type FigureSpec } from "./Figure.tsx";
import { at, easeOut, type Step } from "./timeline.ts";

const STEPS: Step[] = [
  {
    label: "Two layouts",
    caption:
      "Twenty-four values: four fields for each of six nodes. Array-of-structs keeps each node together. Struct-of-arrays keeps each field together. Same bytes, same total, different order.",
  },
  {
    label: "One patch",
    caption:
      "Now change every node's background — a theme toggle, say. Under array-of-structs the writes are scattered across the whole block. Under struct-of-arrays they are one contiguous run.",
    ms: 3200,
  },
  {
    label: "Commit",
    caption:
      "Bun writes into a staged arena, never into the live one. On tick, the engine walks the two span by span. Twenty-four values compared; one span differs.",
    ms: 3400,
  },
  {
    label: "A named patch",
    caption:
      "What comes out is not a boolean. It is: the bg span changed, nodes 0 through 5. That is a patch the engine can act on narrowly — and it is the same mechanism that will make a render thread safe.",
    ms: 3400,
  },
];

const FIELDS = ["bg", "pad", "w", "h"];
const NODES = 6;
const CW = 34;
const CH = 30;

const AOS_X = 52;
const AOS_Y = 74;
const RECORD_GAP = 8;
const aosX = (node: number, field: number) => AOS_X + node * (FIELDS.length * CW + RECORD_GAP) + field * CW;

const SOA_X = 52;
const SPAN_GAP = 12;
const soaX = (field: number, node: number) => SOA_X + field * (NODES * CW + SPAN_GAP) + node * CW;

const STAGED_Y = 196;
const LIVE_Y = 268;

const CHANGED_FIELD = 0; // bg

export const MEMORY: FigureSpec = {
  id: "fig-memory",
  title: "Why struct-of-arrays, and why it is not about speed",
  thesis:
    "A field that is contiguous can be diffed as a unit. That is what turns a block of changed bytes into a patch with a name.",
  height: 360,
  steps: STEPS,
  files: ["src/protocol/schema.ts", "native-src/dziry-engine/src/tables.rs"],
  draw: (i, p) => {
        const patched = i >= 1;
        const reveal = i === 1 ? easeOut(at(p, 0.15, 0.75)) : patched ? 1 : 0;
        const aosFaded = i >= 2 ? 0.3 : 1;
        const scanning = i === 2 ? at(p, 0.15, 0.9) : i > 2 ? 1 : 0;
        const scanX = SOA_X + scanning * (FIELDS.length * NODES * CW + 3 * SPAN_GAP);

        return (
          <>
            {/* ---------- array of structs ---------- */}
            <g opacity={aosFaded}>
              <text className="t-xs t-muted" x={AOS_X} y={44} textAnchor="start">
                array-of-structs — one record per node
              </text>
              {patched && (
                <text
                  className="t-xs"
                  x={908}
                  y={44}
                  textAnchor="end"
                  fill="var(--status-critical)"
                  opacity={reveal}
                >
                  6 scattered writes · nothing contiguous to name
                </text>
              )}
              {Array.from({ length: NODES }, (_, n) => (
                <g key={n}>
                  {FIELDS.map((f, k) => {
                    const hit = patched && k === CHANGED_FIELD;
                    return (
                      <Cell
                        key={f}
                        x={aosX(n, k)}
                        y={AOS_Y}
                        w={CW}
                        h={CH}
                        label={f}
                        fill={hit ? "var(--layer-engine)" : undefined}
                        stroke={hit ? "var(--layer-engine)" : undefined}
                        opacity={hit ? 0.35 + 0.65 * reveal : 1}
                      />
                    );
                  })}
                  <text
                    className="t-xs t-muted"
                    x={aosX(n, 0) + (FIELDS.length * CW) / 2}
                    y={AOS_Y + CH + 13}
                  >
                    node {n}
                  </text>
                </g>
              ))}
            </g>

            {/* ---------- struct of arrays ---------- */}
            <text className="t-xs t-muted" x={SOA_X} y={166} textAnchor="start">
              struct-of-arrays — one span per field {i >= 2 && "· staged"}
            </text>
            {patched && (
              <text
                className="t-xs"
                x={908}
                y={166}
                textAnchor="end"
                fill="var(--status-good)"
                opacity={reveal}
              >
                one run, and it has a name
              </text>
            )}

            {FIELDS.map((f, k) => (
              <g key={f}>
                {Array.from({ length: NODES }, (_, n) => {
                  const hit = patched && k === CHANGED_FIELD;
                  return (
                    <Cell
                      key={n}
                      x={soaX(k, n)}
                      y={STAGED_Y}
                      w={CW}
                      h={CH}
                      label={String(n)}
                      fill={hit ? "var(--layer-engine)" : undefined}
                      stroke={hit ? "var(--layer-engine)" : undefined}
                      opacity={hit ? 0.35 + 0.65 * reveal : 1}
                    />
                  );
                })}
                <text
                  className="t-xs t-muted"
                  x={soaX(k, 0) + (NODES * CW) / 2}
                  y={STAGED_Y - 8}
                >
                  {f}
                </text>
              </g>
            ))}

            {/* ---------- the live arena, and the scan ---------- */}
            {i >= 2 && (
              <g opacity={easeOut(at(p, 0, 0.3))}>
                <text className="t-xs t-muted" x={SOA_X} y={LIVE_Y - 8} textAnchor="start">
                  live
                </text>
                {FIELDS.map((f, k) =>
                  Array.from({ length: NODES }, (_, n) => (
                    <Cell
                      key={`${f}${n}`}
                      x={soaX(k, n)}
                      y={LIVE_Y}
                      w={CW}
                      h={CH}
                      label={String(n)}
                    />
                  )),
                )}

                {/* the comparison sweep */}
                <line
                  x1={scanX}
                  y1={STAGED_Y - 6}
                  x2={scanX}
                  y2={LIVE_Y + CH + 6}
                  stroke="var(--layer-protocol)"
                  strokeWidth={2}
                  opacity={i === 2 ? 1 : 0}
                />

                {/* per-span verdicts, revealed as the sweep passes */}
                {FIELDS.map((f, k) => {
                  const spanEnd = soaX(k, NODES - 1) + CW;
                  const passed = scanX >= spanEnd || i > 2;
                  const changed = k === CHANGED_FIELD;
                  return (
                    <text
                      key={f}
                      className="t-xs"
                      x={soaX(k, 0) + (NODES * CW) / 2}
                      y={LIVE_Y + CH + 20}
                      fill={changed ? "var(--status-serious)" : "var(--ink-muted)"}
                      opacity={passed ? 1 : 0}
                    >
                      {changed ? "changed" : "same"}
                    </text>
                  );
                })}
              </g>
            )}

            {/* ---------- the patch that comes out ---------- */}
            {i >= 3 && (
              <g opacity={easeOut(at(p, 0.15, 0.6))}>
                <rect
                  x={SOA_X}
                  y={318}
                  width={856}
                  height={32}
                  rx={6}
                  fill="var(--raised)"
                  stroke="var(--layer-protocol)"
                  strokeWidth={1.5}
                />
                <text className="t-sm t-ink" x={SOA_X + 14} y={338} textAnchor="start">
                  diff: styles.bg — nodes 0…5
                </text>
                <text className="t-xs t-muted" x={SOA_X + 842} y={338} textAnchor="end">
                  under AoS this would read "24 bytes somewhere in the block changed"
                </text>
              </g>
            )}
          </>
        );
  },
};
