/**
 * The source rewrite that makes a bare signal read reactive.
 *
 * ```tsx
 * const doubled = computed(() => count * 2);   ->  computed(() => $(count) * 2)
 * <div>{count === 7 ? "a" : "b"}</div>         ->  <div>{computed(() => $(count) === 7 ? "a" : "b")}</div>
 * ```
 *
 * Two rewrites, and neither needs type information. That is the whole trick and it
 * is worth stating plainly, because the obvious design does need it: to rewrite
 * `count` you would think you must first know `count` is a signal, which means
 * resolving its declaration — across modules, since dziri's signals are exported
 * from `state.ts` and imported by pages. Svelte pays exactly that cost, and it is
 * why `export let count = $state(0)` cannot work there.
 *
 * Instead every identifier *read* is rewritten and `$` decides at run time. Three
 * things fall out of that, all of them load-bearing:
 *
 *   - **No scope analysis.** A parameter shadowing a signal resolves to the
 *     parameter, because `$` sees the parameter's value. `todos.filter(t => t.done)`
 *     rewrites `t` and costs one predicate.
 *   - **No module graph.** An imported binding is rewritten like any other.
 *   - **Over-rewriting is safe**, not merely tolerated. That converts a correctness
 *     problem into a performance one, and the performance one is a predicate.
 *
 * What it cannot be sloppy about is *position*. `$(x) = 1` is a syntax error, so a
 * read has to be told from a write, a declaration, a key, and a type. That is
 * `isRead`, and it is decided from the parent node alone — no scopes, no symbols.
 *
 * Edits are surgical rather than printed. `magic-string` splices at byte offsets, so
 * formatting, comments, and — critically — line numbers survive, and a stack trace
 * still points where the author looked. Printing an AST would have reformatted every
 * file the transform touched.
 */
import MagicString from "magic-string";
import { parseSync } from "oxc-parser";

/** A node as oxc hands it back: ESTree-shaped, with byte offsets. */
type Node = { type: string; start: number; end: number } & Record<string, unknown>;

export class TransformError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "TransformError";
  }
}

/**
 * JSX expressions that become a `computed`.
 *
 * Deliberately a small allow-list rather than "anything that is not an identifier".
 * Every shape outside it already compiles to something correct today — `{count}` is
 * a binding by identity, `{todos.map(…)}` is a list, `{router.matches(…)}` is a cell
 * — and wrapping those would change working IR for no gain.
 *
 * `LogicalExpression` is excluded on purpose and is not an oversight: `{cond && <div/>}`
 * is conditional *rendering*, which the compiler resolves at build time by dropping
 * the child. Wrapping it would hand the runtime a `computed` where it expects a node.
 * Making that reactive is a separate feature with its own IR.
 */
const WRAPPED = new Set([
  "BinaryExpression",
  "ConditionalExpression",
  "TemplateLiteral",
  "UnaryExpression",
]);

/**
 * Whether a brace's expression should become a `computed`.
 *
 * The extra condition beyond `WRAPPED` is that it must not *contain* JSX.
 * `{cond ? <A/> : <B/>}` is a `ConditionalExpression`, so the shape allows it — but
 * it is conditional rendering, and wrapping it hands the runtime a `computed` where
 * the compiler expects a node. Same reason `LogicalExpression` is excluded outright;
 * this catches the case where the shape does not give it away.
 */
function isWrappable(expression: Node): boolean {
  if (!WRAPPED.has(expression.type)) return false;

  let hasJsx = false;
  walk(expression, ({ node }) => {
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      hasJsx = true;
      return false;
    }
    return !hasJsx;
  });
  return !hasJsx;
}

/**
 * Parent contexts in which an identifier is not a value being read.
 *
 * Each entry is `parentType:field`. Anything not listed is a read, which is the
 * right default: a missed read is a frozen value, and a wrongly-rewritten
 * non-read is a syntax error the build cannot miss. Failing loudly beats failing
 * quietly, so the doubt goes on the side that crashes.
 */
const NOT_A_READ = new Set([
  // `const x = …`, `function f(x)`, `class X`
  "VariableDeclarator:id",
  "FunctionDeclaration:id",
  "FunctionExpression:id",
  "ClassDeclaration:id",
  "ClassExpression:id",
  // `x = 1`, `x += 1`, `x++` — `$(x) = 1` does not parse.
  "AssignmentExpression:left",
  "UpdateExpression:argument",
  // `{ key: value }`, `obj.prop`, `class { method() {} }`
  "Property:key",
  "MemberExpression:property",
  "MethodDefinition:key",
  "PropertyDefinition:key",
  // `import { x }`, `export { x }`
  "ImportSpecifier:local",
  "ImportSpecifier:imported",
  "ImportDefaultSpecifier:local",
  "ImportNamespaceSpecifier:local",
  "ExportSpecifier:local",
  "ExportSpecifier:exported",
  // `break outer;`
  "LabeledStatement:label",
  "BreakStatement:label",
  "ContinueStatement:label",
  // `foo(x)` — the callee is not worth wrapping. `signal(0)` staying `signal(0)`
  // keeps module scope readable, and a signal is never called.
  "CallExpression:callee",
  "NewExpression:callee",
  // `{...spread}` in a pattern, and every destructuring position
  "AssignmentPattern:left",
  "RestElement:argument",
  "ArrayPattern:elements",
  "ObjectPattern:properties",
]);

type Visit = { node: Node; parent: Node | null; field: string };

/** Depth-first walk, carrying the parent and the field the child was reached by. */
function walk(root: Node, visit: (v: Visit) => boolean | void): void {
  const go = (node: Node, parent: Node | null, field: string): void => {
    if (visit({ node, parent, field }) === false) return;

    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) go(child, node, key);
        }
      } else if (isNode(value)) {
        go(value, node, key);
      }
    }
  };
  go(root, null, "root");
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Node).type === "string" &&
    typeof (value as Node).start === "number"
  );
}

/**
 * Whether a function parameter list contains `name`.
 *
 * Not scope analysis — `$` handles shadowing correctly on its own. This exists only
 * so a parameter is not wrapped in its *declaration*, which the `NOT_A_READ` table
 * cannot express: oxc reaches params through `params`, and an `ArrayPattern` nested
 * inside one reaches its identifiers through `elements` on a node that is not the
 * function.
 */
function isParamPosition(v: Visit): boolean {
  return v.field === "params";
}

/**
 * Subtrees in which no identifier is a read, however deeply it is nested.
 *
 * The parent-field table cannot express these, because the disqualifying node is an
 * *ancestor* rather than the parent. `todos.value = […]` reaches `todos` through
 * `MemberExpression:object`, which looks exactly like the read in `[...todos.value]`
 * two characters later — the difference is that one of them is under an assignment's
 * left-hand side. Found by running the rewrite over `state.ts`, where it produced
 * `$m(todos, "value").value = […]`: an assignment to a property of the unwrapped
 * array, which parses, runs, and updates nothing.
 *
 * Recorded as byte ranges during the same pre-order walk. A parent is always visited
 * before its children, so a range is in place before anything inside it is judged.
 */
function frozenRangesOf(node: Node): [number, number][] {
  const out: [number, number][] = [];
  const add = (child: unknown) => {
    if (isNode(child)) out.push([child.start, child.end]);
  };

  switch (node.type) {
    // `x = 1`, `obj.x = 1`, `[a, b] = pair`
    case "AssignmentExpression":
      add(node.left);
      break;
    // `x++`
    case "UpdateExpression":
      add(node.argument);
      break;
    // `const { a, b } = obj` — every name bound, at any depth
    case "VariableDeclarator":
      add(node.id);
      break;
    // `catch (e)`
    case "CatchClause":
      add(node.param);
      break;
    // Parameters, including destructured and defaulted ones.
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      for (const p of (node.params as unknown[]) ?? []) add(p);
      break;
  }
  return out;
}

function isRead(v: Visit): boolean {
  if (v.parent === null) return false;
  if (isParamPosition(v)) return false;

  // A computed member — `obj[key]` — reads `key`, an ordinary one does not.
  if (v.parent.type === "MemberExpression" && v.field === "property") {
    return v.parent.computed === true;
  }
  // Likewise a computed key: `{ [k]: v }`.
  if (v.parent.type === "Property" && v.field === "key") {
    return v.parent.computed === true;
  }

  return !NOT_A_READ.has(`${v.parent.type}:${v.field}`);
}

/** TypeScript type positions, whose identifiers are erased and must not be touched. */
function isTypeNode(type: string): boolean {
  return type.startsWith("TS") || type === "TSTypeAnnotation";
}

export type TransformResult = { code: string; map: string } | null;

/**
 * The namespace the emitted helpers are reached through.
 *
 * A namespace rather than named imports, because the transform cannot know what the
 * module already declares. `import { computed }` would be a duplicate binding in
 * every file that imports `computed` itself — which is most of them — and `$` is a
 * plausible enough identifier that aliasing it is not paranoia.
 */
const NS = "__dzr";

export type TransformOptions = {
  /** Module specifier for `signal.ts`, as the transformed file must import it. */
  helpers: string;
};

/**
 * Rewrites one module. Returns null when nothing changed.
 *
 * `filename` is only used for diagnostics and to pick the parser's dialect.
 */
export function transformReactive(
  source: string,
  filename: string,
  options: TransformOptions,
): TransformResult {
  const parsed = parseSync(filename, source, {
    lang: filename.endsWith(".tsx") ? "tsx" : "ts",
  });

  if (parsed.errors.length > 0) {
    // Let the real toolchain report a syntax error against the original source; a
    // second opinion here would name the same problem in worse words.
    return null;
  }

  const out = new MagicString(source);
  let touched = false;

  const reads: Node[] = [];
  const members: Node[] = [];
  const wraps: Node[] = [];
  /** Shorthand `{ title }`, which has to become `{ title: $(title) }`. */
  const shorthand: Node[] = [];
  /** `router.path` — a member whose result is itself a signal. */
  const unwraps: Node[] = [];
  /** `const count = signal(0)` inside a component — needs a name the artifact can hold. */
  const componentLocals: { call: Node; name: string }[] = [];
  /** `onClick={() => …}` — an arrow with no export name. */
  const inlineHandlers: Node[] = [];
  /** Function bodies, so "declared inside a component" is decidable by containment. */
  const functions: [number, number][] = [];
  const frozen: [number, number][] = [];
  const seen = new Set<number>();

  const isFrozen = (node: Node): boolean =>
    frozen.some(([start, end]) => node.start >= start && node.end <= end);

  walk(parsed.program as unknown as Node, (v) => {
    const { node, parent, field } = v;

    // Types are erased, and a `$()` inside one does not even parse.
    if (isTypeNode(node.type)) return false;

    frozen.push(...frozenRangesOf(node));

    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      functions.push([node.start, node.end]);
    }

    // JSX: a brace either becomes a `computed` or is left completely alone.
    //
    // No middle ground, and that is the point. `{router.path}`, `{todos.map(…)}` and
    // `{router.matches("x")}` are already resolved by identity — rewriting reads
    // inside them would be *harmless* (`$` returns the same object) but it would be
    // noise in the emitted IR and in every diff. Skipping the subtree keeps the
    // guarantee legible: what the transform did not wrap, it did not touch.
    if (node.type === "JSXExpressionContainer") {
      const inner = node.expression as Node | undefined;
      if (!inner) return false;

      // `onClick={() => count.set(count + 1)}` — not wrapped, but walked into, which
      // is a third case the two-way split missed. A handler body is ordinary code and
      // its reads have to unwrap; skipping the subtree left `count + 1` adding to a
      // signal object. It also has no export name, so it is recorded for the emitter
      // the same way an inline expression is.
      if (inner.type === "ArrowFunctionExpression") {
        inlineHandlers.push(inner);
        return true;
      }

      if (!isWrappable(inner)) return false;
      wraps.push(inner);
      return true;
    }

    // JSX tag names are not value reads: `<Foo>` must stay `<Foo>`.
    if (node.type.startsWith("JSX") && node.type !== "JSXExpressionContainer") {
      if (node.type === "JSXIdentifier" || node.type === "JSXMemberExpression") return false;
      return true;
    }

    if (node.type !== "Identifier") return true;
    if (isFrozen(node)) return true;
    if (!isRead(v)) return true;

    // A shorthand property visits one node as both key and value, so without this
    // it would be rewritten twice.
    if (seen.has(node.start)) return true;
    seen.add(node.start);

    // `{ title }` is `{ title: title }`, and `{ $(title) }` is not valid shorthand —
    // the key has to be written out. Caught by `state.ts`, which builds a row that
    // way.
    if (parent?.type === "Property" && parent.shorthand === true) {
      shorthand.push(node);
      return true;
    }

    // `x.y` — the object is rewritten with `$m`, which decides whether `y` belongs
    // to the signal or to its value.
    if (parent?.type === "MemberExpression" && field === "object" && parent.computed !== true) {
      members.push(node);
      return true;
    }

    reads.push(node);
    return true;
  });

  /**
   * A member expression whose *result* is a signal — `router.path`.
   *
   * `$m` unwraps the object; nothing was unwrapping what came back. So
   * `` `at ${router.path}` `` produced `at [object Object]`: `router` is a plain
   * object, `$m` hands it straight back, `.path` is a signal, and a template literal
   * stringifies it. Rendered exactly that way in the routing golden.
   *
   * Excluded when the member is a call's callee, which is the whole distinction —
   * `count.set(5)` must stay `count.set(5)`, not `$(count.set)(5)`, and the same for
   * `todos.filter(…)`. Excluded again when it is itself the object of another
   * member, so `a.b.c` unwraps once at the end rather than at every step.
   */
  walk(parsed.program as unknown as Node, (v) => {
    const { node, parent, field } = v;
    if (isTypeNode(node.type)) return false;
    if (node.type !== "MemberExpression" || node.computed === true) return true;
    if (isFrozen(node)) return true;
    if (parent?.type === "CallExpression" && field === "callee") return true;
    if (parent?.type === "NewExpression" && field === "callee") return true;
    if (parent?.type === "MemberExpression" && field === "object") return true;
    // Only where the object itself was rewritten — otherwise this is an ordinary
    // property read on something that was never a signal.
    if (!members.some((m) => m.start === (node.object as Node | undefined)?.start)) return true;
    unwraps.push(node);
    return true;
  });

  /**
   * Component-local state, and the handlers that write it.
   *
   * A third pass, because both need `functions` complete: "inside a component" is
   * decided by containment, and a pre-order walk has not seen the enclosing function
   * when it reaches a node near the top of the file.
   */
  const insideFunction = (node: Node): boolean =>
    functions.some(([start, end]) => node.start > start && node.end <= end);

  walk(parsed.program as unknown as Node, (v) => {
    const { node, parent, field } = v;
    if (isTypeNode(node.type)) return false;

    // `const count = signal(0)` in a component body. Rewritten to `local(0, "count")`,
    // which registers it so the emitter can declare it in the artifact — see
    // `reactive-runtime.ts`. At module scope it is already nameable and left alone.
    if (
      node.type === "CallExpression" &&
      (node.callee as Node | undefined)?.type === "Identifier" &&
      ((node.callee as Node).name as string) === "signal" &&
      insideFunction(node) &&
      parent?.type === "VariableDeclarator" &&
      field === "init"
    ) {
      const id = parent.id as Node | undefined;
      if (id?.type === "Identifier") {
        componentLocals.push({ call: node, name: id.name as string });
        return true;
      }
    }

    return true;
  });

  /**
   * Every unwrap, as a plain insertion list.
   *
   * A list rather than direct `MagicString` calls because the same edits are needed
   * twice: once for the module, and once to render the *text* of each wrapped
   * expression, which `inline` carries into the artifact. That text has to be the
   * rewritten form — the artifact runs against real signals, so `count === 7` would
   * compare a signal object and be false, where `$(count) === 7` is correct.
   */
  const inserts: { at: number; text: string }[] = [];
  const insert = (at: number, text: string) => {
    inserts.push({ at, text });
    touched = true;
  };

  for (const node of reads) {
    insert(node.start, `${NS}.$(`);
    insert(node.end, ")");
  }

  // Before `members`, and that ordering is forced. A `MemberExpression` begins at the
  // same byte as the identifier it reads from — `t.done` starts where `t` does — and
  // insertions at one offset nest in the order they are made. Members first gave
  // `$m($(t, "done").done)`: the two wrappers interleaved instead of nesting.
  for (const node of unwraps) {
    insert(node.start, `${NS}.$(`);
    insert(node.end, ")");
  }

  for (const node of members) {
    // The property name is known statically here — `parent.computed` was false.
    const property = source.slice(node.end).match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
    if (!property) continue;
    insert(node.start, `${NS}.$m(`);
    insert(node.end, `, ${JSON.stringify(property[1])})`);
  }

  for (const node of shorthand) {
    insert(node.start, `${node.name as string}: ${NS}.$(`);
    insert(node.end, ")");
  }

  /** `source[from, to)` with the unwraps inside it applied. */
  const rendered = (from: number, to: number): string => {
    const inside = inserts.filter((i) => i.at >= from && i.at <= to).sort((a, b) => a.at - b.at);
    let out = "";
    let cursor = from;
    for (const { at, text } of inside) {
      out += source.slice(cursor, at) + text;
      cursor = at;
    }
    return out + source.slice(cursor, to);
  };

  // Wraps go in before the unwraps, and the order is load-bearing rather than
  // incidental. A wrapped expression and the first read inside it can begin at the
  // same offset — `{count === 7}` starts the `BinaryExpression` and the identifier
  // `count` at the same byte. `appendLeft` at one position emits in call order, so
  // unwraps-first produced `$(inline(() => count) === 7)`: the wrapper closing around
  // the identifier instead of the expression. Valid JavaScript, and wrong.
  //
  // `inline` rather than `computed`, because a cell born inside a component has no
  // export name and `resolve-refs` could not put it in the artifact. The second
  // argument is how it gets there.
  for (const node of wraps) {
    out.appendLeft(node.start, `${NS}.inline(() => `);
    out.appendRight(node.end, `, ${JSON.stringify(rendered(node.start, node.end))})`);
    touched = true;
  }

  // `signal(0)` -> `local(0, "count")`. Only the callee is replaced, so the arguments
  // keep whatever they were and are evaluated in their own scope.
  for (const { call, name } of componentLocals) {
    const callee = call.callee as Node;
    out.overwrite(callee.start, callee.end, `${NS}.local`);
    out.appendLeft(call.end - 1, `, ${JSON.stringify(name)}`);
    touched = true;
  }

  // `() => …` -> `handler(() => …, "…")`, carrying its source so the artifact can
  // contain the function rather than a name for it.
  for (const node of inlineHandlers) {
    out.appendLeft(node.start, `${NS}.handler(`);
    out.appendRight(node.end, `, ${JSON.stringify(rendered(node.start, node.end))})`);
    touched = true;
  }

  for (const { at, text } of inserts) {
    // `appendLeft` at the start and `appendRight` at the end, so an insertion never
    // lands inside a wrapper that opened at the same offset.
    out.appendLeft(at, text);
  }

  if (!touched) return null;

  // Appended, not prepended, and that is the whole reason line numbers survive.
  //
  // ES imports are hoisted, so this binds before any of the code above runs. Putting
  // it at the top would shift every line by one — breaking stack traces, the `golden`
  // diff, and any `@jsxImportSource` pragma that has to lead the file.
  out.append(`\nimport * as ${NS} from ${JSON.stringify(options.helpers)};\n`);

  return { code: out.toString(), map: out.generateMap({ hires: true }).toString() };
}
