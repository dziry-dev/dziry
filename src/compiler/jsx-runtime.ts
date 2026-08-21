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
  type Signal,
} from "../runtime/signal.ts";
import { isRecorder, pathOf, recorder } from "./item-path.ts";
import { isRouteParam, paramNameOf } from "./route-args.ts";
import { isRouteData, isRouteError, routeDataPath, routeErrorPath } from "./route-data.ts";
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
   * Called when a control's own value changes — not when it is clicked.
   *
   * The two are genuinely different and the difference is measured: clicking an
   * already-checked radio fires a click and no change, and clicking a label fires a
   * click on the label as well as on the control. Counting clicks cannot recover
   * "the value changed".
   *
   * The argument is that new value, and what it is depends on the control:
   *
   * - checkbox, radio — `boolean`, the new checkedness.
   * - select — `number`, the index of the chosen option within that select.
   *
   * Anything without a value of its own — a `<button>`, a `<div>` — never fires it.
   */
  onChange?: ((value: any) => void) | string;
  /**
   * Runs when this element takes focus, from a pointer or from Tab alike.
   *
   * **`onBlur` fires before the `onFocus` of whatever took the focus**, always — measured,
   * every event of the leaving element precedes every event of the arriving one. So a pair
   * of handlers that hand something between them can rely on the order.
   *
   * Neither runs when focus does not move: pressing the element that already has focus
   * produces nothing, which is what keeps a validate-on-blur from firing on every click of
   * the field it is already in.
   */
  onFocus?: (() => void) | string;
  /** Runs when this element loses focus. See [`onFocus`] for the ordering. */
  onBlur?: (() => void) | string;
  /**
   * Runs when this `<form>` is submitted: Enter in one of its fields, or a click on its
   * submit button.
   *
   * **It receives the form's payload** — an object keyed by the `name` of every control in
   * the form, exactly as a browser collects them, and typed by what each control is:
   *
   * ```tsx
   * <form onSubmit={(data) => save(data)}>
   *   <input name="email" />
   *   <input name="age" type="number" />
   *   <input name="terms" type="checkbox" />
   *   <select name="plan"><option>pro</option></select>
   *   <button>Save</button>
   * </form>
   * ```
   *
   * gives `data.email` a string, `data.age` a number or `undefined`, `data.terms` a
   * boolean, and `data.plan` the chosen option's value.
   *
   * A field needs no `bind:value` to be in it: the compiler declares a cell for every named
   * field that has none, so the browser-shaped form above works with no state module at
   * all. A field that *does* carry `bind:value` uses the author's signal, so the payload and
   * the rendered text cannot disagree.
   *
   * The inclusion rules are the browser's, measured in `probes/form-data.html`: a control
   * with no `name` is not in the payload, nor is a disabled one — including one disabled by
   * an enclosing `<fieldset disabled>` — nor is an unticked checkbox's value. Two controls
   * sharing a name give an array, in document order.
   *
   * With a `validate={…}` the argument is that schema's **output** instead, and this does
   * not run at all when validation fails — see [`onInvalid`].
   *
   * There is no event object and nothing to `preventDefault`: dziri never navigates, so a
   * submission is only ever a call into app code.
   *
   * **Enter does not always submit**, and the conditions are measured rather than
   * intuited (`probes/implicit-submission.html`). A form with no submit button submits
   * only if exactly one `<input>` blocks implicit submission; a *disabled* submit button
   * blocks it outright; and Enter in a `<textarea>` never submits. The compiler resolves
   * all of it, so what an author has to know is just this: give the form a submit button
   * and Enter will work.
   */
  // `any` for the same reason `onClick` uses it: a schema narrows this to its own output
  // type, which this position cannot know, and `unknown` would make every author cast
  // before reading a field off their own payload.
  onSubmit?: ((data: any) => void) | (() => void) | string;
  /**
   * Checks this `<form>`'s payload before `onSubmit` sees it.
   *
   * Three kinds of thing are accepted, and the first two need no dependency at all:
   *
   * ```tsx
   * <form validate={Login} onSubmit={save}>     // Zod, Valibot, ArkType — or an Effect schema
   * <form validate={(d) => (d.age < 18 ? [{ path: ["age"], message: "too young" }] : null)}>
   * ```
   *
   * Anything carrying `~standard` — the Standard Schema interop spec, which Zod 4, Valibot
   * and ArkType implement natively — is used through it. An **Effect** schema does not
   * carry it (measured on effect 3.22), so it is recognised by its `ast` and converted with
   * Effect's own `Schema.standardSchemaV1` after a lazy import; `effect` is never a
   * dependency of dziri, only of the app that passed one.
   *
   * A schema **narrows what `onSubmit` receives**: the payload goes in, the schema's output
   * comes out, so `Schema.NumberFromString` or `z.coerce.date()` hands the handler the
   * number or the `Date` rather than the string.
   *
   * Like every other reference in a tree, it has to be a module-level export — the
   * generated artifact imports it by name.
   */
  validate?: unknown;
  /**
   * Runs instead of `onSubmit` when `validate` rejected the payload.
   *
   * The argument is the issues, normalised to `{ path, message }[]` whichever validator
   * produced them, so an app that moves from Zod to Effect does not rewrite its error
   * rendering.
   *
   * Optional, and a form without one does nothing at all on a bad payload — which is what a
   * browser does with a form that fails its own constraints, minus the bubble.
   */
  onInvalid?: ((issues: any) => void) | string;
  /**
   * Form attributes, kept rather than ignored: a selector can test them.
   *
   * `type` is the important one — twenty-two `input` types are one tag, so
   * `input[type=checkbox]` is the only way a stylesheet can distinguish a
   * checkbox from a text field. These no longer merely "typecheck"; they reach
   * the IR and the cascade reads them.
   *
   * They used to not make a control *behave*, and that stopped being true in protocol
   * v13: `:checked` and `:disabled` are live bits the engine owns, so a click ticks a box
   * and a disabled control swallows the press. What these props still are is the
   * **authored** state — where the control starts, and what `[checked]` and `[disabled]`
   * match. `disabled` also accepts a signal now; see its own comment for why the
   * attribute selector and the pseudo-class part company there.
   */
  type?: string;
  name?: string;
  /**
   * `value` is deliberately absent **from this type**, and present on tags.
   *
   * Adding it here broke two demo pages instantly, and the way it broke them is the
   * argument: a component written `Props & { value: unknown }` intersects to
   * `string & unknown`, so every component that takes a prop called `value` —
   * which is most of them — would have to start writing `Omit<Props, "value">`.
   * A framework type that claims the commonest prop name in the language is
   * hostile.
   *
   * What changed since is that the restriction moved to where it belongs rather than being
   * dropped: `<input value="pro">` and `<option value="pro">` are legal, through
   * [`ElementProps`], because a *tag* is not something a component's props intersect with.
   * A radio's `value` is what its group submits, so a form could not be written in JSX
   * without it.
   */
  placeholder?: string;
  checked?: boolean;
  /**
   * Switches the control off: no press, no keyboard activation, skipped by Tab.
   *
   * A boolean or **a signal**, and the signal is the interesting half —
   * `disabled={isSaving}` is the ordinary thing an author wants and it used to be dropped
   * in silence, producing a control that was never disabled.
   *
   * The two spellings differ in one visible way, and it is not a bug:
   *
   * - `:disabled` matches either way. It is a live predicate bit the engine owns, so a
   *   stylesheet rule fires the moment the signal flips.
   * - `[disabled]` — the *attribute* selector — matches only the literal spelling. An
   *   attribute is text the compiler wrote down; a signal never becomes text. Style the
   *   dynamic case with `:disabled`, which is what it is for.
   *
   * Only on the elements `disabled` means something on — `input`, `select`, `textarea`,
   * `button`. Anywhere else the build says so rather than compiling a flag nothing reads.
   */
  disabled?: boolean | ReadonlySignal<boolean>;
  /**
   * Edits the tab-stop set: `0` puts an element in it, `-1` takes one out.
   *
   * Lower case, matching the HTML attribute rather than the DOM property, because that
   * is the spelling every other attribute here uses and the one a selector reads.
   *
   * A **positive** value is refused with a build warning and treated as `0`. Browsers
   * sort the whole positive group ahead of every other stop — measured — which makes tab
   * order a sort rather than the walk of the live tree dziri is built on. The element
   * still gets a stop, in document order; see `tabIndexOf` in the compiler.
   */
  tabindex?: number | string;
  /**
   * Focus this element when the window first appears. One per document wins.
   *
   * A boolean because that is what the HTML attribute is — its presence is the whole
   * value — and the compiler warns rather than guessing if a second element claims it or
   * if the element cannot hold focus at all.
   *
   * It fires exactly once. An element carrying `autofocus` that appears later, from a
   * list growing or a route showing, does not steal the caret: measured in Chromium
   * (`probes/focus-without-interaction.html`), and a stronger requirement here than
   * there, since dziri republishes its tables whenever any signal changes.
   */
  autofocus?: boolean;
  readOnly?: boolean;
  required?: boolean;
  multiple?: boolean;
  /**
   * `<select size=…>` — its height in rows, and the other half of what makes a list box.
   *
   * A `<select size="4">` with no `multiple` is a list box, not a dropdown: measured,
   * `probes/select-listbox.html`, same box and same in-flow options as a `multiple`. So
   * this is not a cosmetic hint — it decides which of two elements the tag compiles to.
   *
   * Also `<input size=…>`, which dziri does not implement. Typed as a string or a number
   * because both spellings are ordinary in JSX and the compiler parses it either way.
   */
  size?: number | string;
  selected?: boolean;
  /**
   * `<optgroup label=…>`, and nothing renders it yet.
   *
   * Here because it is a real attribute a selector can test — `optgroup[label]` — and
   * because leaving it out made a legal `<optgroup>` a type error, which is worse than
   * an attribute that only the cascade can see. Drawing the label needs a generated box
   * whose text comes from an attribute, which is exactly what `::placeholder` already
   * does; it is a small job and it is not done.
   */
  label?: string;
  /** `<label for=…>`; spelled `htmlFor` because `for` is a reserved word. */
  htmlFor?: string;
  /**
   * `<a href=…>` — a concrete route path, checked and followed.
   *
   * In a window compile the path is matched against the route table (a dead link
   * is a build error, `auditLinks` in build.ts) and the click handler is
   * synthesized as a write to the window's route signal — unless the element has
   * its own `onClick`, which wins. It is also still the attribute a selector can
   * test: `a[href]` is how a stylesheet tells a link from an anchor. What an
   * external `https://` link should do remains an unsettled API.md question, so
   * it is refused like any other non-route path rather than half-opened.
   */
  href?: string;
  /**
   * A string signal this element edits. Focus it by clicking, then typing appends
   * and Backspace deletes. Its value is displayed automatically when the element
   * has no children of its own.
   *
   * **The colon is real syntax, not a naming convention.** TypeScript parses a
   * namespaced JSX attribute and lowers it to a quoted key — `bind:value={draft}`
   * becomes `{ "bind:value": draft }` — then typechecks that key against this
   * type, so a typo is an error naming the property it meant. Bun's transform
   * emits the identical key, which is why one spelling serves both. Measured
   * before the rename, because a syntax the type checker merely tolerated would
   * have been worse than a camelCased prop.
   *
   * Why a namespace at all: two-way is a different *kind* of prop. Everything
   * else here flows one way into a build artifact, while this one is the only
   * place the engine writes back into app state, and the family it opens —
   * `bind:checked` for a checkbox, `bind:group` for a radio set — reads as one
   * idea rather than four unrelated names. Svelte and Vue both landed here.
   *
   * Writable, deliberately: this used to be a `ReadonlySignal`, which let a
   * `derived()` typecheck in a position the host assigns to.
   *
   * **Inside a `map()` row it takes the row's own property** — `bind:value={job.title}`
   * — and that is why the type admits a bare `string`. A list callback runs against a
   * recording proxy, so `job.title` is *typed* as the item's property while being a
   * recorded path at build time; there is no signal object to name, because a row's
   * state lives in the array. Widening the type is what makes the honest spelling
   * compile, and the cost is that a literal `bind:value="hi"` now type-checks — refused
   * by the compiler instead, naming the two things this accepts.
   */
  "bind:value"?: Signal<string> | string;
  /**
   * `<img bind:src={sig}>` — a dynamic image source. The signal's value is
   * interned as the initial string, and the worker rewrites the slot when the
   * signal moves; the loader picks the new path up on the next frame. The
   * `string` arm is the same list-row story as `bind:value` above.
   */
  "bind:src"?: Signal<string> | string;
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
    out.push({ type: "dyntext", parts: [{ param: paramNameOf(child) }] });
    return;
  }

  // `{data.title}` and `{error.message}` inside a route object's component — a
  // recorded path into the loader's exit, not a value. Checked after the list-item
  // and param recorders, since each answers only to its own brand.
  if (isRouteData(child)) {
    out.push({ type: "dyntext", parts: [{ data: routeDataPath(child) }] });
    return;
  }
  if (isRouteError(child)) {
    out.push({ type: "dyntext", parts: [{ error: routeErrorPath(child) }] });
    return;
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
      return { type: "element", tag: FRAGMENT_TAG, id: null, classes: [], children: [], onClick: null, onChange: null, onFocus: null, onBlur: null, onSubmit: null, classWhen: null, bindValue: null, bindSrc: null, style: null, attrs: EMPTY_ATTRS };
    }
    if (Array.isArray(result)) {
      return {
        type: "element",
        tag: FRAGMENT_TAG,
        id: null,
        classes: [],
        children: normalize(result),
        onClick: null, onChange: null, onFocus: null, onBlur: null, onSubmit: null,
        classWhen: null,
        bindValue: null,
        bindSrc: null,
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

  // An editable with no children displays its own value, so `bind:value` alone is
  // enough to both show and edit — reusing the ordinary text-binding machinery.
  //
  // A row's property takes the *item* part shape rather than the signal one, which is what
  // makes the display half of a per-row field free: `{job.title}` written by hand compiles
  // to exactly this, so the arena's per-row slots already know how to render it. The write
  // half is the new mechanism, and it is in `compile.ts`.
  const bound = props["bind:value"];
  if (bound && children.length === 0) {
    children.push(
      isRecorder(bound)
        ? { type: "dyntext", parts: [{ item: pathOf(bound) }] }
        : { type: "dyntext", parts: [{ source: bound }] },
    );
  }

  const droppedSignals: string[] = [];
  const attrs = attrsOf(props, names.classes, droppedSignals);
  const { errorClassName } = props as { errorClassName?: string };

  // `disabled={sig}` is consumed rather than dropped, so it must not be warned about.
  // Pulled out here beside `bind:value` — both are props whose value is a signal the
  // element keeps rather than an attribute the cascade reads.
  const disabledWhen = isSignal(props.disabled) ? props.disabled : null;
  const dropped = disabledWhen ? droppedSignals.filter((p) => p !== "disabled") : droppedSignals;

  return {
    type: "element",
    tag: type.toLowerCase(),
    id: props.id ?? null,
    classes: names.classes,
    children: normalize(children),
    ...(dropped.length ? { droppedSignals: dropped } : {}),
    ...(disabledWhen ? { disabledWhen } : {}),
    onClick: props.onClick ?? null,
    onChange: props.onChange ?? null,
    onFocus: props.onFocus ?? null,
    onBlur: props.onBlur ?? null,
    onSubmit: props.onSubmit ?? null,
    // Optional fields, so the three other places an `Element` is built by hand — a
    // fragment, the document root, the HTML front end — need no edit to stay valid.
    ...(props.onInvalid === undefined ? {} : { onInvalid: props.onInvalid }),
    ...(props.validate === undefined ? {} : { validate: props.validate }),
    // Read through a cast because `errorClassName` lives on `ElementProps` — what a *tag*
    // accepts — rather than on `Props`, which is what components extend. See `ElementProps`.
    ...(errorClassName === undefined ? {} : { errorClassName }),
    classWhen: names.classWhen,
    bindValue: bound ?? null,
    bindSrc: props["bind:src"] ?? null,
    // `checked={t.done}` — a recorded item path, so the row's data owns the tick.
    // A literal `checked` stays an attribute (attrsOf keeps `true` and strings);
    // a *signal* here is not supported yet and falls through to the dropped-signal
    // warning, which names it rather than half-working.
    ...(isRecorder(props.checked) ? { bindChecked: props.checked } : {}),
    style: styleAttr(props.style, type),
    attrs,
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
 *
 * The `bind:` namespace is skipped by prefix rather than by name, so
 * `bind:checked` and `bind:group` need no second edit here. It would be skipped
 * anyway — a signal is neither a string nor `true` — but only by accident of what
 * it holds, and `kebab("bind:value")` is not an attribute name anyone wants in
 * the map if a future binding ever carries a literal.
 */
function attrsOf(
  props: Props,
  classes: string[],
  /** Filled with the names of props that held a signal and were therefore dropped. */
  droppedSignals?: string[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "className" || key === "class" || key === "style") continue;
    // A *class list*, like the two above it, so it is kept as its own field rather than
    // becoming an attribute. `kebab` would spell it `error-class-name`, which is a name no
    // author wants to write in an `.html` document and a value no selector should match
    // against — `[error-class-name~="x"]` is not a question anyone is asking.
    if (key === "errorClassName") continue;
    if (key.startsWith("bind:")) continue;
    if (typeof value === "string") out.set(kebab(key).toLowerCase(), value);
    else if (value === true) out.set(kebab(key).toLowerCase(), "");
    // A signal here is dropped, as the doc above says it must be — but dropping it in
    // silence is the problem. `disabled={isBusy}` reads like it works, compiles without a
    // word, and produces a control that is simply never disabled. Recorded so the build
    // can say so once; see `warnDroppedSignals` in `compile.ts`.
    else if (isSignal(value)) droppedSignals?.push(key);
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
    onClick: null, onChange: null, onFocus: null, onBlur: null, onSubmit: null,
    classWhen: null,
    bindValue: null,
    bindSrc: null,
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
 * `select` was included before its picker could open, on the grounds that the
 * closed control is most of what a form looks like and rendering it correctly beat
 * rendering nothing — which is what Blitz does not do, stubbing `<select>` with
 * `option { display: none }`. That bet paid off: the picker opens as of protocol
 * v18 and the closed control needed no changes to get there, because the parts
 * `ua-structure.ts` already built are the parts a picker hangs off.
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
  | "form"
  // Document text. All of these compile today — the parser takes any tag and the
  // cascade matches it — and the headings already have UA-sheet rules. Being here
  // means being *nameable in JSX*, not being fully rendered: `<em>` is upright and
  // `<ul>` unmarked until `font-style` and `list-style-type` become style fields,
  // which the unstyled demo window (windows/plain) shows rather than hides.
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "a"
  | "b"
  | "strong"
  | "i"
  | "em"
  | "code"
  | "small"
  | "pre"
  | "blockquote"
  | "hr"
  | "ul"
  | "ol"
  | "li"
  /**
   * A replaced element: the bytes behind `src` render into the content box, at
   * the natural size when CSS says nothing — a real graphic, not a styled box.
   * The compiler emits the reference (`images` table), the host resolves the
   * bytes (file or fetch), the engine decodes and paints. See `images.rs`.
   */
  | "img"
  /**
   * A vector graphic, parsed and drawn by the engine — paths, shapes and groups,
   * sized by `viewBox`. The supported subset is documented in `svg.rs`.
   */
  | "svg";

/**
 * What a **tag** accepts, as opposed to what a component does.
 *
 * The two were the same type until a form needed `value`, and the split is what lets that
 * attribute exist at all. `Props` is withheld from claiming `value` on purpose — see its own
 * comment there — because authors write `Props & { value: number }` for their own components
 * and an intersection with `string` makes that prop `never`. Two live examples in this repo:
 * `windows/main/pages/features.tsx` and `pages/reactivity.tsx`.
 *
 * None of that applies to a tag. `<input value="pro">` is an *attribute*, it is always text,
 * and no component's props type is involved — so the restriction only ever needed to be on
 * the half that components extend.
 *
 * It is not cosmetic. A radio's `value` **is** what its group submits, and an `<option>`'s is
 * what a `<select>` submits; without this, every radio in a JSX form would submit the string
 * `"on"` and the payload could not tell them apart.
 */
type ElementProps = Props & {
  /**
   * `<input value>`, `<option value>` — the authored attribute.
   *
   * A field's *default value* for a text input, and the *submitted value* for a checkbox,
   * radio or option. A string, always: an attribute is text a selector can compare against,
   * so `[value="pro"]` means what it says. To change one at run time, bind it —
   * `bind:value` — rather than passing a signal here.
   */
  value?: string;
  /**
   * `<input type="range">` / `<input type="number">` — the bounds, and the distance
   * between adjacent values. Strings, like every attribute: `min="0"`. Read at
   * compile time into the numerics side table; a number input without a bound is
   * unbounded, a range without one gets HTML's 0–100.
   */
  min?: string;
  max?: string;
  step?: string;
  /**
   * `<input type="file" accept=…>` — what the native picker offers, spelled as the
   * HTML attribute: MIME types and `.ext` entries, comma-separated
   * (`accept="image/*,.pdf"`). The host parses it into SDL dialog filters — see
   * `parseAcceptToFilters` in `host/main.ts`.
   */
  accept?: string;
  /**
   * `<input form="login">` — the id of the form this control belongs to.
   *
   * **Ownership, not a hint.** The control is that form's for every purpose: it is in that
   * form's payload, it can be that form's default submit button, and it counts towards that
   * form's implicit-submission rules — even when it is written outside the form, or inside a
   * different one. All three are measured (`probes/form-owner.html`).
   *
   * An id that names no form leaves the control owned by **nothing**, rather than falling
   * back to its ancestor. That is also measured, and it is the behaviour a typo produces.
   *
   * Here rather than on `Props` for the same reason `value` is: `form` is an ordinary prop
   * name a component might want, and a tag is not something a component's props intersect
   * with.
   */
  form?: string;
  /**
   * Names a **group** of controls, and nests the payload.
   *
   * Put it on anything that wraps a control — the div that holds a label, an input and an
   * error message. What it does is give everything inside it a path prefix:
   *
   * ```tsx
   * <div field="email"><input /></div>                        // { email: string }
   * <div field="position"><input name="x" /><input name="y" /></div>
   *                                                           // { position: { x, y } }
   * <div field="address"><div field="city"><input /></div></div>
   *                                                           // { address: { city } }
   * ```
   *
   * A control with no `name` takes the wrapper's path as its own, so a wrapper holding one
   * bare input *is* that field. Named controls inside become its properties. Wrappers nest,
   * and an element without `field` is transparent — a layout div nests nothing.
   *
   * **Not a browser attribute.** HTML has no nesting at all: `name="user[email]"` is the
   * literal key `"user[email]"` in `FormData`, and the bracket convention is invented by
   * server-side parsers, each with its own dialect (measured, `probes/form-nested-names.html`).
   * dziri nests by *structure* instead, because a compiler can see the structure — so there is
   * no path syntax to parse, and a conflict is a build error rather than the silent
   * last-write-wins every one of those parsers has.
   */
  field?: string;
  /**
   * Classes to add to this `field` wrapper while it has a validation error.
   *
   * The one piece of error state there is. It compiles to the same style-table patches a
   * conditional class does, so the whole subtree restyles — the input's border and the
   * message's visibility both come from a class on the wrapper:
   *
   * ```tsx
   * <div field="email" errorClassName="group/error">
   *   <input className="error:border-red-500" />
   *   <span error className="hidden error:block" />
   * </div>
   * ```
   *
   * With Tailwind, define the variant in its **prefix** form — `@custom-variant error
   * (.group\/error &)` — which emits `.group\/error .error\:block`, a plain descendant
   * selector. Tailwind's default form emits `:is(:where(.group\/error) *)`, and the `*`
   * inside `:is()` is not a selector dziri parses.
   *
   * A wrapper is in error when any issue's path has the wrapper's path as a **prefix**, so a
   * `field="position"` wrapper lights up for an issue at `position.x`.
   */
  errorClassName?: string;
  /**
   * Marks this element as the place its `field` wrapper's error message is written.
   *
   * ```tsx
   * <span error className="hidden error:block" />
   * ```
   *
   * The element's text becomes an ordinary text run bound to a cell the compiler declares —
   * the same mechanism as a field's value cell, and the same idea as `::placeholder`, whose
   * text also comes from somewhere other than `content`. Its own children are replaced, so
   * placeholder text inside it is only ever seen at build time.
   *
   * **A string names a field inside the wrapper**, relative to it exactly as a control's `name`
   * is — `error="city"` inside `field="address"` shows the issue at `address.city`, and dots go
   * deeper. That is what lets one group have a message per leaf: each marker shows the first
   * issue under its own path that no more specific marker would show, so the bare form keeps
   * whatever is only the group's own and nothing is said twice.
   *
   * Relative rather than absolute so a group stays movable: renaming the wrapper, or nesting it,
   * must not mean editing every marker inside it. A name no field produces is a build warning —
   * a marker that can never fill looks exactly like a field that is never wrong.
   */
  error?: boolean | string;
  /**
   * When this `<form>` checks itself. `"submit"` unless you say otherwise.
   *
   * - `"submit"` — only when the form is submitted. Costs nothing while typing.
   * - `"change"` — as each field changes, including every keystroke.
   * - `"blur"` — when a field loses focus. Suits a rule that is expensive to check often.
   *
   * **After a failed submit a form always re-validates as its fields change**, whatever this
   * says, so an error the user has already been shown clears itself the moment they fix it.
   * That is behaviour rather than a second attribute because it is not a preference — React
   * Hook Form spells it `reValidateMode: onChange` and defaults it the same way.
   *
   * And before any submit, a field may only show an error once its value has *moved* off the
   * one it was compiled with, so a pristine form does not turn red as you tab through it.
   * That gate is what other libraries store as `touched`; here it needs no state at all,
   * because the initial value is a constant the compiler wrote down.
   *
   * The trigger is named, not the handler: `"change"`, not `"onChange"`.
   */
  validateOn?: "submit" | "change" | "blur";
  /**
   * `<img src>` — where the bytes come from: an `https?://` URL the host fetches,
   * or a file path it reads. A string, always, like every attribute: to change an
   * image at run time, render a different element — there is no `bind:src`.
   */
  src?: string;
  /**
   * `<img alt>` — the text that stands for the image. Carried into the IR and
   * selector-visible, like every attribute; not yet *painted* when the image
   * fails — the box keeps its size and draws nothing, which is the broken-image
   * behaviour minus the alt text.
   */
  alt?: string;
  /**
   * `<img width>` / `<img height>` — presentational hints, parsed as HTML
   * dimensions: a non-negative integer in pixels. They lose to every CSS rule
   * and to inline `style=`, which is what "presentational" means. Strings
   * because attributes are text: `width="100"`.
   */
  width?: string;
  height?: string;
};

export declare namespace JSX {
  type Element = Node;
  type ElementType = Tag | Component<never>;
  type IntrinsicElements = Record<Tag, ElementProps>;
  type ElementChildrenAttribute = { children: {} };
}
