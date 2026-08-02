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
 * Rewrites one module. Returns null when nothing changed.
 *
 * `filename` is only used for diagnostics and to pick the parser's dialect.
 */
export function transformReactive(source: string, filename: string): TransformResult {
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

  walk(parsed.program as unknown as Node, (v) => {
    const { node, parent, field } = v;

    // Types are erased, and a `$()` inside one does not even parse.
    if (isTypeNode(node.type)) return false;

    // JSX: a brace either becomes a `computed` or is left completely alone.
    //
    // No middle ground, and that is the point. `{router.path}`, `{todos.map(…)}` and
    // `{router.matches("x")}` are already resolved by identity — rewriting reads
    // inside them would be *harmless* (`$` returns the same object) but it would be
    // noise in the emitted IR and in every diff. Skipping the subtree keeps the
    // guarantee legible: what the transform did not wrap, it did not touch.
    if (node.type === "JSXExpressionContainer") {
      const inner = node.expression as Node | undefined;
      if (!inner || !isWrappable(inner)) return false;
      wraps.push(inner);
      return true;
    }

    // JSX tag names are not value reads: `<Foo>` must stay `<Foo>`.
    if (node.type.startsWith("JSX") && node.type !== "JSXExpressionContainer") {
      if (node.type === "JSXIdentifier" || node.type === "JSXMemberExpression") return false;
      return true;
    }

    if (node.type !== "Identifier") return true;
    if (!isRead(v)) return true;

    // `x.y` — the object is rewritten with `$m`, which decides whether `y` belongs
    // to the signal or to its value.
    if (parent?.type === "MemberExpression" && field === "object" && parent.computed !== true) {
      members.push(node);
      return true;
    }

    reads.push(node);
    return true;
  });

  // Wraps go in first, and the order is load-bearing rather than incidental.
  //
  // A wrapped expression and the first read inside it can begin at the same offset —
  // `{count === 7}` starts the `BinaryExpression` and the identifier `count` at the
  // same byte. `appendLeft` at one position emits in call order, so reads-first
  // produced `$(computed(() => count) === 7)`: the wrapper closing around the
  // identifier instead of the expression. Silently valid JavaScript, and wrong.
  for (const node of wraps) {
    out.appendLeft(node.start, "computed(() => ");
    out.appendRight(node.end, ")");
    touched = true;
  }

  for (const node of reads) {
    out.appendLeft(node.start, "$(");
    out.appendRight(node.end, ")");
    touched = true;
  }

  for (const node of members) {
    // The property name is known statically here — `parent.computed` was false.
    const property = source.slice(node.end).match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
    if (!property) continue;
    out.appendLeft(node.start, "$m(");
    out.appendRight(node.end, `, ${JSON.stringify(property[1])})`);
    touched = true;
  }

  if (!touched) return null;

  return { code: out.toString(), map: out.generateMap({ hires: true }).toString() };
}
