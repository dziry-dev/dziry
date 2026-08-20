/**
 * The route data/error recording proxies.
 *
 * The compiler calls a route's component against these once, and everything the
 * component *reads* has to become a path, while everything it accidentally does
 * with the proxy as a value (stringify it, spread it, probe it with a foreign
 * brand) has to fail loudly or answer "not mine". A leak in any of those three
 * directions is a frozen constant or a blank row that nothing reports.
 */
import { expect, test } from "bun:test";
import {
  RouteDataSpreadError,
  dataRecorder,
  errorRecorder,
  isRouteData,
  isRouteError,
  routeDataPath,
  routeErrorPath,
} from "./route-data.ts";

test("property reads record the path", () => {
  const data = dataRecorder();
  const leaf = (data as Record<string, unknown>).user as Record<string, unknown>;
  const name = leaf.name;
  expect(isRouteData(name)).toBe(true);
  expect(routeDataPath(name)).toEqual(["user", "name"]);
});

test("numeric-looking keys record as numbers, so arrays read back by index", () => {
  const data = dataRecorder() as Record<string, unknown>;
  const first = (data.rows as Record<string, unknown>)[0];
  expect(routeDataPath(first)).toEqual(["rows", 0]);
});

test("data and error record into separate brands without interference", () => {
  const d = (dataRecorder() as Record<string, unknown>).title;
  const e = (errorRecorder() as Record<string, unknown>).message;
  expect(isRouteData(d)).toBe(true);
  expect(isRouteError(d)).toBe(false);
  expect(isRouteError(e)).toBe(true);
  expect(isRouteData(e)).toBe(false);
  expect(routeErrorPath(e)).toEqual(["message"]);
});

test("plain values are neither brand", () => {
  expect(isRouteData({})).toBe(false);
  expect(isRouteData(null)).toBe(false);
  expect(isRouteData("data.user")).toBe(false);
  expect(isRouteError(undefined)).toBe(false);
});

test("the root recorder's own path is empty", () => {
  expect(routeDataPath(dataRecorder())).toEqual([]);
});

test("stringifying a recorder yields the un-internable marker naming the path", () => {
  const data = dataRecorder() as Record<string, unknown>;
  const user = data.user as Record<string, unknown>;
  const text = String(user.name);
  // Whatever sentinel() wraps it in, it must name the path and must not be a
  // string a template could confuse for a value.
  expect(text).toContain("user.name");
  expect(text).not.toBe("user.name");
});

test("spreading is a build error naming the kind and the path", () => {
  const data = dataRecorder() as Record<string, unknown>;
  expect(() => ({ ...data })).toThrow(RouteDataSpreadError);
  try {
    const _spread = { ...(data.user as object) };
  } catch (err) {
    expect((err as Error).message).toContain("data.user");
    expect((err as Error).message).toContain("cannot spread route data");
  }
  // The error recorder fails with its own kind named.
  expect(() => ({ ...(errorRecorder() as object) })).toThrow("cannot spread route error");
});

test("a foreign symbol probe gets undefined — the 'not mine' every brand check wants", () => {
  const data = dataRecorder();
  expect((data as Record<symbol, unknown>)[Symbol.for("skia-proto.signal")]).toBeUndefined();
  expect((data as Record<symbol, unknown>)[Symbol.for("someone.else")]).toBeUndefined();
});

test("nested recorders keep their own path per branch", () => {
  const data = dataRecorder() as Record<string, unknown>;
  const a = data.a as Record<string, unknown>;
  const b = data.b as Record<string, unknown>;
  expect(routeDataPath(a.x)).toEqual(["a", "x"]);
  expect(routeDataPath(b.x)).toEqual(["b", "x"]);
});
