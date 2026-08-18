/**
 * `source()` — the reactive half of the Effect seam, measured against the real
 * `effect` package (3.22), not a mock, for the same reason `effects.test.ts`
 * does: the load-bearing claims are facts about effect's `Stream`.
 */
import { expect, test } from "bun:test";
import { Context, Effect, Layer, Stream } from "effect";
import { disposeWindowRuntime, provideWindowLayer, startSources } from "./effects.ts";
import { source } from "./source.ts";

/** One settled turn — the forked stream's emissions arrive on the microtask/IO loop. */
const settled = () => new Promise((r) => setTimeout(r, 20));

test("source() seeds the signal from its initial value", () => {
  const s = source<number[]>(() => Stream.empty, [1, 2, 3]);
  expect(s.value).toEqual([1, 2, 3]);
});

test("each emission writes the cell; the last one wins", async () => {
  const s = source<number>(() => Stream.fromIterable([1, 2, 3]), 0);
  await startSources();
  await settled();
  expect(s.value).toBe(3);
});

test("a snapshot stream replaces the cell wholesale", async () => {
  const s = source<number[]>(
    () => Stream.fromIterable([[1], [1, 2], [1, 2, 3]]),
    [] as number[],
  );
  await startSources();
  await settled();
  expect(s.value).toEqual([1, 2, 3]);
});

test("a failing stream is reported, and the cell keeps its initial value", async () => {
  const s = source<number>(() => Stream.fail(new Error("boom")), 0);

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    await startSources();
    await settled();
  } finally {
    console.error = original;
  }

  expect(errors.join("\n")).toContain("boom");
  expect(s.value).toBe(0);
});

test("startSources consumes the registry, so it is idempotent", async () => {
  source<number>(() => Stream.fromIterable([7]), 0);
  await startSources();
  await startSources(); // second call: nothing left to start, no error
  await settled();
});

test("a callback source pushes, and unsubscribe runs on dispose", async () => {
  let unsubscribed = false;
  const holder: { push: ((v: number) => void) | null } = { push: null };

  const s = source<number>(
    (set) => {
      holder.push = set;
      return () => {
        unsubscribed = true;
      };
    },
    0,
  );

  await startSources();
  expect(holder.push).not.toBeNull();
  holder.push?.(42);
  expect(s.value).toBe(42);
  expect(unsubscribed).toBe(false);

  await disposeWindowRuntime();
  expect(unsubscribed).toBe(true);
});

test("a layer-provided service reaches the stream (R is satisfied)", async () => {
  class Greeter extends Context.Tag("test/Greeter")<Greeter, { hello(): string }>() {}
  provideWindowLayer(Layer.succeed(Greeter, { hello: () => "hi" }));

  try {
    const s = source<string>(
      () =>
        Stream.fromEffect(
          Effect.gen(function* () {
            const greeter = yield* Greeter;
            return greeter.hello();
          }),
        ),
      "",
    );
    await startSources();
    await settled();
    expect(s.value).toBe("hi");
  } finally {
    await disposeWindowRuntime();
  }
});
