/**
 * Typed text is the one runtime input that grows native memory.
 *
 * Every character a user types lengthens a string slot, which raises the string
 * arena's required size, and the engine's `grow` is monotonic — it never gives
 * memory back. So the input path needs a ceiling, and the runtime is the only
 * layer that can impose one: by the time the uploader sees the string, the slot
 * is already sized for it.
 */
import { expect, test } from "bun:test";

import { MAX_SLOT_CHARS, typeInto, type EditableRef } from "./bindings.ts";
import { signal } from "./signal.ts";

function editable(initial: string) {
  const value = signal(initial);
  const refs: EditableRef[] = [{ node: 7, signal: value }];
  return { value, refs };
}

test("a keystroke appends to the focused editable", () => {
  const { value, refs } = editable("ab");
  expect(typeInto(refs, 7, { text: "c", backspace: false })).toBe(true);
  expect(value.value).toBe("abc");
});

test("backspace removes the last character", () => {
  const { value, refs } = editable("abc");
  expect(typeInto(refs, 7, { text: null, backspace: true })).toBe(true);
  expect(value.value).toBe("ab");
});

test("a keystroke for an unfocused node is ignored", () => {
  const { value, refs } = editable("ab");
  expect(typeInto(refs, 99, { text: "c", backspace: false })).toBe(false);
  expect(value.value).toBe("ab");
});

test("text is refused at the cap rather than growing the arena", () => {
  const { value, refs } = editable("x".repeat(MAX_SLOT_CHARS));

  expect(typeInto(refs, 7, { text: "y", backspace: false })).toBe(false);
  expect(value.value.length).toBe(MAX_SLOT_CHARS);

  // And a paste that would cross the line is refused whole, not truncated —
  // silently keeping half of what someone pasted is a worse answer than keeping
  // none of it.
  const { value: v2, refs: r2 } = editable("x".repeat(MAX_SLOT_CHARS - 2));
  expect(typeInto(r2, 7, { text: "abcdef", backspace: false })).toBe(false);
  expect(v2.value.length).toBe(MAX_SLOT_CHARS - 2);
});

test("backspace still works at the cap, so the field is not a trap", () => {
  const { value, refs } = editable("x".repeat(MAX_SLOT_CHARS));
  expect(typeInto(refs, 7, { text: null, backspace: true })).toBe(true);
  expect(value.value.length).toBe(MAX_SLOT_CHARS - 1);
});
