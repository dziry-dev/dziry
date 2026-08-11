/**
 * `alert()` on the app thread, which is a message and not a dialog.
 *
 * The dialog itself cannot be tested from here and should not be: SDL will only show one from
 * the thread that initialised video, and a test that opened a modal would block until somebody
 * clicked it. So this asserts the half that lives on this side — what gets posted — and
 * `engine/smoke.test.ts` asserts that the FFI call the other half makes is real.
 */
import { afterEach, expect, test } from "bun:test";

import { alert, setAlertSink, type AlertRequest } from "./alert.ts";

afterEach(() => setAlertSink(null));

test("a message reaches the sink with the level as the engine's integer", () => {
  const seen: AlertRequest[] = [];
  setAlertSink((request) => seen.push(request));

  alert("Saved.");
  alert("Careful.", { level: "warning" });
  alert("Broke.", { level: "error", title: "Offline" });

  expect(seen).toEqual([
    { message: "Saved.", title: "", level: 0 },
    { message: "Careful.", title: "", level: 1 },
    { message: "Broke.", title: "Offline", level: 2 },
  ]);
});

test("with no sink it prints instead of throwing", () => {
  // The case every screenshot, golden scenario and unit test runs in. A handler ending in
  // `alert("saved")` must not fail a harness that has no window — there is nobody to notify,
  // which is not the same as something being wrong.
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    expect(() => alert("no window here")).not.toThrow();
  } finally {
    console.error = original;
  }

  expect(errors.length).toBe(1);
  expect(String(errors[0]![0])).toContain("no window here");
});

test("a title is included in the printed line", () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    alert("disk is full", { title: "Cannot save" });
  } finally {
    console.error = original;
  }

  expect(String(errors[0]![0])).toBe("alert: Cannot save — disk is full");
});

test("the sink can be removed again", () => {
  const seen: AlertRequest[] = [];
  setAlertSink((request) => seen.push(request));
  setAlertSink(null);

  const original = console.error;
  console.error = () => {};
  try {
    alert("goes nowhere");
  } finally {
    console.error = original;
  }
  expect(seen).toEqual([]);
});
