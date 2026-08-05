/**
 * The route at `"controls"` — real form elements, styled by real CSS.
 *
 * Every control below is the actual HTML element: `<input type="checkbox">`,
 * `<input type="radio">`, `<select>`. Not a `<div>` wearing a class. The
 * stylesheet reaches them the way a stylesheet does — `input[type=checkbox]` —
 * which needs attribute selectors, and dresses them with `::before` boxes, which
 * needs pseudo-elements. Both landed for this page.
 *
 * There is no shadow DOM and no widget paint code in the engine. Each tick, dot
 * and knob is a generated box the compiler emitted as an ordinary node, so Taffy
 * lays it out and paint draws it like anything else.
 *
 * `:checked` and `:disabled` are **live**, as of protocol v13 — this paragraph used
 * to say nothing set them and that they were stuck in whatever state they were
 * authored with, which stopped being true when `controls.rs` landed. A click ticks a
 * box, a radio sets itself and clears its group, a disabled control swallows the
 * press, and clicking the *words* beside a box reaches the box.
 *
 * Both text fields are typeable. A field needs `bind:value` to name the signal that
 * holds what the user types; without one there is nothing to write to, so the build
 * warns by name rather than shipping a box that silently eats keystrokes.
 *
 * `::placeholder` works, as of protocol v15 — this paragraph used to say it was refused
 * by name and that an empty field looks empty. It is an ordinary generated box, like
 * `::before`, with two differences: its text comes from the attribute rather than from
 * `content`, and paint draws it only while the field is empty. The UA sheet positions it
 * absolutely so it costs no room and overlays where the first character goes.
 *
 * A field is also one line high when empty, protocol v14. Both of those were the same
 * bug from opposite ends: a box with nothing in it is not a box with no size.
 *
 * There is a caret, and it is engine state: clicking puts it on the nearest character
 * boundary, the arrows and Home/End move it without a round trip to Bun, and typing,
 * Backspace and Delete all edit at it. So `caret-color` is finally a property something
 * reads. Both fields also wear a focus **ring**, which is `box-shadow` reduced to the
 * concentric bands a style row can hold — see `properties.ts::parseBoxShadow`.
 *
 * And there is **selection**, which is the same argument one step further: the engine holds
 * an `(anchor, focus)` pair rather than an ordered range, because that is the only shape a
 * Shift+Arrow reversal survives — measured, BROWSER-FACTS.md. Drag, Shift+Arrow, Shift+click,
 * double click for a word, triple click or Ctrl+A for everything; typing, Backspace and Delete
 * all replace a live range, and Backspace and Delete become identical once there is one. The
 * highlight is `::selection`, two colours on the field's own style row, defaulting from
 * dziri's UA sheet because Chromium does not expose its own.
 *
 * Still honestly not working, and the page says so rather than faking it:
 *
 * There is no clipboard, and no IME. A double-click-then-drag extends by character rather
 * than by word. `accent-color` still resolves with nothing to paint.
 *
 * A `<select>` renders closed. Its picker is a popover with anchor positioning in
 * the spec, and that needs the overlay layer (ROADMAP B1), so the options are
 * `display: none` for now. The closed control is most of what a form looks like.
 */
import { signal } from "dziri";

const CARD = "flex flex-col gap-3 rounded-xl bg-zinc-900 p-6";
const H = "text-lg font-semibold text-zinc-50";
const SUB = "muted text-xs text-zinc-400";
const ROW = "flex flex-row items-center gap-2";
const LABEL = "text-xs text-zinc-300";

export default function Controls() {
  // Component-local, because the field belongs to this page and nothing else reads it.
  // The compiler registers it and declares `const locals = […]` in the artifact — see
  // the Reactivity page for why a local needs that and an export does not.
  // The first one starts with text so a selection has something to cover — drag across it,
  // double click a word, Ctrl+A. The second stays empty, because that is the only way the
  // `::placeholder` box is on screen, and a page where every field is full would demonstrate
  // one feature by hiding another.
  const typed = signal("drag across the quick-brown fox");
  const also = signal("");

  return (
    <div className="flex flex-col gap-5">
      <div className={CARD}>
        <div className={H}>input[type=checkbox]</div>
        <div className={SUB}>
          the real element · the box is `input[type=checkbox]` and the tick is `content: "✓"` on
          its ::before · hover one: the border and the tick both respond, and the tick responds
          because a generated box reads its originating element's state
        </div>
        <div className="flex flex-row gap-6">
          <label className={ROW}>
            <input type="checkbox" />
            <span className={LABEL}>unchecked</span>
          </label>
          <label className={ROW}>
            <input type="checkbox" checked />
            <span className={LABEL}>checked</span>
          </label>
          <label className={ROW}>
            <input type="checkbox" checked disabled />
            <span className={LABEL}>checked + disabled</span>
          </label>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>input[type=radio]</div>
        <div className={SUB}>
          the same element with a different `type`, and the selector is the only thing that tells
          them apart — twenty-two input types share one tag, which is why attribute selectors had
          to exist before a UA stylesheet could describe any of them
        </div>
        <div className="flex flex-row gap-6">
          <label className={ROW}>
            <input type="radio" name="plan" />
            <span className={LABEL}>free</span>
          </label>
          <label className={ROW}>
            <input type="radio" name="plan" checked />
            <span className={LABEL}>pro</span>
          </label>
          <label className={ROW}>
            <input type="radio" name="plan" disabled />
            <span className={LABEL}>enterprise (disabled)</span>
          </label>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>input[type=text]</div>
        <div className={SUB}>
          click either field and type · `bind:value` names the signal that holds what you type, and
          a click focuses it because an editable is hit-testable · `::placeholder` is an ordinary
          generated box whose text comes from the attribute, positioned absolutely so it costs no
          room, and paint draws it only while the field is empty · the caret lands on the boundary
          you clicked, the arrows and Home/End move it, and Delete erases forward · drag to select,
          double click for a word, triple click or Ctrl+A for all of it, Shift+Arrow and Shift+click
          to extend — the engine keeps an `(anchor, focus)` pair, which is the only shape that
          survives extending back through where you started · focus draws a Tailwind `ring`, which
          is `box-shadow` and takes no room in layout · the third is disabled: it cannot be focused,
          and a press on it produces no events at all · no clipboard and no IME yet
        </div>
        <div className="flex flex-col gap-2">
          {/* `focus:ring-*` rather than a thicker border, which is the point of a ring: a
              box-shadow never affects layout, so the field does not move when it gains
              one. The offset colour has to be named — Tailwind's default is `#fff`, and
              an unnamed offset would put a white band around a field on a dark card. */}
          <input
            type="text"
            placeholder="a text field"
            bind:value={typed}
            className="focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-zinc-900"
          />
          {/* A second field with its own signal, so tabbing is not the only way to tell
              two fields apart and `:focus` has something to move between. It was unbound
              on purpose for one commit, to show what the build warning is about — but a
              field that silently ignores typing reads as broken rather than as a lesson,
              and `compile.ts` warns by name whether or not this page demonstrates it. */}
          {/* An inset ring on the second one, so both kinds are on screen at once: this
              band goes *inward* from the border box, over the background and under the
              border, which is where css-backgrounds-3 puts an inner shadow. */}
          <input
            type="text"
            placeholder="and a second one"
            bind:value={also}
            className="focus:inset-ring-2 focus:inset-ring-sky-400"
          />
          {/* Styled with Tailwind's `disabled:` variant rather than the `input:disabled`
              rule in app.css, to show the same predicate reached both ways: a utility
              class and a hand-written selector compile to one variant slot each.

              It also cannot be focused any more. A disabled control swallows the press
              entirely — measured, BROWSER-FACTS.md: no mousedown, no mouseup, no click,
              and it never takes focus. That needed a `controls` row for a *text* field,
              which the compiler had been emitting only for checkbox and radio. */}
          <input
            type="text"
            disabled
            placeholder="disabled"
            className="disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
          />
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>select — closed</div>
        <div className={SUB}>
          just a select and its options — the closed button and the selected option&apos;s text are
          the compiler&apos;s job, exactly as a browser builds them, except they are ordinary nodes
          rather than a shadow tree · the arrow is an ::after box on that button · the picker is a
          popover with anchor positioning in the spec and needs the overlay layer, so the options
          are hidden by the UA sheet for now
        </div>
        <div className="flex flex-row gap-4">
          <select>
            <option>Free</option>
            <option selected>Pro — $20/mo</option>
            <option>Enterprise</option>
          </select>
          <select disabled>
            <option>Unavailable</option>
          </select>
        </div>
        <div className={SUB}>
          and the same control written out longhand, which is the spec&apos;s opt-in form for
          customizing the internals — it compiles to the identical tree
        </div>
        <select>
          <button>
            <selectedcontent>Written by hand</selectedcontent>
          </button>
          <option>Written by hand</option>
        </select>
      </div>

      <div className={CARD}>
        <div className={H}>attribute selectors, on their own</div>
        <div className={SUB}>
          the whole operator set · each box below is styled only by an attribute test, no class
        </div>
        <div className="flex flex-row flex-wrap gap-2">
          <div className="probe" data-tone="warn">
            [data-tone=warn]
          </div>
          <div className="probe" data-tags="alpha beta">
            [data-tags~=beta]
          </div>
          <div className="probe" data-lang="en-GB">
            [data-lang|=en]
          </div>
          <div className="probe" data-file="report.pdf">
            [data-file$=.pdf]
          </div>
          <div className="probe" data-file="draft-notes.md">
            [data-file^=draft]
          </div>
          <div className="probe" data-note="contains-x-here">
            [data-note*=x]
          </div>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>::before and ::after around real content</div>
        <div className={SUB}>
          both boxes plus the element&apos;s own text, so child order is visible: before, content,
          after
        </div>
        <div className="pull-quote text-sm text-zinc-200">a generated box is an ordinary node</div>
      </div>

      <div className={CARD}>
        <div className={H}>Tailwind&apos;s own before: and after:</div>
        <div className={SUB}>
          real Tailwind output, not hand-written CSS · `before:content-[&apos;→&apos;]` emits
          `--tw-content` and `content: var(--tw-content)`, and the variable resolves at build time
          like any other
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-row items-baseline text-sm text-zinc-200 before:content-['→_'] before:text-sky-400">
            before:content
          </div>
          <div className="flex flex-row items-baseline text-sm text-zinc-200 after:content-['_←'] after:text-emerald-400">
            after:content
          </div>
          <div className="flex flex-row items-baseline text-sm text-zinc-200 before:content-['hover_me_-_'] hover:before:text-fuchsia-400">
            hover:before: — the variant reaches the generated box
          </div>
        </div>
      </div>
    </div>
  );
}
