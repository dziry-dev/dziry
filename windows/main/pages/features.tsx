/** @jsxImportSource ../../../src/compiler */

/**
 * The framework's own features, on one route.
 *
 * Not decoration: this page is what `src/engine/upload.test.ts` asserts against and
 * what the four patch golden scenarios render. It needs to keep containing a
 * four-track grid with a spanning cell, a keyed list with per-row handlers, a
 * wrapping flex row, per-item `align-self`, an `aspect-ratio` box, absolutely
 * positioned children, both inline-style forms, and a layout-affecting conditional
 * class. Removing one of those removes a test's subject.
 *
 * Styled with Tailwind except where the point *is* authored CSS — the `compact` and
 * `light` classes are conditional classes compiled to style-table patches, and those
 * rules live in `in.css` beside the Tailwind imports.
 *
 * `.map` on a plain array runs at build time and leaves nothing behind. `view.map`
 * is the exception: it compiles to a template plus an arena, because its length is
 * data.
 */
import { cn, type Props } from "../../../src/compiler/jsx-runtime.ts";
import type { ReadonlySignal } from "../../../src/runtime/signal.ts";
import {
  addTodo,
  clearDraft,
  deleteTodo,
  draft,
  isCompact,
  remaining,
  toggleDensity,
  toggleDone,
  toggleTheme,
  total,
  view,
  type Todo,
} from "../state.ts";

const BTN = "rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700";
const CARD = "card flex flex-col gap-3 rounded-xl bg-zinc-900 p-6";

function Btn({ label, className, onClick }: Props & { label: string }) {
  return (
    <button className={cn(BTN, className)} onClick={onClick}>
      {label}
    </button>
  );
}

/**
 * A grid cell. `wide` spans two tracks.
 *
 * `value` takes a signal *or* a literal: passing the signal object through is what
 * lets the compiler recognise the binding, so the type has to admit it.
 */
function Stat({
  value,
  label,
  className,
}: Props & { value: string | ReadonlySignal<number>; label: string }) {
  return (
    <div className={cn("flex flex-col gap-1 rounded-lg bg-zinc-800 p-4", className)}>
      <div className="text-xl font-semibold text-zinc-50">{value}</div>
      <div className="muted text-xs text-zinc-400">{label}</div>
    </div>
  );
}

/**
 * A row of the list. Called once, with a recording proxy, at build time.
 *
 * Props are passed explicitly rather than spread: `{...t}` cannot work, because the
 * proxy has no keys until a real item exists. Spreading one is a compile error.
 */
function Row({ mark, title }: Props & { mark: string; title: string }) {
  return (
    <div className="row flex flex-row items-center gap-3 rounded-lg bg-zinc-800 px-3 py-2">
      {/* Per-row handlers: one compiled handler serves every row. */}
      <button className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-200" onClick={toggleDone}>
        {mark}
      </button>
      <div className="grow text-sm text-zinc-100">{title}</div>
      <button className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-400" onClick={deleteTodo}>
        x
      </button>
    </div>
  );
}

/** A plain array, so this expands at build time into literal nodes. */
const CHIPS = ["flex", "grid", "wrap", "grow", "align-self", "aspect-ratio", "absolute", "gap"];

export default function Features() {
  return (
    <div className={cn("flex flex-col gap-5", { compact: isCompact })}>
      <div className={CARD}>
        <div className="flex flex-row items-center justify-between">
          <div className="flex flex-col gap-1">
            <div className="heading text-lg font-semibold text-zinc-50">Framework features</div>
            <div className="muted text-xs text-zinc-400">
              conditional classes compiled to style-table patches · a keyed list in an arena
            </div>
          </div>
          <div className="flex flex-row gap-2">
            <Btn label="Theme" onClick={toggleTheme} />
            <Btn label="Density" onClick={toggleDensity} />
          </div>
        </div>

        {/* Four tracks; the first cell spans two, so three cells fill one row
            exactly. Auto-placement puts the rest wherever they fit. */}
        <div className="grid grid-cols-4 gap-2.5">
          <Stat value="grid + flex" label="both, from one style table" className="col-span-2" />
          <Stat value={remaining} label="remaining" />
          <Stat value={total} label="total" />
        </div>
      </div>

      <div className={CARD}>
        <div className="heading text-base font-semibold text-zinc-100">
          Dynamic list · keyed · per-row handlers
        </div>

        {/* grow on the field: it takes the leftover width. */}
        <div className="flex flex-row gap-2">
          <div
            className="grow rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
            bindValue={draft}
          />
          <Btn label="Add" className="bg-sky-600 text-sky-50 hover:bg-sky-500" onClick={addTodo} />
          <Btn label="Clear" onClick={clearDraft} />
        </div>

        <div className="flex flex-col gap-2">
          {view.map((t: Todo & { mark: string }) => <Row mark={t.mark} title={t.title} />, {
            key: (t: Todo) => t.id,
          })}
        </div>
      </div>

      <div className={CARD}>
        <div className="heading text-base font-semibold text-zinc-100">
          Flex · wrap, align-self, aspect-ratio, absolute
        </div>

        <div className="flex max-w-sm flex-row flex-wrap gap-2">
          {CHIPS.map((label) => (
            <div className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{label}</div>
          ))}
        </div>

        {/* Four items, three of them overriding the parent's align-items — then a
            fifth that takes its height from `aspect-square` and its width alone.
            The stretch one is deliberately *not* the aspect one: stretch fills the
            cross axis, which would override the ratio and make the square a
            rectangle. No padding on the row, so cross-axis start really is the
            container's edge. */}
        <div className="sunken flex h-24 flex-row items-start gap-3 rounded-lg bg-zinc-950">
          <div className="h-8 w-8 rounded bg-sky-500" />
          <div className="h-8 w-8 self-center rounded bg-violet-500" />
          <div className="h-8 w-8 self-end rounded bg-pink-500" />
          <div className="w-8 self-stretch rounded bg-amber-500" />
          <div className="aspect-square w-8 rounded bg-emerald-500" />
        </div>

        {/* Absolutely positioned children, out of flow. */}
        <div className="sunken relative h-24 rounded-lg bg-zinc-950">
          <div className="absolute top-2.5 right-2.5 rounded bg-sky-600 px-2 py-1 text-xs text-sky-50">
            absolute
          </div>
          <div className="absolute bottom-2.5 left-2.5 text-xs text-zinc-500">
            left: 10px · bottom: 10px
          </div>
        </div>
      </div>

      {/* Inline styles, both forms. Each beats the Tailwind class that would
          otherwise colour these, which is the precedence a browser gives an inline
          declaration — and neither costs the runtime anything: they fold into the
          node's computed style at build time. */}
      <div className={CARD}>
        <div className="heading text-base font-semibold text-zinc-100">Inline styles beat every selector</div>
        <div className="flex flex-row items-center gap-3">
          <button className={BTN} style="background: #b91c1c; color: #fee2e2">
            string
          </button>
          <button
            className={BTN}
            style={{ background: "#15803d", color: "#dcfce7", paddingLeft: 24, fontWeight: 600 }}
          >
            object
          </button>
          <div className="text-xs text-zinc-500">8 is 8px, 600 is not</div>
        </div>
      </div>

      <div className="flex flex-row justify-between text-xs text-zinc-500">
        <div>
          {remaining} of {total} left · compiled at build time, no CSS in the runtime
        </div>
        <div>no DOM · no browser engine</div>
      </div>
    </div>
  );
}
