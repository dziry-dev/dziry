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

   No inset either, and that one is a limitation rather than a choice: the spec
   anchors a picker with top:anchor(bottom), dziri's nearest spelling would be
   top:100%, and css.ts refuses percentage lengths. (No backticks in this comment,
   and that is not a style choice — the whole sheet is a template literal, so one
   would end the string. It has now cost two builds.) So the engine offsets the
   overlay by its select's own box, which it can do because it has both rects. An
   author's own top/left still shift it from there — they move where Taffy puts the
   box, and the anchor offset is applied on top.

   Appearance — the picker's background and border, radii, the tick on a checkbox —
   is deliberately absent. That is a decision about how dziri's controls look, it
   belongs in a theme rather than in the sheet that makes elements behave like
   themselves, and html-coverage has nothing to say about it. */
select::picker(select) { position: absolute }

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
