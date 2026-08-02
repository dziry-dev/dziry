/** @jsxImportSource ../../../src/compiler */

/**
 * The reactivity API, every form of it, rendered.
 *
 * Each card pairs what you write with what it does, and every example on this page
 * is live — the counter really drives all of them. That is the point: a demo of
 * reactivity that showed frozen values would be demonstrating the bug.
 *
 * What makes the bare reads work is a source rewrite (`src/compiler/reactive-transform.ts`).
 * `tick * 2` is compiled to `$(tick) * 2`, where `$` unwraps a signal and passes
 * everything else through — decided at run time, so the transform needs no type
 * information and no scope analysis. `Signal<T>` is `T & Ops<T>` so the same
 * expression also type-checks.
 */
import { cn } from "../../../src/compiler/jsx-runtime.ts";
import {
  addLang,
  bump,
  doubled,
  drop,
  dropLang,
  isBig,
  isThree,
  langCount,
  langRows,
  note,
  parity,
  reset,
  shout,
  tick,
  type Lang,
} from "../reactivity.ts";
import type { Props } from "../../../src/compiler/jsx-runtime.ts";

const CARD = "card flex flex-col gap-3 rounded-xl bg-zinc-900 p-6";
const BTN = "rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700";
const CODE = "rounded bg-zinc-950 px-2 py-1 text-xs text-sky-300";
const CELL = "flex flex-col gap-1 rounded-lg bg-zinc-800 p-4";

/** One `code -> result` pair. `value` takes a signal or a literal. */
function Row({ code, value, note }: Props & { code: string; value: unknown; note?: string }) {
  return (
    <div className="flex flex-row items-center gap-3">
      <div className={cn(CODE, "w-64")}>{code}</div>
      <div className="text-sm font-semibold text-zinc-100">{value as never}</div>
      {note ? <div className="text-xs text-zinc-500">{note}</div> : null}
    </div>
  );
}

function LangRow({ badge, name, kind }: Props & { badge: string; name: string; kind: string }) {
  return (
    <div className="row flex flex-row items-center gap-3 rounded-lg bg-zinc-800 px-3 py-2">
      <div className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300">{badge}</div>
      <div className="grow text-sm text-zinc-100">{name}</div>
      <div className="text-xs text-zinc-500">{kind}</div>
    </div>
  );
}

/**
 * State that belongs to one component, declared where it is used.
 *
 * `signal(0)` here has no export name, and `ui.gen.ts` can only hold names — so the
 * compiler registers it and declares `const locals = [signal(0)]` in the artifact.
 * The inline arrow reaches the same module as source, with `n` substituted for its
 * registry slot. Neither needs a state module, and neither can be reused: this
 * component's state is its own.
 */
function LocalCounter() {
  const n = signal(0);

  return (
    <div className="flex flex-row items-center gap-3">
      <div className={cn(CODE, "w-64")}>const n = signal(0)</div>
      <div className="w-8 text-sm font-semibold text-zinc-100">{n}</div>
      <button className={BTN} onClick={() => n.set(n - 1)}>
        −
      </button>
      <button className={BTN} onClick={() => n.set(n + 1)}>
        +
      </button>
      <div className="text-xs text-zinc-500">no state module · declared in the component</div>
    </div>
  );
}

export default function Reactivity() {
  return (
    <div className="flex flex-col gap-5">
      <div className={CARD}>
        <div className="flex flex-row items-center justify-between">
          <div className="flex flex-col gap-1">
            <div className="heading text-lg font-semibold text-zinc-50">Reactivity</div>
            <div className="muted text-xs text-zinc-400">
              five things · signal · computed · .set · .map · cn — and a read is just the name
            </div>
          </div>
          <div className="flex flex-row gap-2">
            <button className={BTN} onClick={drop}>
              −
            </button>
            <button className={BTN} onClick={bump}>
              +
            </button>
            <button className={BTN} onClick={reset}>
              reset
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2.5">
          <div className={CELL}>
            <div className="text-xl font-semibold text-sky-400">{tick}</div>
            <div className="muted text-xs text-zinc-400">signal(3)</div>
          </div>
          <div className={CELL}>
            <div className="text-xl font-semibold text-emerald-400">{doubled}</div>
            <div className="muted text-xs text-zinc-400">computed(() =&gt; tick * 2)</div>
          </div>
          <div className={CELL}>
            <div className="text-xl font-semibold text-violet-400">{parity}</div>
            <div className="muted text-xs text-zinc-400">a ternary over a signal</div>
          </div>
          <div className={CELL}>
            <div className="text-xl font-semibold text-amber-400">{langCount}</div>
            <div className="muted text-xs text-zinc-400">computed(() =&gt; langs.length)</div>
          </div>
        </div>
      </div>

      {/* Every one of these was broken before the rewrite. `===` compared a signal
          object to a number and was false for ever; a ternary saw an object and was
          always truthy; a template literal printed [object Object]. */}
      <div className={CARD}>
        <div className="heading text-base font-semibold text-zinc-100">
          Operators on a bare signal
        </div>
        <div className="muted text-xs text-zinc-400">
          Written in a computed, in the window&apos;s own module. The read is the name — no
          .value, no dependency array.
        </div>

        <div className="flex flex-col gap-2">
          <Row code="computed(() => tick * 2)" value={doubled} />
          <Row code="computed(() => tick > 5)" value={isBig} note="click + past 5" />
          <Row code="computed(() => tick === 3)" value={isThree} note="=== works" />
          <Row code="computed(() => tick % 2 === 0 ? …)" value={parity} />
        </div>
      </div>

      {/* Interpolation, and the one rule worth knowing: a brace holding a lone
          signal is resolved by identity, while an expression is rewritten into a
          cell — which can only name module exports. */}
      <div className={CARD}>
        <div className="heading text-base font-semibold text-zinc-100">In markup</div>

        <div className="flex flex-col gap-2">
          <Row code="{tick}" value={tick} note="identity — the signal itself" />
          <Row code="{doubled}" value={doubled} note="a computed is a signal too" />
          <Row code="{shout}" value={shout} note="a template literal, in the module" />
        </div>

        <div className="sunken flex flex-col gap-2 rounded-lg bg-zinc-950 p-4">
          <div className="text-xs text-zinc-400">
            An expression inside a brace is compiled into a cell, and a cell reaches the
            generated module as text — so it can only name exports. A local cannot be written
            down: {"{"}`at ${"{"}router.path{"}"}`{"}"} is a build error naming the export it
            should have used, while {"{"}router.path{"}"} on its own compiles by identity.
          </div>
        </div>
      </div>

      {/* A conditional class driven by a signal: no string comparison at run time,
          just style-table writes when the cell flips. */}
      <div className={CARD}>
        <div className="heading text-base font-semibold text-zinc-100">
          Conditional classes · style-table patches
        </div>
        <div className="muted text-xs text-zinc-400">
          cn(&quot;box&quot;, {"{"} big: isBig {"}"}) — the class is resolved both ways at build
          time, so a change costs a few integer writes and nothing per frame.
        </div>

        <div className="flex flex-row items-center gap-3">
          <div className={cn("flag rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-100", { active: isBig })}>
            tick &gt; 5
          </div>
          <div className={cn("flag rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-100", { active: isThree })}>
            tick === 3
          </div>
          <div className="text-xs text-zinc-500">both driven by computeds over one signal</div>
        </div>
      </div>

      {/* A keyed list plus an editable, both taking the signal by identity. */}
      <div className={CARD}>
        <div className="heading text-base font-semibold text-zinc-100">
          Lists and editables · signals by identity
        </div>

        <div className="flex flex-row gap-2">
          <div
            className="grow rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
            bindValue={note}
          />
          <button className={cn(BTN, "bg-sky-600 text-sky-50 hover:bg-sky-500")} onClick={addLang}>
            Add
          </button>
          <button className={BTN} onClick={dropLang}>
            Drop
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {langRows.map((l: Lang & { badge: string }) => <LangRow badge={l.badge} name={l.name} kind={l.kind} />, {
            key: (l: Lang) => l.id,
          })}
        </div>
      </div>

      {/* Local state: `signal()` inside the component, with an inline handler.
          Neither has an export name, so the artifact declares the signal in a
          registry and contains the handler as source. There is no render and no
          unmount here — the body runs once at build time — so "created once" comes
          for free and the only missing piece was a name. */}
      <div className={CARD}>
        <div className="heading text-base font-semibold text-zinc-100">
          Component-local state
        </div>
        <div className="muted text-xs text-zinc-400">
          const n = signal(0) — declared in the component, not in a state module
        </div>
        <LocalCounter />
      </div>

      <div className={CARD}>
        <div className="heading text-base font-semibold text-zinc-100">Writes</div>
        <div className="flex flex-col gap-2">
          <Row code="tick.set(tick + 1)" value="a value" note="reads work in handlers too" />
          <Row code="tick.set((n) => n - 1)" value="or a function" note="one method, not two" />
        </div>
      </div>

      <div className="flex flex-row justify-between text-xs text-zinc-500">
        <div>{shout}</div>
        <div>no .value · no deps · no virtual DOM</div>
      </div>
    </div>
  );
}
