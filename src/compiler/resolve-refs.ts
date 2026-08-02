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
import { inlineSourceOf, depsOf } from "./reactive-runtime.ts";

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

  /**
   * `{count * 2}` — a cell the reactive transform made, carrying its own source.
   *
   * Same shape as `asRouteMatch` and simpler, because there is nothing to
   * reconstruct: the transform held the text and handed it over. What still has to
   * be resolved are the *signals* it reads, which the cell discovered by running —
   * each one needs an import, or `ui.gen.ts` names something it never imported.
   *
   * `__dzr.` is stripped because the artifact is generated: it can import `$` and
   * `$m` under their own names with no risk of colliding with anything, which is
   * exactly the risk that made the namespace necessary in authored files.
   */
  const asInline = (value: unknown): ResolvedRef | null => {
    const text = inlineSourceOf(value);
    if (text === undefined) return null;

    const deps = depsOf(value);
    let first: ResolvedRef | null = null;
    const named: [unknown, ResolvedRef][] = [];

    for (const dep of deps) {
      const ref = index.get(routePathBehind(dep) ?? dep);
      if (ref) named.push([dep, ref]);
      if (!ref) {
        throw new RefError(
          `an inline expression reads a signal that is not a module-level export:\n` +
            `    ${text}\n` +
            `  Every signal an expression reads has to be nameable, because the generated\n` +
            `  module imports it. Declare it as an export of the window's state module.`,
        );
      }
      record(ref, `an inline expression (${text})`);
      first ??= ref;
    }

    // A cell exists only when something reactive was read — `inline` folds the rest
    // to a plain value before one is created — so this cannot be empty.
    if (!first) return null;

    // Every signal it read must appear in the text under the name it is exported by.
    //
    // The text goes into `ui.gen.ts` verbatim, where the only bindings in scope are
    // the imports. A local reaches the same signal under a different name —
    // `useRouter().path` is the route, but the text says `router` — and emitting that
    // produces a module referring to something it never imported. Caught here rather
    // than as "Cannot find name 'router'" in generated code.
    for (const [dep, ref] of named) {
      if (new RegExp(`\\b${ref.name}\\b`).test(text)) continue;
      throw new RefError(
        `an inline expression reads a signal through a local name:\n    ${text}\n` +
          `  It resolves to the export "${ref.name}" (${ref.specifier}), but the generated\n` +
          `  module can only import that name — a local like \`useRouter()\` is gone by then.\n` +
          `  Read the export directly, or keep the expression whole: {router.path} compiles\n` +
          `  as a binding without being rewritten.`,
      );
    }

    return {
      specifier: first.specifier,
      name: first.name,
      expression: `computed(() => ${text.replaceAll("__dzr.", "")})`,
    };
  };

  const lookup = (value: unknown, what: string): ResolvedRef => {
    const inline = asInline(value);
    if (inline) return inline;

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
    binding.parts = binding.parts.map((part) => {
      if (!("source" in part)) return part;
      const ref = lookup(part.source, `a signal interpolated into node ${binding.node}`);
      // The expression when the cell has no name of its own, the name otherwise. An
      // inline `{count * 2}` is the first case; `{count}` is the second.
      return { export: ref.expression ?? ref.name };
    });
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
