/**
 * `navigate()`/`back()` over an installed route signal — the whole surface,
 * including the two decisions worth pinning: history is one entry deep (going
 * back twice oscillates), and navigating to where you already are records
 * nothing, so `back()` still points where it did.
 */
import { expect, test } from "bun:test";
import { signal } from "./signal.ts";
import { back, installNavigation, navigate } from "./navigate.ts";
import { deadNavigations } from "../compiler/build.ts";
import type { Route } from "../compiler/routes.ts";

test("navigate writes the installed signal; back is one entry deep", () => {
  const route = signal("/");
  installNavigation(route);

  navigate("layout");
  expect(route.value).toBe("layout");

  navigate("colors");
  back();
  expect(route.value).toBe("layout");
  back(); // one entry: back from a back is where you just were, not older history
  expect(route.value).toBe("colors");
});

test("navigating to the current path records nothing", () => {
  const route = signal("/");
  installNavigation(route);

  navigate("layout");
  navigate("layout"); // a no-op, so `previous` still says "/"
  back();
  expect(route.value).toBe("/");
});

test("back before any navigation, and navigate before install, both do nothing", () => {
  const route = signal("/");
  installNavigation(route);
  back();
  expect(route.value).toBe("/");

  installNavigation(signal("/")); // fresh install clears history
  back();
});

test("deadNavigations: a literal the table cannot answer for is named; the rest pass", () => {
  const routes: Route[] = [
    { window: "m", path: "/", file: "index.tsx", segments: [], params: [], parent: -1 },
    { window: "m", path: "layout", file: "layout.tsx", segments: ["layout"], params: [], parent: -1 },
  ];
  const errors = deadNavigations(
    [`() => navigate("layout")`, `() => navigate('abuot')`, "goOverview", `() => navigate(somewhere)`],
    routes,
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(`navigate("abuot") names no route`);
});
