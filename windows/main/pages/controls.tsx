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
 * Three things are honestly not working yet, and the page says so rather than
 * faking them:
 *
 * `:checked` and `:disabled` compile to predicate bits exactly like `:hover`, and
 * nothing sets them — that is A3. The authored `checked`/`disabled` *attributes*
 * are matched instead, which is a static selector rather than live state, so the
 * controls below are stuck in whatever state they were authored with.
 *
 * A `<select>` renders closed. Its picker is a popover with anchor positioning in
 * the spec, and that needs the overlay layer (ROADMAP B1), so the options are
 * `display: none` for now. The closed control is most of what a form looks like.
 *
 * `accent-color` and `caret-color` resolve into the style table and nothing reads
 * them yet.
 */
const CARD = "flex flex-col gap-3 rounded-xl bg-zinc-900 p-6";
const H = "text-lg font-semibold text-zinc-50";
const SUB = "muted text-xs text-zinc-400";
const ROW = "flex flex-row items-center gap-2";
const LABEL = "text-xs text-zinc-300";

export default function Controls() {
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
          the box is styled and the field is empty, honestly: `placeholder` reaches the IR as an
          attribute and a selector can test it, but rendering its text needs `::placeholder`, which
          is refused by name until it exists · `caret-color` and `accent-color` are set here and
          compile into the style table, and neither is painted — there is no caret until A5
        </div>
        <div className="flex flex-col gap-2">
          <input type="text" placeholder="a text field" />
          <input type="text" disabled placeholder="disabled" />
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
