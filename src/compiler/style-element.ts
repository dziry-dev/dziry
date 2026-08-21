/**
 * Taking `<style>` out of the tree and putting it into the cascade.
 *
 * A `<style>` element is the third way CSS reaches a window, after an imported
 * stylesheet and an inline `style=` attribute. It exists for the case the other two
 * are clumsy for: a handful of rules that belong with the markup that needs them,
 * without a file.
 *
 * # It is removed, not hidden
 *
 * A browser gives `<style>` `display: none` and leaves it in the document. dziry
 * deletes it, because there is no run-time document for it to be in — its text has
 * already become integers in the style table by the time anything renders, and a
 * node that exists only to be invisible would still cost a row in every table, a
 * Taffy child, and a link in the sibling chain.
 *
 * # Where it lands in the cascade
 *
 * After every imported sheet, in document order among themselves. That is the one
 * ordering that stays true to "later wins" without pretending the two sources are
 * interleaved: imports are ordered by the module graph and `<style>` by the tree,
 * and there is no single sequence both belong to. Putting the markup's own rules
 * last matches the intuition that the thing written next to the element is the
 * more specific statement of intent.
 */
import type { Element, Node } from "./html.ts";

/** One `<style>` block's text, in document order. */
export type InlineSheet = {
  /** The window-relative label used if this block fails to parse. */
  label: string;
  text: string;
};

/**
 * Strips every `<style>` from the tree and returns their contents in document
 * order.
 *
 * Mutates. The tree is walked again by `compileVariants`, once per toggle, and both
 * passes have to see the same nodes — extracting a copy would leave the variant
 * compilation resolving a cascade against a tree that still had the elements in it.
 */
export function extractStyleElements(root: Element): InlineSheet[] {
  const found: InlineSheet[] = [];

  const visit = (element: Element): void => {
    const kept: Node[] = [];

    for (const child of element.children) {
      if (child.type !== "element") {
        kept.push(child);
        continue;
      }

      if (child.tag === "style") {
        const text = child.children
          .map((n) => (n.type === "text" ? n.value : ""))
          .join("");
        found.push({ label: `<style> #${found.length + 1}`, text });
        continue;
      }

      visit(child);
      kept.push(child);
    }

    element.children = kept;
  };

  visit(root);
  return found;
}
