/**
 * dziri's user-agent stylesheet.
 *
 * Until this file existed, dziri rendered every element as an identical empty
 * box: `<h1>` was not bold, `<b>` was not bold, `<audio>` drew a box where a
 * browser draws nothing. `html-coverage` measures exactly that gap against
 * Chrome, and its output *is* the specification for this file — 63 of its 80
 * findings are properties dziri already has and simply never sets.
 *
 * **This is a compile-time constant, not a runtime sheet.** It is parsed and
 * cascaded during compilation like any other stylesheet and then discarded; the
 * emitted IR contains only computed values, so nothing here reaches the engine
 * or costs a frame. That is the compile-time-first rule applied to the one piece
 * of CSS every app shares.
 *
 * **It cascades at UA origin**, below every author rule regardless of selector
 * weight (`Origin.UA` in `css.ts`). An author writing `p { margin: 0 }` must win
 * against a sheet they cannot see, and they do.
 *
 * ## Adding to this file
 *
 * Only add what a measurement justifies, and name the measurement. Most rules
 * come from `html-coverage` — re-run it afterwards, the count is the review. The
 * control-appearance block instead cites `probes/control-metrics.html` via
 * BROWSER-FACTS.md, because what a UA-drawn tick looks like is not a computed
 * style any tool can diff. Either way a reader can trace any line back to a
 * measurement rather than to taste; nothing here comes from memory or from
 * another browser's sheet, and the handful of values no API exposes are marked
 * as stated conventions where they sit.
 *
 * Properties dziri has no field for yet cannot be set here at all. As of
 * 2026-08-12 that is down to one: `list-style-type` for `li`, which is a marker
 * paint feature rather than a plain field. `font-style`, `font-family` and
 * `text-decoration-line` landed with protocol v26 and are set below.
 */
export const UA_SHEET = `
/* Tier 0a — never rendered. Chrome's sheet hides these; dziri drew empty boxes
   in the flow, which pushes every following sibling down by their height. */
base, basefont, datalist, head, link, meta, noembed, noframes, param, rp, script,
style, template, title { display: none }

/* audio without controls is display:none in Chrome's sheet. dziri has no
   controls attribute selector yet, and no audio element either way. */
audio { display: none }

/* Headings — 24 findings across six elements, the largest single group.

   Chrome's own sheet writes these in em (h1 is 2em, its margin 0.67em) and that
   is *not* portable here: css.ts resolves em against the root's 16px rather than
   against the element's own font-size, so 0.67em on an h1 would compute 10.72px
   where Chrome computes 21.44px. Written in px, at the exact values Chrome
   reports, which encodes a 16px root — revisit every number here if a root
   font-size ever becomes settable.

   h4 gets no font-size because Chrome's 1em already equals dziri's 16px default. */
h1 { font-weight: 700; font-size: 32px;    margin-block-start: 21.44px;   margin-block-end: 21.44px }
h2 { font-weight: 700; font-size: 24px;    margin-block-start: 19.92px;   margin-block-end: 19.92px }
h3 { font-weight: 700; font-size: 18.72px; margin-block-start: 18.72px;   margin-block-end: 18.72px }
h4 { font-weight: 700;                     margin-block-start: 21.28px;   margin-block-end: 21.28px }
h5 { font-weight: 700; font-size: 13.28px; margin-block-start: 22.1776px; margin-block-end: 22.1776px }
h6 { font-weight: 700; font-size: 10.72px; margin-block-start: 24.9776px; margin-block-end: 24.9776px }

/* Text-level semantics and block spacing — every value below is html-coverage's
   Chrome column, 2026-08-10. What is still blocked on STYLE_FIELDS: li wants
   list-style-type (a marker is a paint feature, not a field). That stays in the
   differ table rather than being half-written here.

   The decoration rules joined the italic and monospace ones when the
   decorationLine field landed: underline for a/u/ins, line-through for del/s,
   which is what Chrome's own sheet sets. a is keyed on the tag rather than
   -webkit-any-link, which dziri has no equivalent of — a bare anchor gets an
   underline a browser would not draw, the one deliberate overreach here.

   16px margins written as px, not 1em, for the reason the headings' are: em
   resolves against the root in css.ts, which happens to be right at the default
   font size and wrong the moment a root size becomes settable. */
b, strong { font-weight: 700 }
small, sub, sup { font-size: 13.3333px }
a, u, ins { text-decoration-line: underline }
del, s { text-decoration-line: line-through }

/* The two fields protocol v26 added, at their Chrome defaults. monospace is a
   generic the engine resolves to one platform face at startup; italic is a slant
   the face provides or the platform synthesizes. No font-size here on purpose:
   the "monospace shrinks to 13px" lore did not survive measurement —
   html-coverage reports only the family differing for these elements. (And no
   backticks in this comment: the sheet is a template literal. Third build this
   has cost.) */
i, em, cite, dfn, var, address { font-style: italic }
code, kbd, samp, pre { font-family: monospace }

p, blockquote, dl, figure, pre { margin-block-start: 16px; margin-block-end: 16px }
hr { margin-block-start: 8px; margin-block-end: 8px }

ul, ol, menu {
  margin-block-start: 16px;
  margin-block-end: 16px;
  padding-inline-start: 40px;
}

fieldset { padding-inline-start: 12px }
dialog { padding-inline-start: 16px }
/* Chrome's UA sheet pads the geolocation element the same way; measured by
   html-coverage, 2026-08-12. */
geolocation { padding-inline-start: 16px }

/* Form controls — structure, not appearance.

   ua-structure.ts gives a select the button and selectedcontent that a browser
   would build in a shadow tree, and the ::picker(select) box its options live in.
   This rule is the other half of that: the picker is taken out of flow, so a
   closed select is exactly as tall as its button and the options sit over the page
   rather than stacked underneath the control.

   The options used to be display:none instead, because there was no overlay layer
   to draw them in (ROADMAP B1). That rendered the *closed* control correctly and
   nothing else; the layer exists now, so they are positioned.

   Out of flow is also what makes opening one free. The picker is laid out whether
   or not it is showing, and the engine decides whether to *paint* it — the same
   split ::placeholder uses, and it buys the same thing: no relayout when it opens,
   so a dropdown cannot jank on the frame it appears.

   Which is why there is deliberately no display rule keyed on :open. Visibility
   belongs to the engine for the reason NodeFlags.PLACEHOLDER gives: were it an
   authored property, display:block on a picker would leave a dropdown hanging open
   over the page with no way to close it. :open is still there to style with —
   borders, colours, a transform — it just does not decide what is drawn.

   No *vertical* inset, and that one is a limitation rather than a choice: the spec
   anchors a picker with top:anchor(bottom), dziri's nearest spelling would be
   top:100%, and css.ts refuses percentage lengths. (No backticks in this comment,
   and that is not a style choice — the whole sheet is a template literal, so one
   would end the string. It has now cost two builds.) So the engine offsets the
   overlay by its select's own box, which it can do because it has both rects. An
   author's own top still shifts it from there — it moves where Taffy puts the box,
   and the anchor offset is applied on top.

   left:0 and right:0 *are* here, and they do a job worth naming: an absolutely
   positioned box with both inline insets set is stretched to its containing block,
   so a picker comes out exactly as wide as its select. That is the spec's
   min-inline-size:anchor-size(self-inline) reached with two plain lengths instead
   of a function dziri does not have — and unlike a width in a theme it cannot drift,
   because there is no second number to keep in step. A picker narrower than the
   control it belongs to was the visible bug this replaced.

   It is a *minimum* in the spec and a fixed size here: a picker whose longest
   option is wider than the select will not grow to fit it. That wants max-content
   sizing against a floor, which is min-inline-size, and dziri has the field but no
   percentage or anchor-size value to put in it.

   Appearance — the picker's background and border, the tick on a checkbox — used
   to be deliberately absent here, on the grounds that it belonged in a theme. The
   unstyled demo window (windows/plain) refuted that by rendering: a checkbox that
   draws nothing is not "unthemed", it is indistinguishable from missing, and a
   browser's controls look like controls with no stylesheet anywhere. The
   appearance block further down is the correction. */
select::picker(select) { position: absolute; left: 0; right: 0 }

/* Chrome's sheet gives the picker's button no border of its own; the border
   belongs to the select. Stated so an author styling select does not get a
   doubled edge they never asked for.

   The background and padding joined the border when buttons gained a default
   appearance below: a select's internal button is structure, and without this
   reset every select would wear a grey pill inside its own border. Same-origin,
   higher specificity, so it wins over the button rule without leaving UA. */
select button {
  border-width: 0;
  background-color: transparent;
  padding: 0;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

/* The arrow that says "this opens". Chromium draws a triangle as part of the
   native widget, so there is no glyph or colour to measure — U+25BE at a 4px
   offset is a stated convention, drawn the way app.css draws its own: an ::after
   box on the internal button, which an author's select button::after replaces. */
select button::after { content: "\\25BE"; padding-left: 4px }

/* Form controls — appearance.

   This paragraph used to say appearance was deliberately absent and belonged in a
   theme. That was wrong in exactly the way the unstyled demo window made visible:
   a browser's unstyled checkbox is still a checkbox — box, border, tick — and a
   control that draws nothing reads as broken, not as unthemed. What belongs in a
   theme is a *different* look, not the existence of one.

   Values are Chromium 151's, measured in probes/control-metrics.html and recorded
   in BROWSER-FACTS.md ("What box each form control gets from the UA sheet"),
   with three approximations, each forced by a missing field and stated here:

   - border-style does not exist, so Chrome's "2px inset" and "2px outset" become
     solid at the same width. The colour of an inset edge is not a computed value
     anywhere, so #767676 — Chromium's control grey — is a stated convention.
   - font-family exists only as a generic-family enum, so controls keep the page
     font where Chrome switches them to Arial. The 13.3333px size is real and
     kept: it is most of why an unstyled form reads smaller than the text around
     it. (textarea is the exception: Chrome puts it in monospace, which the enum
     can say, so the rule above does.)
   - The tick and the dot have no DOM ("read off pixels", same entry): the tick is
     a glyph on a generated box, the dot an empty circle at 6px of 13 — inside the
     measured 45-50% — both centred by the flex rules, exactly as a theme would.

   The accent is #3390ff, the same stated convention the focus ring and
   ::selection use, because Chrome's own accent computes to auto and cannot be
   read. One invented colour in this file, used three times, stays one thing to
   keep in step.

   A field's measured width is a function of size= and the font (29 + 7 x size at
   Chrome's 13.3333px Arial), which a sheet cannot express — 169px is that formula
   at the default size="20", a constant standing in for a rule. */
input {
  width: 169px;
  border-width: 2px;
  border-color: #767676;
  padding-top: 1px; padding-bottom: 1px;
  padding-left: 2px; padding-right: 2px;
  background-color: #ffffff;
  font-size: 13.3333px;
}

input[type="hidden"] { display: none }

textarea {
  width: 162px;
  border-width: 1px;
  border-color: #767676;
  padding: 2px;
  background-color: #ffffff;
  font-size: 13.3333px;
  /* Chrome's sheet puts a textarea in monospace where the other controls go to
     Arial; monospace is a generic dziri can express, so this one is set. */
  font-family: monospace;
}

select {
  border-width: 1px;
  border-color: #767676;
  background-color: #ffffff;
  font-size: 13.3333px;
}

button, input[type="submit"], input[type="reset"], input[type="button"] {
  width: auto;
  border-width: 2px;
  border-color: #767676;
  padding-top: 1px; padding-bottom: 1px;
  padding-left: 6px; padding-right: 6px;
  background-color: #f0f0f0;
  font-size: 13.3333px;
}

/* Two approximations of inline flow, which dziri does not have.

   A label computes display:inline in Chrome, so a checkbox and its words share a
   line; dziri's default box is a column, which stacked every label's control on
   top of its own caption. A row that centres its items is the nearest true
   thing, and it is what every hand-written form was already doing (app.css ROW).

   A select and a button are inline-blocks: they shrink to their content where a
   column's stretch makes them page-wide bars. dziri has no fit-content width, so
   align-self:flex-start is the spelling that stops the stretch — in a row parent
   it top-aligns instead, which is roughly where a baseline would put them. An
   author's own align-self or width wins on origin, like everything here. */
label { flex-direction: row; align-items: center }
button, select { align-self: flex-start }

/* 13x13 with a 3px margin, measured; the radio's missing margin-bottom is
   Chrome's own quirk, kept because matching it is cheaper than remembering why
   we did not. The border is the box: unchecked draws grey, checked accent. */
input[type="checkbox"], input[type="radio"] {
  width: 13px;
  height: 13px;
  margin: 3px;
  border-width: 2px;
  border-color: #767676;
  padding: 0;
  background-color: transparent;
  justify-content: center;
  align-items: center;
}
input[type="radio"] { border-radius: 9999px; margin-bottom: 0 }
input[type="checkbox"] { border-radius: 2px }

/* The tick: present but transparent until :checked, so checking changes two
   colours and no geometry — the same reason app.css draws it this way. */
input[type="checkbox"]::before {
  content: "\\2713";
  color: transparent;
  font-size: 9px;
  font-weight: 700;
}
input[type="checkbox"]:checked {
  background-color: #3390ff;
  border-color: #3390ff;
}
input[type="checkbox"]:checked::before { color: #ffffff }

/* The dot: an empty box with a radius rather than a glyph, because a glyph sits
   on a baseline and a box sits where flex centres it. 6 of 13px is 46%. */
input[type="radio"]::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background-color: transparent;
}
input[type="radio"]:checked { border-color: #3390ff }
input[type="radio"]:checked::before { background-color: #3390ff }

/* The picker floats over the page, so it cannot be transparent: options drawn
   straight onto whatever is beneath are unreadable, which is worse than any
   colour choice. White with the control grey, and the focused option carries
   the accent — that highlight is the engine's own pending-choice state, and
   without a colour it is invisible. */
select::picker(select) {
  background-color: #ffffff;
  border-width: 1px;
  border-color: #767676;
}
option:focus {
  background-color: #3390ff;
  color: #ffffff;
}

/* :disabled, exactly as measured — probes/disabled-control-styles.html, recorded
   in BROWSER-FACTS.md. Two shapes worth noticing, both verbatim from Chromium:
   button and the text fields grey out with *alpha* colours, so a disabled field
   over a dark card darkens with the card instead of going pastel; a select keeps
   its white background and instead fades the whole element to 0.7 opacity with
   its own darker grey. A disabled option computes no change at all, so there is
   deliberately no rule for it. */
button:disabled, input[type="submit"]:disabled, input[type="reset"]:disabled,
input[type="button"]:disabled {
  color: rgba(16, 16, 16, 0.3);
  background-color: rgba(239, 239, 239, 0.3);
  border-color: rgba(118, 118, 118, 0.3);
}

input:disabled, textarea:disabled {
  color: #545454;
  background-color: rgba(239, 239, 239, 0.3);
  border-color: rgba(118, 118, 118, 0.3);
}

/* The border grey is measured; extending it to the checked fill is the sheet's
   own call, because a disabled checked box's fill is painted like the tick and
   computes nothing. Grey fill under the white tick reads as "chosen, but off",
   which is the meaning being drawn. */
input[type="checkbox"]:disabled, input[type="radio"]:disabled {
  background-color: transparent;
  border-color: #545454;
}
input[type="checkbox"]:checked:disabled {
  background-color: #545454;
  border-color: #545454;
}
input[type="radio"]:checked:disabled::before { background-color: #545454 }

select:disabled {
  color: #6d6d6d;
  border-color: rgba(118, 118, 118, 0.3);
  opacity: 0.7;
}

/* A list box's *selection*, as opposed to its focus. Without this, an unstyled
   multiple-select is a working control that looks broken in a specific, misleading
   way: ctrl+click builds a set the engine tracks correctly, but the only visible
   highlight is the single focus bar — so it reads as "can only select one". The
   selection is :checked on each chosen option, drawn here so every member of the
   set shows. Scoped to the listbox attribute because a dropdown's committed option
   also carries :checked, and painting it in the picker would show two bars — the
   focus the arrows move plus a phantom — where Chromium shows one. */
select[data-dziri-listbox] option:checked {
  background-color: #3390ff;
  color: #ffffff;
}

/* A list box: a select with multiple, or with a size above one.

   Not a dropdown with a flag on it. Measured (probes/select-listbox.html and
   select-multiple.html): its options are ordinary in-flow boxes with a box, a computed
   style and an offsetParent, where a dropdown's are browser chrome with no box at all.
   So none of the picker rules above apply to it — and they do not have to be undone
   either, because it has no picker box and no button for them to match.

   display:block is what makes the options stack. dziri's default display is flex, whose
   default direction is row, so without this the rows come out side by side — which is
   what the first render of this showed, six options in a line spilling out of the box.
   Block is also the measured display of the options themselves, so the two agree.

   overflow-y:scroll is the other half of "size rows": the box is a fixed number of rows
   tall whether or not the options fit, so the rest has to be reachable. Measured, a
   list box of six options with no size has a client height of four rows and a scroll
   height of six.

   The height itself is deliberately absent, and it is the one thing here that cannot be
   written down: it is the size attribute times a *row*, and a row is ascent + descent +
   line gap at the resolved size. Measured as a ratio across a 4x font-size range, so the
   17px it looks like at the default font is an instance rather than a constant. The row
   count travels in controls.rows and layout.rs multiplies — see size_listboxes.

   The attribute is written by the compiler, not by the author. A selector cannot express
   "multiple or size above one": select[size] matches size="1", which is a dropdown, and
   CSS has no numeric comparison. So compile.ts resolves the condition and records it as
   something this sheet can match. It sits at UA origin like everything else here, which
   is the point of doing it this way rather than in the engine — an author's own
   overflow or display beats it. */
select[data-dziri-listbox] { display: block; overflow-y: scroll }

/* A placeholder overlays the text rather than occupying room beside it.

   No backticks anywhere in this comment, and that is not a style choice: the whole sheet
   is a template literal, so one would end the string. It cost a build.

   position:absolute is doing two jobs. It takes the box out of flow, so a field with a
   placeholder is exactly as tall as one without — which matters because the field's
   height is now a strut and gaining a second in-flow child would double it. And it is
   what lets paint decide the visibility of a box layout has already placed: the engine
   draws a placeholder only while its field is empty, and because nothing is in flow
   there is no relayout when that flips.

   No left/top here, deliberately. An absolutely positioned box is placed against its
   containing block's *padding* box, while text sits in the *content* box — so left:0 is
   short by padding-left, and the placeholder sat against the border while the typed text
   beside it was correctly indented. The inset has to be the field's own padding, which
   is a value the author chooses and this sheet cannot name. walkPlaceholder supplies it
   as a per-state default instead, from the resolved style, which an author's own rule
   still overrides.

   The colour is Chrome's own placeholder grey, and it is here rather than in a theme for
   the reason the rest of this file is: a placeholder nobody can read is not "unstyled",
   it is broken. An author's own ::placeholder rule overrides it like any other, since
   this is an ordinary generated box in an ordinary cascade. */
input::placeholder, textarea::placeholder {
  position: absolute;
  color: #757575;
}

/* A focus ring, on keyboard focus only.

   :focus-visible rather than :focus, and that distinction is the entire feature —
   measured, probes/focus-visible.html. A ring on every click is what the pseudo-class
   was invented to stop, and no ring while somebody is tabbing is a keyboard user with
   no idea where they are. Chromium hangs its own ring on exactly this pseudo-class:
   a focused-but-not-visible element computes outline-style:none, a visible one
   computes outline:auto 1px.

   This belongs in the UA sheet for the same reason the placeholder colour does, and
   the argument is stronger here. A placeholder nobody can read is broken; a focus
   indicator nobody can see is a WCAG 2.4.7 failure, and it is the one default that an
   app cannot be left to remember. Every element gets it, because every element that
   can hold focus needs it and the compiler already knows which those are.

   The value is a **stated convention**, like the ::selection colours below and for the
   same reason: Chromium's outline:auto 1px -webkit-focus-ring-color is unexpressible
   here twice over. dziri has no outline property at all, no auto width, and the
   platform colour is not exposed to getComputedStyle. So this is a 2px ring in the
   same blue ::selection uses — one accent in this file rather than two, since neither
   is measured and a second invented colour would just be a second thing to keep in
   step.

   box-shadow, because that is the property dziri has: the ring* fields are the
   concentric-band subset of it, which is exactly a ring and nothing else. An author's
   own focus ring writes the same fields and so wins on origin, which is why adding
   this does not double up any ring already in a theme.

   **Listed per tag rather than written as a bare :focus-visible**, and that is not
   tidiness — it is the difference between 62 variant rows and 986. Chromium can write
   the universal form because it resolves style on demand; dziri precompiles one style
   row per combination of the predicates a node's rules mention, so a rule matching
   everything gives *every node in the document* a two-entry run, including the 900-odd
   that can never hold focus. The output is identical either way. The general lesson,
   worth stating once here: in a UA sheet compiled this way, a state rule has to be
   scoped to the elements that can be in that state.

   Even scoped it is not free, and the number is worth having rather than hiding: the
   demo goes from 377 style slots to 478. A variant run is the cross product of the
   predicates a node's rules mention, so a field that already had :hover and :focus
   gains slots for every combination with this one, not one slot. That is the standing
   cost of precomputing states, paid here for the one indicator a keyboard user cannot
   work without.

   The list is the tab-stop set from compile.ts, minus nothing. If the two ever
   disagree, this is the copy that is wrong — a focusable element with no ring is the
   failure, and an unfocusable one with a rule that cannot match is only waste.

   [tabindex] is on the list for exactly that reason. It is the one entry that is not a
   tag, and it covers the case the whole attribute exists for: an element made focusable
   because the author said so. Leaving it out would have given a ring to every control
   that already looks like one and none to the custom widget that has nothing else to
   say it has focus — the failure this rule is here to prevent, aimed at the only element
   that cannot fall back on looking like a button. It matches on the attribute's
   presence, so tabindex="-1" carries it too; that element is not tabbable but a pointer
   or a script can still focus it, and focus you cannot see is the thing being fixed. */
a:focus-visible,
button:focus-visible,
input:focus-visible,
textarea:focus-visible,
select:focus-visible,
[tabindex]:focus-visible {
  box-shadow: 0 0 0 2px #3390ff;
}

/* What a selected range looks like when nobody said.

   This one is a stated convention rather than a match, and the difference is recorded
   because it cannot be closed: Chromium does not expose its own highlight colour through
   getComputedStyle. A ::selection with no author rule reports a transparent background,
   which is a "nothing here" and not the colour it paints — same category as the caret's
   width and blink rate. Measured and refused, BROWSER-FACTS.md. Getting the real answer
   would take a screen recording.

   So this is a choice: #3390ff, a mid blue close to what desktop platforms use, with white
   text over it. Both are needed. A background with no colour beside it leaves dark text on
   a saturated fill, which is the one combination that reads worse than no highlight at all.

   On body rather than on input, and that is the whole reason the two fields inherit. A UA
   rule on the field would beat an author's body::selection, which is backwards: the author
   should win. Declared at the root, it reaches every field by inheritance, so an author's
   body::selection wins on origin and an author's input::selection wins by sitting closer. */
body::selection {
  background-color: #3390ff;
  color: #ffffff;
}
`;
