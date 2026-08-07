/**
 * The parts a control is made of, supplied by the compiler rather than authored.
 *
 * A browser builds a `<select>`'s internals for you — the closed button, the
 * selected option's text inside it, and the popover the options are drawn in. It
 * does that with a UA shadow tree. dziri has no shadow tree and does not need one:
 * the internals are ordinary nodes, and the compiler is already in the business of
 * turning one authored element into several. This is that step, and it runs before
 * the cascade, so everything downstream — selectors, pseudo-elements, inheritance,
 * variants — sees a plain tree and needs to know nothing about controls.
 *
 * The structure is not invented. It is exactly the shape MDN documents for a
 * customizable `<select>`:
 *
 * ```html
 * <select>
 *   <button><selectedcontent></selectedcontent></button>
 *   <option>…</option>
 * </select>
 * ```
 *
 * which is *light DOM* in the spec too — the modern parser keeps those elements
 * rather than hiding them. So an author who writes them gets them, and an author
 * who writes only `<option>`s gets the same tree with the button filled in. Both
 * spellings compile to the same nodes, which is the property that makes
 * `::picker(select)` an ordinary structural grouping.
 *
 * # Why the options come out separately
 *
 * They are laid out inside the picker box and everything else is laid out in flow,
 * so the two lists cannot be one list. What this deliberately does *not* do is make
 * the picker a wrapper element the options become children of: `select > option` is
 * a legal selector that must keep matching, and in a browser it does, because a
 * picker is a pseudo-element the light-DOM options render *into* rather than a node
 * they move under. The split is at the node level for exactly that reason — see
 * `compile.ts::walkPicker`, which walks them with the ancestor path still ending at
 * the select.
 */
import type { Element, Node } from "./html.ts";

/** An element with no attributes, handlers or inline style — the usual case here. */
function plain(tag: string, children: Node[], classes: string[] = []): Element {
  return {
    type: "element",
    tag,
    id: null,
    classes,
    children,
    onClick: null, onChange: null, onFocus: null, onBlur: null,
    onSubmit: null,
    classWhen: null,
    bindValue: null,
    style: null,
    attrs: new Map(),
  };
}

/**
 * The static text of a subtree, for cloning an option's label into the button.
 *
 * Static only. `<selectedcontent>` holds *a clone of the selected option's
 * content*, and a clone of a dynamic text run would need its own binding — the
 * signal would have to drive two nodes. That is real work and it is A3's, so a
 * dynamic option label yields an empty button rather than a wrong one.
 */
function staticText(node: Node): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(staticText).join("");
  return "";
}

/** The first descendant with this tag, in document order, or null. */
function findTag(node: Node, tag: string): Element | null {
  if (node.type !== "element") return null;
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const found = findTag(child, tag);
    if (found !== null) return found;
  }
  return null;
}

/** Which of a `<select>`'s children belong in the picker rather than in flow. */
function isPickerChild(node: Node): boolean {
  return node.type === "element" && (node.tag === "option" || node.tag === "optgroup");
}

/**
 * Every `<option>` in document order, descending through `<optgroup>`.
 *
 * Recursive rather than a direct-child filter because an option inside a group is
 * still one of the select's options — it is selectable, it counts for "the first one
 * is selected when none is", and the engine has to see it in the same group. A
 * direct-child filter reads as correct and quietly makes a grouped select
 * unselectable.
 */
export function optionsOf(nodes: Node[]): Element[] {
  const out: Element[] = [];
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.tag === "option") out.push(node);
    else if (node.tag === "optgroup") out.push(...optionsOf(node.children));
  }
  return out;
}

/** An element's children, split into the parts the compiler has to place differently. */
export type UaParts = {
  /** Compiled in flow, as ordinary children. */
  children: Node[];
  /**
   * Compiled into the `::picker(select)` box, or null when the element has no picker.
   *
   * Empty is not the same as null: a `<select>` with no options still gets a picker,
   * because an author can open it and a browser shows an empty popover rather than
   * nothing. Only a non-select gets null.
   */
  picker: Node[] | null;
  /**
   * The `<option>` whose label the closed control shows, or null.
   *
   * `selected`, else the first — which is what a browser shows for a `<select>` with
   * no selection, and why an empty `<select>` shows an empty button rather than
   * nothing at all. It is also the option the compiler marks `CHECKED`, so the
   * baked label and the engine's initial selection cannot disagree.
   */
  chosen: Element | null;
  /**
   * The `<selectedcontent>` whose text mirrors the selection, or null.
   *
   * Found by search rather than by construction, because an author may have written
   * the button themselves — the spec's opt-in form exists precisely so the internals
   * can be customized. An author who writes a `<button>` with no
   * `<selectedcontent>` in it gets null, and a closed control whose label simply does
   * not follow the selection: their markup, their decision.
   */
  selectedContent: Element | null;
};

/** Everything that is not a control: children as authored, and no picker. */
function inFlowOnly(el: Element): UaParts {
  return { children: el.children, picker: null, chosen: null, selectedContent: null };
}

/**
 * The parts to compile for `el`, with any UA-supplied ones spliced in.
 *
 * Returns `el.children` unchanged for everything that is not a control, which is
 * almost every element — this is on the walk's hot path.
 */
export function uaParts(el: Element): UaParts {
  if (el.tag !== "select") return inFlowOnly(el);

  const picker = el.children.filter(isPickerChild);
  const inFlow = el.children.filter((c) => !isPickerChild(c));

  const options = optionsOf(picker);
  const chosen = options.find((o) => o.attrs.has("selected")) ?? options[0] ?? null;

  // An author who wrote the button already gets theirs. The spec's opt-in form
  // exists precisely so the internals can be customized, and overwriting it would
  // make `appearance: base-select` pointless.
  const authored = inFlow.find((c) => c.type === "element" && c.tag === "button");
  if (authored !== undefined) {
    return {
      children: inFlow,
      picker,
      chosen,
      selectedContent: findTag(authored, "selectedcontent"),
    };
  }

  const label = chosen ? staticText(chosen) : "";
  const selectedContent = plain("selectedcontent", label ? [{ type: "text", value: label }] : []);
  return {
    children: [plain("button", [selectedContent]), ...inFlow],
    picker,
    chosen,
    selectedContent,
  };
}
