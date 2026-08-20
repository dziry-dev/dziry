/**
 * The channel lock, in-process.
 *
 * The engine/worker pair these semantics protect run on real threads, but every
 * primitive here is a synchronous `Atomics` op on a `SharedArrayBuffer`, which a
 * test process has exactly as much of as the app does. The one genuinely
 * cross-thread property — a blocked `acquire` wakes on `release` — gets a real
 * Worker (channel-worker.fixture.ts), not a mock of `Atomics.wait`.
 *
 * The killed-mid-batch case is the hot-reload bug this module's contract exists
 * for: `reloadApp` terminates a worker that may hold the lock, and the engine
 * thread's force-`release` is the only thing standing between that and a window
 * that pumps forever without ever committing again.
 */
import { expect, test } from "bun:test";
import {
  ALIVE,
  DIRTY,
  LOCK,
  acquire,
  alive,
  createChannel,
  publish,
  release,
  stop,
  takeDirty,
  tryAcquire,
} from "./channel.ts";

function flagsOf(sab: SharedArrayBuffer): Int32Array {
  return new Int32Array(sab);
}

test("a fresh channel is unlocked, clean and alive", () => {
  const flags = flagsOf(createChannel());
  expect(Atomics.load(flags, LOCK)).toBe(0);
  expect(Atomics.load(flags, DIRTY)).toBe(0);
  expect(Atomics.load(flags, ALIVE)).toBe(1);
});

test("tryAcquire takes a free lock and only one holder gets it", () => {
  const flags = flagsOf(createChannel());
  expect(tryAcquire(flags)).toBe(true);
  expect(tryAcquire(flags)).toBe(false); // held — the engine thread pumps instead
  release(flags);
  expect(tryAcquire(flags)).toBe(true);
});

test("acquire returns with the lock held", () => {
  const flags = flagsOf(createChannel());
  acquire(flags); // free, so no wait
  expect(tryAcquire(flags)).toBe(false);
  release(flags);
});

test("publish then takeDirty reads once and clears", () => {
  const flags = flagsOf(createChannel());
  expect(takeDirty(flags)).toBe(false);
  publish(flags);
  expect(takeDirty(flags)).toBe(true);
  // The exchange cleared it: a second commit finds nothing to do.
  expect(takeDirty(flags)).toBe(false);
});

test("stop clears alive and is observable", () => {
  const flags = flagsOf(createChannel());
  expect(alive(flags)).toBe(true);
  stop(flags);
  expect(alive(flags)).toBe(false);
});

test("release wakes a waiter — the mechanism acquire relies on", async () => {
  const flags = flagsOf(createChannel());
  tryAcquire(flags);
  const observed = Atomics.waitAsync(flags, LOCK, 1).value as Promise<unknown>;
  release(flags);
  await observed; // would hang the test run if notify were lost
});

test("a blocked acquire waits for release, then proceeds", async () => {
  const sab = createChannel();
  tryAcquire(flagsOf(sab)); // the engine thread holds it, mid-tick

  const worker = new Worker(new URL("./channel-worker.fixture.ts", import.meta.url));
  const messages: string[] = [];
  const next = (want: string) =>
    new Promise<void>((resolve, reject) => {
      const started = performance.now();
      const poll = () => {
        if (messages.includes(want)) return resolve();
        if (performance.now() - started > 5000) return reject(new Error(`never saw "${want}"`));
        setTimeout(poll, 5);
      };
      poll();
    });
  worker.onmessage = (e: MessageEvent) => messages.push(e.data as string);

  try {
    worker.postMessage(sab);
    await next("waiting"); // parked in Atomics.wait, not still booting
    await Bun.sleep(50);
    expect(messages).not.toContain("acquired"); // the lock is held: it must not proceed
    release(flagsOf(sab));
    await next("acquired");
  } finally {
    worker.terminate();
  }
});

test("a writer killed mid-batch leaves the lock HELD, and a force-release frees it", async () => {
  // reloadApp's exact scenario: terminate() does not run finally blocks, so the
  // worker's release never happens. The engine thread noticing the death has to
  // be able to take the lock back.
  const sab = createChannel();
  const flags = flagsOf(sab);
  const worker = new Worker(new URL("./channel-worker.fixture.ts", import.meta.url));
  const acquired = new Promise<void>((resolve) => {
    worker.onmessage = (e: MessageEvent) => {
      if (e.data === "acquired") resolve();
    };
  });
  worker.postMessage(sab);
  await acquired; // the worker holds the lock now

  worker.terminate(); // no finally, no release
  expect(tryAcquire(flags)).toBe(false); // the poisoned state: HELD by a dead agent

  release(flags); // the engine thread's recovery
  expect(tryAcquire(flags)).toBe(true);
});
