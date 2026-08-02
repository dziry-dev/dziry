/**
 * A JSX runtime that produces the compiler's `Element` tree directly.
 *
 * This is the entire "component system": Bun's JSX transform rewrites `<div/>`
 * into `jsx("div", props)` against this module, function components are just
 * called at build time, and `.map()` expands lists before the compiler ever
 * runs. Nothing here ships to the runtime — by the time `ui.gen.ts` exists,
 * components have been erased into nodes and style ids.
 *
 * No framework is involved. The JSX transform is a bundler feature, not a React
 * one, so pointing `jsxImportSource` at this file gets the syntax with no
 * dependency and no VNodes.
 */
import {
  isSignal,
  setListBuilder,
  type MapOptions,
  type ReadonlySignal,
} from "../runtime/signal.ts";
import { isRecorder, pathOf, recorder } from "./item-path.ts";
import { isRouteParam, ParamNotEmittedError, paramNameOf } from "./route-args.ts";
import type { DynList, DynText, Element, Node, TextPart } from "./html.ts";

export class ListError extends Error {}

/**
 * Turns `todos.map(render, { key })` into a compiled list template.
 *
 * The callback runs exactly once, with a recording proxy, so the subtree it
 * returns has item *paths* where values would be. Registered on the signal module
 * so `.map` can live on the signal without that module depending on compiler
 * types.
 */
setListBuilder((source, initial, render, options) => {
  const opts = options as MapOptions<never> | undefined;
  if (typeof opts?.key !== "function") {
    throw new ListError(
      "map() requires a key: todos.map(t => …, { key: t => t.id }).\n" +
        "  Keys are not optional here. Item nodes are interchangeable for painting, so a\n" +
        "  reorder needs no structural work — but focus is a node id, so without a key a\n" +
        "  reorder would move focus to a different row.",
    );
  }

  const keyPath = pathOf(opts.key(recorder() as never));
  if (keyPath.length === 0) {
    throw new ListError(
      "map()'s key function must read a property of the item, e.g. { key: t => t.id }.\n" +
        "  Returning the item itself gives no stable identity to reconcile against.",
    );
  }

  const produced = render(recorder() as never, 0);
  const children: Node[] = [];
  flatten(produced as Child, children);
  const normalized = normalize(children);

  if (normalized.length !== 1) {
    throw new ListError(
      `map()'s callback must return exactly one element per item, got ${normalized.length}. ` +
        `Wrap them in a single container — item subtrees are a fixed stride in the arena.`,
    );
  }

  const items = Array.isArray(initial) ? initial : [];
  const list: DynList = {
    type: "dynlist",
    source,
    template: normalized[0]!,
    keyPath,
    // Headroom so the common case of appending a few items needs no regrowth.
    capacity: opts.capacity ?? Math.max(8, items.length * 2),
  };
  return list;
});

export type Child =
  | Node
  | ReadonlySignal<unknown>
  | Record<string, unknown>
  | string
  | number
  | boolean
  | null
  | undefined
  | Child[];

export type Props = {
  /**
   * Both spellings are accepted; `className` is the JSX convention.
   *
   * Either a plain string, or `cn(...)` for conditionals:
   * `className={cn("btn", { light: isLight })}`.
   */
  class?: string | ClassSpec;
  className?: string | ClassSpec;
  id?: string;
  /**
   * A function the app exports at module level — see `Element.onClick`.
   *
   * Inside a list item it receives that row's item and index, since one compiled
   * handler serves every row.
   */
  // `any`, not `unknown`: one compiled handler serves every row, so this position
  // cannot know the item type, and `unknown` would make every author cast before
  // reading a field. The `eslint-disable` that used to sit here suppressed a rule
  // from a linter this repo has never configured.
  onClick?: ((item: any, index: number) => void) | (() => void) | string;
  /**
   * Form attributes, kept rather than ignored: a selector can test them.
   *
   * `type` is the important one — twenty-two `input` types are one tag, so
   * `input[type=checkbox]` is the only way a stylesheet can distinguish a
   * checkbox from a text field. These no longer merely "typecheck"; they reach
   * the IR and the cascade reads them.
   *
   * They still do not make a control *behave*. `checked` and `disabled` here are
   * the static, authored attributes, which is what a selector matches; the live
   * `:checked` state is a predicate bit that nothing sets yet (A3).
   */
  type?: string;
  name?: string;
  /**
   * `value` is deliberately absent.
   *
   * Adding it broke two demo pages instantly, and the way it broke them is the
   * argument: a component written `Props & { value: unknown }` intersects to
   * `string & unknown`, so every component that takes a prop called `value` —
   * which is most of them — would have to start writing `Omit<Props, "value">`.
   * A framework type that claims the commonest prop name in the language is
   * hostile, and dziri already spells an input's value `bindValue`. An authored
   * `value=` attribute still reaches the IR from HTML, so `[value="x"]` selectors
   * work; it is only the JSX prop that is withheld.
   */
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  multiple?: boolean;
  selected?: boolean;
  /** `<label for=…>`; spelled `htmlFor` because `for` is a reserved word. */
  htmlFor?: string;
  /**
   * A string signal this element edits. Focus it by clicking, then typing appends
   * and Backspace deletes. Its value is displayed automatically when the element
   * has no children of its own.
   */
  bindValue?: ReadonlySignal<string>;
  /**
   * Inline declarations, applied after the cascade and beating every selector —
   * the same precedence a browser gives them.
   *
   * Either CSS text or an object of camelCased properties:
   *
   * ```tsx
   * <div style="color: red; padding: 8px" />
   * <div style={{ color: "red", padding: 8, fontWeight: 600 }} />
   * ```
   *
   * A number means pixels, except for the genuinely unitless properties
   * (`fontWeight`, `flexGrow`, `aspectRatio`, grid line numbers) — the same rule
   * React uses, chosen because it is the one people already have in their hands.
   *
   * Both forms resolve at build time and cost the runtime nothing. A value that
   * is *not* static — `{ color: someSignal }` — is a compile error rather than a
   * silent drop, because there is no node to attach it to once the compiler is
   * gone. Use a conditional class for that.
   */
  style?: string | StyleObject;
  children?: Child;
};

/** Camel-cased CSS properties with static values. */
export type StyleObject = Record<string, string | number | null | undefined>;

/**
 * Properties where a bare number is not a length.
 *
 * Everything else gets `px`, which is what makes `padding: 8` mean what it
 * looks like.
 */
/** Shared, because a fragment and the root have no attributes and never gain any. */
const EMPTY_ATTRS: ReadonlyMap<string, string> = new Map();

const UNITLESS = new Set([
  "fontWeight",
  "flexGrow",
  "flexShrink",
  "flex",
  "aspectRatio",
  "gridColumn",
  "gridRow",
  "zIndex",
  "opacity",
  "lineClamp",
]);

/** `backgroundColor` -> `background-color`. */
const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Normalises either `style` form into CSS text the cascade can parse. */
function styleAttr(style: Props["style"], tag: string): string | null {
  if (style == null) return null;
  if (typeof style === "string") return style.trim() || null;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (value === null || value === undefined) continue;

    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(
        `<${tag} style={{ ${key}: … }}>: inline styles are resolved at build time, ` +
          `so the value must be a string or a number. A signal has no value yet — ` +
          `use a conditional class (className={cn({ … })}) instead.`,
      );
    }

    const text =
      typeof value === "number" && !UNITLESS.has(key) ? `${value}px` : String(value);
    parts.push(`${kebab(key)}: ${text}`);
  }

  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Wraps a signal as a dynamic text part.
 *
 * Rarely needed directly: `{count}` in JSX passes the signal *object* through
 * `flatten`, which recognises it. Identity is what makes that possible — the JSX
 * transform evaluates expressions at build time, so `{count.value}` would hand
 * the compiler a number with no way back to the dependency.
 *
 *   <div className="count">{remaining} of {total} left</div>
 *
 * is one text node with five parts, not five nodes.
 */
export function bind(source: ReadonlySignal<unknown>): DynText {
  return { type: "dyntext", parts: [{ source }] };
}

// ---------------------------------------------------------------------------
// Class specs
// ---------------------------------------------------------------------------

const CLASS_SPEC = Symbol.for("skia-proto.classSpec");

/**
 * The result of `cn(...)`: static classes plus conditional ones, each still
 * carrying the signal that drives it.
 */
export type ClassSpec = {
  [CLASS_SPEC]: true;
  classes: string[];
  conditional: { name: string; source: unknown }[];
};

export type ClassArg =
  | string
  | false
  | null
  | undefined
  | Record<string, ReadonlySignal<boolean> | unknown>;

/**
 * Builds a class list the compiler can read.
 *
 * Unlike `clsx`, this does **not** return a string. It cannot: by the time a
 * string exists the connection to the signal is gone, and the compiler needs that
 * connection to compile the conditional into style-table writes. So `cn` returns a
 * marked object and the compiler unpacks it.
 *
 *   className={cn("btn", "primary", { light: isLight })}
 *
 * Static names land in `classes`; signal-keyed entries become toggles. A falsy or
 * plain-boolean value is resolved immediately, since that is a build-time constant.
 */
export function cn(...args: ClassArg[]): ClassSpec {
  const classes: string[] = [];
  const conditional: { name: string; source: unknown }[] = [];

  for (const arg of args) {
    if (!arg) continue;

    if (typeof arg === "string") {
      for (const name of arg.split(/\s+/)) if (name) classes.push(name);
      continue;
    }

    for (const [name, source] of Object.entries(arg)) {
      // A literal boolean is known now, so it needs no runtime mechanism.
      if (typeof source === "boolean") {
        if (source) classes.push(name);
        continue;
      }
      if (source === null || source === undefined) continue;
      conditional.push({ name, source });
    }
  }

  return { [CLASS_SPEC]: true, classes, conditional };
}

function isClassSpec(value: unknown): value is ClassSpec {
  return typeof value === "object" && value !== null && CLASS_SPEC in value;
}

export type Component<P extends Props = Props> = (props: P) => Node | Node[] | null;

/** Groups children without introducing a node. Spliced away during flattening. */
export const Fragment = "#fragment" as const;

const FRAGMENT_TAG = "#fragment";

/** Splits `class`/`className` into static names and signal-driven conditionals. */
function classList(props: Props): {
  classes: string[];
  classWhen: Record<string, unknown> | null;
} {
  const classes: string[] = [];
  let classWhen: Record<string, unknown> | null = null;

  for (const value of [props.class, props.className]) {
    if (!value) continue;

    if (isClassSpec(value)) {
      classes.push(...value.classes);
      for (const { name, source } of value.conditional) {
        classWhen ??= {};
        classWhen[name] = source;
      }
      continue;
    }

    for (const name of String(value).split(/\s+/)) if (name) classes.push(name);
  }

  return { classes, classWhen };
}

/**
 * Flattens arrays, drops nullish and boolean children (so `cond && <div/>`
 * works), splices fragments, and turns primitives into text.
 */
function flatten(child: Child, out: Node[]): void {
  if (child === null || child === undefined || child === false || child === true) return;

  if (Array.isArray(child)) {
    for (const c of child) flatten(c, out);
    return;
  }

  if (typeof child === "string" || typeof child === "number") {
    out.push({ type: "text", value: String(child) });
    return;
  }

  // `{t.text}` inside a list callback — a recorded path, not a value. Checked
  // before signals, since a recorder answers to any property access.
  if (isRecorder(child)) {
    out.push({ type: "dyntext", parts: [{ item: pathOf(child) }] });
    return;
  }

  // `{args.id}` — a route parameter, recognised before it is mistaken for a node.
  // Checked here rather than left to the proxy's own trap, which would fire on the
  // `.type` read below and report a computed expression that nobody wrote.
  if (isRouteParam(child)) {
    throw new ParamNotEmittedError(paramNameOf(child));
  }

  // `{count}` — a signal reached the tree as an object, so it is a binding.
  if (isSignal(child)) {
    out.push({ type: "dyntext", parts: [{ source: child }] });
    return;
  }

  const node = child as Node;

  if (node.type === "element" && node.tag === FRAGMENT_TAG) {
    for (const c of node.children) out.push(c);
    return;
  }

  out.push(node);
}

/**
 * Merges adjacent text children into one node, then collapses whitespace the way
 * `white-space: normal` does.
 *
 * The merge matters: JSX splits `Count: {n}` into two children, and two separate
 * IR text nodes would be laid out as two flex items — stacked vertically, since a
 * box with no `display` defaults to COLUMN. Coalescing keeps a text run one node.
 */
function normalize(nodes: Node[]): Node[] {
  // Runs of text and bindings merge into one node; a run containing any binding
  // becomes a dynamic text node with literal and key parts interleaved.
  const merged: Node[] = [];

  const isRun = (n: Node | undefined): n is Text | DynText =>
    n?.type === "text" || n?.type === "dyntext";

  for (const node of nodes) {
    const prev = merged[merged.length - 1];

    if (!isRun(node) || !isRun(prev)) {
      merged.push(
        node.type === "text"
          ? { type: "text", value: node.value }
          : node.type === "dyntext"
            ? { type: "dyntext", parts: [...node.parts] }
            : node,
      );
      continue;
    }

    // Both are runs: fold `node` into `prev`, promoting to dyntext if needed.
    const parts: TextPart[] = prev.type === "text" ? [{ literal: prev.value }] : prev.parts;
    const add: TextPart[] = node.type === "text" ? [{ literal: node.value }] : node.parts;
    const combined = [...parts, ...add];

    if (prev.type === "text" && node.type === "text") {
      prev.value += node.value;
    } else {
      merged[merged.length - 1] = { type: "dyntext", parts: combined };
    }
  }

  const out: Node[] = [];
  for (const node of merged) {
    if (node.type === "text") {
      node.value = collapse(node.value);
      if (node.value !== "") out.push(node);
      continue;
    }
    if (node.type === "dyntext") {
      // Collapse whitespace inside literals but keep them — the spaces between
      // `{bind("a")} of {bind("b")}` are meaningful.
      node.parts = node.parts
        .map((p) => ("literal" in p ? { literal: collapse(p.literal, false) } : p))
        .filter((p) => !("literal" in p) || p.literal !== "")
        // Two literals can end up adjacent — JSX splitting `at {x}` around a marked
        // string puts the surrounding text and the string's own prefix side by side.
        // They are one run, so they are one part; leaving them split costs a string
        // slot and makes the emitted binding read as though something separates them.
        .reduce<TextPart[]>((acc, part) => {
          const last = acc[acc.length - 1];
          if (last && "literal" in last && "literal" in part) {
            acc[acc.length - 1] = { literal: last.literal + part.literal };
          } else acc.push(part);
          return acc;
        }, []);
      if (node.parts.length > 0) out.push(node);
      continue;
    }
    out.push(node);
  }

  return out;
}

function collapse(value: string, trim = true): string {
  const collapsed = value.replace(/\s+/g, " ");
  return trim ? collapsed.trim() : collapsed;
}

type Text = Extract<Node, { type: "text" }>;

export function jsx(
  type: string | Component<never>,
  props: Props,
  _key?: unknown,
): Node {
  // Function components are expanded here, at build time, and leave no trace.
  if (typeof type === "function") {
    const result = (type as Component)(props);
    if (result === null) {
      return { type: "element", tag: FRAGMENT_TAG, id: null, classes: [], children: [], onClick: null, classWhen: null, bindValue: null, style: null, attrs: EMPTY_ATTRS };
    }
    if (Array.isArray(result)) {
      return {
        type: "element",
        tag: FRAGMENT_TAG,
        id: null,
        classes: [],
        children: normalize(result),
        onClick: null,
        classWhen: null,
        bindValue: null,
        style: null,
        attrs: EMPTY_ATTRS,
      };
    }
    return result;
  }

  /**
   * `<style>` belongs to the HTML front-end, not to JSX.
   *
   * Refused rather than supported, because in JSX it would be a tag that looks
   * dynamic and scoped while being neither. It sits inside a component, so it reads
   * as though it can hold a signal, be rendered conditionally, or apply to the
   * subtree around it — and none of those are true: the cascade is resolved once at
   * build time, the rules are global, and a component rendered twice cannot
   * sensibly contribute its stylesheet twice.
   *
   * A JSX module already has the honest mechanism, which is the same one the rest of
   * the ecosystem uses. An `.html` document has no imports at all, which is why it
   * keeps `<style>`.
   */
  if (type.toLowerCase() === "style") {
    throw new Error(
      `<style> is not supported in JSX — import the stylesheet instead.\n` +
        `    import "./app.css";\n` +
        `  Imports are ordered by the module graph, so the cascade follows the same\n` +
        `  order a bundler would give it. In JSX a <style> tag would look scoped and\n` +
        `  dynamic while being neither.\n` +
        `  (\`.html\` documents keep <style>, having no import statement to use.)`,
    );
  }

  const children: Node[] = [];
  flatten(props.children, children);
  const names = classList(props);

  // An editable with no children displays its own value, so `bindValue` alone is
  // enough to both show and edit — reusing the ordinary text-binding machinery.
  if (props.bindValue && children.length === 0) {
    children.push({ type: "dyntext", parts: [{ source: props.bindValue }] });
  }

  return {
    type: "element",
    tag: type.toLowerCase(),
    id: props.id ?? null,
    classes: names.classes,
    children: normalize(children),
    onClick: props.onClick ?? null,
    classWhen: names.classWhen,
    bindValue: props.bindValue ?? null,
    style: styleAttr(props.style, type),
    attrs: attrsOf(props, names.classes),
  };
}

/**
 * The props an attribute selector can see.
 *
 * Only strings and `true`, and the filter is the point rather than laziness: a
 * selector matches against text, so a signal or a handler in this map would be
 * a value no selector could ever compare against. A boolean attribute becomes
 * the empty string, which is what HTML says `<input disabled>` means and what
 * makes `[disabled]` a presence test rather than a value test.
 *
 * `class` and `id` are re-added from the parsed forms so `[class~="x"]` sees the
 * same list the cascade does — `className` may have been a `cn()` call, and the
 * raw prop would be an object.
 */
function attrsOf(props: Props, classes: string[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "className" || key === "class" || key === "style") continue;
    if (typeof value === "string") out.set(kebab(key).toLowerCase(), value);
    else if (value === true) out.set(kebab(key).toLowerCase(), "");
  }
  if (classes.length) out.set("class", classes.join(" "));
  if (typeof props.id === "string") out.set("id", props.id);
  return out;
}

/** Bun calls `jsxs` when there are multiple static children; same behaviour here. */
export const jsxs = jsx;

/** Wraps whatever a module exported into a document container the compiler accepts. */
export function toDocument(exported: Node | Node[]): Element {
  const children: Node[] = [];
  flatten(exported as Child, children);
  return {
    type: "element",
    tag: "#root",
    id: null,
    classes: [],
    children: normalize(children),
    onClick: null,
    classWhen: null,
    bindValue: null,
    style: null,
    attrs: EMPTY_ATTRS,
  };
}

/**
 * Tags the compiler understands. Enumerated rather than open-ended so a typo like
 * `<dvi>` is a type error instead of an unstyled node.
 */
/**
 * Intrinsic tags the compiler accepts.
 *
 * The form elements are here so a stylesheet can *name* them —
 * `input[type=checkbox]` is how a UA sheet says which control it is describing,
 * and there was no way to write that when `<input>` was the only one and
 * attributes were discarded. They still compile to ordinary boxes: nothing about
 * being in this list makes an element behave like a control. What gives a
 * checkbox its tick is CSS on a generated box, and what will give it its
 * checked-ness is A3.
 *
 * `select` is deliberately included even though its picker cannot open yet. The
 * closed control — the button and the selected option's text — is most of what a
 * form looks like, and the picker needs the overlay layer (ROADMAP B1). Rendering
 * the closed state correctly is better than rendering nothing, and it is what
 * Blitz does not do: it stubs `<select>` with `option { display: none }`.
 */
type Tag =
  | "body"
  | "div"
  | "span"
  | "p"
  | "label"
  | "button"
  | "input"
  | "select"
  | "selectedcontent"
  | "option"
  | "optgroup"
  | "textarea"
  | "fieldset"
  | "legend"
  | "form";

export declare namespace JSX {
  type Element = Node;
  type ElementType = Tag | Component<never>;
  type IntrinsicElements = Record<Tag, Props>;
  type ElementChildrenAttribute = { children: {} };
}
