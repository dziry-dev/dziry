/**
 * The recording proxy's failure modes.
 *
 * These are regression tests for the defect the architecture review rated as the
 * single worst in the compiler: an item expression that is not a bare property
 * read used to stringify into `"[item.title]"`, intern as an ordinary literal,
 * and render frozen into every row — while the build printed a success line.
 *
 * Valid-looking source, wrong artifact, no diagnostic. The tests below are what
 * stops that coming back.
 */
import { expect, test } from "bun:test";
import {
  isItemSentinel,
  ItemExpressionError,
  ItemSpreadError,
  isRecorder,
  pathOf,
  readPath,
  recorder,
} from "./item-path.ts";

test("a bare property read records a path", () => {
  const t = recorder() as Record<string, { title: unknown }>;
  expect(isRecorder(t.title)).toBe(true);
  expect(pathOf(t.title)).toEqual(["title"]);
  expect(pathOf((t as never as Record<string, Record<string, unknown>>).a!.b!)).toEqual(["a", "b"]);
});

test("numeric keys record as numbers, so readPath indexes arrays", () => {
  const t = recorder() as unknown as Record<string, unknown[]>;
  expect(pathOf(t.tags![0])).toEqual(["tags", 0]);
  expect(readPath({ tags: ["x", "y"] }, ["tags", 0])).toBe("x");
});

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------

test("a template literal produces an un-internable sentinel, not a plausible string", () => {
  const t = recorder() as unknown as { title: string };
  const interpolated = `${t.title}`;

  // The old behaviour was `"[item.title]"` — a perfectly ordinary string that
  // interned, rendered, and told nobody.
  expect(interpolated).not.toBe("[item.title]");
  expect(isItemSentinel(interpolated)).toBe(true);
});

test("concatenation, ternaries and coercion all trip the same guard", () => {
  const t = recorder() as unknown as { first: string; last: string; done: unknown };

  expect(isItemSentinel("Hello " + t.first)).toBe(true);
  expect(isItemSentinel(String(t.last))).toBe(true);
  expect(isItemSentinel(`${t.first} ${t.last}`)).toBe(true);

  // A ternary is the one shape the proxy genuinely cannot see: the branch is
  // taken at build time and the recorder is always truthy. It records nothing at
  // all, which is why `walkList` also errors when a template yields no bindings.
  const branch = t.done ? "x" : "";
  expect(branch).toBe("x");
});

test("the sentinel names the path that produced it", () => {
  const t = recorder() as unknown as { user: { name: string } };
  const error = new ItemExpressionError(`${t.user.name}`);

  expect(error).toBeInstanceOf(ItemExpressionError);
  expect(error.message).toContain("item.user.name");
  // The message has to say what to do instead, not just what went wrong.
  expect(error.message).toContain("computed()");
});

test("authored text is never mistaken for a sentinel", () => {
  for (const authored of ["[item.title]", "Compile the cascade", "", "a b c", "{t.title}"]) {
    expect(isItemSentinel(authored)).toBe(false);
  }
});

test("spreading an item is still a distinct, earlier error", () => {
  const t = recorder();
  // `ownKeys` throws, so the spread never silently yields empty props.
  expect(() => ({ ...t })).toThrow(ItemSpreadError);
});
