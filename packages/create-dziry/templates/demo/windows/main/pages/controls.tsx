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
 * dziry's UA sheet because Chromium does not expose its own.
 *
 * Still honestly not working, and the page says so rather than faking it:
 *
 * There is no clipboard, and no IME. A double-click-then-drag extends by character rather
 * than by word. `accent-color` still resolves with nothing to paint.
 *
 * A `<select>` **opens**, as of protocol v18 — this paragraph used to say the options were
 * `display: none` because the picker needed an overlay layer. That layer is one node flag:
 * a `::picker(select)` box is an ordinary child of its select, so it inherits and lays out
 * with no special case, and `NodeFlags.OVERLAY` moves only its *turn* — painted after the
 * tree, hit-tested before it. Both halves are needed, and for different reasons; the flag's
 * own comment says which.
 *
 * Almost nothing about it is new state. The picker opens on the **press**, not the click,
 * which is the opposite of a checkbox and is measured. The committed choice is `:checked` on
 * an option, because committing one *is* a radio set. And the pending highlight an arrow key
 * moves is **focus** — measured, since Chromium's `activeElement` while a picker is open is
 * an `<option>` rather than the select — so `option:focus` draws it, Escape discards it by
 * doing what closing always does, and the "two pieces of state" ROADMAP B1 asks for cost no
 * fields at all. What is genuinely new is one integer for which select is open, and one
 * redirect per committed label so the closed button can read the chosen option's string
 * without the engine writing into Bun's tables.
 *
 * Opening costs **no relayout**: the picker is positioned absolutely and laid out whether or
 * not it shows, so showing it is a pure paint decision — the same trick `::placeholder` uses.
 *
 * Still honestly missing there: the picker does not flip or shift when it would run off the
 * window, which is collision handling and belongs to ROADMAP B2's `@floating-ui` adapter.
 * Scrolling outside does not dismiss it, `<optgroup>` labels do not render, and there is no
 * type-to-select.
 */
import { signal, fileInfo, readFile, readFileText } from "dziry";

const CARD = "flex flex-col gap-3 rounded-xl bg-zinc-900 p-6";
const H = "text-lg font-semibold text-zinc-50";
const SUB = "muted text-xs text-zinc-400";
const ROW = "flex flex-row items-center gap-2";
const LABEL = "text-xs text-zinc-300";

// Module-level, unlike this page's other signals, because `onFilePick` below has to
// reach them. A handler that calls a package helper (`fileInfo`) must itself be a
// module-level export: an *inline* handler's body is copied into the generated
// artifact verbatim, where `fileInfo` would be a bare name with no import.
export const filePath = signal("");
export const fileName = signal("");
export const fileSize = signal(0);
export const fileType = signal("");

/** Fills the metadata rows once the native picker returns a path. */
export function onFilePick(): void {
  const path = filePath.value;
  if (!path) return;
  void fileInfo(path).then((info) => {
    fileName.set(info.name);
    fileSize.set(info.size);
    fileType.set(info.type);
  });
}

// --- Example 1: image upload with preview ------------------------------------

/** The image preview's `src`, driven by `bind:src` on the `<img>`. */
export const previewSrc = signal("");
export const previewName = signal("");
export const savedTo = signal("");
export const previewBytes = signal(0);

/** When a file is picked, show its name and preview it. */
export function onImagePick(): void {
  const path = filePath.value;
  if (!path) return;
  previewSrc.set(path);
  previewName.set(path.split("\\").pop() ?? path);
  void readFile(path).then((bytes) => previewBytes.set(bytes.length));
}

/** Copies the picked file into `uploads/` beside the project. */
export function saveToUploads(): void {
  const path = filePath.value;
  if (!path) return;
  const name = previewName.value || "upload";
  const dest = `uploads/${name}`;
  void readFile(path).then((bytes) => {
    Bun.write(dest, bytes);
    savedTo.set(dest);
  });
}

// --- Example 2: read the file as a buffer ------------------------------------

export const bufferPath = signal("");
export const bufferInfo = signal("");
export const bufferPreview = signal("");

/** Reads the picked file into memory and shows a hex preview. */
export function onBufferPick(): void {
  const path = bufferPath.value;
  if (!path) return;
  void fileInfo(path).then((info) => {
    bufferInfo.set(`${info.name} — ${info.size} bytes — ${info.type}`);
  });
  void readFile(path).then((bytes) => {
    // Show the first 16 bytes as hex, like a hex editor would.
    const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    bufferPreview.set(`first 16 bytes: ${hex}${bytes.length > 16 ? " …" : ""}`);
  });
}

/** Reads the picked file as text, for `.txt` / `.json` / `.csv` picks. */
export function onTextPick(): void {
  const path = bufferPath.value;
  if (!path) return;
  void readFileText(path).then((text) => {
    bufferPreview.set(text.slice(0, 200));
  });
}

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

  // What `onChange` reports, written out so the page proves the wiring rather than
  // asserting it. Until protocol v22 the engine queued a `CHANGE` for every one of these
  // and nothing drained it, so a checkbox could flip its own bit and tell the app nothing.
  //
  // The value's *type* differs with the control, which is the part worth showing: a
  // checkbox hands over a boolean and a select hands over the chosen index.
  const lastChange = signal("nothing yet");

  // Focus and blur, on the one element that has nothing else to say it has focus. The pair
  // is ordered: the leaving element hears first, always, measured — so tabbing from this
  // box to anything else writes "left" before the next element could write anything.
  const focusState = signal("not focused");
  const submitted = signal("nothing yet");
  // Drives a real `disabled`, not a class: the button stops taking presses.
  const busy = signal(false);
  const saves = signal(0);
  const formName = signal("");
  const formTwo = signal("");
  const formFields = signal("");
  const rangeVal = signal("50");
  const colorVal = signal("#6366f1");
  const numVal = signal("42");

  return (
    <div className="flex flex-col gap-5">
      <div className={CARD}>
        <div className={H}>input[type=checkbox]</div>
        <div className={SUB}>
          the real element · the box is `input[type=checkbox]` and the tick is `content: "✓"` on
          its ::before · hover one: the border and the tick both respond, and the tick responds
          because a generated box reads its originating element's state
        </div>
        <div className={SUB}>
          the first box carries an `onChange`, which is new in protocol v22 · the engine has
          queued a CHANGE for every tick since v13 and no host drained it, so a control could
          change its own state and tell the app nothing · `onChange` is not `onClick`: clicking
          an already-checked radio fires a click and no change, and clicking a label fires a
          click on the label as well as on the control, so counting clicks cannot recover
          &ldquo;the value changed&rdquo;
        </div>
        <div className="flex flex-row gap-6">
          <label className={ROW}>
            <input type="checkbox" onChange={(on) => lastChange.set(`checkbox → ${on}`)} />
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
        <div className={ROW}>
          <span className={LABEL}>last onChange:</span>
          <span className="text-xs font-semibold text-sky-300">{lastChange}</span>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>input[type=radio]</div>
        <div className={SUB}>
          the same element with a different `type`, and the selector is the only thing that tells
          them apart — twenty-two input types share one tag, which is why attribute selectors had
          to exist before a UA stylesheet could describe any of them
        </div>
        <div className={SUB}>
          the group is one tab stop, on whichever radio is checked, and the arrows move inside
          it — all four of them, since a group has no orientation to respect · an arrow both moves
          focus and changes the value, which no other key here does, and it wraps at both ends
          where a select&apos;s picker clamps · both measured · the tab stop follows the choice, so
          tabbing away and back returns to it
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
        <div className={H}>select — it opens</div>
        <div className={SUB}>
          click it, or focus it and press ArrowDown, ArrowUp, Enter, Space or F4 — all six open the
          picker rather than walking the value, and every one of them is measured · Enter means
          two things and the state decides which: closed, it opens; open, it commits · arrows move
          the highlight and Home/End jump to its ends, Escape leaves the value alone, Tab closes
          without advancing, and a click outside dismisses and still activates what it hit · the
          closed button and the selected option&apos;s text are the compiler&apos;s job, exactly as
          a browser builds them, except they are ordinary nodes rather than a shadow tree · the
          arrow is an ::after box on that button
        </div>
        <div className={SUB}>
          all of it is now reachable without a pointer: Tab and Shift+Tab walk the live tree over a
          compile-time set of stops, a radio group is one stop on its checked member, and the ring
          you see on a keyboard-focused control is `:focus-visible` — which a click deliberately
          does not draw, except on a field where typing goes · Enter activates a button on the
          press and Space on the release, because that is what browsers do and it was measured
          rather than guessed
        </div>
        <div className={SUB}>
          still keyboard operability only, which is most of what accessibility means but not all of
          it: there is no assistive-technology surface yet — no UIAutomation, NSAccessibility or
          AT-SPI — so a screen reader learns nothing about this page. Named rather than glossed,
          because &ldquo;accessible&rdquo; would be the wrong word for what is here
        </div>
        <div className="flex flex-row gap-4">
          <select onChange={(i) => lastChange.set(`select → index ${i}`)}>
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
          customizing the internals — it compiles to the identical tree · the picker below it holds
          an &lt;optgroup&gt;, whose options are still the select&apos;s own: they arrow and commit
          like any other, though the group&apos;s label does not render yet
        </div>
        <select>
          <button>
            <selectedcontent>Written by hand</selectedcontent>
          </button>
          <option>Written by hand</option>
          <optgroup label="grouped">
            <option>Inside an optgroup</option>
            <option>And another</option>
          </optgroup>
        </select>
      </div>

      <div className={CARD}>
        <div className={H}>select multiple — the same tag, the opposite element</div>
        <div className={SUB}>
          a `&lt;select&gt;` with `multiple`, or with a `size` above one, is not a dropdown with
          a flag on it · its options are ordinary in-flow boxes rather than browser chrome, so
          there is no picker, no overlay and nothing to open — measured, and it is the finding
          that decided the implementation · everything else follows: it acts on the release
          where a dropdown opens on the press, its selection is a set rather than one value, and
          re-choosing the row you are on is a change here because it deselects
        </div>
        <div className={SUB}>
          click a row to replace the selection, ctrl+click to add or remove one, shift+click to
          take a range · ctrl+click also *moves the anchor* the next shift+click measures from,
          which is measured and is the one rule with a visible consequence · tab to it and the
          arrows walk it, shift+arrow extends, Ctrl+Space toggles where you are, Ctrl+A takes
          everything — and Ctrl+Arrow and plain Space are measured to do nothing at all, which
          is why they are consumed rather than forwarded
        </div>
        <div className={SUB}>
          it starts with **nothing** selected unless an option says `selected`, where a dropdown
          falls back to its first — the rule differs by shape and dziry had the dropdown&apos;s
          in both places until it was measured · the height is `size` rows, and it is the one box
          the compiler cannot resolve: a row is the font&apos;s ascent + descent + line gap, so
          the row *count* crosses the boundary and the engine multiplies
        </div>
        <div className="flex flex-row gap-4">
          <select
            multiple
            size="4"
            onChange={(picked) => lastChange.set(`multiple → [${picked}]`)}
          >
            <option selected>espresso</option>
            <option>cortado</option>
            <option selected>flat white</option>
            <option>filter</option>
            <option>cold brew</option>
            <option>affogato</option>
          </select>
          {/* No `multiple`, so this one is a list box that still selects one at a time —
              the shape that would have compiled to a dropdown had the fork been on the
              attribute rather than on `multiple || size > 1`. */}
          <select size="3" onChange={(picked) => lastChange.set(`size=3 → [${picked}]`)}>
            <option>one at a time</option>
            <option>still a list</option>
            <option>not a dropdown</option>
            <option>and it scrolls</option>
          </select>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>tabindex — the keyboard, on anything</div>
        <div className={SUB}>
          the set of tab stops is compile-time, and `tabindex` is how an author edits it ·
          `tabindex="0"` puts an ordinary box in the order, `tabindex="-1"` takes a control out
          of it, and that is the whole of the attribute here — it needed no new flag, because a
          pointer press focuses whatever it hits regardless
        </div>
        <div className={SUB}>
          a positive tabindex is refused and the build says so: browsers sort the whole
          positive group ahead of every other stop, which makes tab order a sort rather than a
          walk of the tree · dziry walks, so the element still gets a stop, in document order
        </div>
        <div className={SUB}>
          tab to the box below · the ring is the UA sheet on `[tabindex]:focus-visible`, which is
          the only element on this page with nothing else to say it has focus · neither Enter nor
          Space does anything to it, and that is measured rather than missing — a browser does not
          activate a focusable div either, which is why `role="button"` has to be scripted
        </div>
        <div className="flex flex-row gap-4">
          <div
            tabindex="0"
            className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200"
            onFocus={() => focusState.set("focused")}
            onBlur={() => focusState.set("left")}
          >
            div[tabindex=0] — reachable
          </div>
          <button
            tabindex="-1"
            className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200"
          >
            button[tabindex=-1] — skipped
          </button>
          <span className={LABEL}>onFocus/onBlur:</span>
          <span className="text-xs font-semibold text-sky-300">{focusState}</span>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>disabled, following a signal</div>
        <div className={SUB}>
          `disabled` takes a signal, not just a literal · flip the switch and the button
          below stops responding for real: no press, no Enter, no Space, and Tab walks past
          it · this is the state every "saving…" button needs and it used to be dropped in
          silence, compiling to a button that was never disabled
        </div>
        <div className={SUB}>
          it costs no protocol change and no engine work. `Controls::rescan` already cleared
          every live flag except `:checked` and re-read DISABLED from the table each time —
          on the grounds that checkedness is the user's and disabledness is the author's — so
          the author changing their mind is the case that path was built for, before anything
          could express it
        </div>
        <div className={SUB}>
          `:disabled` matches either way, because it reads the live flag · `[disabled]` — the
          attribute selector — matches only the literal spelling, since an attribute is text
          the compiler wrote down and a signal never becomes text
        </div>
        <div className="flex flex-row flex-wrap items-center gap-4">
          <label className={ROW}>
            <input type="checkbox" onChange={(on) => busy.set(on === true)} />
            <span className={LABEL}>pretend we are saving</span>
          </label>
          <button
            disabled={busy}
            className="rounded-lg bg-sky-700 px-3 py-1 text-xs font-semibold text-zinc-50"
            onClick={() => saves.set(saves + 1)}
          >
            Save
          </button>
          <span className={LABEL}>presses that landed:</span>
          <span className="text-xs font-semibold text-sky-300">{saves}</span>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>input[type=range]</div>
        <div className={SUB}>
          drag or arrow-key the thumb - bind:value wires the position as a number between
          min and max - step/min/max are compiler-side constants, never in shared memory
        </div>
        <div className='flex flex-col gap-3'>
          <div className={ROW}>
            <input type='range' min='0' max='100' step='1' bind:value={rangeVal} className='w-48' />
            <span className='text-xs font-semibold text-sky-300'>{rangeVal}</span>
          </div>
          <div className={ROW}>
            <input type='range' min='0' max='100' value='25' className='w-48' />
            <span className={LABEL}>unbound, value=25</span>
          </div>
          <div className={ROW}>
            <input type='range' disabled className='w-48' />
            <span className={LABEL}>disabled</span>
          </div>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>input[type=color]</div>
        <div className={SUB}>
          the authored value (a hex colour) becomes a presentational background-color hint -
          the fill is the content box - bind:value wires it to a signal
        </div>
        <div className='flex flex-col gap-3'>
          <div className={ROW}>
            <input type='color' bind:value={colorVal} />
            <span className='text-xs font-semibold text-sky-300'>{colorVal}</span>
          </div>
          <div className={ROW}>
            <input type='color' value='#10b981' />
            <span className={LABEL}>unbound, value=#10b981</span>
          </div>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>input[type=file]</div>
        <div className={SUB}>
          the UA sheet adds ::before content: 'Choose file' to make it look like a button ·
          click opens the native OS file picker · accept and multiple attributes configure
          the dialog
        </div>
        <div className='flex flex-col gap-3'>
          <div className={ROW}>
            <input type='file' />
            <span className={LABEL}>unbound, no filter</span>
          </div>
          <div className={ROW}>
            <input
              type='file'
              accept='image/*'
              bind:value={filePath}
              onChange={onFilePick}
            />
            <span className={LABEL}>accept=image/*, bound, shows metadata</span>
          </div>
          <div className={ROW}>
            <input type='file' disabled />
            <span className={LABEL}>disabled</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>path:</span>
            <span className='text-xs text-zinc-200'>{filePath}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>name:</span>
            <span className='text-xs text-zinc-200'>{fileName}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>size:</span>
            <span className='text-xs text-zinc-200'>{fileSize}</span>
            <span className={LABEL}>type:</span>
            <span className='text-xs text-zinc-200'>{fileType}</span>
          </div>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>Example 1: image upload with preview</div>
        <div className={SUB}>
          pick an image, it previews immediately via bind:src · then click Save to copy it
          into the uploads/ folder
        </div>
        <div className='flex flex-col gap-3'>
          <div className={ROW}>
            <input
              type='file'
              accept='image/*'
              bind:value={filePath}
              onChange={onImagePick}
            />
            <span className={LABEL}>pick an image</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>preview:</span>
            <span className='text-xs text-zinc-200'>{previewName}</span>
            <span className='text-xs text-zinc-400'>(</span>
            <span className='text-xs text-zinc-400'>{previewBytes}</span>
            <span className='text-xs text-zinc-400'>bytes)</span>
          </div>
          <img bind:src={previewSrc} className='h-32 w-auto rounded-lg' />
          <div className={ROW}>
            <button
              className='rounded-lg bg-sky-700 px-3 py-1 text-xs font-semibold text-zinc-50'
              onClick={saveToUploads}
            >
              Save to uploads/
            </button>
            <span className='text-xs text-emerald-400'>{savedTo}</span>
          </div>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>Example 2: read the file as a buffer</div>
        <div className={SUB}>
          onChange receives the path - readFile loads the bytes - the hex preview shows
          the first 16 bytes, like a hex editor
        </div>
        <div className='flex flex-col gap-3'>
          <div className={ROW}>
            <input
              type='file'
              bind:value={bufferPath}
              onChange={onBufferPick}
            />
            <span className={LABEL}>pick any file</span>
          </div>
          <div className={ROW}>
            <span className='text-xs text-zinc-200'>{bufferInfo}</span>
          </div>
          <div className={ROW}>
            <span className='text-xs font-mono text-amber-300'>{bufferPreview}</span>
          </div>
          <div className={ROW}>
            <button
              className='rounded-lg bg-zinc-700 px-3 py-1 text-xs font-semibold text-zinc-50'
              onClick={onTextPick}
            >
              Read as text instead
            </button>
          </div>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>input[type=number]</div>
        <div className={SUB}>
          arrow-up/down step by the step attribute (default 1), clamped to min/max -
          bind:value wires to a signal, typing works like a text field
        </div>
        <div className='flex flex-col gap-3'>
          <div className={ROW}>
            <input
              type='number'
              min='0'
              max='100'
              step='5'
              bind:value={numVal}
              className='w-24 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-100'
            />
            <span className='text-xs font-semibold text-sky-300'>{numVal}</span>
          </div>
          <div className={ROW}>
            <span className={LABEL}>arrow up/down steps by 5, clamped 0-100</span>
          </div>
        </div>
      </div>

      <div className={CARD}>
        <div className={H}>forms — Enter submits, and when it does not</div>
        <div className={SUB}>
          `onSubmit` runs on Enter in a field and on a press of the submit button · there is no
          event object and nothing to cancel, because dziry never navigates: a submission is a
          call into app code, and the values are already in the signals the fields are bound to
        </div>
        <div className={SUB}>
          the conditions are measured, not guessed · the left form has a submit button, so Enter
          in it always submits · the right one has none and two fields, so Enter does nothing at
          all — a form with no button submits only when exactly one field blocks implicit
          submission, and a disabled submit button blocks it outright
        </div>
        <div className={SUB}>
          all of that is resolved at build time into one number per form: which button Enter
          clicks, or none · what is left at run time is walking up from the focused node to find
          the form
        </div>
        <div className="flex flex-row flex-wrap items-start gap-8">
          <div className="flex flex-col gap-1">
            <span className={LABEL}>one field and a submit button — Enter submits</span>
            <form
              className="flex flex-row items-center gap-2"
              onSubmit={() => submitted.set("the form with a button")}
            >
              <input
                type="text"
                bind:value={formName}
                placeholder="name"
                className="w-40 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
              />
              <button
                type="submit"
                className="rounded-lg bg-sky-700 px-3 py-1 text-xs font-semibold text-zinc-50"
              >
                submit
              </button>
            </form>
          </div>
          <div className="flex flex-col gap-1">
            <span className={LABEL}>two fields and no button — Enter does nothing</span>
            {/* The readout below stays as it was if Enter is pressed in either of these, which
                is the whole demonstration. A handler is attached precisely so that "nothing
                happened" is a measured absence rather than a missing wire. */}
            <form
              className="flex flex-row items-center gap-2"
              onSubmit={() => submitted.set("the two-field form — this should be unreachable")}
            >
              <input
                type="text"
                bind:value={formTwo}
                className="w-24 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
                placeholder="two"
              />
              <input
                type="text"
                bind:value={formFields}
                className="w-24 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
                placeholder="fields"
              />
            </form>
          </div>
          <div className="flex flex-col gap-1">
            <span className={LABEL}>onSubmit:</span>
            <span className="text-xs font-semibold text-sky-300">{submitted}</span>
          </div>
        </div>
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
