/**
 * `dziry/livestore` — the binding's dziry half, measured against a fake store.
 *
 * The LiveStore side is type-checked by `tsc` against the real `@livestore/livestore`
 * types (a devDependency); the runtime behaviour worth owning here is the plumbing:
 * seed → resolve the store → snapshot + subscribe → `set` → unsubscribe on dispose.
 * A fake store (not the real SQLite engine) keeps the test fast and decoupled, the
 * same reason `effects.test.ts` uses a mock layer rather than a real service.
 */
import { expect, test } from "bun:test";
import { disposeWindowRuntime, startSources } from "./runtime/effects.ts";
import { signal } from "./runtime/signal.ts";
import { liveQuery, useSyncStatus } from "./livestore.ts";

/** One settled turn — the store resolution arrives on a microtask. */
const settled = () => new Promise((r) => setTimeout(r, 20));

type Row = { id: string };

/** A fake store with LiveStore's query/subscribe shape (typed `any` at the boundary). */
function fakeStore() {
  const rows: Row[] = [{ id: "a" }, { id: "b" }];
  let unsubscribed = false;
  const store = {
    query: () => rows,
    subscribe: (_query: unknown, cb: (rows: Row[]) => void) => {
      cb(rows);
      return () => {
        unsubscribed = true;
      };
    },
  };
  return { store, rows, unsubscribed: () => unsubscribed };
}

test("liveQuery seeds empty, then fills from the store at launch", async () => {
  const { store } = fakeStore();
  const todos = liveQuery(Promise.resolve(store as any), {} as any);

  // Before startSources: the empty seed, not the store's rows.
  expect(todos.value).toEqual([]);

  await startSources();
  await settled();
  expect(todos.value).toEqual([{ id: "a" }, { id: "b" }]);

  await disposeWindowRuntime();
});

test("liveQuery accepts an already-resolved store", async () => {
  const { store } = fakeStore();
  const todos = liveQuery(store as any, {} as any);

  await startSources();
  await settled();
  expect(todos.value).toEqual([{ id: "a" }, { id: "b" }]);

  await disposeWindowRuntime();
});

test("liveQuery accepts a store thunk, resolved once at launch", async () => {
  const { store } = fakeStore();
  let created = 0;
  const thunk = () => {
    created++;
    return Promise.resolve(store as any);
  };

  const todos = liveQuery(thunk, {} as any);
  expect(created).toBe(0); // the thunk is not called at module scope

  await startSources();
  await settled();
  expect(created).toBe(1); // called exactly once, at launch
  expect(todos.value).toEqual([{ id: "a" }, { id: "b" }]);

  await disposeWindowRuntime();
});

test("liveQuery unsubscribes the store on dispose", async () => {
  const { store, unsubscribed } = fakeStore();
  liveQuery(Promise.resolve(store as any), {} as any);

  await startSources();
  await settled();
  expect(unsubscribed()).toBe(false);

  await disposeWindowRuntime();
  expect(unsubscribed()).toBe(true);
});

test("useSyncStatus seeds its literal, then tracks the store", async () => {
  let unsubscribed = false;
  const status = { localHead: "e1", upstreamHead: "e1", pendingCount: 0, isSynced: true };
  const store = {
    syncStatus: () => status,
    subscribeSyncStatus: (cb: (s: typeof status) => void) => {
      cb(status);
      return () => {
        unsubscribed = true;
      };
    },
  };

  const sync = useSyncStatus(Promise.resolve(store as any));

  // Before launch: the not-yet-known literal seed.
  expect(sync.value).toEqual({ localHead: "", upstreamHead: "", pendingCount: 0, isSynced: false });

  await startSources();
  await settled();
  expect(sync.value).toEqual(status);
  expect(unsubscribed).toBe(false);

  await disposeWindowRuntime();
  expect(unsubscribed).toBe(true);
});

test("liveQuery takes an explicit seed for a non-list query", async () => {
  const { store } = fakeStore();
  const count = liveQuery(Promise.resolve(store as any), {} as any, 0);

  // A scalar seed, not the empty-list default.
  expect(count.value).toBe(0);

  await startSources();
  await settled();
  await disposeWindowRuntime();
});

test("a thunk query re-subscribes when a signal it reads changes", async () => {
  // A store whose query honours the queryable's `done` filter, with counters so the
  // test can see the re-subscription rather than infer it.
  const rows: Row[] = [
    { id: "a" } as Row,
    { id: "b" } as Row,
  ];
  let subscribes = 0;
  let storeUnsubscribes = 0;
  const store = {
    query: (q: { done?: boolean }) => rows,
    subscribe: (q: { done?: boolean }, cb: (rows: Row[]) => void) => {
      subscribes++;
      cb(rows);
      return () => {
        storeUnsubscribes++;
      };
    },
  };

  const done = signal(false);
  const todos = liveQuery(store as any, () => ({ done: done.value }) as any);

  await startSources();
  await settled();
  expect(subscribes).toBe(1);
  expect(todos.value).toEqual(rows);

  // Changing the signal the thunk read re-runs the query and re-subscribes.
  done.set(true);
  expect(subscribes).toBe(2);
  expect(storeUnsubscribes).toBe(1); // the previous subscription was torn down

  await disposeWindowRuntime();
});

test("a store that fails to resolve is reported, not an unobserved rejection", async () => {
  const orig = console.error;
  let reported = "";
  console.error = (...args: unknown[]) => {
    reported += args.map(String).join(" ");
  };
  try {
    liveQuery(Promise.reject(new Error("corrupt db")), {} as any);
    await startSources();
    await settled();
    expect(reported).toContain("liveQuery's store failed to resolve");
    expect(reported).toContain("corrupt db");
  } finally {
    console.error = orig;
  }

  await disposeWindowRuntime();
});
