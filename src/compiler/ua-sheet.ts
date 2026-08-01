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
`;
