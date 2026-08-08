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

/**
 * Whether a `<select>` is drawn as a list rather than a dropdown, and how tall.
 *
 * `null` for a dropdown. The condition is `multiple || size > 1` and **not** `multiple`
 * alone — measured, `probes/select-listbox.html`: `<select size="4">` with no `multiple`
 * is a six-option list box with in-flow options and an empty initial selection, exactly
 * like a `multiple`. Forking on the attribute would have compiled a shape authors really
 * write into a dropdown.
 *
 * `rows` defaults to 4, which is a constant rather than "as many as fit" or "all of
 * them": the same measurement gives `size="9"` nine rows of height with six options and
 * empty space below.
 *
 * A malformed `size` — `size="abc"`, `size="0"`, `size="-3"` — is treated as absent
 * rather than as a reason to refuse. HTML says a non-positive-integer `size` reflects as
 * its default, and refusing here would fail a build over an attribute a browser shrugs
 * at.
 */
export function listboxOf(el: Element): { multiple: boolean; rows: number } | null {
  if (el.tag !== "select") return null;
  const multiple = el.attrs.has("multiple");
  const raw = Number.parseInt(el.attrs.get("size") ?? "", 10);
  const size = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (!multiple && size <= 1) return null;
  return { multiple, rows: size > 0 ? size : 4 };
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
   * Every option that is selected at rest — what the compiler marks `CHECKED`.
   *
   * Separate from [`chosen`] because the two answer different questions and a list box
   * makes them diverge. `chosen` is *the option whose label the closed button shows*, so
   * there is at most one and a dropdown always has one. This is *what is selected*, which
   * for a `multiple` is a set and for a list box may be empty.
   *
   * The rules, both measured in `probes/select-listbox.html`:
   *
   * - A **dropdown** falls back to its first option when none says `selected`. A **list
   *   box** does not — it starts with nothing selected, `selectedIndex` of -1. Inheriting
   *   the dropdown's fallback would open a list with a row highlighted the user never
   *   chose.
   * - With two `selected` attributes a `multiple` keeps **both**, and a single-selection
   *   list box keeps the **last**. So `selected` is a per-option flag whose resolution
   *   depends on `multiple`, which is why this is computed here rather than read off the
   *   attribute at each option.
   */
  selected: Set<Element>;
  /** `multiple || size > 1`, with the row count. Null for a dropdown. */
  listbox: { multiple: boolean; rows: number } | null;
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
  return {
    children: el.children,
    picker: null,
    chosen: null,
    selected: new Set(),
    listbox: null,
    selectedContent: null,
  };
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

  // A list box keeps its options in flow and gets neither a button nor a picker. That is
  // not a simplification of the dropdown — it is the measured structure: an option inside
  // one has a box, a computed style and an `offsetParent`, where a dropdown's options are
  // browser chrome with no box at all. So there is nothing for an overlay to hold, and
  // nothing for a closed control to display.
  //
  // Returned before the button is built rather than by emptying it afterwards, so a list
  // box never has a `<selectedcontent>` for the engine's label redirect to find. A commit
  // in a list changes which rows are drawn selected and nothing else.
  const listbox = listboxOf(el);
  if (listbox !== null) {
    const options = optionsOf(el.children);
    const marked = options.filter((o) => o.attrs.has("selected"));
    // Every marked option for a `multiple`; the last for a single-selection list box.
    // Both measured — and note there is no fallback to the first for either, which is the
    // one rule a list box does not share with a dropdown.
    const selected = listbox.multiple ? marked : marked.slice(-1);
    return {
      children: el.children,
      picker: null,
      chosen: null,
      selected: new Set(selected),
      listbox,
      selectedContent: null,
    };
  }

  const options = optionsOf(picker);
  // The **last** option marked `selected`, else the first option at all. `findLast` and
  // not `find`: measured, `probes/select-listbox.html`, a dropdown with its 2nd and 4th
  // options marked shows the 4th. This read `find` until that row was added, and nothing
  // had caught it because every case measured before marked at most one option — the two
  // rules cannot disagree until markup does something slightly odd, and this is legal
  // markup a form generator emits.
  const chosen = options.findLast((o) => o.attrs.has("selected")) ?? options[0] ?? null;
  const selected = new Set(chosen ? [chosen] : []);

  // An author who wrote the button already gets theirs. The spec's opt-in form
  // exists precisely so the internals can be customized, and overwriting it would
  // make `appearance: base-select` pointless.
  const authored = inFlow.find((c) => c.type === "element" && c.tag === "button");
  if (authored !== undefined) {
    return {
      children: inFlow,
      picker,
      chosen,
      selected,
      listbox: null,
      selectedContent: findTag(authored, "selectedcontent"),
    };
  }

  const label = chosen ? staticText(chosen) : "";
  const selectedContent = plain("selectedcontent", label ? [{ type: "text", value: label }] : []);
  return {
    children: [plain("button", [selectedContent]), ...inFlow],
    picker,
    chosen,
    selected,
    listbox: null,
    selectedContent,
  };
}
