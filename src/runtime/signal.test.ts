/**
 * Signals: laziness, batching, and the priming rule.
 *
 * The interesting cases here are the ones where nothing throws and the UI simply
 * stops updating — which is how a reactivity bug presents when the runtime has no
 * scheduler to complain to.
 */
import { expect, test } from "bun:test";
import { batch, computed, signal } from "./signal.ts";

test("a computed recomputes only when a dependency changed", () => {
  const n = signal(2);
  let computations = 0;
  const doubled = computed(() => {
    computations++;
    return n.value * 2;
  });

  expect(doubled.value).toBe(4);
  expect(doubled.value).toBe(4);
  expect(computations).toBe(1);

  n.value = 3;
  expect(doubled.value).toBe(6);
  expect(computations).toBe(2);
});

test("a computed nobody reads costs nothing", () => {
  const n = signal(0);
  let computations = 0;
  computed(() => {
    computations++;
    return n.value;
  });

  n.value = 1;
  n.value = 2;
  expect(computations).toBe(0);
});

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------

test("subscribing to a never-read computed still fires", () => {
  // The bug this pins: a computed registers with its dependencies only inside
  // the `value` getter, so subscribing to one that has never been read attached
  // the callback to a signal subscribed to nothing. The dependency changed,
  // nothing invalidated, and the subscriber never ran — no error, just a UI that
  // stopped updating.
  const n = signal(1);
  const doubled = computed(() => n.value * 2);

  let fired = 0;
  doubled.subscribe(() => fired++); // note: `.value` never read before this

  n.value = 2;
  expect(fired).toBe(1);
  expect(doubled.value).toBe(4);
});

test("the same holds for a chain of computeds", () => {
  const n = signal(1);
  const a = computed(() => n.value + 1);
  const b = computed(() => a.value * 10);

  let fired = 0;
  b.subscribe(() => fired++);

  n.value = 2;
  expect(fired).toBeGreaterThan(0);
  expect(b.value).toBe(30);
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

test("a batch notifies once however many signals it writes", () => {
  const a = signal(1);
  const b = signal(2);
  const sum = computed(() => a.value + b.value);

  let fired = 0;
  sum.subscribe(() => fired++);

  batch(() => {
    a.value = 10;
    b.value = 20;
  });

  expect(fired).toBe(1);
  expect(sum.value).toBe(30);
});

test("an effect on both a signal and a computed derived from it runs once", () => {
  // The subtlety batching had to get right: a computed's invalidation is
  // bookkeeping, not an effect, so it must propagate synchronously even inside a
  // batch. Queuing it made this fire twice.
  const n = signal(1);
  const doubled = computed(() => n.value * 2);

  let fired = 0;
  n.subscribe(() => fired++);
  doubled.subscribe(() => fired++);

  batch(() => {
    n.value = 2;
  });

  expect(fired).toBe(2); // one per distinct subscriber, not one per write
});

test("unsubscribing stops delivery", () => {
  const n = signal(0);
  const doubled = computed(() => n.value * 2);

  let fired = 0;
  const off = doubled.subscribe(() => fired++);

  n.value = 1;
  expect(fired).toBe(1);

  off();
  n.value = 2;
  expect(fired).toBe(1);
});
