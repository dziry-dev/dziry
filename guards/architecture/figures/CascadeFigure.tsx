/**
 * Figure 2 — the cascade, run once, on a table.
 *
 * The bet this figure has to make believable is that resolving CSS early loses
 * nothing. So it runs the real algorithm — match, sort by specificity, take the
 * winner per property — and only then shows the result being frozen. The hover
 * state is resolved the same way rather than as a diff over the base, because
 * that is the detail the whole variant design rests on.
 */
import { Arrow, Box, type FigureSpec } from "./Figure.tsx";
import { at, easeOut, lerp, type Step } from "./timeline.ts";

const STEPS: Step[] = [
  {
    label: "The sheet",
    caption:
      "Four rules mention .card. At run time a browser would have to work out which of them apply to this element, and it would do it again the next time the element changed.",
  },
  {
    label: "Match",
    caption:
      "Three match; #sidebar .card does not, because this card is not in the sidebar. Matching happens against the tree the compiler just built, so the answer is knowable now.",
  },
  {
    label: "Specificity",
    caption:
      "The matched rules sort. Two class selectors beat one — .panel .card wins padding from .card, and nothing outranks .card for background.",
  },
  {
    label: "Per property",
    caption:
      "The winner is taken property by property, not rule by rule. padding comes from one rule and background from another, which is what makes this a cascade rather than a lookup.",
    ms: 3200,
  },
  {
    label: "Hover too",
    caption:
      "The hover state is resolved as a full cascade from scratch, not as a patch over the finished base. That is why hover ∧ focus merges correctly later: the machinery that computes the combination already exists here.",
    ms: 3200,
  },
  {
    label: "Intern",
    caption:
      "Both results are interned into the style table. Two elements that resolved identically share a slot, and the node keeps an index rather than a style — this card is now the number 7.",
    ms: 3000,
  },
];

type Rule = { sel: string; decl: string; spec: string; matches: boolean; state?: boolean };

const RULES: Rule[] = [
  { sel: ".card", decl: "padding: 14px; background: #1b1b1f", spec: "0,1,0", matches: true },
  { sel: ".panel .card", decl: "padding: 8px", spec: "0,2,0", matches: true },
  { sel: "#sidebar .card", decl: "padding: 2px", spec: "1,1,0", matches: false },
  { sel: ".card:hover", decl: "background: #26262c", spec: "0,2,0", matches: true, state: true },
];

// The element sits across the top rather than in the middle: the winning
// declarations have to travel left-to-right past it, and an arrow through the
// thing being styled reads as "this rule hit the element" when it means the
// opposite.
const RULE_X = 26;
const RULE_W = 344;
const RULE_H = 48;
const RULE_GAP = 10;
const ruleY = (n: number) => 100 + n * (RULE_H + RULE_GAP);

/**
 * Where a rule sits once the matched ones have closed ranks and sorted.
 *
 * The rejected rule gets a slot too — the last one. Leaving it in place instead
 * put it underneath `.card:hover` as that rule rose past it, which read as one
 * garbled box rather than as a rule being set aside.
 */
const SORTED_SLOT: Record<number, number> = { 0: 0, 1: 1, 3: 2, 2: 3 };

const OUT_X = 590;
const OUT_W = 344;

export const CASCADE: FigureSpec = {
  id: "fig-cascade",
  title: "The cascade, resolved once",
  thesis:
    "Match, sort, take the winner per property — the same algorithm a browser runs, moved to a machine that is not holding a frame open.",
  height: 356,
  steps: STEPS,
  files: ["src/compiler/compile.ts", "src/compiler/css.ts", "src/ir.ts"],
  draw: (i, p) => {
        const sorting = i >= 2 ? easeOut(at(p, 0, 0.6)) : 0;
        const settled = i > 2 ? 1 : sorting;

        return (
          <>
            {/* --- the target, across the top -------------------------------- */}
            <g>
              <Box x={370} y={22} w={220} h={46} tone="var(--layer-authoring)" />
              <text className="t-sm t-ink" x={480} y={42}>
                &lt;div class="card"&gt;
              </text>
              <text className="t-xs t-muted" x={480} y={57}>
                inside .panel, not in #sidebar
              </text>
            </g>
            <text className="t-xs t-muted" x={RULE_X} y={86} textAnchor="start">
              app.css — four rules mention .card
            </text>
            <text className="t-xs t-muted" x={OUT_X + OUT_W} y={86} textAnchor="end">
              what gets shipped
            </text>

            {/* --- rules ----------------------------------------------------- */}
            {RULES.map((r, n) => {
              const rejected = i >= 1 && !r.matches;
              const slot = SORTED_SLOT[n];
              const y = lerp(ruleY(n), slot === undefined ? ruleY(n) : ruleY(slot), settled);
              const tone = r.state
                ? "var(--layer-engine)"
                : r.matches
                  ? "var(--layer-compiler)"
                  : "var(--rule-strong)";

              return (
                <g key={r.sel} opacity={rejected ? 0.28 : 1}>
                  <Box
                    x={RULE_X}
                    y={y}
                    w={RULE_W}
                    h={RULE_H}
                    tone={i >= 1 && r.matches ? tone : undefined}
                    lit={!rejected}
                  />
                  <text className="t-sm t-ink" x={RULE_X + 13} y={y + 20} textAnchor="start">
                    {r.sel}
                  </text>
                  <text className="t-xs t-muted" x={RULE_X + 13} y={y + 36} textAnchor="start">
                    {r.decl}
                  </text>

                  {i === 1 && (
                    <text
                      className="t-xs"
                      x={RULE_X + RULE_W - 14}
                      y={y + 29}
                      textAnchor="end"
                      fill={r.matches ? "var(--status-good)" : "var(--status-critical)"}
                      opacity={easeOut(at(p, 0.15, 0.6))}
                    >
                      {r.matches ? "✓ matches" : "✗ no"}
                    </text>
                  )}

                  {i >= 2 && r.matches && (
                    <text
                      className="t-xs"
                      x={RULE_X + RULE_W - 14}
                      y={y + 29}
                      textAnchor="end"
                      fill="var(--ink-muted)"
                      opacity={settled}
                    >
                      {r.spec}
                    </text>
                  )}
                </g>
              );
            })}

            {/* --- transfer of winning declarations -------------------------- */}
            {/* Sorted slot 1 wins padding, slot 0 wins background — the arrows
                cross, and that crossing IS the point of a per-property cascade. */}
            {i >= 3 &&
              [
                { fromSlot: 1, y: 128, tone: "var(--layer-compiler)" },
                { fromSlot: 0, y: 154, tone: "var(--layer-compiler)" },
              ].map((t, n) => (
                <Arrow
                  key={n}
                  x1={RULE_X + RULE_W + 6}
                  y1={ruleY(t.fromSlot) + RULE_H / 2}
                  x2={OUT_X - 8}
                  y2={t.y}
                  tone={t.tone}
                  opacity={i === 3 ? easeOut(at(p, 0.1 + n * 0.2, 0.5 + n * 0.2)) : 0.4}
                />
              ))}

            {i >= 4 && (
              <Arrow
                x1={RULE_X + RULE_W + 6}
                y1={ruleY(2) + RULE_H / 2}
                x2={OUT_X - 8}
                y2={228}
                tone="var(--layer-engine)"
                opacity={i === 4 ? easeOut(at(p, 0.1, 0.5)) : 0.4}
              />
            )}

            {/* --- results --------------------------------------------------- */}
            {i >= 3 && (
              <g opacity={i === 3 ? easeOut(at(p, 0.25, 0.7)) : 1}>
                <Box x={OUT_X} y={100} w={OUT_W} h={76} tone="var(--layer-compiler)" />
                <text className="t-xs t-muted" x={OUT_X + 14} y={118} textAnchor="start">
                  base
                </text>
                <text className="t-sm t-ink" x={OUT_X + 14} y={140} textAnchor="start">
                  padding 8 8 8 8
                </text>
                <text className="t-xs t-muted" x={OUT_X + OUT_W - 14} y={140} textAnchor="end">
                  .panel .card
                </text>
                <text className="t-sm t-ink" x={OUT_X + 14} y={162} textAnchor="start">
                  background 0xff1b1b1f
                </text>
                <text className="t-xs t-muted" x={OUT_X + OUT_W - 14} y={162} textAnchor="end">
                  .card
                </text>
              </g>
            )}

            {i >= 4 && (
              <g opacity={i === 4 ? easeOut(at(p, 0.25, 0.7)) : 1}>
                <Box x={OUT_X} y={196} w={OUT_W} h={64} tone="var(--layer-engine)" />
                <text className="t-xs t-muted" x={OUT_X + 14} y={214} textAnchor="start">
                  :hover — a second full cascade, not a diff
                </text>
                <text className="t-sm t-ink" x={OUT_X + 14} y={238} textAnchor="start">
                  padding 8 · background 0xff26262c
                </text>
              </g>
            )}

            {/* --- interning -------------------------------------------------- */}
            {i >= 5 && (
              <g opacity={easeOut(at(p, 0.1, 0.55))}>
                <Box x={OUT_X} y={280} w={OUT_W} h={56} tone="var(--layer-protocol)" />
                <text className="t-sm t-ink" x={OUT_X + 14} y={302} textAnchor="start">
                  styles[7] · styles[8]
                </text>
                <text className="t-xs t-muted" x={OUT_X + 14} y={320} textAnchor="start">
                  node 12 stores the number 7, and nothing else
                </text>
              </g>
            )}
          </>
        );
  },
};
