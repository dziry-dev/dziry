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
  expect(typeInto(refs, 7, { text: "c" })).toBe(true);
  expect(value.value).toBe("abc");
});

test("backspace removes the last character", () => {
  const { value, refs } = editable("abc");
  expect(typeInto(refs, 7, { text: null, erase: "backward" })).toBe(true);
  expect(value.value).toBe("ab");
});

test("a keystroke for an unfocused node is ignored", () => {
  const { value, refs } = editable("ab");
  expect(typeInto(refs, 99, { text: "c" })).toBe(false);
  expect(value.value).toBe("ab");
});

test("text is refused at the cap rather than growing the arena", () => {
  const { value, refs } = editable("x".repeat(MAX_SLOT_CHARS));

  expect(typeInto(refs, 7, { text: "y" })).toBe(false);
  expect(value.value.length).toBe(MAX_SLOT_CHARS);

  // And a paste that would cross the line is refused whole, not truncated —
  // silently keeping half of what someone pasted is a worse answer than keeping
  // none of it.
  const { value: v2, refs: r2 } = editable("x".repeat(MAX_SLOT_CHARS - 2));
  expect(typeInto(r2, 7, { text: "abcdef" })).toBe(false);
  expect(v2.value.length).toBe(MAX_SLOT_CHARS - 2);
});

test("backspace still works at the cap, so the field is not a trap", () => {
  const { value, refs } = editable("x".repeat(MAX_SLOT_CHARS));
  expect(typeInto(refs, 7, { text: null, erase: "backward" })).toBe(true);
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
  expect(typeInto(refs, 7, { text: "X", caret: 2 })).toBe(true);
  expect(value.value).toBe("abXcd");
});

test("backspace removes the character before the caret", () => {
  const { value, refs } = editable("abcd");
  expect(typeInto(refs, 7, { text: null, erase: "backward", caret: 2 })).toBe(true);
  expect(value.value).toBe("acd");
});

test("backspace at the start consumes the key and changes nothing", () => {
  const { value, refs } = editable("abcd");
  // Consumed, not refused: Backspace at offset 0 doing nothing is the measured behaviour,
  // and returning false would send the host looking for another meaning for the key.
  expect(typeInto(refs, 7, { text: null, erase: "backward", caret: 0 })).toBe(true);
  expect(value.value).toBe("abcd");
});

test("delete removes the character after the caret", () => {
  const { value, refs } = editable("abcd");
  // The key did nothing before this: the engine forwarded it like every other unhandled
  // keycode, and the worker matched only Backspace, so it fell off the end of the switch.
  expect(typeInto(refs, 7, { text: null, erase: "forward", caret: 2 })).toBe(true);
  expect(value.value).toBe("abd");
});

test("delete at the end consumes the key and changes nothing", () => {
  const { value, refs } = editable("abcd");
  // The mirror of Backspace at 0, and consumed for the same reason.
  expect(typeInto(refs, 7, { text: null, erase: "forward", caret: 4 })).toBe(true);
  expect(value.value).toBe("abcd");

  // And with no caret at all: `at` becomes the length, which is the end.
  expect(typeInto(refs, 7, { text: null, erase: "forward" })).toBe(true);
  expect(value.value).toBe("abcd");
});

test("delete eats a whole astral character", () => {
  // The forward half of the surrogate-pair case: slicing by `.length` would leave the low
  // surrogate behind as a lone broken unit.
  const { value, refs } = editable("a😀b");
  expect(typeInto(refs, 7, { text: null, erase: "forward", caret: 1 })).toBe(true);
  expect(value.value).toBe("ab");
});

test("a caret at the end appends, and so does no caret at all", () => {
  const { value, refs } = editable("ab");
  expect(typeInto(refs, 7, { text: "c", caret: 2 })).toBe(true);
  expect(value.value).toBe("abc");

  // -1 is "nothing focused", and an absent field is a host that never places a caret.
  // Both append, so this behaves as it did before there was a caret at all.
  expect(typeInto(refs, 7, { text: "d", caret: -1 })).toBe(true);
  expect(value.value).toBe("abcd");
  expect(typeInto(refs, 7, { text: "e" })).toBe(true);
  expect(value.value).toBe("abcde");
});

test("a caret past the end is clamped rather than trusted", () => {
  const { value, refs } = editable("ab");
  // It crossed a process boundary, and app code may have rewritten the signal since the
  // engine read the length. Slicing at 99 would silently drop text.
  expect(typeInto(refs, 7, { text: "!", caret: 99 })).toBe(true);
  expect(value.value).toBe("ab!");
});

// ---------------------------------------------------------------------------
// Editing over a live selection
// ---------------------------------------------------------------------------

test("typing over a selection replaces exactly the selected range", () => {
  const { value, refs } = editable("abcdefghij");
  // Measured: `X` over `2..6` gives `abXghij`. The engine sends the two offsets it holds —
  // `caret` is the focus and `anchor` the other end — and this splices between them.
  expect(typeInto(refs, 7, { text: "X", caret: 6, anchor: 2 })).toBe(true);
  expect(value.value).toBe("abXghij");
});

test("Backspace and Delete are identical once a range is live", () => {
  // The measured surprise, and the reason both keys share one branch: over a range neither
  // takes the extra character its collapsed behaviour would. Backspace over `1..4` gives
  // `ahij`, not `hij`, and Delete over the same range gives `ahij` too.
  for (const erase of ["backward", "forward"] as const) {
    const { value, refs } = editable("abcdefghij");
    expect(typeInto(refs, 7, { text: null, erase, caret: 4, anchor: 1 })).toBe(true);
    expect(value.value, erase).toBe("aefghij");
  }
});

test("a backward selection edits the same as a forward one", () => {
  // The engine stores `(anchor, focus)` because that is what survives a Shift reversal, so
  // `caret` can be the *low* end. Measured to edit identically; splicing `caret..anchor`
  // without ordering them first would produce a negative slice and silently drop nothing.
  const forward = editable("abcdefghij");
  expect(typeInto(forward.refs, 7, { text: "Z", caret: 4, anchor: 1 })).toBe(true);

  const backward = editable("abcdefghij");
  expect(typeInto(backward.refs, 7, { text: "Z", caret: 1, anchor: 4 })).toBe(true);

  expect(backward.value.value).toBe(forward.value.value);
  expect(forward.value.value).toBe("aZefghij");
});

test("a collapsed range is a caret, not a zero-length selection", () => {
  // `anchor === caret` is what the engine sends whenever nothing is selected, which is most
  // of the time. Taking the range branch there would make every Backspace a no-op.
  const { value, refs } = editable("abcd");
  expect(typeInto(refs, 7, { text: null, erase: "backward", caret: 2, anchor: 2 })).toBe(true);
  expect(value.value).toBe("acd");

  // And an absent anchor — a host that never reports one — behaves the same way.
  const two = editable("abcd");
  expect(typeInto(two.refs, 7, { text: "X", caret: 2 })).toBe(true);
  expect(two.value.value).toBe("abXcd");
});

test("a selection past the end is clamped, not trusted", () => {
  // Both offsets crossed a process boundary, and app code may have shortened the signal
  // since the engine read it. Slicing at 99 would drop text silently.
  const { value, refs } = editable("abc");
  expect(typeInto(refs, 7, { text: "!", caret: 99, anchor: 1 })).toBe(true);
  expect(value.value).toBe("a!");
});

test("replacing a selection can free room at the cap", () => {
  // The ceiling is on the *result*, not on what was there before — so selecting the whole of
  // a full field and typing one character has to be allowed. Checking `chars.length + text`
  // as the collapsed path does would refuse it and leave the field uneditable forever.
  const full = "x".repeat(MAX_SLOT_CHARS);
  const { value, refs } = editable(full);
  expect(typeInto(refs, 7, { text: "y", caret: MAX_SLOT_CHARS, anchor: 0 })).toBe(true);
  expect(value.value).toBe("y");
});

test("the caret counts characters, not UTF-16 units", () => {
  // "😀" is one character and two UTF-16 units. The engine resolved the click by counting
  // *characters*, so slicing by `.length` here would put the insert in the middle of a
  // surrogate pair and produce two broken halves.
  const { value, refs } = editable("😀a");
  expect(typeInto(refs, 7, { text: "X", caret: 1 })).toBe(true);
  expect(value.value).toBe("😀Xa");

  // And backspace over the emoji removes the whole thing, not half of it.
  const two = editable("😀a");
  expect(typeInto(two.refs, 7, { text: null, erase: "backward", caret: 1 })).toBe(true);
  expect(two.value.value).toBe("a");
});
