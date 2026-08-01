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
import {
  RouteHookError,
  useRoute,
  useRouter,
  withPage,
  withWindowRoute,
  routeMatchOf,
  routePathBehind,
  hasRouteSentinel,
  splitRouteSentinel,
  RouteValueLeakError,
  type Args,
} from "./route.ts";
import { isSignal, signal } from "../runtime/signal.ts";
import { jsx } from "./jsx-runtime.ts";
import type { DynText, Element } from "./html.ts";
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

// ---------------------------------------------------------------------------
// useRouter
// ---------------------------------------------------------------------------

test("useRouter hands back the window's own route signal, by identity", () => {
  const route = signal("/");

  withWindowRoute(route, () => {
    // Wrapped, so that `.value` yields a marker rather than the initial route — but
    // the wrapper has to lead back to the exported signal, or `resolve-refs` could
    // not resolve it to the export name the artifact imports.
    expect(routePathBehind(useRouter().path)).toBe(route);
  });
});

test("useRouter outside a window says the window has to declare its route", () => {
  const run = () => useRouter();
  expect(run).toThrow(RouteHookError);
  expect(run).toThrow(/needs the window to declare its route/);
  expect(run).toThrow(/<Window route=/);
});

test("matches() is a live cell, not a comparison the compiler evaluated away", () => {
  const route = signal("/");

  withWindowRoute(route, () => {
    const router = useRouter();
    const onLayout = router.matches("layout");

    // The trap this exists to remove: `router.path === "layout"` is a signal
    // compared to a string, which is `false` at build time and stays false. The
    // cell tracks instead.
    expect(onLayout.value).toBe(false);
    route.value = "layout";
    expect(onLayout.value).toBe(true);
  });
});

test("router.path.value yields a marker, not the route it happened to start on", () => {
  const route = signal("/");

  withWindowRoute(route, () => {
    const router = useRouter();

    // The read is right and only early: there is no route while compiling. So it
    // gives back something the compiler can replace rather than the initial value,
    // which would freeze `/` into the page and compile clean.
    // Opaque to `tsc` on purpose — `RoutePath` is not a `string`, so it cannot be
    // compared to one. It *is* one at run time, which is what this asserts.
    const read = router.path.value as unknown as string;
    expect(hasRouteSentinel(read)).toBe(true);
    expect(read).not.toBe("/");

    // And nothing an author could type is mistaken for one.
    expect(hasRouteSentinel("/")).toBe(false);
    expect(hasRouteSentinel("products/$id")).toBe(false);

    // The comparison the marker cannot save, refused by `bun run check` instead.
    // `===` calls no user code, so there is no build-time hook to rewrite it — the
    // only defence is a type with no overlap. A *branded* string does not give one:
    // TS treats `string & {…}` as comparable to a string literal, so the first
    // version of this passed and the nav stayed dark. `RoutePath` is opaque.
    // @ts-expect-error — RoutePath and "layout" have no overlap.
    expect(router.path.value === "layout").toBe(false);
    // @ts-expect-error — and neither do the signal and a string.
    expect(router.path === "layout").toBe(false);
  });
});

test("interpolation around the read survives, so a template literal compiles", () => {
  const route = signal("/");

  withWindowRoute(route, () => {
    const router = useRouter();

    // `` `at ${router.path.value}` `` has to reach the compiler as a literal and a
    // binding — the shape a dynamic text run already has — or the surrounding text
    // would be lost and only the route would render.
    expect(splitRouteSentinel(`at ${router.path.value}`)).toEqual([
      { literal: "at " },
      { route: true },
    ]);

    expect(splitRouteSentinel(`${router.path.value} — dziri`)).toEqual([
      { route: true },
      { literal: " — dziri" },
    ]);

    // A bare read is one part, with no empty literals on either side.
    expect(splitRouteSentinel(`${router.path.value}`)).toEqual([{ route: true }]);
  });
});

test("a rendered .value compiles to a binding on the window's route signal", () => {
  const route = signal("/");

  withWindowRoute(route, () => {
    const router = useRouter();
    // What the author wrote: `<div>at {router.path.value}</div>`.
    const node = jsx("div", { children: ["at ", router.path.value] }) as Element;

    // Not text. If this were `{ type: "text" }` the page would render whatever the
    // route was initialised with, for ever, and the build would say nothing — the
    // failure this whole mechanism exists to make impossible.
    const [child] = node.children;
    expect(child?.type).toBe("dyntext");
    expect((child as DynText).parts).toEqual([{ literal: "at " }, { source: route }]);
  });
});

test("a .value the compiler cannot bind is named, not silently dropped", () => {
  const route = signal("/");

  withWindowRoute(route, () => {
    const { path } = useRouter();

    // Rendered text is the only placement with somewhere to put a subscription.
    // The others each fail *quietly* if left alone: a class nothing matches, an id
    // nothing selects, an inline style resolved once. That is the shape of failure
    // the marker exists to prevent, so every one of them is a named error.
    const div = (props: object) => () => jsx("div", { ...props, children: "x" });

    expect(div({ className: path.value })).toThrow(RouteValueLeakError);
    expect(div({ className: `tab-${path.value}` })).toThrow(RouteValueLeakError);
    expect(div({ id: path.value })).toThrow(RouteValueLeakError);
    expect(div({ style: { color: path.value } })).toThrow(RouteValueLeakError);

    // And the message shows the read in place, so the line is findable.
    expect(div({ id: path.value })).toThrow(/\$\{router\.path\.value\}/);
    expect(div({ id: path.value })).toThrow(/router\.matches\("products"\)/);
  });
});

test("the binding is the signal itself, so resolve-refs can name it", () => {
  const route = signal("/");

  withWindowRoute(route, () => {
    const node = jsx("div", { children: useRouter().path.value }) as Element;
    const parts = (node.children[0] as DynText).parts;

    // By identity, and the *unwrapped* signal: the artifact imports the export the
    // window declared, and the guard proxy is not that object.
    expect((parts[0] as { source: unknown }).source).toBe(route);
  });
});

test("the guarded path is still the signal everything downstream needs", () => {
  const route = signal("/");

  withWindowRoute(route, () => {
    const { path } = useRouter();

    // It has to pass `isSignal`, or `{router.path}` would not be recognised as a
    // binding and would render as an object.
    expect(isSignal(path)).toBe(true);
    // And it has to lead back to the exported signal, or `resolve-refs` could not
    // find the name the artifact imports.
    expect(routePathBehind(path)).toBe(route);
  });
});

test("matches() is prefix-aware, because a nav entry names a section", () => {
  const route = signal("products/new");

  withWindowRoute(route, () => {
    const router = useRouter();
    expect(router.matches("products").value).toBe(true);
    expect(router.matches("products/new").value).toBe(true);
    expect(router.matches("products/$id").value).toBe(false);

    // A prefix of the *string* is not a prefix of the path: `product` must not
    // match `products/new`, or every nav entry would light up its neighbours.
    expect(router.matches("product").value).toBe(false);
  });
});

test("matches(\"/\") is exact, or the index would match everything", () => {
  const route = signal("layout");

  withWindowRoute(route, () => {
    expect(useRouter().matches("/").value).toBe(false);
    route.value = "/";
    expect(useRouter().matches("/").value).toBe(true);
  });
});

test("a matches() cell remembers what it asked, so the emitter can rebuild it", () => {
  const route = signal("/");

  withWindowRoute(route, () => {
    const cell = useRouter().matches("layout");
    const match = routeMatchOf(cell);

    // It has no export name — it was created inside a component — so the artifact
    // contains the comparison instead. That needs the signal *by identity* and the
    // path as written.
    expect(match).toBeDefined();
    expect(match!.signal).toBe(route);
    expect(match!.path).toBe("layout");
  });

  // An ordinary signal is not one of these.
  expect(routeMatchOf(signal("x"))).toBeUndefined();
});

test("the window scope and the page scope are independent", () => {
  const route = signal("/");

  // A page can read the route without being a parameter route, and a parameter
  // route can read both. They are set by different things for different spans:
  // the route is the window's, the page cursor moves per file.
  withWindowRoute(route, () => {
    expect(routePathBehind(useRouter().path)).toBe(route);
    withPage(PRODUCT, () => {
      expect(useRoute("products/$id").path).toBe("products/$id");
      expect(routePathBehind(useRouter().path)).toBe(route);
    });
  });

  // And each unwinds on its own.
  expect(() => useRouter()).toThrow(RouteHookError);
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
