/**
 * `useRoute` — the typing, and the check that pays for the repetition.
 *
 * The path string is written twice: once as a filename, once in the call. That is
 * only acceptable because nothing can silently disagree — the type comes from the
 * string, and the compiler compares the string with the file. Both halves are
 * tested here, along with the parameter recorders, which fail the same way list
 * items do: an un-internable sentinel and a named error, never a plausible string
 * frozen into the page.
 */
import { expect, test } from "bun:test";
import { RouteHookError, useRoute, withPage, type Args } from "./route.ts";
import {
  isParamSentinel,
  isRouteParam,
  paramNameOf,
  ParamExpressionError,
  UnknownParamError,
} from "./route-args.ts";

const PRODUCT = { path: "products/$id", file: "windows/main/pages/products/$id.tsx" };

// ---------------------------------------------------------------------------
// Types — checked by `bun run check`, not at run time
// ---------------------------------------------------------------------------

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type _OneParam = Expect<Equal<Args<"products/$id">, { id: string }>>;
type _TwoParams = Expect<Equal<Args<"$org/repos/$name">, { org: string; name: string }>>;
type _ParamThenStatic = Expect<Equal<Args<"products/$id/edit">, { id: string }>>;
type _NoParams = Expect<Equal<Args<"about">, {}>>;
type _Index = Expect<Equal<Args<"/">, {}>>;

test("args is typed from the string, and only the string's parameters exist", () => {
  withPage(PRODUCT, () => {
    const { args } = useRoute("products/$id");
    expect(isRouteParam(args.id)).toBe(true);

    // @ts-expect-error — "products/$id" has no $slug, so neither does args.
    expect(() => args.slug).toThrow(UnknownParamError);
  });
});

test("a page with no parameters has an empty args", () => {
  withPage({ path: "about", file: "windows/main/pages/about.tsx" }, () => {
    const { args, path } = useRoute("about");
    expect(path).toBe("about");
    expect(Object.keys(args)).toEqual([]);
  });
});

/**
 * The href union's accepted limit, written down as a test rather than as prose.
 *
 * `${string}` spans slashes, so the type admits a path with too many segments.
 * TypeScript catches typos in the static parts; the compiler catches shape.
 */
test("the generated href type accepts interpolation and rejects typos", () => {
  type Href = "/" | "about" | "products" | "products/new" | `products/${string}`;

  const accepts = (href: Href): Href => href;

  const id = "1";
  const ok: Href[] = ["/", "about", "products/new", `products/${id}`, "products/1"];
  expect(ok).toHaveLength(5);

  // @ts-expect-error — a typo in a static segment is not in the union.
  expect(accepts("prodcuts/1")).toBe("prodcuts/1");

  // Accepted by the type, rejected by the compiler: `string` spans slashes.
  expect(accepts("products/a/b/c")).toBe("products/a/b/c");
});

// ---------------------------------------------------------------------------
// The string has to match the file
// ---------------------------------------------------------------------------

test("a string that disagrees with the file is an error naming both", () => {
  const run = () => withPage(PRODUCT, () => useRoute("products/$productId"));

  expect(run).toThrow(RouteHookError);
  expect(run).toThrow(/products\/\$id/);
  expect(run).toThrow(/windows\/main\/pages\/products\/\$id\.tsx/);
});

test("a rename the string did not follow fails rather than drifting", () => {
  // The file moved from products/$id.tsx to items/$id.tsx; the call did not.
  const moved = { path: "items/$id", file: "windows/main/pages/items/$id.tsx" };
  expect(() => withPage(moved, () => useRoute("products/$id"))).toThrow(
    /whose route is "items\/\$id"/,
  );
});

test("useRoute with no page being compiled says so, rather than guessing", () => {
  const run = () => useRoute("products/$id");
  expect(run).toThrow(RouteHookError);
  expect(run).toThrow(/no page was being compiled/);
  expect(run).toThrow(/module scope/);
});

test("withPage refuses an async callback instead of scoping nothing", () => {
  // The scope closes when the callback returns, and an async one returns at its
  // first await — so the component would expand outside it and `useRoute` would
  // report no page at all, three frames from the cause. Found exactly that way.
  const run = () => withPage(PRODUCT, async () => useRoute("products/$id"));
  expect(run).toThrow(RouteHookError);
  expect(run).toThrow(/async callback/);
  expect(run).toThrow(/Import the module first/);
});

test("page scope nests and unwinds, including through a throw", () => {
  withPage(PRODUCT, () => {
    expect(useRoute("products/$id").path).toBe("products/$id");

    const inner = { path: "about", file: "windows/main/pages/about.tsx" };
    expect(() => withPage(inner, () => useRoute("products/$id"))).toThrow(RouteHookError);

    // The inner scope's failure did not leave the cursor pointing at `about`.
    expect(useRoute("products/$id").path).toBe("products/$id");
  });

  expect(() => useRoute("about")).toThrow(/no page was being compiled/);
});

// ---------------------------------------------------------------------------
// Parameters are recorded, never evaluated
// ---------------------------------------------------------------------------

test("a bare read records the parameter name", () => {
  withPage(PRODUCT, () => {
    const { args } = useRoute("products/$id");
    expect(paramNameOf(args.id)).toBe("id");
  });
});

test("computing with a parameter produces an un-internable sentinel", () => {
  withPage(PRODUCT, () => {
    const { args } = useRoute("products/$id");

    expect(isParamSentinel(`${args.id}`)).toBe(true);
    expect(isParamSentinel("#" + args.id)).toBe(true);
    expect(isParamSentinel(String(args.id))).toBe(true);

    // And it is not a string anyone could have typed.
    expect(`${args.id}`).not.toBe("id");
    expect(isParamSentinel("id")).toBe(false);
    expect(isParamSentinel("products/$id")).toBe(false);
  });
});

test("a method call on a parameter errors at the call site, not later", () => {
  withPage(PRODUCT, () => {
    const { args } = useRoute("products/$id");
    // `args.id.toUpperCase` is already wrong: there is nothing to read a property
    // off of yet, so failing here beats interning whatever it returned.
    expect(() => (args.id as string).toUpperCase()).toThrow(ParamExpressionError);
    expect(() => ({ ...(args.id as unknown as object) })).toThrow(ParamExpressionError);
  });
});

test("the expression error says where the value should come from instead", () => {
  withPage(PRODUCT, () => {
    const { args } = useRoute("products/$id");
    const error = new ParamExpressionError(`${args.id}`);

    expect(error.message).toContain("args.id");
    expect(error.message).toContain("computed()");
  });
});

test("a parameter survives the brand checks the compiler runs on children", () => {
  withPage(PRODUCT, () => {
    const { args } = useRoute("products/$id");
    const value = args.id as unknown;

    // `isSignal` uses `in`, and the item recorder reads its own symbol off
    // whatever it is handed. Either throwing here would make a parameter unable
    // to travel through the code that has to tell it apart from them.
    expect(Symbol.for("skia-proto.signal") in (value as object)).toBe(false);
    expect(() => (value as Record<symbol, unknown>)[Symbol.for("skia-proto.itemPath")]).not.toThrow();
    expect(Array.isArray(value)).toBe(false);
  });
});
