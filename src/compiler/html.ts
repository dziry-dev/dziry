/**
 * A small, strict HTML parser.
 *
 * Deliberately *not* an error-recovering browser parser: unbalanced tags are a
 * compile error, not something to silently repair. Authoring input is a
 * constrained subset, so strictness costs nothing and catches typos at build
 * time instead of producing a surprising tree.
 */

export type Element = {
  type: "element";
  tag: string;
  id: string | null;
  classes: string[];
  children: Node[];
  /**
   * The click handler as authored: the function itself in JSX, or a name string
   * from an HTML `onclick` attribute.
   *
   * A function reference cannot be serialized into the generated module, so the
   * compiler reverse-maps it to the export name it came from and emits an import.
   * That works because `ui.gen.ts` is a module, not data — which is also why
   * handlers must be module-level exports.
   */
  onClick: unknown;
  /**
   * The change handler as authored — a function in JSX, a name string from an
   * `onchange` attribute. Same reverse-mapping to an export name as [`onClick`].
   *
   * A *separate* field rather than a kind on one handler, because an element can
   * legitimately have both: a checkbox inside a clickable row has an `onClick` that
   * belongs to the row and an `onChange` that belongs to the box, and one slot would
   * make the author choose.
   */
  onChange: unknown;
  /**
   * Classes applied while a boolean signal is true: `{ light: isLight }`.
   *
   * The compiler compiles each of these into a *style-table patch* — it resolves
   * the whole cascade with the class present, diffs against the baseline, and
   * emits the differing entries. The runtime writes integers into the style table;
   * it never sees a class name.
   */
  classWhen: Record<string, unknown> | null;
  /**
   * A string signal this element edits. Makes the node focusable and routes
   * keystrokes into the signal while it holds focus.
   *
   * There is no text-editing *widget* — the field is an ordinary node and the value is an
   * ordinary signal — but the editing model behind it is a real one: the engine owns the
   * caret and the selection, and every editing key is one splice into this signal. Insert,
   * Backspace and Delete at the caret or over a range, arrows and Home/End, drag, Shift+Arrow,
   * Shift+click, double click for a word, Ctrl+A. No clipboard and no IME.
   *
   * This comment used to end "No caret, no selection", and that sentence was quoted as
   * evidence in `HTML-ELEMENT-COVERAGE-RESEARCH.md` — so it is worth keeping accurate.
   */
  bindValue: unknown;
  /**
   * An inline `style="…"` declaration list.
   *
   * Applied after the cascade and beating every selector, exactly as a browser
   * does — an inline declaration outranks any specificity. It needs no runtime
   * support at all: the declarations belong to one element, so the compiler
   * resolves them into that node's computed style and nothing survives to the
   * IR but the resulting integers.
   *
   * A string only. `style={{ color: someSignal }}` would be a runtime value
   * with no node to attach it to at build time, and is a compile error.
   */
  style: string | null;
  /**
   * Attributes an attribute selector can test, lower-cased by name.
   *
   * Kept rather than discarded because `input[type=checkbox]` is how a UA
   * stylesheet distinguishes one control from another — twenty-two `input` types
   * are one tag and twelve render archetypes, and the tag alone cannot tell them
   * apart. Values stay as authored; matching lower-cases where the selector says
   * to, not here, because `[value="Yes"]` is case-sensitive in HTML.
   *
   * `id`, `class` and `style` are *also* here even though each has its own field.
   * They are real attributes and `[class~="x"]` is a legal selector; having two
   * spellings of the same fact is better than an attribute selector that silently
   * cannot see the three most common attributes.
   */
  attrs: ReadonlyMap<string, string>;
};

export type Text = { type: "text"; value: string };

/**
 * A literal chunk of a text run, or a value read from state.
 *
 * `source` holds the signal object as authored; the compiler replaces it with the
 * export name it resolves to. Identity is what lets `{count}` be recognised as a
 * binding at all — the JSX transform would otherwise hand us only a value.
 */
export type TextPart =
  | { literal: string }
  | { source: unknown }
  | { export: string }
  /** A path recorded from a list item callback, e.g. `t.text` -> `["text"]`. */
  | { item: (string | number)[] };

/**
 * A text run with at least one dynamic part.
 *
 * Kept as one node rather than several so `Count: {n}` stays a single IR text
 * node — two nodes would be two flex items, stacked vertically since a box with
 * no `display` defaults to COLUMN.
 */
export type DynText = { type: "dyntext"; parts: TextPart[] };

/**
 * A list whose length is a runtime value: `todos.map(render, { key })`.
 *
 * `template` is the subtree the callback produced when invoked with a recording
 * proxy, so every `{t.field}` inside it is an item path rather than a value. The
 * compiler materializes that subtree `capacity` times into a contiguous arena;
 * the runtime only rewrites the child chain and the bound string slots.
 *
 * `keyPath` is required. Nodes are interchangeable for painting, so a reorder
 * needs no structural work — but focus is a *node id*, so without keys a reorder
 * would silently move focus to a different logical row.
 */
export type DynList = {
  type: "dynlist";
  /** The signal holding the array. */
  source: unknown;
  template: Node;
  keyPath: (string | number)[];
  /** Item slots materialized up front; grows by re-arenaing if exceeded. */
  capacity: number;
};

export type Node = Element | Text | DynText | DynList;

export class HtmlError extends Error {}

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link"]);

/**
 * Unwrapped into their children. `body` is deliberately *not* here — the
 * compiler promotes it to the root node so `body { ... }` styles the window
 * container, which is what an author expects.
 */
const TRANSPARENT_TAGS = new Set(["html"]);

export function parseHtml(src: string): Element {
  const root: Element = {
    type: "element",
    tag: "#root",
    id: null,
    classes: [],
    children: [],
    onClick: null,
    onChange: null,
    classWhen: null,
    bindValue: null,
    style: null,
    attrs: new Map(),
  };
  const stack: Element[] = [root];
  let i = 0;

  const top = () => stack[stack.length - 1]!;

  while (i < src.length) {
    const lt = src.indexOf("<", i);

    if (lt === -1) {
      pushText(top(), src.slice(i));
      break;
    }

    if (lt > i) pushText(top(), src.slice(i, lt));

    // Comments and doctype
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      if (end === -1) throw new HtmlError("unclosed comment");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt);
      if (end === -1) throw new HtmlError("unclosed doctype");
      i = end + 1;
      continue;
    }

    const gt = src.indexOf(">", lt);
    if (gt === -1) throw new HtmlError(`unclosed tag at offset ${lt}`);
    const inner = src.slice(lt + 1, gt).trim();
    i = gt + 1;

    // Closing tag
    if (inner.startsWith("/")) {
      const tag = inner.slice(1).trim().toLowerCase();
      if (TRANSPARENT_TAGS.has(tag)) continue;

      const open = top();
      if (open === root) throw new HtmlError(`</${tag}> with no matching open tag`);
      if (open.tag !== tag) {
        throw new HtmlError(`</${tag}> closes <${open.tag}> — tags must nest properly`);
      }
      stack.pop();
      continue;
    }

    // Opening tag
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1).trim() : inner;
    const space = body.search(/\s/);
    const tag = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const attrSrc = space === -1 ? "" : body.slice(space + 1);

    if (TRANSPARENT_TAGS.has(tag)) continue;

    // `<style>` holds CSS, and CSS is not markup. Scanning it for tags would let
    // `content: "<"` open an element and `&amp;` decode to something the cascade
    // then cannot parse, so the body is taken verbatim up to the closing tag —
    // the same raw-text rule a browser applies here.
    if (tag === "style" && !selfClosing) {
      const close = src.toLowerCase().indexOf("</style", i);
      if (close === -1) throw new HtmlError("unclosed <style>");
      const gtAfter = src.indexOf(">", close);
      if (gtAfter === -1) throw new HtmlError("unclosed </style>");

      const el: Element = {
        type: "element",
        tag: "style",
        id: null,
        classes: [],
        children: [{ type: "text", value: src.slice(i, close) }],
        onClick: null,
        onChange: null,
        classWhen: null,
        bindValue: null,
        style: null,
        attrs: parseAttributes(attrSrc),
      };
      top().children.push(el);
      i = gtAfter + 1;
      continue;
    }

    const attrs = parseAttributes(attrSrc);
    const el: Element = {
      type: "element",
      tag,
      id: attrs.get("id") ?? null,
      classes: (attrs.get("class") ?? "").split(/\s+/).filter(Boolean),
      children: [],
      onClick: attrs.get("onclick") ?? null,
      onChange: attrs.get("onchange") ?? null,
      classWhen: null,
      bindValue: null,
      style: attrs.get("style") ?? null,
      attrs,
    };

    top().children.push(el);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(el);
  }

  if (stack.length > 1) {
    throw new HtmlError(`unclosed <${top().tag}>`);
  }

  return root;
}

function parseAttributes(src: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([A-Za-z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    attrs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Collapses whitespace the way CSS `white-space: normal` does, and drops
 * whitespace-only runs so pretty-printed markup doesn't produce phantom text
 * nodes between elements.
 */
function pushText(parent: Element, raw: string): void {
  const collapsed = raw.replace(/\s+/g, " ");
  if (collapsed.trim() === "") return;
  parent.children.push({ type: "text", value: decodeEntities(collapsed).trim() });
}
