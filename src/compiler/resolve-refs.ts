/**
 * Resolves authored object references to the export names that hold them.
 *
 * `{count}` puts a signal *object* in the tree and `onClick={increment}` puts a
 * *function* there. Neither can be written into a generated file. But `ui.gen.ts`
 * is a module rather than data, so it can `import { count } from "./state.ts"` —
 * all the compiler needs is the name.
 *
 * It gets the name by identity: import the app's modules, walk their exports, and
 * match by reference. That is why signals and handlers must be module-level
 * exports, and an unresolved reference is a compile error naming the rule rather
 * than a silently dead binding.
 */
import type { CompileResult } from "./compile.ts";
import { routeMatchOf, routePathBehind } from "./route.ts";

export type RefSource = {
  /** Import specifier the generated module should use, e.g. "./state.ts". */
  specifier: string;
  /** Exported name -> value. */
  exports: Record<string, unknown>;
};

export class RefError extends Error {}

/**
 * Which module and export a resolved reference came from.
 *
 * `expression` is set when the reference has no name of its own and the artifact
 * has to contain the thing it was derived *from* — `router.matches("layout")`
 * becomes `computed(() => route.value === "layout")`. `name` still points at the
 * import that expression needs.
 */
export type ResolvedRef = { specifier: string; name: string; expression?: string };

export function buildRefIndex(sources: RefSource[]): Map<unknown, ResolvedRef> {
  const index = new Map<unknown, ResolvedRef>();

  for (const source of sources) {
    for (const [name, value] of Object.entries(source.exports)) {
      if (value === null || (typeof value !== "object" && typeof value !== "function")) continue;
      // First writer wins, so an earlier module's name is preferred when the same
      // object is re-exported.
      if (!index.has(value)) index.set(value, { specifier: source.specifier, name });
    }
  }

  return index;
}

/**
 * Rewrites signal and handler references in place, and returns the set of imports
 * the generated module needs.
 */
export function resolveRefs(
  result: CompileResult,
  index: Map<unknown, ResolvedRef>,
  variants?: {
    patches: {
      source: unknown;
      className: string;
      exportName: string;
      exportExpression?: string;
    }[];
  },
): { imports: Map<string, Set<string>> } {
  const imports = new Map<string, Set<string>>();

  /**
   * Which module each imported name came from.
   *
   * Only interesting because the router made this a many-module pass. With one
   * entry and its `state.ts` a name could not collide; with a module per page, two
   * pages exporting `draft` and both using it would emit two `import { draft }`
   * lines and an artifact that cannot parse — reported as a syntax error in
   * generated code, pointing nowhere near the two files that caused it.
   *
   * Keyed on *used* names rather than on every export, so two pages may each have
   * their own private `draft` as long as at most one of them reaches the tree.
   */
  const from = new Map<string, string>();

  const record = (ref: ResolvedRef, what: string): void => {
    const previous = from.get(ref.name);
    if (previous !== undefined && previous !== ref.specifier) {
      throw new RefError(
        `two modules export "${ref.name}", and ${what} needs both:\n` +
          `    ${previous}\n    ${ref.specifier}\n` +
          `  The generated module imports every signal and handler by name, so one name\n` +
          `  cannot mean two things. Rename one of them, or move the shared one into a\n` +
          `  module both import.`,
      );
    }
    from.set(ref.name, ref.specifier);

    let names = imports.get(ref.specifier);
    if (!names) {
      names = new Set();
      imports.set(ref.specifier, names);
    }
    names.add(ref.name);
  };

  /**
   * `router.matches("layout")` — a cell with no name, rebuilt as an expression.
   *
   * Every other reference survives the compiler/runtime boundary by being a
   * module-level export the artifact can import. This one cannot be: it is created
   * inside a component, and components are erased. What it *can* do is say how it
   * was derived — a route signal and a path — and both of those the artifact can
   * write down, so the emitted module contains the comparison rather than a name
   * for it.
   *
   * `computed` is already a runtime export, so this costs no new runtime surface;
   * the generated code says exactly what the author wrote.
   */
  const asRouteMatch = (value: unknown): ResolvedRef | null => {
    const match = routeMatchOf(value);
    if (!match) return null;

    const route = index.get(match.signal);
    if (!route) {
      throw new RefError(
        `router.matches(${JSON.stringify(match.path)}) reads a route signal that is not a\n` +
          `  module-level export. <Window route={…}> has to be given an exported signal, because\n` +
          `  the generated module imports it by name.`,
      );
    }

    const active = `${route.name}.value`;
    const test =
      match.path === "/"
        ? `${active} === "/"`
        : `(${active} === ${JSON.stringify(match.path)} || ` +
          `${active}.startsWith(${JSON.stringify(`${match.path}/`)}))`;

    record(route, `a route match on "${match.path}"`);
    return { specifier: route.specifier, name: route.name, expression: `computed(() => ${test})` };
  };

  const lookup = (value: unknown, what: string): ResolvedRef => {
    const derived = asRouteMatch(value);
    if (derived) return derived;

    // `router.path` is handed to pages wrapped, so that `.value` yields a marker
    // the compiler can bind rather than the route the signal happened to start on.
    // The wrapper is not the object the window exported, so it has to come off
    // before the name lookup — otherwise every `{router.path}` is unresolvable.
    const ref = index.get(routePathBehind(value) ?? value);
    if (!ref) {
      throw new RefError(
        `${what} is not a module-level export of a known state module.\n` +
          `  Signals and handlers must be declared as exports — of the window's state.ts, its\n` +
          `  entry, or the page itself — so the compiler can name them. A value created inside\n` +
          `  a component has nowhere to live, because components are erased at build time.`,
      );
    }
    record(ref, what);
    return ref;
  };

  for (const binding of result.textBindings) {
    binding.parts = binding.parts.map((part) =>
      "source" in part
        ? { export: lookup(part.source, `a signal interpolated into node ${binding.node}`).name }
        : part,
    );
  }

  for (const handler of result.handlers) {
    // An HTML `onclick="name"` attribute is already a name.
    if (typeof handler.ref === "string") {
      handler.name = handler.ref;
      continue;
    }
    const ref = lookup(handler.ref, `the click handler on node ${handler.node}`);
    handler.name = ref.name;
  }

  for (const editable of result.editables) {
    editable.name = lookup(editable.ref, `the bindValue on node ${editable.node}`).name;
  }

  for (const list of result.lists) {
    list.exportName = lookup(list.source, `the array behind a map() in node ${list.container}`).name;
    for (const handler of list.itemHandlers) {
      handler.name = lookup(
        handler.ref,
        `a per-row click handler in the list in node ${list.container}`,
      ).name;
    }
  }

  for (const patch of variants?.patches ?? []) {
    const ref = lookup(
      patch.source,
      `the signal driving the conditional class ".${patch.className}"`,
    );
    // The expression when there is one, the export name otherwise. Emit tells them
    // apart by `exportExpression` rather than by inspecting the string.
    patch.exportName = ref.name;
    patch.exportExpression = ref.expression;
  }

  return { imports };
}
