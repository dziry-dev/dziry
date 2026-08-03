/**
 * The matcher through its own interface.
 *
 * `cascade.test.ts:9-10` says of itself that it exercises "parsing, matching,
 * specificity, inheritance and expansion together rather than a seam", which was
 * accurate and unavoidable: there was no seam. Asserting "0,2,0 ties, so source
 * order decides" meant driving an HTML parse, the UA sheet, `@property` merging,
 * keyframe resolution, every variant cascade and ten typed-array builds, then
 * reading one integer out of a style table at the far end.
 *
 * These assert the same rules against `collectDecls`, whose output is a
 * `Map<property, value>` of CSS strings.
 *
 * Not because the old failures were unreadable — that was measured rather than
 * assumed, and they are fine. Deleting the re-insertion in `collectDecls` fails
 * `cascade.test.ts:62` with `Expected: 2, Received: 4` on `padL`, which is clear
 * enough if you know that `padL = 4` implies the shorthand expanded in the wrong
 * order. What the seam buys is narrower and more useful:
 *
 *   * the same mutation fails here by printing the map *and its order*, which is
 *     the mechanism itself rather than an integer four steps downstream
 *   * no HTML-to-IR pipeline runs at all — no UA sheet, no `@property` merge, no
 *     keyframes, no interning, no typed arrays. 22 assertions in under a second.
 *   * assertions that had no reachable subject before: `MediaBits` spending one bit
 *     per distinct condition, `hasPseudoRule` and `hasPseudoElementRule` answering
 *     directly, `matches` being subject-relative, UA-versus-author origin observed
 *     as declarations rather than as a resolved field
 *
 * `cascade.test.ts` stays exactly as it is. It covers the one thing this cannot —
 * that the seam is wired up correctly — so the two are complements, and the overlap
 * between them is deliberate.
 */
import { expect, test } from "bun:test";
import { parseHtml, type Element, type Node } from "./html.ts";
import { parseCss, Origin, type Pseudo } from "./css.ts";
import {
  collectDecls,
  hasPseudoElementRule,
  hasPseudoRule,
  matches,
  MediaBits,
  mediaMaskFor,
} from "./matcher.ts";

/**
 * The ancestor chain down to the element `html` marks with `id="subject"`.
 *
 * Via `parseHtml` rather than object literals: an `Element` has nine required
 * fields and hand-built ones drift from what the parser actually produces, which
 * would make these tests agree with each other and disagree with the compiler.
 */
function pathToSubject(html: string): Element[] {
  const root = parseHtml(html);
  const found: Element[] = [];

  const walk = (node: Node, chain: Element[]): boolean => {
    if (node.type !== "element") return false;
    const here = [...chain, node];
    if (node.id === "subject") {
      found.push(...here);
      return true;
    }
    return node.children.some((child) => walk(child, here));
  };

  if (!walk(root, [])) throw new Error(`no id="subject" in: ${html}`);
  return found;
}

/** The common case: author CSS, no states beyond `none`, no media conditions live. */
function declsFor(css: string, html: string, states: Pseudo[] = ["none"]): Map<string, string> {
  return collectDecls(parseCss(css), pathToSubject(html), states, new MediaBits());
}

// ---------------------------------------------------------------------------
// Specificity and source order
// ---------------------------------------------------------------------------

test("equal specificity is broken by source order, not by selector shape", () => {
  const decls = declsFor(
    `.a.b { color: red } .b.a { color: blue }`,
    `<div id="subject" class="a b"></div>`,
  );
  expect(decls.get("color")).toBe("blue");
});

test("a class beats a tag, whatever the order", () => {
  const html = `<div id="subject" class="c"></div>`;
  expect(declsFor(`.c { color: red } div { color: blue }`, html).get("color")).toBe("red");
  expect(declsFor(`div { color: blue } .c { color: red }`, html).get("color")).toBe("red");
});

test("an id beats any number of classes", () => {
  const decls = declsFor(
    `#subject { color: red } .a.b.c.d { color: blue }`,
    `<div id="subject" class="a b c d"></div>`,
  );
  expect(decls.get("color")).toBe("red");
});

test("author CSS beats the UA sheet even at lower specificity", () => {
  const ua = parseCss(`div#subject { color: uawins }`, Origin.UA);
  const author = parseCss(`div { color: authorwins }`);
  const decls = collectDecls(
    [...ua, ...author],
    pathToSubject(`<div id="subject"></div>`),
    ["none"],
    new MediaBits(),
  );
  expect(decls.get("color")).toBe("authorwins");
});

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

test("a descendant combinator crosses any depth; a child combinator does not", () => {
  const html = `<div class="outer"><span><b id="subject"></b></span></div>`;
  expect(declsFor(`.outer b { color: red }`, html).get("color")).toBe("red");
  expect(declsFor(`.outer > b { color: red }`, html).get("color")).toBeUndefined();
});

test("a child combinator matches its direct parent", () => {
  const html = `<div class="outer"><b id="subject"></b></div>`;
  expect(declsFor(`.outer > b { color: red }`, html).get("color")).toBe("red");
});

// ---------------------------------------------------------------------------
// Functional pseudo-classes — the specificity of a selector list
// ---------------------------------------------------------------------------

test(":where() contributes zero specificity, so a bare class outranks it", () => {
  const decls = declsFor(
    `:where(.a.b.c) { color: blue } .a { color: red }`,
    `<div id="subject" class="a b c"></div>`,
  );
  expect(decls.get("color")).toBe("red");
});

test(":is() contributes its argument's specificity, so it outranks a bare class", () => {
  const decls = declsFor(
    `:is(.a.b) { color: blue } .a { color: red }`,
    `<div id="subject" class="a b"></div>`,
  );
  expect(decls.get("color")).toBe("blue");
});

test(":not() matches when its argument does not", () => {
  expect(
    declsFor(`div:not(.skip) { color: red }`, `<div id="subject"></div>`).get("color"),
  ).toBe("red");
  expect(
    declsFor(`div:not(.skip) { color: red }`, `<div id="subject" class="skip"></div>`).get("color"),
  ).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Structural position
// ---------------------------------------------------------------------------

test(":first-child and :last-child read position among element siblings", () => {
  const first = `<div><b id="subject"></b><i></i></div>`;
  const last = `<div><i></i><b id="subject"></b></div>`;
  expect(declsFor(`b:first-child { color: red }`, first).get("color")).toBe("red");
  expect(declsFor(`b:first-child { color: red }`, last).get("color")).toBeUndefined();
  expect(declsFor(`b:last-child { color: red }`, last).get("color")).toBe("red");
  expect(declsFor(`b:last-child { color: red }`, first).get("color")).toBeUndefined();
});

test("an only child is both first and last", () => {
  const html = `<div><b id="subject"></b></div>`;
  expect(declsFor(`b:first-child { color: red }`, html).get("color")).toBe("red");
  expect(declsFor(`b:last-child { color: blue }`, html).get("color")).toBe("blue");
});

// ---------------------------------------------------------------------------
// Pseudo-class state, which is a filter and not a weighting
// ---------------------------------------------------------------------------

test("a :hover rule contributes nothing unless hover is among the live states", () => {
  const css = `.btn:hover { color: hovered }`;
  const html = `<div id="subject" class="btn"></div>`;
  expect(declsFor(css, html, ["none"]).get("color")).toBeUndefined();
  expect(declsFor(css, html, ["none", "hover"]).get("color")).toBe("hovered");
});

test("hover does not automatically beat base — it ties at equal specificity and loses on order", () => {
  const html = `<div id="subject" class="btn primary"></div>`;
  // `.btn:hover` and `.btn.primary` are both (0,2,0). Source order decides, so the
  // later rule wins even though the earlier one is the hover state. Resolving hover
  // as a patch over the finished base style would get this backwards.
  expect(
    declsFor(`.btn:hover { color: hovered } .btn.primary { color: base }`, html, ["none", "hover"])
      .get("color"),
  ).toBe("base");
  expect(
    declsFor(`.btn.primary { color: base } .btn:hover { color: hovered }`, html, ["none", "hover"])
      .get("color"),
  ).toBe("hovered");
});

// ---------------------------------------------------------------------------
// Pseudo-elements are a separate cascade
// ---------------------------------------------------------------------------

test("a ::before rule does not reach the originating element", () => {
  const decls = declsFor(
    `p::before { color: generated }`,
    `<p id="subject"></p>`,
  );
  expect(decls.get("color")).toBeUndefined();
});

test("collectDecls addresses the pseudo-element cascade by its last argument", () => {
  const decls = collectDecls(
    parseCss(`p::before { color: generated } p { color: element }`),
    pathToSubject(`<p id="subject"></p>`),
    ["none"],
    new MediaBits(),
    0,
    "before",
  );
  expect(decls.get("color")).toBe("generated");
});

test("hasPseudoElementRule reports whether a generated box is authored at all", () => {
  const path = pathToSubject(`<p id="subject"></p>`);
  expect(hasPseudoElementRule(parseCss(`p::before { color: red }`), path, "before")).toBe(true);
  expect(hasPseudoElementRule(parseCss(`p::before { color: red }`), path, "after")).toBe(false);
  expect(hasPseudoElementRule(parseCss(`p { color: red }`), path, "before")).toBe(false);
});

// ---------------------------------------------------------------------------
// @media — a filter on candidacy, with no effect on specificity
// ---------------------------------------------------------------------------

test("a rule inside @media is skipped unless its condition is live", () => {
  const rules = parseCss(`.a { color: base } @media (min-width: 768px) { .a { color: wide } }`);
  const path = pathToSubject(`<div id="subject" class="a"></div>`);
  const media = new MediaBits();

  const mask = mediaMaskFor(rules, path, media);
  expect(mask).not.toBe(0);

  expect(collectDecls(rules, path, ["none"], media, 0).get("color")).toBe("base");
  expect(collectDecls(rules, path, ["none"], media, mask).get("color")).toBe("wide");
});

test("@media does not weight the cascade — a live query still loses to higher specificity", () => {
  const rules = parseCss(
    `@media (min-width: 768px) { .a { color: wide } } #subject { color: byid }`,
  );
  const path = pathToSubject(`<div id="subject" class="a"></div>`);
  const media = new MediaBits();
  const mask = mediaMaskFor(rules, path, media);
  expect(collectDecls(rules, path, ["none"], media, mask).get("color")).toBe("byid");
});

test("one bit per distinct condition, however many places mention it", () => {
  const media = new MediaBits();
  const a = media.bitFor({ axis: "width", side: "min", px: 768 });
  const b = media.bitFor({ axis: "width", side: "min", px: 768 });
  const c = media.bitFor({ axis: "width", side: "max", px: 768 });
  expect(a).toBe(b);
  expect(c).not.toBe(a);
  expect(media.size).toBe(2);
});

// ---------------------------------------------------------------------------
// The two questions the walker asks before it commits to a variant
// ---------------------------------------------------------------------------

test("hasPseudoRule finds a state worth precompiling, and reports nothing when there is none", () => {
  const path = pathToSubject(`<div id="subject" class="btn"></div>`);
  expect(hasPseudoRule(parseCss(`.btn:hover { color: red }`), path, "hover")).toBe(true);
  expect(hasPseudoRule(parseCss(`.btn:hover { color: red }`), path, "focus")).toBe(false);
  expect(hasPseudoRule(parseCss(`.other:hover { color: red }`), path, "hover")).toBe(false);
});

test("matches is subject-relative — the last entry in the path is what is being asked about", () => {
  const path = pathToSubject(`<div class="outer"><b id="subject"></b></div>`);
  const [sel] = parseCss(`.outer b { color: red }`)[0]!.selectors;
  expect(matches(sel!, path)).toBe(true);
  // The same selector against the ancestor alone: `.outer` is not a `b`.
  expect(matches(sel!, path.slice(0, 1))).toBe(false);
});

// ---------------------------------------------------------------------------
// The re-insertion rule, which is why the returned Map's order is part of its value
// ---------------------------------------------------------------------------

test("a winning shorthand moves to the end, so expansion order matches cascade order", () => {
  // `.card { padding: 14px }` takes position 0 and `padding-left` position 1. When
  // `.x .card { padding: 2px }` wins, `Map.set` alone would update position 0 and
  // leave it there — so a caller expanding in iteration order would apply
  // `padding: 2px` first and `padding-left: 4px` second, giving padL = 4 even
  // though `.x .card` outranks `.card`. Re-inserting is what keeps the two agreed.
  const decls = declsFor(
    `.card { padding: 14px } .card { padding-left: 4px } .x .card { padding: 2px }`,
    `<div class="x"><div id="subject" class="card"></div></div>`,
  );
  expect([...decls]).toEqual([
    ["padding-left", "4px"],
    ["padding", "2px"],
  ]);
});
