/**
 * The reactive rewrite, and the positions it must not touch.
 *
 * Two halves, and the second is the one that earns its keep. Rewriting a read is
 * easy to get right and easy to check. Rewriting something that is *not* a read is
 * how a transform breaks a codebase — `$(x) = 1` does not parse, `import { $(x) }`
 * does not parse, and a wrapped type annotation does not compile. Every such
 * position gets a test naming why it is excluded.
 *
 * The bias is deliberate: an unlisted position is treated as a read. A missed read
 * renders a frozen value and says nothing; a wrongly-rewritten non-read is a syntax
 * error the build cannot miss. The doubt goes on the side that crashes.
 */
import { expect, test } from "bun:test";
import { transformReactive } from "./reactive-transform.ts";

const HELPERS = "../runtime/signal.ts";
const IMPORT = `\nimport * as __dzr from "${HELPERS}";\n`;

/** The rewritten body, with the appended helper import stripped for legibility. */
const run = (source: string): string => {
  const out = transformReactive(source, "t.tsx", { helpers: HELPERS })?.code ?? source;
  return out.endsWith(IMPORT) ? out.slice(0, -IMPORT.length) : out;
};

// ---------------------------------------------------------------------------
// Reads are rewritten
// ---------------------------------------------------------------------------

test("a bare read in a computed body is unwrapped", () => {
  expect(run("computed(() => count * 2)")).toBe("computed(() => __dzr.$(count) * 2)");
});

test("every operator that a bare signal used to break is covered", () => {
  expect(run("computed(() => count === 7)")).toBe("computed(() => __dzr.$(count) === 7)");
  expect(run("computed(() => count ? a : b)")).toBe(
    "computed(() => __dzr.$(count) ? __dzr.$(a) : __dzr.$(b))",
  );
  expect(run("computed(() => !count)")).toBe("computed(() => !__dzr.$(count))");
  expect(run("computed(() => `n is ${count}`)")).toBe("computed(() => `n is ${__dzr.$(count)}`)");
});

test("a member read unwraps the object, not the property", () => {
  // `$(user).name`, never `$(user).$(name)` — `name` is not a binding.
  expect(run("computed(() => user.name)")).toBe('computed(() => __dzr.$m(user, "name").name)');
});

test("a computed member reads both sides", () => {
  expect(run("computed(() => obj[key])")).toBe("computed(() => __dzr.$(obj)[__dzr.$(key)])");
});

test("handlers are rewritten too, so a read works anywhere", () => {
  expect(run("const inc = () => count.set(count + 1)")).toBe(
    'const inc = () => __dzr.$m(count, "set").set(__dzr.$(count) + 1)',
  );
});

/**
 * Shadowing needs no scope analysis, which is the reason the transform is small.
 *
 * `t` is rewritten exactly like `todos` is. At run time `$(t)` sees a plain row and
 * returns it, so the parameter wins because the parameter is what is in scope. A
 * transform that tried to be clever here would need symbol resolution and would get
 * this same answer.
 */
test("a shadowing parameter is rewritten and resolves to itself", () => {
  expect(run("computed(() => todos.filter((t) => t.done))")).toBe(
    'computed(() => __dzr.$m(todos, "filter").filter((t) => __dzr.$m(t, "done").done))',
  );
});

// ---------------------------------------------------------------------------
// Non-reads are not
// ---------------------------------------------------------------------------

test("a declaration is not a read", () => {
  expect(run("const count = signal(0)")).toBe("const count = signal(0)");
});

test("an assignment target is not a read — `$(x) = 1` does not parse", () => {
  expect(run("function f() { x = 1; x += 2; x++; }")).toBe("function f() { x = 1; x += 2; x++; }");
});

test("a call callee is left alone, so module scope stays readable", () => {
  expect(run("const c = signal(0)")).toBe("const c = signal(0)");
  expect(run("computed(() => fn(count))")).toBe("computed(() => fn(__dzr.$(count)))");
});

test("imports and exports are not reads", () => {
  const source = 'import { count } from "./state.ts";\nexport { count };';
  expect(run(source)).toBe(source);
});

test("object keys are not reads, but computed keys are", () => {
  expect(run("computed(() => ({ count: count }))")).toBe(
    "computed(() => ({ count: __dzr.$(count) }))",
  );
  expect(run("computed(() => ({ [k]: 1 }))")).toBe("computed(() => ({ [__dzr.$(k)]: 1 }))");
});

test("parameters are not reads in their own declaration", () => {
  expect(run("const f = (count) => 1")).toBe("const f = (count) => 1");
  expect(run("function g(a, b) { return 1 }")).toBe("function g(a, b) { return 1 }");
});

test("type positions are erased and must not be touched", () => {
  const source = "const x: Todo[] = [];\nfunction f(a: Signal<number>): Todo { return a as Todo }";
  expect(run(source)).not.toContain("$(Todo)");
  expect(run(source)).not.toContain("$(Signal)");
});

test("a JSX tag name is not a read", () => {
  expect(run("const el = <Foo bar={1} />")).not.toContain("$(Foo)");
});

// ---------------------------------------------------------------------------
// JSX braces
// ---------------------------------------------------------------------------

/**
 * The second argument is what lets the cell reach the artifact.
 *
 * A `computed` created inside a component has no export name, so `resolve-refs`
 * cannot name it — it puts the *expression* in `ui.gen.ts` instead. The text is the
 * rewritten form rather than what the author typed, because the artifact runs
 * against real signals: `count === 7` would compare a signal object and be false,
 * where `$(count) === 7` is right.
 */
test("an expression in a brace becomes an inline cell carrying its own source", () => {
  expect(run("const el = <div>{count * 2}</div>")).toBe(
    'const el = <div>{__dzr.inline(() => __dzr.$(count) * 2, "__dzr.$(count) * 2")}</div>',
  );
});

/**
 * The forms that already compile correctly are left exactly as they are.
 *
 * `{count}` is a binding by identity, `{todos.map(…)}` is a list, and
 * `{router.matches(…)}` is a cell. Wrapping any of them would change working IR for
 * no gain — and `golden` would notice.
 */
test("a lone identifier keeps its identity", () => {
  expect(run("const el = <div>{count}</div>")).toBe("const el = <div>{count}</div>");
});

test("a call in a brace is untouched, so lists and cells still compile", () => {
  const list = "const el = <div>{todos.map(row, { key: k })}</div>";
  expect(run(list)).toBe(list);
  const cell = 'const el = <div>{router.matches("x")}</div>';
  expect(run(cell)).toBe(cell);
});

test("a member expression in a brace keeps its identity", () => {
  expect(run("const el = <div>{router.path}</div>")).toBe("const el = <div>{router.path}</div>");
});

/**
 * Conditional rendering is excluded, and this is a decision rather than a gap.
 *
 * `{cond && <div/>}` is resolved at build time by dropping the child. Wrapping it
 * would hand the runtime a `computed` where the compiler expects a node. Making it
 * reactive is a separate feature that needs its own IR.
 */
test("conditional rendering is not wrapped", () => {
  const and = "const el = <div>{cond && <span />}</div>";
  expect(run(and)).toBe(and);

  // Shape says wrappable, meaning says otherwise — a ternary over JSX branches.
  const ternary = "const el = <div>{cond ? <A /> : <B />}</div>";
  expect(run(ternary)).toBe(ternary);
});

test("a wrapped brace still has its reads rewritten inside", () => {
  const out = run('const el = <div>{count === 7 ? "a" : "b"}</div>');
  expect(out).toContain('__dzr.inline(() => __dzr.$(count) === 7 ? "a" : "b",');
  // And the carried text matches the body it was built from, unwraps included.
  expect(out).toContain(JSON.stringify('__dzr.$(count) === 7 ? "a" : "b"'));
});

// ---------------------------------------------------------------------------
// Mechanics
// ---------------------------------------------------------------------------

test("the helper import is appended, so no line number moves", () => {
  const source = "const a = 1;\nconst b = 2;\ncomputed(() => count * 2);\nconst c = 3;";
  const out = transformReactive(source, "t.ts", { helpers: HELPERS })!.code;
  const lines = out.split("\n");

  // The rewritten line is still line 3, and the import is past the end.
  expect(lines[2]).toBe("computed(() => __dzr.$(count) * 2);");
  expect(lines[3]).toBe("const c = 3;");
  expect(out).toContain(`import * as __dzr from "${HELPERS}";`);
});

test("a module with nothing to rewrite gets no import", () => {
  expect(transformReactive("const a = 1;\nexport { a };", "t.ts", { helpers: HELPERS })).toBeNull();
});

test("a syntax error defers to the real toolchain rather than guessing", () => {
  expect(transformReactive("const = = =", "t.ts", { helpers: HELPERS })).toBeNull();
});

test("a source map is produced", () => {
  const result = transformReactive("computed(() => count * 2)", "t.ts", { helpers: HELPERS });
  expect(JSON.parse(result!.map).mappings.length).toBeGreaterThan(0);
});
