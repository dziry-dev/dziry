/**
 * The parts a control is made of, supplied by the compiler rather than authored.
 *
 * A browser builds a `<select>`'s internals for you — the closed button, and the
 * selected option's text inside it. It does that with a UA shadow tree. dziri has
 * no shadow tree and does not need one: the internals are ordinary nodes, and the
 * compiler is already in the business of turning one authored element into
 * several. This is that step, and it runs before the cascade, so everything
 * downstream — selectors, pseudo-elements, inheritance, variants — sees a plain
 * tree and needs to know nothing about controls.
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
 * `::picker(select)` implementable later as an ordinary structural grouping.
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
    onClick: null,
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

/**
 * The children to compile for `el`, with any UA-supplied parts spliced in.
 *
 * Returns `el.children` unchanged for everything that is not a control, which is
 * almost every element — this is on the walk's hot path.
 */
export function uaChildren(el: Element): Node[] {
  if (el.tag !== "select") return el.children;

  // An author who wrote the button already gets theirs. The spec's opt-in form
  // exists precisely so the internals can be customized, and overwriting it would
  // make `appearance: base-select` pointless.
  const authored = el.children.some((c) => c.type === "element" && c.tag === "button");
  if (authored) return el.children;

  const options = el.children.filter(
    (c): c is Element => c.type === "element" && c.tag === "option",
  );

  // `selected`, else the first option — which is what a browser shows for a
  // `<select>` with no selection, and why an empty `<select>` shows an empty
  // button rather than nothing at all.
  const chosen = options.find((o) => o.attrs.has("selected")) ?? options[0];
  const label = chosen ? staticText(chosen) : "";

  const selectedContent = plain("selectedcontent", label ? [{ type: "text", value: label }] : []);
  return [plain("button", [selectedContent]), ...el.children];
}
