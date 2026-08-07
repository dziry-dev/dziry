/**
 * The cascade: specificity, source order, shorthand-vs-longhand, and inline.
 *
 * The compiler had no unit tests at all, and the cascade is the part of it whose
 * output is *plausible* when wrong — a box with the wrong padding looks like a
 * design choice, not a bug. These pin the rules that the resolution order
 * actually has to honour.
 *
 * `compile()` is the real entry point, so these exercise parsing, matching,
 * specificity, inheritance and expansion together rather than a seam.
 */
import { expect, test } from "bun:test";
import { compile, compileTree, dump, emit, toCompiledUi } from "./compile.ts";
import { compileVariants, findToggles } from "./variant-compile.ts";
import { parseHtml } from "./html.ts";
import {
  Align,
  compactBits,
  ControlFlags,
  NodeKind,
  Display,
  INITIAL_STYLE,
  Position,
  Predicate,
  UNSET,
  type StyleField,
} from "../ir.ts";

/** The computed value of one field on the node matching `tag`. */
function styleOf(html: string, css: string, field: StyleField, tag = "div"): number {
  const ui = toCompiledUi(compile(html, css));
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;

  // body is node 0; the first element of `tag` is what the tests target.
  for (let i = 0; i < ui.nodes.count; i++) {
    if (ui.nodes.kind[i] === 0 && i > 0) return styles[field][ui.nodes.style[i]!]!;
  }
  throw new Error(`no <${tag}> in the compiled tree`);
}

test("specificity decides, not source order", () => {
  expect(styleOf(`<body><div class="a b"></div></body>`, `.b { width: 10px } .a { width: 20px }`, "width")).toBe(20);
  expect(
    styleOf(`<body><div class="a b"></div></body>`, `.a.b { width: 10px } .a { width: 20px }`, "width"),
  ).toBe(10);
});

test("source order breaks a specificity tie", () => {
  expect(styleOf(`<body><div class="a b"></div></body>`, `.a { width: 10px } .b { width: 20px }`, "width")).toBe(20);
});

// ---------------------------------------------------------------------------
// The regression: shorthand expansion position
// ---------------------------------------------------------------------------

test("a higher-specificity shorthand beats a lower-specificity longhand", () => {
  // `.x .card` (0,2,0) outranks `.card` (0,1,0), so its `padding` wins outright.
  //
  // This produced padL = 4 before: `padding` kept the position it was first
  // inserted at, so it expanded *before* the longhand and lost to it, inverting
  // the cascade.
  const html = `<body class="x"><div class="card"></div></body>`;
  const css = `.card { padding: 14px } .card { padding-left: 4px } .x .card { padding: 2px }`;

  expect(styleOf(html, css, "padL")).toBe(2);
  expect(styleOf(html, css, "padT")).toBe(2);
});

test("a longhand still beats a shorthand of equal rank declared before it", () => {
  const html = `<body><div class="card"></div></body>`;
  const css = `.card { padding: 14px; padding-left: 4px }`;

  expect(styleOf(html, css, "padL")).toBe(4);
  expect(styleOf(html, css, "padR")).toBe(14);
});

test("a shorthand declared after a longhand overwrites it", () => {
  const html = `<body><div class="card"></div></body>`;
  const css = `.card { padding-left: 4px; padding: 14px }`;

  expect(styleOf(html, css, "padL")).toBe(14);
});

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

test("inline beats every selector, however specific", () => {
  const html = `<body class="x"><div class="card" style="width: 5px"></div></body>`;
  const css = `.x .card { width: 100px } .card { width: 50px }`;

  expect(styleOf(html, css, "width")).toBe(5);
});

test("an inline shorthand beats a longhand from the sheet", () => {
  // The same position bug, reached the other way: an inline `padding` that only
  // replaced the cascade's `padding` would expand at the cascade's position and
  // then lose to `padding-left` from a matched rule.
  const html = `<body><div class="card" style="padding: 0"></div></body>`;
  const css = `.card { padding: 14px; padding-left: 9px }`;

  expect(styleOf(html, css, "padL")).toBe(0);
  expect(styleOf(html, css, "padT")).toBe(0);
});

test("inline only overrides what it declares", () => {
  const html = `<body><div class="card" style="width: 5px"></div></body>`;
  const css = `.card { width: 50px; height: 30px }`;

  expect(styleOf(html, css, "width")).toBe(5);
  expect(styleOf(html, css, "height")).toBe(30);
});

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

test("hover and focus merge per property instead of one winning", () => {
  // The reason the state table stopped being three named columns.
  //
  // With `(hover, active, focus)` the runtime *picked* one precompiled style, so
  // a node that was hovered and focused at once got whichever role ranked higher
  // and lost the other's declarations entirely — hover beat focus outright. CSS
  // combines them per property.
  const html = `<body><div class="btn"></div></body>`;
  const css = `
    .btn { background: #000000; border-color: #000000 }
    .btn:hover { background: #ff0000 }
    .btn:focus { border-color: #00ff00 }
  `;

  const ui = toCompiledUi(compile(html, css));
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  const { variants } = ui;

  expect(variants.count).toBe(1);
  const mask = variants.mask[0]!;
  expect(mask).toBe(Predicate.HOVER | Predicate.FOCUS);

  // Two predicates, so four entries: base, hover, focus, hover+focus.
  const start = variants.runStart[0]!;
  const run = Array.from(variants.slots.subarray(start, start + 4));
  expect(run.length).toBe(4);

  const bg = (slot: number) => styles.bg[slot]!;
  const border = (slot: number) => styles.borderColor[slot]!;

  expect(bg(run[0]!)).toBe(0xff000000);
  expect(bg(run[1]!)).toBe(0xffff0000); // hover only
  expect(border(run[2]!)).toBe(0xff00ff00); // focus only

  // Both at once: red background *and* green border. Neither declaration is lost.
  expect(bg(run[3]!)).toBe(0xffff0000);
  expect(border(run[3]!)).toBe(0xff00ff00);
});

test(":checked and :disabled are predicates like any other", () => {
  // The whole of ROADMAP C2 phase 0, asserted: widening the state set is one
  // entry in `PREDICATE_PSEUDO` and one in `SUPPORTED_PSEUDO`, and everything
  // downstream — mask, run, merge — already worked in bits.
  //
  // So a disabled checkbox that is also checked gets a style resolved with *both*
  // live, which is what a real form needs and what the old named-role triple
  // could not have produced at all.
  const html = `<body><div class="box"></div></body>`;
  const css = `
    .box { background: #000000; border-color: #000000; accent-color: #0284c7 }
    .box:checked { accent-color: #16a34a }
    .box:disabled { background: #cccccc }
  `;

  const ui = toCompiledUi(compile(html, css));
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  const { variants } = ui;

  expect(variants.count).toBe(1);
  const mask = variants.mask[0]!;
  expect(mask).toBe(Predicate.CHECKED | Predicate.DISABLED);

  const start = variants.runStart[0]!;
  const at = (live: number) => start + compactBits(live, mask);

  expect(styles.accentColor[variants.slots[at(0)]!]!).toBe(0xff0284c7);
  expect(styles.accentColor[variants.slots[at(Predicate.CHECKED)]!]!).toBe(0xff16a34a);
  expect(styles.bg[variants.slots[at(Predicate.DISABLED)]!]!).toBe(0xffcccccc);

  // Checked *and* disabled: the green accent and the grey background together.
  const both = variants.slots[at(Predicate.CHECKED | Predicate.DISABLED)]!;
  expect(styles.accentColor[both]!).toBe(0xff16a34a);
  expect(styles.bg[both]!).toBe(0xffcccccc);
});

test("::before and ::after emit real nodes, in document order", () => {
  // The substitution for a shadow tree. A generated box is an ordinary emitted
  // node, so it lays out in Taffy and paints in the normal pass — which is what a
  // synthesised paint-time rect would not do, and what a shadow tree would have
  // needed a whole parallel mechanism for.
  const html = `<body><div class="q">mid</div></body>`;
  const css = `
    .q::before { content: "«" }
    .q::after  { content: "»" }
  `;

  const ui = toCompiledUi(compile(html, css));
  const div = 1;
  const kids: number[] = [];
  for (let n = ui.nodes.firstChild[div]!; n !== -1; n = ui.nodes.nextSibling[n]!) kids.push(n);
  expect(kids.length).toBe(3);

  const textOf = (n: number) => ui.strings[ui.nodes.text[n]!];
  expect(textOf(kids[0]!)).toBe("«");
  expect(textOf(kids[1]!)).toBe("mid");
  expect(textOf(kids[2]!)).toBe("»");

  // Flagged, so the engine resolves their predicates against the originating
  // element rather than themselves.
  expect([...ui.generated]).toEqual([kids[0]!, kids[2]!]);
});

test("a pseudo-element with no content renders nothing", () => {
  // CSS is explicit: absent, `normal` or `none` content means the box is not
  // rendered at all. A rule that exists only for its other declarations is the
  // ordinary case, not an error.
  const ui = toCompiledUi(
    compile(`<body><div class="a"></div></body>`, `.a::before { color: #ff0000 }`),
  );
  expect(ui.nodes.firstChild[1]).toBe(-1);
  expect([...ui.generated]).toEqual([]);

  const none = toCompiledUi(
    compile(`<body><div class="a"></div></body>`, `.a::before { content: none; color: #ff0000 }`),
  );
  expect(none.nodes.firstChild[1]).toBe(-1);
});

test("a generated box gets its own variant run from the element's state", () => {
  // `.btn:hover::before` is the shape a UA control stylesheet is written in, and
  // it only works because a pseudo-element goes through the same mask/run
  // resolution the element does rather than a lesser second path.
  const html = `<body><div class="btn"></div></body>`;
  const css = `
    .btn::before          { content: "\\2713"; color: transparent }
    .btn:checked::before  { color: #ffffff }
  `;

  const ui = toCompiledUi(compile(html, css));
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  const box = ui.nodes.firstChild[1]!;
  expect(ui.strings[ui.nodes.text[box]!]).toBe("✓");

  const row = [...ui.variants.node].indexOf(box);
  expect(row).toBeGreaterThanOrEqual(0);
  const mask = ui.variants.mask[row]!;
  expect(mask).toBe(Predicate.CHECKED);

  const start = ui.variants.runStart[row]!;
  expect(styles.fg[ui.variants.slots[start]!]!).toBe(0x00000000);
  expect(styles.fg[ui.variants.slots[start + compactBits(Predicate.CHECKED, mask)]!]!).toBe(
    0xffffffff,
  );
});

test("a generated box is never interactive, however many states it styles", () => {
  // Found by the characterize corpus, and the failure is counter-intuitive: the
  // box carries a hover variant, so the "has a state style" rule made it
  // interactive — and `hit_test` returns the innermost interactive node, so the
  // pointer over a checkbox's tick would make the *tick* hovered and leave the
  // checkbox un-hovered. `.check:hover` would stop applying precisely when the
  // pointer was over the middle of the control.
  const html = `<body><div class="check"></div></body>`;
  const css = `
    .check:hover         { border-color: #0284c7 }
    .check::before        { content: "\\2713" }
    .check:hover::before  { color: #a1a1aa }
  `;

  const ui = toCompiledUi(compile(html, css));
  const box = ui.nodes.firstChild[1]!;

  expect([...ui.generated]).toEqual([box]);
  expect([...ui.interactive]).toEqual([1]);
  expect([...ui.interactive]).not.toContain(box);
});

test("content may not depend on a state, and says so", () => {
  // The silent-failure case this refuses: reading only the resting cascade would
  // compile a tick that never appears, which reads as a stylesheet bug rather
  // than a missing feature. Text is one string slot; a variant run carries style
  // ids only.
  expect(() =>
    compile(
      `<body><div class="c"></div></body>`,
      `.c::before { content: "" } .c:checked::before { content: "x" }`,
    ),
  ).toThrow(/content` cannot depend on `:checked`/);
});

test("attribute selectors tell one input type from another", () => {
  // The reason they had to exist: twenty-two `input` types share one tag, so
  // without this a UA stylesheet cannot say which control it is describing.
  const html = `<body><input type="checkbox"><input type="radio"><input type="text" placeholder="p"></body>`;
  const css = `
    input                      { border-width: 1px }
    input[type="checkbox"]     { border-radius: 4px }
    input[type="radio"]        { border-radius: 9px }
    input[placeholder]         { color: #ff0000 }
  `;

  const ui = toCompiledUi(compile(html, css));
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  const at = (n: number, f: StyleField) => styles[f][ui.nodes.style[n]!]!;

  // All three get the tag rule; only their own type rule applies.
  for (const n of [1, 2, 3]) expect(at(n, "borderWidth")).toBe(1);
  expect(at(1, "radTL")).toBe(4);
  expect(at(2, "radTL")).toBe(9);
  expect(at(3, "radTL")).toBe(0);

  // Presence, not value.
  expect(at(3, "fg")).toBe(0xffff0000);
  expect(at(1, "fg")).not.toBe(0xffff0000);
});

test("every attribute operator, against the spec's semantics", () => {
  const html =
    `<body>` +
    `<div data-t="alpha beta"></div>` +
    `<div data-t="en-GB"></div>` +
    `<div data-t="report.pdf"></div>` +
    `</body>`;
  const css = `
    [data-t~="beta"]      { width: 1px }
    [data-t|="en"]        { height: 2px }
    [data-t$=".pdf"]      { min-width: 3px }
    [data-t^="report"]    { max-width: 4px }
    [data-t*="port"]      { flex-grow: 5 }
    [data-t="alpha beta"] { flex-shrink: 6 }
    [data-t]              { gap: 7px }
  `;

  const ui = toCompiledUi(compile(html, css));
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  const at = (n: number, f: StyleField) => styles[f][ui.nodes.style[n]!]!;

  // `~=` matches a whole word, not a substring — the easy one to get wrong.
  // Unmatched is `auto`, which is NaN, not zero.
  expect(at(1, "width")).toBe(1);
  expect(at(3, "width")).toBeNaN();

  // `|=` matches the value or the value plus a hyphen, which is what makes
  // `[lang|=en]` match `en-GB`.
  expect(at(2, "height")).toBe(2);
  expect(at(1, "height")).toBeNaN();

  expect(at(3, "minW")).toBe(3);
  expect(at(3, "maxW")).toBe(4);
  expect(at(3, "grow")).toBe(5);
  expect(at(1, "shrink")).toBe(6);

  // Presence matches all three.
  for (const n of [1, 2, 3]) expect(at(n, "gapRow")).toBe(7);
});

test("a select gets its closed button and selected text from the compiler", () => {
  // The user-visible claim: an author writes a select and its options, and the
  // parts a browser would build in a shadow tree are built here as real nodes.
  const ui = toCompiledUi(
    compile(
      `<body><select><option>Free</option><option selected>Pro</option></select></body>`,
      "",
    ),
  );

  // select > [button, picker]; button > selectedcontent > "Pro"; picker > two options.
  //
  // The options used to be direct children and the UA sheet hid them, because there was
  // no overlay layer to draw a picker in. They are in one now — which is a structural
  // change, so this test moved with it rather than being deleted.
  const select = 1;
  const kids: number[] = [];
  for (let n = ui.nodes.firstChild[select]!; n !== -1; n = ui.nodes.nextSibling[n]!) kids.push(n);
  expect(kids.length).toBe(2);

  const button = kids[0]!;
  const selectedContent = ui.nodes.firstChild[button]!;
  const label = ui.nodes.firstChild[selectedContent]!;
  expect(ui.strings[ui.nodes.text[label]!]).toBe("Pro");

  // `selected`, not the first option — the same decision that marks it `CHECKED`, so the
  // baked label and the engine's initial selection cannot disagree.
  const chosen = [...ui.controls.node].findIndex(
    (_, row) => (ui.controls.flags[row]! & ControlFlags.CHECKED) !== 0,
  );
  expect(chosen).toBeGreaterThan(-1);
  expect(ui.controls.label[chosen]!).toBeGreaterThan(-1);

  // The picker holds the options, and it is an overlay — painted after the tree and
  // hit-tested before it. `position: absolute` from the UA sheet is what keeps a closed
  // select exactly as tall as its button.
  const picker = kids[1]!;
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  expect(styles.position[ui.nodes.style[picker]!]!).toBe(Position.ABSOLUTE);
  expect([...ui.overlays]).toEqual([picker]);

  const options: number[] = [];
  for (let n = ui.nodes.firstChild[picker]!; n !== -1; n = ui.nodes.nextSibling[n]!) {
    options.push(n);
  }
  expect(options.length).toBe(2);
  // Laid out rather than hidden, which is the whole of the change.
  for (const option of options) {
    expect(styles.display[ui.nodes.style[option]!]!).not.toBe(Display.NONE);
  }
});

test("a select's option still matches `select > option`", () => {
  // The picker is spliced in at the *node* level precisely so this keeps working: a
  // browser's picker is a pseudo-element the light-DOM options render into, not a wrapper
  // they become children of. Doing it in `uaParts` would have been shorter and would have
  // silently broken every `select > option` rule an author writes.
  const ui = toCompiledUi(
    compile(
      `<body><select><option>Free</option><option selected>Pro</option></select></body>`,
      `select > option { width: 3px } select option:first-child { height: 5px }`,
    ),
  );
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;

  const picker = [...ui.overlays][0]!;
  const options: number[] = [];
  for (let n = ui.nodes.firstChild[picker]!; n !== -1; n = ui.nodes.nextSibling[n]!) {
    options.push(n);
  }
  expect(options.length).toBe(2);
  for (const option of options) expect(styles.width[ui.nodes.style[option]!]!).toBe(3);

  // And `:first-child` counts the options as the select's own children, so the first
  // option is one. Before this, `positionOf` walked the UA-supplied button too and every
  // option was shifted by a position — so this matched nothing.
  expect(styles.height[ui.nodes.style[options[0]!]!]!).toBe(5);
  expect(styles.height[ui.nodes.style[options[1]!]!]!).toBeNaN();
});

test("the tab-stop set is the measured one, not the interactive one", () => {
  // ROADMAP A3's compile-time half. Written against `probes/tab-order.html` and, more to
  // the point, written against the three places the tab-stop set and the *interactive*
  // set disagree — because deriving one from the other is the obvious shortcut and each
  // of these is a case where it silently gives the wrong answer.
  const ui = toCompiledUi(
    compile(
      `<body>` +
        `<a href="/x">linked</a>` +
        `<a>bare</a>` +
        `<button>press</button>` +
        `<input type="checkbox">` +
        `<select><option>Free</option><option selected>Pro</option></select>` +
        `<div>plain</div>` +
        `<span>words</span>` +
        `</body>`,
      "",
    ),
  );

  // Body's children in document order, which is the order they are written above. Node
  // ids are not usable directly here because every element with text has a run between
  // it and its next sibling.
  const kids: number[] = [];
  for (let n = ui.nodes.firstChild[0]!; n !== -1; n = ui.nodes.nextSibling[n]!) kids.push(n);
  const [linked, bare, button, checkbox, select, div, span] = kids as [
    number, number, number, number, number, number, number,
  ];
  const stops = [...ui.tabStops];

  expect(stops).toContain(linked);
  expect(stops).toContain(button);
  expect(stops).toContain(checkbox);

  // A link with no destination is not focusable at all — not by Tab, not by script — and
  // it *is* interactive content for a label's purposes. So the two sets differ here, and
  // the compiler asks about `href` rather than about the tag.
  expect(stops).not.toContain(bare);

  // A select is **one** stop. Its UA-supplied `<button>` is what the pointer hits, and it
  // is not in the tab order — measured, and the reason this cannot be derived from
  // `ownsPress`, which exempts the same button for an unrelated reason.
  expect(stops).toContain(select);
  const uaButton = ui.nodes.firstChild[select]!;
  expect(ui.nodes.kind[uaButton]!).toBe(NodeKind.BUTTON);
  expect(stops).not.toContain(uaButton);

  // An `<option>` is a control with a kind and a row of its own, and Tab never visits one.
  // A picker's list is arrowed.
  const picker = [...ui.overlays][0]!;
  for (let n = ui.nodes.firstChild[picker]!; n !== -1; n = ui.nodes.nextSibling[n]!) {
    expect(stops).not.toContain(n);
  }

  // And nothing that is merely a box.
  for (const node of [0, div, span]) expect(stops).not.toContain(node);

  // Sorted, because `findRow` binary-searches it. **Not** because it is the order — node
  // ids are document order today, which is exactly what would make a sequence read off
  // this array look correct until the first keyed reorder.
  expect(stops).toEqual([...stops].sort((a, b) => a - b));
});

test("tabindex overrides the tag rule in both directions", () => {
  // The whole of `tabindex` support, and the reason it needed no protocol change: a
  // pointer press focuses whatever it hits regardless of any flag, so "focusable but not
  // tabbable" — the second set `NodeFlags.TAB_STOP` anticipated — is empty here, and
  // `tabindex="-1"` is exactly "not a tab stop".
  const result = compile(
    `<body>` +
      `<div tabindex="0">reachable</div>` +
      `<button tabindex="-1">unreachable</button>` +
      `<span tabindex="3">positive</span>` +
      `<div tabindex="nonsense">ignored</div>` +
      `</body>`,
    "",
  );
  const ui = toCompiledUi(result);

  const kids: number[] = [];
  for (let n = ui.nodes.firstChild[0]!; n !== -1; n = ui.nodes.nextSibling[n]!) kids.push(n);
  const [div, button, span, bogus] = kids as [number, number, number, number];
  const stops = [...ui.tabStops];

  expect(stops).toContain(div);
  // A `<button>` is a tab stop by its tag, and this is the case that proves the attribute
  // wins rather than merely adding: the only way to observe an override is to remove one.
  expect(stops).not.toContain(button);

  // A positive tabindex still reaches the keyboard, in document order, because dropping
  // it would be an accessibility regression to punish a stylistic choice. The build says
  // what it did instead of doing it quietly.
  expect(stops).toContain(span);
  expect(result.warnings.join("\n")).toMatch(/tabindex="3".*is treated as tabindex="0"/s);

  // HTML ignores an invalid value, and ignoring it means falling back to the tag — which
  // for a `<div>` is "not a stop".
  expect(stops).not.toContain(bogus);
});

test("an authored select button is left alone", () => {
  // The spec's opt-in form for customizing the internals. Overwriting it would
  // make `appearance: base-select` pointless.
  const ui = toCompiledUi(
    compile(
      `<body><select><button><selectedcontent>Mine</selectedcontent></button><option>Other</option></select></body>`,
      "",
    ),
  );
  const kids: number[] = [];
  for (let n = ui.nodes.firstChild[1]!; n !== -1; n = ui.nodes.nextSibling[n]!) kids.push(n);
  expect(kids.length).toBe(2);

  const label = ui.nodes.firstChild[ui.nodes.firstChild[kids[0]!]!]!;
  expect(ui.strings[ui.nodes.text[label]!]).toBe("Mine");
});

test("a pseudo-element rule does not style its originating element", () => {
  // Separate cascades. `p::before { color }` colouring the `<p>` would be the
  // most obvious possible bug and the easiest to introduce, since both resolve
  // through the same collectDecls.
  const ui = toCompiledUi(
    compile(
      `<body><p class="p">x</p></body>`,
      `.p { color: #111111 } .p::before { content: "!"; color: #ff0000 }`,
    ),
  );
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  expect(styles.fg[ui.nodes.style[1]!]!).toBe(0xff111111);

  // And the box inherits the element's colour only where it says nothing itself.
  const box = ui.nodes.firstChild[1]!;
  expect(styles.fg[ui.nodes.style[box]!]!).toBe(0xffff0000);
});

test("hover and focus still merge when a conditional class is present", () => {
  // The gap this closes. `compileVariants` re-interns every style over the
  // vector of its values across variants, so with a toggle in the document the
  // run had to be rebuilt from its output — and its output was three named
  // roles, so combined entries fell back to precedence.
  //
  // Which meant the merge above held only for documents with no conditional
  // class. This app has two, so the fix applied nowhere real until now.
  // No `theme` in the class attribute: the toggle *adds* it, so the baseline and
  // the variant actually differ and a patch exists to inspect.
  const html = `<body><div class="btn"></div></body>`;
  const css = `
    .btn { color: #111111; background: #222222; border-color: #333333 }
    .btn:hover { color: #ff0000 }
    .btn:focus { background: #0000ff }
    .theme .btn { border-color: #444444 }
  `;

  // This has to go through `compileVariants`, so the tree needs a `classWhen` —
  // which the HTML front-end cannot express. Attaching one by hand is what a
  // `className={cn({ theme: isDark })}` would have produced.
  const doc = parseHtml(html);
  const signal = { fake: "signal" };
  doc.children[0]!.type === "element" && (doc.children[0]!.classWhen = { theme: signal });

  const toggles = findToggles(doc);
  expect(toggles.length).toBe(1);

  const baseline = compileTree(doc, css);
  const compiled = compileVariants(doc, css, baseline, toggles);

  // The button is the only conditional node.
  const node = compiled.masks.findIndex((m) => m !== 0);
  expect(node).toBeGreaterThan(0);
  expect(compiled.masks[node]!).toBe(Predicate.HOVER | Predicate.FOCUS);

  const run = compiled.runs[node]!;
  const both = run[compactBits(Predicate.HOVER | Predicate.FOCUS, compiled.masks[node]!)]!;

  // Read out of the variant compiler's own table, which is what ships.
  const field = (f: StyleField, slot: number) => compiled.table[f][slot]!;

  // Neither declaration is dropped. Before this, `both` was whichever single
  // role precedence ranked highest, so one of these two was the base value.
  expect(field("fg", both)).toBe(0xffff0000);
  expect(field("bg", both)).toBe(0xff0000ff);

  // And the toggle still patches the same slot: `.theme .btn` raises the border
  // colour when it is on, which is a patch entry rather than a second slot.
  const borderPatch = compiled.patches[0]!.entries.find((e) => e.field === "borderColor");
  expect(borderPatch).toBeDefined();
  expect(borderPatch!.on).toContain(0xff444444);
});

test("a node whose states resolve to its base style is not conditional", () => {
  // A `:hover` rule that changes nothing must not put the node in the variant
  // table, or every frame pays a binary search to learn there is nothing to do.
  const html = `<body><div class="btn"></div></body>`;
  const css = `.btn { background: #ff0000 } .btn:hover { background: #ff0000 }`;

  expect(toCompiledUi(compile(html, css)).variants.count).toBe(0);
});

test("an unsupported selector is refused, not silently rewritten", () => {
  // Each of these used to parse into a *different, plausible* selector, because
  // the token scanner searched the string instead of covering it.
  const cases: Array<[string, string]> = [
    // `input[type="text"]` was the first entry here and is now supported — the
    // whole reason attribute selectors were built. Its replacement keeps the
    // *shape* of the original bug: a bracketed construct the scanner must not
    // quietly drop the way it once dropped `[type="text"]` down to `text`.
    [`input[type="text"i] extra] { width: 1px }`, "malformed attribute selector was swallowed"],
    // `div > span` was here and is now supported — the whole reason the child
    // combinator was built, since `space-y-*` compiles to
    // `:where(.space-y-4 > :not(:last-child))`. The sibling one stays: it asks
    // about siblings rather than ancestors, which the matcher cannot answer.
    [`div + span { width: 1px }`, "sibling combinator became a descendant one"],
    [`* { width: 1px }`, "universal selector matched nothing"],
  ];

  for (const [css, why] of cases) {
    expect(() => compile(`<body><div></div></body>`, css), why).toThrow();
  }
});

/**
 * The child combinator has to *mean* child, which is the half of the old refusal
 * that mattered: `div > span` parsing as `div span` is the failure that made
 * refusing it correct in the first place, so the test that replaces the refusal is
 * the one where the two would disagree.
 */
test("a child combinator does not match a grandchild", () => {
  const html = `<body><div class="a"><span class="direct"></span><i><span class="deep"></span></i></div></body>`;
  const ui = toCompiledUi(
    compile(html, `.a > span { width: 7px } .a span { height: 3px }`),
  );
  const styles = ui.styles as unknown as Record<string, ArrayLike<number>>;
  // 0 body, 1 .a, 2 span.direct, 3 i, 4 span.deep
  const widthOf = (n: number) => styles.width![ui.nodes.style[n]!]!;
  const heightOf = (n: number) => styles.height![ui.nodes.style[n]!]!;

  expect(widthOf(2)).toBe(7);
  expect(heightOf(2)).toBe(3);
  // The descendant rule reaches the nested span; the child rule must not.
  expect(heightOf(4)).toBe(3);
  expect(widthOf(4)).not.toBe(7);
});

/**
 * `:where()` is the wrapper every Tailwind `space-*` and `divide-*` utility is
 * emitted inside, and its whole job is to weigh nothing — so the test is a
 * specificity comparison, not a match.
 */
test(":where() matches its argument and contributes no specificity", () => {
  const html = `<body><div class="a b"></div></body>`;
  // On specificity alone `.a:where(.b)` is (0,1,0) and `.a` is (0,1,0) too, so
  // source order decides and the *earlier* `.a` must lose. If `:where()` counted
  // its argument it would be (0,2,0) and win regardless of order — which is the
  // failure this pins.
  const ui = toCompiledUi(compile(html, `.a:where(.b) { width: 1px } .a { width: 9px }`));
  const styles = ui.styles as unknown as Record<string, ArrayLike<number>>;
  expect(styles.width![ui.nodes.style[1]!]).toBe(9);

  // `:is()` does count it, so the same pair resolves the other way.
  const withIs = toCompiledUi(compile(html, `.a:is(.b) { width: 1px } .a { width: 9px }`));
  const isStyles = withIs.styles as unknown as Record<string, ArrayLike<number>>;
  expect(isStyles.width![withIs.nodes.style[1]!]).toBe(1);
});

/**
 * The structural pseudo-classes, which is what makes `space-y-*` produce a
 * *different* style for the last child rather than the same one everywhere.
 */
test(":first-child, :last-child and :only-child resolve off the tree", () => {
  const html = `<body><div><i class="x"></i><i class="y"></i><i class="z"></i></div></body>`;
  const ui = toCompiledUi(
    compile(html, `i:first-child { width: 1px } i:last-child { width: 2px } i:only-child { width: 3px }`),
  );
  const styles = ui.styles as unknown as Record<string, ArrayLike<number>>;
  const widthOf = (n: number) => styles.width![ui.nodes.style[n]!]!;
  // 0 body, 1 div, 2 .x, 3 .y, 4 .z
  expect(widthOf(2)).toBe(1);
  expect(widthOf(4)).toBe(2);
  expect(widthOf(3)).not.toBe(1);
  expect(widthOf(3)).not.toBe(2);

  const lone = toCompiledUi(compile(`<body><div><i></i></div></body>`, `i:only-child { width: 3px }`));
  const loneStyles = lone.styles as unknown as Record<string, ArrayLike<number>>;
  expect(loneStyles.width![lone.nodes.style[2]!]).toBe(3);
});

/**
 * Text between elements must not count. `:last-child` counts *elements*, and a
 * tree written with newlines between its tags has a text run after the final one —
 * so counting nodes rather than elements would make nothing the last child, and
 * `space-y-*` would put a trailing margin on every row.
 */
test("a trailing text run does not displace :last-child", () => {
  const html = `<body><div>\n  <i class="x"></i>\n  <i class="y"></i>\n</div></body>`;
  const ui = toCompiledUi(compile(html, `i:last-child { width: 2px }`));
  const styles = ui.styles as unknown as Record<string, ArrayLike<number>>;
  const yNode = ui.nodes.style.findIndex((_, n) => styles.width![ui.nodes.style[n]!] === 2);
  expect(yNode).toBeGreaterThan(0);
});

test("align-items defaults to stretch, as CSS's `normal` does", () => {
  // This was `flex-start`, and the cost was paid in stylesheets: the sample
  // carried six `align-items: stretch` declarations purely to undo it. Removing
  // the default *and* all six produced a byte-identical render, which is the
  // evidence that they only ever existed to cancel this.
  //
  // A column's child with no width of its own should fill the cross axis.
  const html = `<body><div class="card"></div></body>`;
  const css = `body { width: 200px } .card { height: 10px }`;
  const ui = toCompiledUi(compile(html, css));

  expect(INITIAL_STYLE.align).toBe(UNSET);
  // Nothing in the sheet sets `align-items`, so the child inherits the default
  // and the engine leaves Taffy's — which is per-display-mode, and is why this
  // is UNSET rather than literally STRETCH.
  const styles = ui.styles as unknown as Record<StyleField, ArrayLike<number>>;
  expect(styles.align[ui.nodes.style[1]!]).toBe(UNSET);
});

test("inherited properties pass down, non-inherited do not", () => {
  const html = `<body><div class="card"></div></body>`;
  const css = `body { color: #ff0000; width: 200px }`;

  expect(styleOf(html, css, "fg")).toBe(0xffff0000);
  // `width` is not inherited: the child is `auto`, which is NaN.
  expect(Number.isNaN(styleOf(html, css, "width"))).toBe(true);
});

/**
 * `currentcolor` is not dynamic, and the cascade is where it stops looking like it.
 *
 * It means "this element's computed `color`", and the cascade already resolves `color` per
 * node at build time — so it is a lookup, not a signal. Substituting it textually before
 * the expander runs is what makes bare `ring-2` work: Tailwind reaches the keyword through
 * `var(--tw-ring-color, currentcolor)`, so it is not in the authored text at all.
 */
test("currentcolor resolves to the element's own colour, whatever the declaration order", () => {
  const html = `<body><div class="a"></div></body>`;

  // Written *before* `color`, which must not matter: `currentcolor` is a computed-value
  // rule, not a fold over declarations in order.
  expect(styleOf(html, `.a { border-color: currentcolor; color: #ff0000 }`, "borderColor")).toBe(
    0xffff0000,
  );

  // The element's own colour beats the inherited one.
  expect(
    styleOf(html, `body { color: #0000ff } .a { color: #00ff00; box-shadow: 0 0 0 2px currentcolor }`, "ringOuterColor"),
  ).toBe(0xff00ff00);

  // With no `color` of its own it is the inherited one, because that is what `color`
  // computes to here.
  expect(styleOf(html, `body { color: #0000ff } .a { box-shadow: 0 0 0 2px currentcolor }`, "ringOuterColor")).toBe(
    0xff0000ff,
  );

  // `currentcolor` on `color` itself is the *parent's* colour — the one case where it must
  // not resolve against the value being computed, or it would be a cycle.
  expect(styleOf(html, `body { color: #0000ff } .a { color: currentcolor }`, "fg")).toBe(0xff0000ff);
});

// ---------------------------------------------------------------------------
// The emitted artifact
// ---------------------------------------------------------------------------

/**
 * A style column that is the same in every slot is emitted as one value.
 *
 * `emit` already knew this trick for the node tables (`new Int16Array(n).fill(-1)`)
 * and did not use it for the style columns, so most of a style table was identical
 * values spelled out — 2279 bytes of the sample's 19335, which JSC tokenizes on
 * every start. This asserts the shape of the output, not the size: a uniform column
 * collapses, and a column that actually varies keeps every element.
 */
test("a uniform style column is emitted as a fill, and a varying one is not", () => {
  const html = `<body><div class="a"></div><div class="b"></div></body>`;
  // Nothing here sets a margin, so `marT` is uniform; `width` differs per slot.
  const css = `.a { width: 10px } .b { width: 20px }`;
  const source = emit(compile(html, css), { html, css, typesFrom: "../src" });

  // Zero needs no `fill`: a typed array is already zero-filled.
  expect(source).toMatch(/marT: new Float32Array\(\d+\),/);
  // `NaN` and `Infinity` do, and `Number.isNaN` is why the all-`auto` columns
  // collapse at all — `NaN !== NaN` would call every one of them non-uniform.
  expect(source).toMatch(/maxW: new Float32Array\(\d+\)\.fill\(Infinity\),/);
  expect(source).toMatch(/basis: new Float32Array\(\d+\)\.fill\(NaN\),/);
  // Uniform is a property of the values, not of the field.
  expect(source).toMatch(/width: new Float32Array\(\[[^\]]*10[^\]]*20[^\]]*\]\)/);
});

// ---------------------------------------------------------------------------
// Golden IR
// ---------------------------------------------------------------------------

/**
 * One fixture, the whole IR, as text.
 *
 * `dump()` already existed for `bun run compile`, which makes it the cheapest
 * broad assertion available: node kinds and tree shape, style interning and reuse,
 * inheritance, the hover variant, and the string table, all in one comparison.
 * The individual tests above pin *rules*; this pins the *output*, so a change
 * anywhere in the pipeline has to be looked at and either explained or fixed.
 *
 * Written inline rather than as a snapshot file: a golden nobody reads is a golden
 * that gets regenerated on autopilot. Notice what it records — style 2 is shared by
 * `.row` and the nested `.row` span, `fg` is inherited into every slot including
 * the text nodes, and the button's `hover` slot repeats every non-colour field
 * because a variant is a whole resolved style rather than a delta.
 */
test("the IR for one small document is exactly this", () => {
  const html =
    `<body class="page"><h1 id="title">Hi</h1><div class="row">` +
    `<button class="btn">Go</button><span class="row">x</span></div></body>`;
  const css = `
  .page { padding: 8px; display: flex; flex-direction: column; gap: 4px; color: #eeeeee }
  #title { font-size: 20px; font-weight: 700 }
  .row { display: flex; gap: 4px }
  .btn { background: #123456; border: 1px solid #abcdef; border-radius: 6px; padding: 2px 6px }
  .btn:hover { background: #2244aa }
`;

  expect(dump(compile(html, css))).toBe(
    [
      "tree",
      "  #0 box  style=0",
      "    #1 box  style=1",
      '      #2 text "Hi"  style=2',
      "    #3 box  style=3",
      '      #4 button "Go"  style=4 hover=5 focus-visible=6',
      "      #5 box  style=3",
      '        #6 text "x"  style=8',
      "",
      // Seven, not six: the UA sheet gives `h1` a margin, and margins do not
      // inherit — so the heading and its text run are no longer the same computed
      // style and stop sharing a slot. Every index after it shifts by one. That is
      // the interner working, not a regression: `.row` and the nested `.row` span
      // still share style 3, which is the sharing this fixture exists to pin.
      //
      // `selectionBg`/`selectionFg` on every row is the UA sheet's `body::selection`
      // arriving by *inheritance*, which is how one rule at the root becomes the default
      // for every field without being declared on any of them — and what lets an author's
      // own `body::selection` win on origin instead of losing to a UA rule sitting closer.
      //
      // They print as hex rather than as a nine-digit decimal because `describeStyle`
      // derives which fields are colours from the wire type now instead of naming three of
      // them. Half the palette — both scrollbar colours, `accentColor`, `caretColor` — had
      // been dumping as raw integers.
      // Nine, not seven: the UA sheet's `:focus-visible` ring gives the button a second
      // predicate, and a variant run is the *cross product* of the predicates a node's
      // rules mention — so `hover` and `focus-visible` together need four slots, of which
      // two are new. That growth is the cost model of precompiled variants, visible here
      // in miniature, and it is why the ring rule is scoped to focusable tags rather than
      // written as a bare `:focus-visible`: universal, it would do this to every node in
      // the document.
      "styles (9 unique)",
      "    0  fg=#eeeeee selectionBg=#3390ff selectionFg=#ffffff " +
        "padT=8 padR=8 padB=8 padL=8 gapRow=4 gapCol=4",
      "    1  fg=#eeeeee selectionBg=#3390ff selectionFg=#ffffff " +
        "marT=21.44 marB=21.44 fontSize=20 fontWeight=700",
      "    2  fg=#eeeeee selectionBg=#3390ff selectionFg=#ffffff fontSize=20 fontWeight=700",
      "    3  fg=#eeeeee selectionBg=#3390ff selectionFg=#ffffff direction=row gapRow=4 gapCol=4",
      "    4  bg=#123456 fg=#eeeeee borderColor=#abcdef borderWidth=1 radTL=6 radTR=6 radBR=6 radBL=6 " +
        "selectionBg=#3390ff selectionFg=#ffffff padT=2 padR=6 padB=2 padL=6",
      "    5  bg=#2244aa fg=#eeeeee borderColor=#abcdef borderWidth=1 radTL=6 radTR=6 radBR=6 radBL=6 " +
        "selectionBg=#3390ff selectionFg=#ffffff padT=2 padR=6 padB=2 padL=6",
      "    6  bg=#123456 fg=#eeeeee borderColor=#abcdef borderWidth=1 radTL=6 radTR=6 radBR=6 radBL=6 " +
        "ringOuterWidth=2 ringOuterColor=#3390ff selectionBg=#3390ff selectionFg=#ffffff padT=2 padR=6 padB=2 padL=6",
      "    7  bg=#2244aa fg=#eeeeee borderColor=#abcdef borderWidth=1 radTL=6 radTR=6 radBR=6 radBL=6 " +
        "ringOuterWidth=2 ringOuterColor=#3390ff selectionBg=#3390ff selectionFg=#ffffff padT=2 padR=6 padB=2 padL=6",
      "    8  fg=#eeeeee selectionBg=#3390ff selectionFg=#ffffff",
      "",
      "strings (3)",
      '    0  "Hi"',
      '    1  "Go"',
      '    2  "x"',
    ].join("\n"),
  );
});

/**
 * `min-width` and `min-height` are `auto` when nobody sets them.
 *
 * CSS's initial value, and for a flex item `auto` resolves to the content size —
 * which is the rule that stops a column from shrinking its children when the
 * container is too small. `INITIAL_STYLE` said `0`, which is a *different* and
 * legal value meaning "may shrink to nothing", and the symptom was list rows
 * compressing as the window got shorter (see upload.test.ts). Pinned here because
 * this is where the value is decided, not where it is felt.
 */
test("an unset min-size is auto, not zero", () => {
  const html = `<body><div class="a"></div></body>`;
  const css = `.a { width: 10px }`;

  expect(Number.isNaN(styleOf(html, css, "minW"))).toBe(true);
  expect(Number.isNaN(styleOf(html, css, "minH"))).toBe(true);

  // A declared one still wins, including an explicit zero.
  expect(styleOf(html, `.a { min-height: 0 }`, "minH")).toBe(0);
  expect(styleOf(html, `.a { min-height: 24px }`, "minH")).toBe(24);
});

/**
 * The shorthands and aliases that needed no new style field — `inset`, the logical
 * sizing properties and the two `place-*` forms all write fields the longhands were
 * already writing, which is why they were the cheapest thing left in Tailwind's
 * blocker list.
 *
 * `conformance` checks each against Chrome's computed value and `layout-diff`
 * checks that `inset`'s four values land on the right sides. These are here for
 * what neither of those covers: that the *expansion* is what it claims, read
 * straight off the field.
 */
test("inset expands to four sides, and its axis forms to two", () => {
  const box = `<body><div class="a"></div></body>`;
  const at = (css: string, field: "insetT" | "insetR" | "insetB" | "insetL") =>
    styleOf(box, `.a { position: absolute; ${css} }`, field);

  // One value reaches all four.
  for (const f of ["insetT", "insetR", "insetB", "insetL"] as const) {
    expect(at("inset: 6px", f)).toBe(6);
  }

  // Four values are top/right/bottom/left, in that order. The two the CSS puts
  // last are the ones a wrong order gets wrong.
  expect(at("inset: 1px 2px 3px 4px", "insetT")).toBe(1);
  expect(at("inset: 1px 2px 3px 4px", "insetR")).toBe(2);
  expect(at("inset: 1px 2px 3px 4px", "insetB")).toBe(3);
  expect(at("inset: 1px 2px 3px 4px", "insetL")).toBe(4);

  // The axis forms are start-then-end, and neither touches the other axis.
  expect(at("inset-inline: 2px 8px", "insetL")).toBe(2);
  expect(at("inset-inline: 2px 8px", "insetR")).toBe(8);
  expect(at("inset-inline: 5px", "insetL")).toBe(5);
  expect(at("inset-block: 3px 9px", "insetT")).toBe(3);
  expect(at("inset-block: 3px 9px", "insetB")).toBe(9);

  // `auto` is the sentinel Taffy resolves, not a length. Untestable in
  // `conformance` — Chrome reports a used value there — so it is asserted here.
  expect(at("inset: auto", "insetT")).toBeNaN();
});

test("the logical sizing properties are aliases of the physical ones", () => {
  const box = `<body><div class="a"></div></body>`;
  const at = (css: string, field: "width" | "height" | "minW" | "maxW" | "minH" | "maxH") =>
    styleOf(box, `.a { ${css} }`, field);

  expect(at("inline-size: 120px", "width")).toBe(120);
  expect(at("block-size: 40px", "height")).toBe(40);
  expect(at("min-inline-size: 30px", "minW")).toBe(30);
  expect(at("max-inline-size: 300px", "maxW")).toBe(300);
  expect(at("min-block-size: 24px", "minH")).toBe(24);
  expect(at("max-block-size: 200px", "maxH")).toBe(200);

  // `none` on either max is Infinity, the same as the physical spelling — the one
  // place these are not a plain `parseLength` and so the one worth pinning.
  expect(at("max-inline-size: none", "maxW")).toBe(Infinity);
  expect(at("max-block-size: none", "maxH")).toBe(Infinity);
});

test("place-items and place-self set both axes, and `safe` binds forward", () => {
  const box = `<body><div class="a"></div></body>`;
  const at = (css: string, field: "align" | "justifyItems" | "alignSelf" | "justifySelf") =>
    styleOf(box, `.a { ${css} }`, field);

  // One value is both axes.
  expect(at("place-items: center", "align")).toBe(Align.CENTER);
  expect(at("place-items: center", "justifyItems")).toBe(Align.CENTER);
  // Two values are block-then-inline. Swapping them would pass a one-value test.
  expect(at("place-items: center stretch", "align")).toBe(Align.CENTER);
  expect(at("place-items: center stretch", "justifyItems")).toBe(Align.STRETCH);

  expect(at("place-self: center", "alignSelf")).toBe(Align.CENTER);
  expect(at("place-self: center", "justifySelf")).toBe(Align.CENTER);
  // `auto` on `place-self` defers to the parent on both axes, which is UNSET.
  expect(at("place-self: auto", "alignSelf")).toBe(UNSET);
  expect(at("place-self: auto", "justifySelf")).toBe(UNSET);

  // The trap. `safe center` is ONE value — Box Alignment writes each half as
  // `[safe | unsafe]? <position>` — so a whitespace split would read align as
  // `safe` and justify as `center`, silently giving the two axes different
  // alignments. dziri has no overflow-alignment, so it is refused; what matters is
  // that it is refused as one bad value rather than accepted as two good ones.
  // Tailwind emits exactly this, as `place-items-center-safe`.
  expect(() => styleOf(box, `.a { place-items: safe center }`, "align")).toThrow(
    /unsupported place-items "safe center"/,
  );
  expect(() => styleOf(box, `.a { place-self: unsafe end }`, "alignSelf")).toThrow(
    /unsupported place-self "unsafe end"/,
  );
  // Three values is not a shorthand, it is a typo.
  expect(() => styleOf(box, `.a { place-items: center start end }`, "align")).toThrow(
    /more than two values/,
  );

  // `place-content` is left out of the switch entirely rather than written as
  // "justify-content and drop the other half", because it needs `align-content`,
  // which dziri does not have. So it takes the ordinary unsupported-property path —
  // a warning, and no field touched. This asserts the *not half-applied* part: a
  // `place-content-center` must not silently centre one axis and leave the other.
  expect(styleOf(box, `.a { place-content: center }`, "justify")).toBe(INITIAL_STYLE.justify);
  expect(styleOf(box, `.a { place-content: center }`, "align")).toBe(INITIAL_STYLE.align);
});
