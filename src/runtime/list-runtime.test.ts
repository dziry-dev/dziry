/**
 * subscribeLists — the one list-runtime export the pipeline tests do not reach.
 *
 * Everything else in this module is driven end to end: list-splice.test.tsx
 * covers updateList's relinking and dispatchItem/dispatchItemChange, and
 * form.test.tsx covers applyRowValidity and typeIntoRow. What no test pinned is
 * the subscription contract: one subscription per binding, fired by that
 * binding's signal, and an unsubscribe that actually unsubscribes.
 */
import { expect, test } from "bun:test";
import { subscribeLists, type ListBindingRef } from "./list-runtime.ts";
import { signal } from "./signal.ts";

function binding(listSignal: unknown): ListBindingRef {
  return { signal: listSignal } as unknown as ListBindingRef;
}

test("a bound array's signal drives the change callback", () => {
  const items = signal([1, 2]);
  let calls = 0;
  subscribeLists([binding(items)], () => calls++);
  (items as { value: unknown[] }).value = [1, 2, 3];
  expect(calls).toBe(1);
});

test("two lists are two subscriptions, each answering its own signal", () => {
  const a = signal([1]);
  const b = signal([2]);
  let calls = 0;
  subscribeLists([binding(a), binding(b)], () => calls++);
  (a as { value: unknown[] }).value = [];
  expect(calls).toBe(1);
  (b as { value: unknown[] }).value = [];
  expect(calls).toBe(2);
});

test("the returned unsubscribe stops every subscription", () => {
  const items = signal([1]);
  let calls = 0;
  const off = subscribeLists([binding(items)], () => calls++);
  off();
  (items as { value: unknown[] }).value = [1, 2];
  expect(calls).toBe(0);
});
