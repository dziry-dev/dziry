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

export type RefSource = {
  /** Import specifier the generated module should use, e.g. "./state.ts". */
  specifier: string;
  /** Exported name -> value. */
  exports: Record<string, unknown>;
};

export class RefError extends Error {}

/** Which module and export a resolved reference came from. */
export type ResolvedRef = { specifier: string; name: string };

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
  variants?: { patches: { source: unknown; className: string; exportName: string }[] },
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

  const lookup = (value: unknown, what: string): ResolvedRef => {
    const ref = index.get(value);
    if (!ref) {
      throw new RefError(
        `${what} is not a module-level export of a known state module.\n` +
          `  Signals and handlers must be declared as exports (e.g. in app/state.ts) so the\n` +
          `  compiler can name them — a value created inside a component has nowhere to live,\n` +
          `  because components are erased at build time.`,
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
    patch.exportName = lookup(
      patch.source,
      `the signal driving the conditional class ".${patch.className}"`,
    ).name;
  }

  return { imports };
}
