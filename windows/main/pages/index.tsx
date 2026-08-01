/** @jsxImportSource ../../../src/compiler */

/**
 * Everything the framework currently supports, on one screen — and now a route.
 *
 * Layout: CSS Grid with explicit tracks and a spanning cell, flexbox with
 * grow/shrink/basis, wrapping, per-item `align-self`, `aspect-ratio`, and
 * absolutely positioned children. State: a text field, a dynamic keyed list with
 * per-row handlers, derived values, and conditional classes compiled to
 * style-table patches.
 *
 * Components and `.map` on a plain array run at build time and leave nothing
 * behind. `view.map` is the exception — it compiles to a template plus an arena,
 * because its length is data.
 *
 * The density toggle stays here rather than moving to the window, because the
 * cascade it drives starts at `.app.compact`. The theme toggle is on `<Window>`,
 * where `body.light` starts.
 */
import { cn, type Props } from "../../../src/compiler/jsx-runtime.ts";
import type { ReadonlySignal } from "../../../src/runtime/signal.ts";
import {
  draft,
  view,
  remaining,
  total,
  addTodo,
  clearDraft,
  toggleDone,
  deleteTodo,
  isCompact,
  toggleTheme,
  toggleDensity,
  type Todo,
} from "../state.ts";

function Btn({ label, className, onClick }: Props & { label: string }) {
  return (
    <button className={cn("btn", className)} onClick={onClick}>
      {label}
    </button>
  );
}

/**
 * A grid cell. `wide` spans two tracks.
 *
 * `value` takes a signal *or* a literal: passing the signal object through is
 * what lets the compiler recognise the binding, so the type has to admit it.
 */
function Stat({
  value,
  label,
  className,
}: Props & { value: string | ReadonlySignal<number>; label: string }) {
  return (
    <div className={cn("stat", className)}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/**
 * A row of the list. Called once, with a recording proxy, at build time.
 *
 * Props are passed explicitly rather than spread: `{...t}` cannot work, because
 * the proxy has no keys until a real item exists. Spreading one is a compile error.
 */
function Row({ mark, title }: Props & { mark: string; title: string }) {
  return (
    <div className="todo">
      {/* Per-row handlers: one compiled handler serves every row. */}
      <button className="check" onClick={toggleDone}>
        {mark}
      </button>
      <div className="label">{title}</div>
      <button className="del" onClick={deleteTodo}>
        x
      </button>
    </div>
  );
}

/** A plain array, so this expands at build time into literal nodes. */
const CHIPS = ["flex", "grid", "wrap", "grow", "align-self", "aspect-ratio", "absolute", "gap"];

export default function Home() {
  return (
    <div className={cn("app", { compact: isCompact })}>
      <div className="header">
        <div>
          <div className="title">dziri</div>
          <div className="subtitle">Taffy lays out · Skia paints · SDL3 owns the window</div>
        </div>
        <div className="toolbar">
          <Btn label="Theme" onClick={toggleTheme} />
          <Btn label="Density" onClick={toggleDensity} />
        </div>
      </div>

      {/* Four tracks; the first cell spans two, so three cells fill one row
          exactly. Auto-placement puts the rest wherever they fit. */}
      <div className="stats">
        <Stat value="grid + flex" label="both, from one style table" className="wide" />
        <Stat value={remaining} label="remaining" />
        <Stat value={total} label="total" />
      </div>

      <div className="panels">
        <div className="card">
          <div className="card-title">Dynamic list · keyed · per-row handlers</div>

          {/* flex-grow on the field: it takes the leftover width. */}
          <div className="newrow">
            <div className="field" bindValue={draft} />
            <Btn label="Add" className="primary" onClick={addTodo} />
            <Btn label="Clear" onClick={clearDraft} />
          </div>

          <div className="list">
            {view.map(
              (t: Todo & { mark: string }) => <Row mark={t.mark} title={t.title} />,
              { key: (t: Todo) => t.id },
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Flex · wrap, align-self, aspect-ratio</div>

          <div className="chips">
            {CHIPS.map((label) => (
              <div className="chip">{label}</div>
            ))}
          </div>

          {/* Four items, three of them overriding the parent's align-items. */}
          <div className="align-demo">
            <div className="swatch" />
            <div className="swatch mid" />
            <div className="swatch low" />
            <div className="swatch tall" />
          </div>

          {/* Absolutely positioned children, out of flow. */}
          <div className="stage">
            <div className="badge">absolute</div>
            <div className="pinned">left: 10px · bottom: 10px</div>
          </div>
        </div>
      </div>

      {/* Inline styles, both forms. Each beats the `.btn` rule that would
          otherwise colour these grey — the precedence a browser gives an
          inline declaration — and neither costs the runtime anything: they
          fold into the node's computed style at build time. */}
      <div className="inline-demo">
        <button className="btn" style="background: #b91c1c; color: #fee2e2">
          string
        </button>
        <button
          className="btn"
          style={{
            background: "#15803d",
            color: "#dcfce7",
            paddingLeft: 24,
            fontWeight: 600,
          }}
        >
          object
        </button>
        <div className="hint">inline beats every selector · 8 is 8px, 600 is not</div>
      </div>

      <div className="footer">
        <div className="hint">
          {remaining} of {total} left · compiled at build time, no CSS in the runtime
        </div>
        <div className="hint">no DOM · no browser engine</div>
      </div>
    </div>
  );
}
