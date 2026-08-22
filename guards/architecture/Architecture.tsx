/**
 * The view. All of the prose lives in `data.ts`; all of the numbers come from
 * `metrics` (measured per request) or from `src/protocol/schema.ts` (imported
 * directly, so the protocol tab is the protocol rather than a copy of it).
 *
 * Nothing here should ever contain a fact. If you find yourself typing a line
 * count or a field name into this file, it belongs on the other side.
 */
import { useEffect, useMemo, useState } from "react";
import { ELEM_SIZE, PROTOCOL_VERSION, TABLES } from "../src/protocol/schema.ts";
import {
  BETS,
  DOCS,
  GUARDS,
  LAYERS,
  MILESTONES,
  STAGES,
  TABLE_ROLES,
  type LayerId,
  type Phase,
  type Stage,
} from "./data.ts";
import type { Metrics } from "./metrics.ts";
import { HowItWorks } from "./HowItWorks.tsx";

type TabId = "how" | "pipeline" | "protocol" | "modules" | "roadmap";

const TABS: { id: TabId; label: string }[] = [
  { id: "how", label: "How it works" },
  { id: "pipeline", label: "Pipeline" },
  { id: "protocol", label: "The boundary" },
  { id: "modules", label: "Modules" },
  { id: "roadmap", label: "Bets & roadmap" },
];

const BANDS: { phase: Phase; label: string }[] = [
  { phase: "build", label: "Build time · runs once, and none of it ships" },
  { phase: "boundary", label: "The boundary · shared memory, described at startup" },
  { phase: "frame", label: "Every frame · the loop" },
];

type Theme = "system" | "light" | "dark";

const THEME_KEY = "dziry-arch-theme";

/** Reading it back on mount is what stops a hot reload throwing the choice away. */
function storedTheme(): Theme {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

const layerColor = (id: LayerId) => `var(--layer-${id})`;
const layerLabel = (id: LayerId) => LAYERS.find((l) => l.id === id)?.label ?? id;
const num = (n: number) => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------

export function Architecture({ metrics }: { metrics: Metrics | null }) {
  const [tab, setTab] = useState<TabId>("how");
  const [theme, setTheme] = useState<Theme>(storedTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const cycleTheme = () =>
    setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"));

  const styleFieldCount = TABLES.find((t) => t.name === "styles")?.fields.length ?? 0;

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1 className="wordmark">dziry — architecture</h1>
          <p className="thesis">
            A UI framework that resolves CSS, the cascade and every interaction state{" "}
            <em>before the app runs</em>, then hands a native Rust engine a block of shared memory
            instead of a call surface. This page is generated from the repo — the numbers are
            measured, and the tables are imported from the protocol schema itself.
          </p>
        </div>
        <button className="iconbtn" onClick={cycleTheme} title="Cycle light / dark / system">
          theme: {theme}
        </button>
      </header>

      <div className="stat-row">
        <Stat value={metrics ? num(metrics.totals.typescript) : "—"} label="TypeScript lines" />
        <Stat value={metrics ? num(metrics.totals.rust) : "—"} label="Rust lines" />
        <Stat value={metrics ? num(metrics.totals.testLines) : "—"} label="of that, tests" />
        <Stat value={String(TABLES.length)} label="shared tables" />
        <Stat value={String(styleFieldCount)} label="style fields" />
        <Stat value={`v${PROTOCOL_VERSION}`} label="protocol" />
      </div>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            className="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "how" && <HowItWorks />}
      {tab === "pipeline" && <PipelineView metrics={metrics} />}
      {tab === "protocol" && <ProtocolView />}
      {tab === "modules" && <ModulesView metrics={metrics} />}
      {tab === "roadmap" && <RoadmapView />}

      <p className="footnote">
        {metrics
          ? `measured ${new Date(metrics.measuredAt).toLocaleString()} · ${metrics.files.length} source files scanned`
          : "metrics unavailable — is the dev server running?"}
        {" · "}
        edit <code>guards/architecture/data.ts</code>, then run <code>bun run arch:check</code>
      </p>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Legend({
  active,
  onToggle,
}: {
  active?: LayerId | null;
  onToggle?: (id: LayerId) => void;
}) {
  return (
    <ul className="legend">
      {LAYERS.map((l) => (
        <li
          key={l.id}
          style={{
            cursor: onToggle ? "pointer" : undefined,
            opacity: !active || active === l.id ? 1 : 0.45,
          }}
          onClick={() => onToggle?.(l.id)}
        >
          <span className="swatch" style={{ ["--swatch" as string]: layerColor(l.id) }} />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function PipelineView({ metrics }: { metrics: Metrics | null }) {
  const [selected, setSelected] = useState<string>(STAGES[0]!.id);
  const stage = STAGES.find((s) => s.id === selected) ?? STAGES[0]!;

  return (
    <>
      <p className="section-intro">
        Left to right, top to bottom: what happens once at build time, what crosses the boundary,
        and what happens on every frame. Pick a stage for what it does, which files do it, and what
        a refactor there must not break.
      </p>
      <Legend />
      <div className="pipeline-grid">
        <div>
          {BANDS.map((band) => {
            const stages = STAGES.filter((s) => s.phase === band.phase);
            const offset = STAGES.findIndex((s) => s.phase === band.phase);
            return (
              <section className="band-group" key={band.phase}>
                <h2 className="band">{band.label}</h2>
                <div className="stage-row">
                  {stages.map((s, i) => (
                    <button
                      key={s.id}
                      className="stage"
                      aria-pressed={s.id === selected}
                      style={{ ["--stage-color" as string]: layerColor(s.layer) }}
                      onClick={() => setSelected(s.id)}
                    >
                      <span className="stage-index">
                        {String(offset + i + 1).padStart(2, "0")} · {layerLabel(s.layer)}
                      </span>
                      <div className="stage-title">{s.title}</div>
                      <div className="stage-summary">{s.summary}</div>
                    </button>
                  ))}
                </div>
                {band.phase === "frame" && (
                  <div className="loopback">a signal changed → back to the staged arena</div>
                )}
              </section>
            );
          })}
        </div>

        <StageDetail stage={stage} metrics={metrics} />
      </div>
    </>
  );
}

function StageDetail({ stage, metrics }: { stage: Stage; metrics: Metrics | null }) {
  return (
    <aside className="detail" style={{ ["--stage-color" as string]: layerColor(stage.layer) }}>
      <div className="stage-index">{layerLabel(stage.layer)}</div>
      <h3>{stage.title}</h3>
      {stage.detail.map((p, i) => (
        <p key={i}>{p}</p>
      ))}

      {stage.facts && stage.facts.length > 0 && (
        <>
          <div className="detail-label">Worth knowing</div>
          <ul className="factlist">
            {stage.facts.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </>
      )}

      <div className="detail-label">Code</div>
      <div className="filelist">
        {stage.files.map((path) => {
          const file = metrics?.files.find((f) => f.path === path);
          return (
            <div className="file" key={path}>
              <span className={file || !metrics ? "" : "file-missing"}>{path}</span>
              <span className="file-lines">
                {file ? `${num(file.lines)} L` : metrics ? "missing" : ""}
              </span>
            </div>
          );
        })}
      </div>

      {stage.invariant && (
        <>
          <div className="detail-label" />
          <div className="invariant">
            <strong>Do not undo</strong>
            {stage.invariant}
          </div>
        </>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

function ProtocolView() {
  return (
    <>
      <p className="section-intro">
        One schema generates both sides. Layout is struct-of-arrays — every field is its own
        contiguous span — so a style patch touches one array and paint stays monomorphic. These
        tables are imported live from <code>src/protocol/schema.ts</code>: if the schema changes,
        this page changes with it.
      </p>
      <ul className="legend">
        <li>
          <span className="affects affects-layout" /> layout-affecting — the engine must tell Taffy
        </li>
        <li>
          <span className="affects affects-paint" /> paint-only — the repaint already scheduled is
          the whole response
        </li>
      </ul>

      {TABLES.map((table) => {
        const role = TABLE_ROLES[table.name];
        const bytes = table.fields.reduce((n, f) => n + ELEM_SIZE[f.type], 0);
        return (
          <div className="table-card" key={table.name}>
            <div className="table-head">
              <span className="table-name">{table.name}</span>
              <span className="pill">
                {table.fields.length} field{table.fields.length === 1 ? "" : "s"}
              </span>
              <span className="pill">{bytes} B/elem</span>
              <span className="pill">sized by {table.sizedBy}</span>
            </div>
            {role && (
              <p className="flow">
                {role.writer}
                <span className="arrow">→</span>
                {role.reader}
              </p>
            )}
            <div className="fields">
              {table.fields.map((f) => (
                <span
                  className="field"
                  key={f.name}
                  title={[f.doc, f.affects && `${f.affects}-affecting`].filter(Boolean).join(" · ")}
                >
                  {f.affects && <span className={`affects affects-${f.affects}`} />}
                  {f.name}
                  <span className="field-type">{f.type}</span>
                </span>
              ))}
            </div>
            <p className="note">{role ? role.note : table.doc}</p>
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

function ModulesView({ metrics }: { metrics: Metrics | null }) {
  const [filter, setFilter] = useState<LayerId | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null);

  const shown = useMemo(() => {
    if (!metrics) return [];
    const all = filter ? metrics.files.filter((f) => f.layer === filter) : metrics.files;
    return showAll ? all : all.slice(0, 30);
  }, [metrics, filter, showAll]);

  if (!metrics) return <p className="section-intro">No metrics — start the dev server.</p>;

  const max = Math.max(1, ...shown.map((f) => f.lines));
  const hidden = (filter ? metrics.files.filter((f) => f.layer === filter) : metrics.files).length -
    shown.length;

  return (
    <>
      <p className="section-intro">
        Every source file in the tree, by size, coloured by the layer it belongs to. Faded bars are
        test files. Click a layer to filter.
      </p>

      <div className="layer-summary">
        {LAYERS.map((l) => {
          const b = metrics.totals.byLayer[l.id];
          return (
            <div
              className="layer-card"
              key={l.id}
              style={{ ["--card-color" as string]: layerColor(l.id) }}
            >
              <h3>{l.label}</h3>
              <p>{l.blurb}</p>
              <span className="layer-count">
                {b ? `${num(b.source)} source · ${num(b.test)} test · ${b.files} files` : "—"}
              </span>
            </div>
          );
        })}
      </div>

      <Legend active={filter} onToggle={(id) => setFilter(filter === id ? null : id)} />

      <div className="bars">
        {shown.map((f) => (
          <div
            className={`bar-row${f.test ? " bar-test" : ""}`}
            key={f.path}
            onMouseMove={(e) =>
              setHover({
                text: `${f.path} · ${num(f.lines)} lines · ${
                  f.layer ? layerLabel(f.layer) : "unassigned"
                }${f.test ? " · test" : ""}`,
                x: e.clientX,
                y: e.clientY,
              })
            }
            onMouseLeave={() => setHover(null)}
          >
            <span className="bar-label" title={f.path}>
              <span className="bar-dir">{f.path.slice(0, f.path.lastIndexOf("/") + 1)}</span>
              <span className="bar-base">{f.path.slice(f.path.lastIndexOf("/") + 1)}</span>
            </span>
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{
                  width: `${(f.lines / max) * 100}%`,
                  ["--bar-color" as string]: f.layer ? layerColor(f.layer) : "var(--rule-strong)",
                }}
              />
            </span>
            <span className="bar-value">{num(f.lines)}</span>
          </div>
        ))}
      </div>

      {hidden > 0 && (
        <button className="iconbtn" style={{ marginTop: 14 }} onClick={() => setShowAll(true)}>
          show {hidden} more
        </button>
      )}
      {showAll && (
        <button className="iconbtn" style={{ marginTop: 14 }} onClick={() => setShowAll(false)}>
          collapse
        </button>
      )}

      {hover && (
        <div
          role="tooltip"
          style={{
            position: "fixed",
            left: Math.min(hover.x + 14, window.innerWidth - 340),
            top: hover.y + 16,
            background: "var(--raised)",
            border: "1px solid var(--rule-strong)",
            borderRadius: 6,
            padding: "6px 9px",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--ink)",
            pointerEvents: "none",
            zIndex: 10,
            maxWidth: 330,
          }}
        >
          {hover.text}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bets & roadmap
// ---------------------------------------------------------------------------

function RoadmapView() {
  return (
    <>
      <h2 className="band">The six bets — reviewed 2026-07-30, all six survived</h2>
      <div className="cards">
        {BETS.map((b) => (
          <div className="card" key={b.id}>
            <span className={`badge ${b.verdict === "keep" ? "badge-good" : "badge-warning"}`}>
              {b.verdict === "keep" ? "✓ keep" : "△ keep with changes"}
            </span>
            <h3>{b.title}</h3>
            <p className="claim">{b.claim}</p>
            <p>{b.review}</p>
          </div>
        ))}
      </div>

      <h2 className="band">Where it is going</h2>
      <ul className="milestones">
        {MILESTONES.map((m) => (
          <li className="milestone" key={m.id}>
            <span className="milestone-id">{m.id}</span>
            <div>
              <div className="milestone-title">
                {m.title}
                <span className={`state state-${m.state}`}>
                  {m.state === "done"
                    ? "✓ done"
                    : m.state === "partial"
                      ? "◐ partial"
                      : m.state === "next"
                        ? "◆ next"
                        : "○ planned"}
                </span>
              </div>
              {m.note && <p className="milestone-note">{m.note}</p>}
            </div>
          </li>
        ))}
      </ul>

      <h2 className="band">What keeps the claims honest</h2>
      <p className="section-intro">
        Each of these is a <code>bun run</code> script. Several use a headless browser as an oracle
        rather than a spec reading — the rule in this repo is that browser behaviour is measured,
        not remembered.
      </p>
      <div className="guards">
        {GUARDS.map((g) => (
          <div className="guard" key={g.script}>
            <code>bun run {g.script}</code>
            <p>{g.what}</p>
            {g.oracle && <span className="oracle">oracle: {g.oracle}</span>}
          </div>
        ))}
      </div>

      <h2 className="band" style={{ marginTop: 30 }}>
        The long-form sources
      </h2>
      <ul className="doclist">
        {DOCS.map((d) => (
          <li key={d.path}>
            <code>{d.path}</code>
            <span>{d.what}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
