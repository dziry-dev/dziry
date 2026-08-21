import { expect, test } from "bun:test";
import { isResource, resource, takeResources } from "./resource.ts";
import { isSignal } from "./signal.ts";

/** Registers, starts, and hands back — each test owns what it created. */
function started<T>(fetcher: () => Promise<T> | T, initial: T) {
  const r = resource(fetcher, initial);
  for (const start of takeResources()) start();
  return r;
}

/** One macrotask, so a promise the fetcher returned has settled. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a resource is a signal — bindings and lists need nothing new", () => {
  const r = resource(() => Promise.resolve(1), 0);
  takeResources();
  expect(isSignal(r)).toBe(true);
  expect(isResource(r)).toBe(true);
  // And a plain signal is not a resource — the brand is what compile collects by.
  expect(isResource(isSignal)).toBe(false);
});

test("registered is not run: nothing fetches until the worker starts it", async () => {
  let ran = 0;
  const r = resource(() => {
    ran++;
    return Promise.resolve("fetched");
  }, "initial");

  // The compiler's world: modules imported, nothing started.
  expect(ran).toBe(0);
  expect(r.status.value).toBe("pending");
  expect(r.value).toBe("initial");

  for (const start of takeResources()) start();
  expect(ran).toBe(1);
  await tick();
  expect(r.value).toBe("fetched");
  expect(r.status.value).toBe("ready");
});

test("takeResources consumes — a second take starts nothing twice", () => {
  let ran = 0;
  resource(() => {
    ran++;
    return 1;
  }, 0);
  for (const start of takeResources()) start();
  for (const start of takeResources()) start();
  expect(ran).toBe(1);
});

test("a sync fetcher settles inside the start call", () => {
  const r = started(() => 42, 0);
  expect(r.status.value).toBe("ready");
  expect(r.value).toBe(42);
});

test("a rejection lands in error and status, and keeps the shown data", async () => {
  const r = started(() => Promise.reject(new Error("down")), "last-good");
  await tick();
  expect(r.status.value).toBe("error");
  expect((r.error.value as Error).message).toBe("down");
  expect(r.value).toBe("last-good");
});

test("a throwing fetcher is the same failure as a rejecting one", () => {
  const r = started(() => {
    throw new Error("sync boom");
  }, 0);
  expect(r.status.value).toBe("error");
  expect((r.error.value as Error).message).toBe("sync boom");
});

test("refetch goes stale, never pending — revalidation must not flash a fallback", async () => {
  let answer = "first";
  const r = started(() => Promise.resolve(answer), "");
  await tick();
  expect(r.status.value).toBe("ready");

  answer = "second";
  r.refetch();
  expect(r.status.value).toBe("stale");
  expect(r.value).toBe("first"); // the shown data stays up while newer is fetched

  await tick();
  expect(r.status.value).toBe("ready");
  expect(r.value).toBe("second");
});

test("a refetch settling clears the previous error", async () => {
  let fail = true;
  const r = started(() => (fail ? Promise.reject(new Error("down")) : Promise.resolve("up")), "");
  await tick();
  expect(r.status.value).toBe("error");

  fail = false;
  r.refetch();
  await tick();
  expect(r.status.value).toBe("ready");
  expect(r.error.value).toBeNull();
});

test("a superseded run lands nowhere — the latest refetch wins", async () => {
  const settles: ((v: string) => void)[] = [];
  const r = started(() => new Promise<string>((resolve) => settles.push(resolve)), "");

  r.refetch();
  expect(settles.length).toBe(2);

  // The *first* (superseded) run settles late, after the second already answered.
  settles[1]!("newer");
  await tick();
  expect(r.value).toBe("newer");
  settles[0]!("older");
  await tick();
  expect(r.value).toBe("newer");
  expect(r.status.value).toBe("ready");
});

test("status changes notify subscribers — what a boundary hangs off", async () => {
  const seen: string[] = [];
  const r = started(() => Promise.resolve(1), 0);
  r.status.subscribe(() => seen.push(r.status.value));
  await tick();
  expect(seen).toEqual(["ready"]);
});
