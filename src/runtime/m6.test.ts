/**
 * M6: `effect`, `untrack`, `peek`, and the dep-set fix.
 *
 * The leak these pin: capture was one-way — a read added the listener to the
 * signal's subscribers and nothing ever removed it. A computed whose reads are
 * conditional accumulated a subscription per abandoned branch, for ever, and an
 * effect would have inherited the same shape. Values were never wrong (a
 * recompute reads current deps), which is exactly why it needed a test: a leak
 * that only shows as growth is invisible to every assertion about values.
 */
import { expect, test } from "bun:test";
import { batch, computed, createScope, effect, signal, untrack } from "./signal.ts";

// ---------------------------------------------------------------------------
// The dep-set fix
// ---------------------------------------------------------------------------

test("a computed leaves the dependency it stopped reading", () => {
  const cond = signal(true);
  const a = signal(1);
  const b = signal(10);
  let computations = 0;
  const pick = computed(() => {
    computations++;
    return cond.value ? a.value : b.value;
  });

  expect(pick.value).toBe(1);
  cond.value = false;
  expect(pick.value).toBe(10);
  expect(computations).toBe(2);

  // `a` is no longer read. Before the fix its subscriber set still held the
  // invalidator: a write woke a recompute that read nothing new.
  a.value = 99;
  expect(computations).toBe(2); // not woken
  expect(pick.value).toBe(10); // and still correct on read

  // The branch taken now *is* tracked.
  b.value = 11;
  expect(pick.value).toBe(11);
  expect(computations).toBe(3);
});

test("a computed that returns to a branch re-subscribes to it", () => {
  const cond = signal(true);
  const a = signal(1);
  const b = signal(10);
  const pick = computed(() => (cond.value ? a.value : b.value));

  expect(pick.value).toBe(1);
  cond.value = false;
  expect(pick.value).toBe(10);
  cond.value = true;
  expect(pick.value).toBe(1); // back on `a`, so `a` must wake it again
  a.value = 2;
  expect(pick.value).toBe(2);
});

// ---------------------------------------------------------------------------
// untrack
// ---------------------------------------------------------------------------

test("untrack reads without subscribing the enclosing computation", () => {
  const tracked = signal(1);
  const free = signal(100);
  let computations = 0;
  const c = computed(() => {
    computations++;
    return tracked.value + untrack(() => free.value);
  });

  expect(c.value).toBe(101);
  free.value = 200;
  expect(computations).toBe(1); // free is not a dependency
  tracked.value = 2;
  expect(c.value).toBe(202); // the untracked read is re-read when recomputing
});

// ---------------------------------------------------------------------------
// peek
// ---------------------------------------------------------------------------

test("peek reads the value without capturing, signals and computeds alike", () => {
  const n = signal(5);
  const other = signal(0);
  const doubled = computed(() => n.value * 2);

  const seen: number[] = [];
  const dispose = effect(() => {
    // Only `other` may be captured; both peeks must be invisible to it.
    seen.push(doubled.peek() + other.value);
  });
  expect(seen).toEqual([10]);

  n.value = 6;
  expect(seen).toEqual([10]); // doubled moved, but it was peeked — no re-run
  // ...and a peek at a stale computed still computes — peek refuses the
  // *subscription*, not the value.
  expect(doubled.peek()).toBe(12);

  other.value = 1;
  expect(seen).toEqual([10, 13]);
  dispose();
});

// ---------------------------------------------------------------------------
// effect
// ---------------------------------------------------------------------------

test("an effect runs now, and again when a read signal changes", () => {
  const n = signal(1);
  const seen: number[] = [];
  effect(() => {
    seen.push(n.value);
  });
  expect(seen).toEqual([1]);
  n.value = 2;
  expect(seen).toEqual([1, 2]);
});

test("an effect re-captures per run — abandoned branches stop waking it", () => {
  const cond = signal(true);
  const a = signal(0);
  const b = signal(0);
  let runs = 0;
  effect(() => {
    runs++;
    void (cond.value ? a.value : b.value);
  });
  expect(runs).toBe(1);

  cond.value = false;
  expect(runs).toBe(2);
  a.value = 1; // no longer read
  expect(runs).toBe(2);
  b.value = 1; // the live branch
  expect(runs).toBe(3);
});

test("the returned cleanup runs before a re-run and at disposal", () => {
  const n = signal(0);
  const events: string[] = [];
  const dispose = effect(() => {
    const v = n.value;
    events.push(`run ${v}`);
    return () => events.push(`cleanup ${v}`);
  });

  n.value = 1;
  expect(events).toEqual(["run 0", "cleanup 0", "run 1"]);
  dispose();
  expect(events).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1"]);
});

test("a disposed effect is not woken, including by a write already batched", () => {
  const n = signal(1);
  let runs = 0;
  const dispose = effect(() => {
    runs++;
    void n.value;
  });
  expect(runs).toBe(1);

  // Disposed while its re-run sits in the batch queue: the flush must skip it.
  batch(() => {
    n.value = 2;
    dispose();
  });
  expect(runs).toBe(1);

  n.value = 3;
  expect(runs).toBe(1);
});

test("a batch wakes an effect once however many of its deps it writes", () => {
  const a = signal(1);
  const b = signal(2);
  let runs = 0;
  effect(() => {
    runs++;
    void a.value;
    void b.value;
  });
  batch(() => {
    a.value = 10;
    b.value = 20;
  });
  expect(runs).toBe(2); // initial + one batched re-run
});

// ---------------------------------------------------------------------------
// disposal scopes
// ---------------------------------------------------------------------------

test("a scope disposes every effect created inside its run", () => {
  const a = signal(0);
  const b = signal(0);
  let runsA = 0;
  let runsB = 0;

  const scope = createScope();
  scope.run(() => {
    effect(() => {
      runsA++;
      void a.value;
    });
    effect(() => {
      runsB++;
      void b.value;
    });
  });
  expect([runsA, runsB]).toEqual([1, 1]);

  scope.dispose();
  a.value = 1;
  b.value = 1;
  expect([runsA, runsB]).toEqual([1, 1]);
});

test("an effect created outside any scope is only disposed by its handle", () => {
  const n = signal(0);
  let runs = 0;
  const dispose = effect(() => {
    runs++;
    void n.value;
  });
  const scope = createScope();
  scope.dispose(); // owns nothing — must not touch the effect
  n.value = 1;
  expect(runs).toBe(2);
  dispose();
});

test("scopes nest: disposing the outer does not skip the inner", () => {
  const n = signal(0);
  let inner = 0;
  let outer = 0;
  const outside = createScope();
  outside.run(() => {
    effect(() => {
      outer++;
      void n.value;
    });
    createScope().run(() => {
      effect(() => {
        inner++;
        void n.value;
      });
    });
  });
  outside.dispose();
  n.value = 1;
  // The inner effect was created while the outer scope was current, so the
  // outer owns it transitively: one dispose covers the subtree.
  expect([outer, inner]).toEqual([1, 1]);
});

test("own() into a disposed scope runs the disposer immediately", () => {
  const scope = createScope();
  scope.dispose();
  let ran = false;
  scope.own(() => {
    ran = true;
  });
  expect(ran).toBe(true); // owning into a dead scope is a leak by another name
});

test("run() on a disposed scope refuses", () => {
  const scope = createScope();
  scope.dispose();
  expect(() => scope.run(() => {})).toThrow("disposed");
});
