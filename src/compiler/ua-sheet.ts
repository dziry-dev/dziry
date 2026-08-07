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
 * Only add what `html-coverage` reports, and re-run it afterwards — the count is
 * the review. Rules are grouped by the finding that justifies them so a reader
 * can trace any line back to a measurement rather than to taste. Values come from
 * Chrome's computed output as reported by that tool, not from memory or from
 * another browser's sheet.
 *
 * Properties dziri has no field for yet cannot be set here at all. As of
 * 2026-08-01 that blocks 17 findings across four properties — `font-style`,
 * `text-decoration-line`, `font-family` and `list-style-type` — and those are a
 * `STYLE_FIELDS` job, not a stylesheet one.
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

   Appearance — the picker's background and border, radii, the tick on a checkbox —
   is deliberately absent. That is a decision about how dziri's controls look, it
   belongs in a theme rather than in the sheet that makes elements behave like
   themselves, and html-coverage has nothing to say about it. */
select::picker(select) { position: absolute; left: 0; right: 0 }

/* Chrome's sheet gives the picker's button no border of its own; the border
   belongs to the select. Stated so an author styling select does not get a
   doubled edge they never asked for. */
select button { border-width: 0 }

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
