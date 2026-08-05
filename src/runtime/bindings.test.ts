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

// ---------------------------------------------------------------------------
// Editing at the caret
// ---------------------------------------------------------------------------

test("text is inserted at the caret, not appended", () => {
  const { value, refs } = editable("abcd");
  // The bug this fixes: clicking into the middle of a field and typing put the
  // characters at the end, because the host had no idea where the caret was. The engine
  // owns the index and reports it beside the text; this owns the string.
  expect(typeInto(refs, 7, { text: "X", backspace: false, caret: 2 })).toBe(true);
  expect(value.value).toBe("abXcd");
});

test("backspace removes the character before the caret", () => {
  const { value, refs } = editable("abcd");
  expect(typeInto(refs, 7, { text: null, backspace: true, caret: 2 })).toBe(true);
  expect(value.value).toBe("acd");
});

test("backspace at the start consumes the key and changes nothing", () => {
  const { value, refs } = editable("abcd");
  // Consumed, not refused: Backspace at offset 0 doing nothing is the measured behaviour,
  // and returning false would send the host looking for another meaning for the key.
  expect(typeInto(refs, 7, { text: null, backspace: true, caret: 0 })).toBe(true);
  expect(value.value).toBe("abcd");
});

test("a caret at the end appends, and so does no caret at all", () => {
  const { value, refs } = editable("ab");
  expect(typeInto(refs, 7, { text: "c", backspace: false, caret: 2 })).toBe(true);
  expect(value.value).toBe("abc");

  // -1 is "nothing focused", and an absent field is a host that never places a caret.
  // Both append, so this behaves as it did before there was a caret at all.
  expect(typeInto(refs, 7, { text: "d", backspace: false, caret: -1 })).toBe(true);
  expect(value.value).toBe("abcd");
  expect(typeInto(refs, 7, { text: "e", backspace: false })).toBe(true);
  expect(value.value).toBe("abcde");
});

test("a caret past the end is clamped rather than trusted", () => {
  const { value, refs } = editable("ab");
  // It crossed a process boundary, and app code may have rewritten the signal since the
  // engine read the length. Slicing at 99 would silently drop text.
  expect(typeInto(refs, 7, { text: "!", backspace: false, caret: 99 })).toBe(true);
  expect(value.value).toBe("ab!");
});

test("the caret counts characters, not UTF-16 units", () => {
  // "😀" is one character and two UTF-16 units. The engine resolved the click by counting
  // *characters*, so slicing by `.length` here would put the insert in the middle of a
  // surrogate pair and produce two broken halves.
  const { value, refs } = editable("😀a");
  expect(typeInto(refs, 7, { text: "X", backspace: false, caret: 1 })).toBe(true);
  expect(value.value).toBe("😀Xa");

  // And backspace over the emoji removes the whole thing, not half of it.
  const two = editable("😀a");
  expect(typeInto(two.refs, 7, { text: null, backspace: true, caret: 1 })).toBe(true);
  expect(two.value.value).toBe("a");
});
