import { expect, test } from "bun:test";
import {
  describeThrown,
  hideRedbox,
  reportFailure,
  setFailureSink,
  showRedbox,
} from "./redbox.ts";
import type { CompiledUi, RedboxNodes } from "../ir.ts";

/**
 * The three nodes as the artifact carries them: box 5, whose two TEXT children
 * (6 and 7) point at reserved slots 2 and 3. The slot indirection through
 * `nodes.text` is the thing worth pinning — the ref carries node ids only, so a
 * repacked string table cannot strand it.
 */
function ui(): { ui: CompiledUi; redbox: RedboxNodes } {
  return {
    ui: {
      strings: ["app", "text", "", ""],
      nodes: {
        hidden: new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0]),
        text: new Int32Array([-1, -1, -1, -1, -1, -1, 2, 3]),
      },
    } as unknown as CompiledUi,
    redbox: { root: 5, title: 6, detail: 7 },
  };
}

test("showing writes the message and clears the hidden byte", () => {
  const { ui: u, redbox } = ui();

  const changed = showRedbox(u, redbox, "Build failed", "line 4: no such class");

  expect(u.strings[2]).toBe("Build failed");
  expect(u.strings[3]).toBe("line 4: no such class");
  expect(u.nodes.hidden[5]).toBe(0);
  // The text nodes need re-measuring, exactly like a binding write.
  expect(changed).toEqual([6, 7]);
  // Nothing else was touched — the box is three nodes, not a repaint of the world.
  expect(u.strings[0]).toBe("app");
  expect(u.nodes.hidden[4]).toBe(0);
});

test("hiding puts the byte back and leaves the message alone", () => {
  const { ui: u, redbox } = ui();
  showRedbox(u, redbox, "t", "d");

  hideRedbox(u, redbox);

  expect(u.nodes.hidden[5]).toBe(1);
  // The stale message is invisible with the byte set; clearing it would be an
  // extra string upload for nothing.
  expect(u.strings[2]).toBe("t");
});

test("a second failure overwrites the first — the box shows the latest", () => {
  const { ui: u, redbox } = ui();
  showRedbox(u, redbox, "first", "a");
  showRedbox(u, redbox, "second", "b");
  expect(u.strings[2]).toBe("second");
  expect(u.strings[3]).toBe("b");
});

test("reportFailure reaches the registered sink, and only while registered", () => {
  const seen: [string, string][] = [];

  reportFailure("before any sink", "dropped"); // must not throw
  setFailureSink((t, d) => seen.push([t, d]));
  reportFailure("onClick handler failed", "boom");
  setFailureSink(null);
  reportFailure("after removal", "dropped");

  expect(seen).toEqual([["onClick handler failed", "boom"]]);
});

test("describeThrown keeps a stack when there is one and stringifies the rest", () => {
  const described = describeThrown(new Error("boom"));
  expect(described).toContain("boom");
  expect(described).toContain("redbox.test"); // the stack names this file

  expect(describeThrown("a bare string")).toBe("a bare string");
  expect(describeThrown(42)).toBe("42");
});
