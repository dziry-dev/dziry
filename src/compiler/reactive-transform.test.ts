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

const run = (source: string): string => transformReactive(source, "t.tsx")?.code ?? source;

// ---------------------------------------------------------------------------
// Reads are rewritten
// ---------------------------------------------------------------------------

test("a bare read in a computed body is unwrapped", () => {
  expect(run("computed(() => count * 2)")).toBe("computed(() => $(count) * 2)");
});

test("every operator that a bare signal used to break is covered", () => {
  expect(run("computed(() => count === 7)")).toBe("computed(() => $(count) === 7)");
  expect(run("computed(() => count ? a : b)")).toBe("computed(() => $(count) ? $(a) : $(b))");
  expect(run("computed(() => !count)")).toBe("computed(() => !$(count))");
  expect(run("computed(() => `n is ${count}`)")).toBe("computed(() => `n is ${$(count)}`)");
});

test("a member read unwraps the object, not the property", () => {
  // `$(user).name`, never `$(user).$(name)` — `name` is not a binding.
  expect(run("computed(() => user.name)")).toBe('computed(() => $m(user, "name").name)');
});

test("a computed member reads both sides", () => {
  expect(run("computed(() => obj[key])")).toBe("computed(() => $(obj)[$(key)])");
});

test("handlers are rewritten too, so a read works anywhere", () => {
  expect(run("const inc = () => count.set(count + 1)")).toBe(
    'const inc = () => $m(count, "set").set($(count) + 1)',
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
    'computed(() => $m(todos, "filter").filter((t) => $m(t, "done").done))',
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
  expect(run("computed(() => fn(count))")).toBe("computed(() => fn($(count)))");
});

test("imports and exports are not reads", () => {
  const source = 'import { count } from "./state.ts";\nexport { count };';
  expect(run(source)).toBe(source);
});

test("object keys are not reads, but computed keys are", () => {
  expect(run("computed(() => ({ count: count }))")).toBe("computed(() => ({ count: $(count) }))");
  expect(run("computed(() => ({ [k]: 1 }))")).toBe("computed(() => ({ [$(k)]: 1 }))");
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

test("an expression in a brace becomes a computed", () => {
  expect(run("const el = <div>{count * 2}</div>")).toBe(
    "const el = <div>{computed(() => $(count) * 2)}</div>",
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
  const source = "const el = <div>{cond && <span />}</div>";
  expect(run(source)).toBe(source);
});

test("a wrapped brace still has its reads rewritten inside", () => {
  expect(run('const el = <div>{count === 7 ? "a" : "b"}</div>')).toBe(
    'const el = <div>{computed(() => $(count) === 7 ? "a" : "b")}</div>',
  );
});

// ---------------------------------------------------------------------------
// Mechanics
// ---------------------------------------------------------------------------

test("a module with nothing to rewrite is returned unchanged", () => {
  expect(transformReactive('const a = 1;\nexport { a };', "t.ts")).toBeNull();
});

test("a syntax error defers to the real toolchain rather than guessing", () => {
  expect(transformReactive("const = = =", "t.ts")).toBeNull();
});

test("line numbers survive, so a stack trace still points at the author's line", () => {
  const source = "const a = 1;\nconst b = 2;\ncomputed(() => count * 2);\nconst c = 3;";
  const out = run(source).split("\n");
  expect(out[2]).toBe("computed(() => $(count) * 2);");
  expect(out).toHaveLength(4);
});

test("a source map is produced", () => {
  const result = transformReactive("computed(() => count * 2)", "t.ts");
  expect(JSON.parse(result!.map).mappings.length).toBeGreaterThan(0);
});
