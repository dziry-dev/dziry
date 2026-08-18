/**
 * Hot reload's compiler half: the fingerprint and the payload.
 *
 * The ruling these tests pin down (ROADMAP D1, stage 1): editing a style *value*
 * in an existing rule must produce an identical fingerprint (the running window's
 * tables are rewritten in place), while anything that changes the table's *shape*
 * — a new unique style, a dropped one, a media condition coming or going — must
 * move it, because row indices are pointers and a swapped table with shifted rows
 * paints the wrong styles on every node.
 */
import { expect, test } from "bun:test";
import { compile, emit, hashText } from "./compile.ts";

const html = `<body><div class="a"></div><div class="b"></div></body>`;
const css = `.a { width: 10px; background: red } .b { width: 20px }`;

const fingerprintOf = (h: string, c: string): string =>
  hashText(emit(compile(h, c), { html: h, css: c, typesFrom: "../src" }).structural);

test("editing a style value keeps the fingerprint and changes the payload", () => {
  const before = emit(compile(html, css), { html, css, typesFrom: "../src" });
  const edited = emit(compile(html, css.replace("red", "blue")), {
    html,
    css,
    typesFrom: "../src",
  });

  expect(hashText(edited.structural)).toBe(hashText(before.structural));
  // ...but the payload carries the new colour, so the swap has something to ship.
  expect(before.hot.styles.bg).not.toEqual(edited.hot.styles.bg);
  expect(before.hot.counts).toEqual(edited.hot.counts);
});

test("an identical recompile keeps the fingerprint", () => {
  expect(fingerprintOf(html, css)).toBe(fingerprintOf(html, css));
});

test("adding a property to an existing rule keeps the fingerprint", () => {
  // `.b` gains a background it never had. That is a *value* change, not a shape
  // change: b's computed style still interns to the same row, with new contents —
  // exactly what the swap ships. (What adds rows is two styles merging or
  // splitting, covered by the next test.)
  const withNewRule = `${css} .b { background: blue }`;
  expect(fingerprintOf(html, withNewRule)).toBe(fingerprintOf(html, css));

  const before = emit(compile(html, css), { html, css, typesFrom: "../src" });
  const after = emit(compile(html, withNewRule), { html, css, typesFrom: "../src" });
  expect(after.hot.counts).toEqual(before.hot.counts);
  expect(before.hot.styles.bg).not.toEqual(after.hot.styles.bg);
});

test("two styles becoming one moves the fingerprint", () => {
  // `.a` and `.b` resolving identically shrinks the interned table — the reverse
  // renumber, and just as fatal to a swap. (The count is 2, not 1: body owns a
  // row of its own.)
  const merged = `.a { width: 10px } .b { width: 10px }`;
  const both = emit(compile(html, merged), { html, css: merged, typesFrom: "../src" });
  const baseline = emit(compile(html, css), { html, css, typesFrom: "../src" });
  expect(fingerprintOf(html, merged)).not.toBe(fingerprintOf(html, css));
  expect(both.hot.counts.styles).toBe(baseline.hot.counts.styles - 1);
});

test("a media threshold change keeps the fingerprint; a new condition moves it", () => {
  const withMedia = `${css} @media (min-width: 600px) { .a { width: 30px } }`;
  const thresholdEdited = `${css} @media (min-width: 800px) { .a { width: 30px } }`;

  expect(fingerprintOf(html, thresholdEdited)).toBe(fingerprintOf(html, withMedia));
  expect(fingerprintOf(html, withMedia)).not.toBe(fingerprintOf(html, css));
});

test("a markup change moves the fingerprint", () => {
  // Classes resolve away at compile time, so a class nothing matches is a
  // legitimate no-op. Pointing the second div at `.a` is not: its style row
  // changes (and the table merges a row away).
  const edited = html.replace('class="b"', 'class="a"');
  expect(fingerprintOf(edited, css)).not.toBe(fingerprintOf(html, css));
});

test("an animation's timing edits keep the fingerprint", () => {
  const anim = `${css} @keyframes spin { to { transform: rotate(360deg) } } .a { animation: spin 1s linear infinite }`;
  const faster = anim.replace("1s", "200ms");
  expect(fingerprintOf(html, faster)).toBe(fingerprintOf(html, anim));

  const before = emit(compile(html, anim), { html, css: anim, typesFrom: "../src" });
  const after = emit(compile(html, faster), { html, css: faster, typesFrom: "../src" });
  expect(before.hot.tweens.duration).not.toEqual(after.hot.tweens.duration);
});
