/**
 * `runLoader` — a route loader's exit, interpreted for the router.
 *
 * Measured against the real `effect` package for the same reason `effects.test.ts`
 * does: the load-bearing claim is the shape of an Effect's Exit and how a
 * `Redirect` / `Cancel` failure reaches it.
 */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Cancel, Redirect, runLoader } from "./effects.ts";

test("a sync loader returns success", async () => {
  expect(await runLoader(() => 42, {})).toEqual({ kind: "success", value: 42 });
});

test("an async loader returns success", async () => {
  expect(await runLoader(async () => "hi", {})).toEqual({ kind: "success", value: "hi" });
});

test("the loader receives its route args", async () => {
  let seen: unknown = null;
  await runLoader((args) => {
    seen = args;
    return 0;
  }, { id: "42" });
  expect(seen).toEqual({ id: "42" });
});

test("a thrown Redirect is navigation, not failure", async () => {
  expect(await runLoader(() => {
    throw new Redirect("login");
  }, {})).toEqual({ kind: "redirect", to: "login" });
});

test("a thrown Cancel is silence", async () => {
  expect(await runLoader(() => {
    throw new Cancel();
  }, {})).toEqual({ kind: "cancel" });
});

test("an Effect loader returns success", async () => {
  expect(await runLoader(() => Effect.succeed(7), {})).toEqual({ kind: "success", value: 7 });
});

test("an Effect failing with Redirect navigates, silently", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    expect(await runLoader(() => Effect.fail(new Redirect("login")), {})).toEqual({
      kind: "redirect",
      to: "login",
    });
    expect(errors).toEqual([]); // navigation is not a failure to print
  } finally {
    console.error = original;
  }
});

test("an Effect failing with Cancel stays put, silently", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    expect(await runLoader(() => Effect.fail(new Cancel()), {})).toEqual({ kind: "cancel" });
    expect(errors).toEqual([]);
  } finally {
    console.error = original;
  }
});

test("a real failure is reported, not swallowed", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const exit = await runLoader(() => Effect.fail(new Error("boom")), {});
    expect(exit.kind).toBe("failure");
    expect((exit as { value: unknown }).value).toBeInstanceOf(Error);
    expect(errors.join("\n")).toContain("boom");
  } finally {
    console.error = original;
  }
});
