/**
 * The Effect seam, measured against the real `effect` package (3.22, the repo's
 * devDependency) — not a mock, because the load-bearing claims are structural
 * facts about effect's values: the registered symbol, the Exit shape, what
 * ManagedRuntime provides. A mock would prove the mock.
 */
import { expect, test } from "bun:test";
import { Context, Effect, Layer } from "effect";
import {
  Cancel,
  disposeWindowRuntime,
  isEffect,
  provideWindowLayer,
  Redirect,
  runDispatched,
} from "./effects.ts";
import { dispatch, dispatchChange } from "./bindings.ts";
import type { CompiledUi } from "../ir.ts";
import { emptyControlTable } from "../ir.ts";

/** One settled turn — the runner's fire-and-forget path is a chain of awaits. */
const settled = () => new Promise((r) => setTimeout(r, 20));

// --- detection ------------------------------------------------------------------

test("isEffect recognises a real Effect by its registered symbol", () => {
  expect(isEffect(Effect.succeed(1))).toBe(true);
  expect(isEffect(Effect.gen(function* () {}))).toBe(true);
});

test("isEffect rejects everything a handler ordinarily returns", () => {
  expect(isEffect(undefined)).toBe(false);
  expect(isEffect(null)).toBe(false);
  expect(isEffect(7)).toBe(false);
  expect(isEffect("click")).toBe(false);
  expect(isEffect({})).toBe(false);
  expect(isEffect(Promise.resolve(1))).toBe(false);
  expect(isEffect(() => Effect.succeed(1))).toBe(false);
});

// --- the tags -------------------------------------------------------------------

test("Redirect and Cancel are tagged, dependency-free, and Effect-failable", async () => {
  const r = new Redirect("login");
  expect(r._tag).toBe("Redirect");
  expect(r.to).toBe("login");
  expect(new Cancel()._tag).toBe("Cancel");

  // The same objects work as an Effect's typed failure — the two-worlds claim.
  const exit = await Effect.runPromiseExit(Effect.fail(new Redirect("login")));
  expect(exit._tag).toBe("Failure");
});

// --- running --------------------------------------------------------------------

test("runDispatched runs an Effect and reports it took one", async () => {
  let ran = false;
  expect(runDispatched(Effect.sync(() => (ran = true)), "test handler")).toBe(true);
  await settled();
  expect(ran).toBe(true);
});

test("runDispatched ignores a non-Effect return", () => {
  expect(runDispatched(undefined, "test handler")).toBe(false);
  expect(runDispatched(42, "test handler")).toBe(false);
});

test("a failed Effect is printed, not swallowed", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    runDispatched(Effect.fail(new Error("boom")), "click handler at node 7");
    await settled();
  } finally {
    console.error = original;
  }
  expect(errors.join("\n")).toContain("click handler at node 7");
  expect(errors.join("\n")).toContain("boom");
});

test("the window layer's services reach a dispatched Effect", async () => {
  class Greeter extends Context.Tag("test/Greeter")<Greeter, { hello(): string }>() {}

  provideWindowLayer(Layer.succeed(Greeter, { hello: () => "from the layer" }));
  try {
    let seen = "";
    runDispatched(
      Effect.gen(function* () {
        const greeter = yield* Greeter;
        seen = greeter.hello();
      }),
      "test handler",
    );
    await settled();
    expect(seen).toBe("from the layer");
  } finally {
    await disposeWindowRuntime();
  }
});

test("disposing the runtime runs the layer's finalizers", async () => {
  class Res extends Context.Tag("test/Res")<Res, { open: boolean }>() {}

  let released = false;
  provideWindowLayer(
    Layer.scoped(
      Res,
      Effect.acquireRelease(Effect.succeed({ open: true }), () =>
        Effect.sync(() => {
          released = true;
        }),
      ),
    ),
  );
  // Force acquisition by actually running something through the runtime.
  runDispatched(Effect.andThen(Res, () => Effect.void), "test handler");
  await settled();
  expect(released).toBe(false);

  await disposeWindowRuntime();
  expect(released).toBe(true);
});

// --- through dispatch, the way a click actually arrives ---------------------------

function uiWith(handlers: CompiledUi["handlers"]): CompiledUi {
  return {
    handlers,
    controls: emptyControlTable(),
    forms: [],
  } as unknown as CompiledUi;
}

test("a click handler returning an Effect is run by dispatch", async () => {
  let ran = false;
  const ui = uiWith([
    { node: 4, kind: "click", fn: () => Effect.sync(() => (ran = true)) },
  ] as CompiledUi["handlers"]);

  expect(dispatch(ui, 4)).toBe(true);
  await settled();
  expect(ran).toBe(true);
});

test("a change handler returning an Effect is run, and still gets its value", async () => {
  let seen: unknown = null;
  const ui = uiWith([
    { node: 9, kind: "change", fn: (v?: unknown) => Effect.sync(() => (seen = v)) },
  ] as CompiledUi["handlers"]);

  expect(dispatchChange(ui, 9, 3)).toBe(true);
  await settled();
  expect(seen).toBe(3);
});
