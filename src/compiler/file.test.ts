// file input compiler + runtime tests: accept, multiple, metadata helpers
import { expect, test } from "bun:test";
import { compile } from "./compile.ts";
import { ControlKind } from "../ir.ts";
import { parseAcceptToFilters } from "../host/main.ts";
import { fileInfo, readFile, readFileText } from "../runtime/files.ts";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- accept attribute → SDL filters -------------------------------------------

test("accept='image/*' produces an Images filter", () => {
  const filters = parseAcceptToFilters("image/*");
  expect(filters).toEqual([["Images", "png;jpg;jpeg;gif;webp;svg;bmp;ico"]]);
});

test("accept='.pdf,.doc' groups extensions", () => {
  const filters = parseAcceptToFilters(".pdf,.doc");
  expect(filters).toEqual([["Accepted files", "pdf;doc"]]);
});

test("accept='video/*,.mkv' combines wildcard and extension", () => {
  const filters = parseAcceptToFilters("video/*,.mkv");
  expect(filters).toContainEqual(["Videos", "mp4;webm;avi;mov;mkv"]);
  expect(filters).toContainEqual(["Accepted files", "mkv"]);
});

test("accept='text/plain' maps MIME to extension", () => {
  const filters = parseAcceptToFilters("text/plain");
  expect(filters).toEqual([["Accepted files", "plain"]]);
});

test("accept='' produces no filters", () => {
  expect(parseAcceptToFilters("")).toEqual([]);
});

// --- compiler captures accept / multiple on BuiltControl ------------------------

test("file input accept attribute is captured in compile result", () => {
  const result = compile('<body><input type="file" accept="image/*,.png"></body>', '');
  const fileCtrl = result.controls.find((c) => c.kind === ControlKind.FILE);
  expect(fileCtrl).toBeDefined();
  expect(fileCtrl!.accept).toBe("image/*,.png");
  expect(fileCtrl!.multiple).toBe(false);
});

test("file input multiple attribute is captured in compile result", () => {
  const result = compile('<body><input type="file" multiple></body>', '');
  const fileCtrl = result.controls.find((c) => c.kind === ControlKind.FILE);
  expect(fileCtrl).toBeDefined();
  expect(fileCtrl!.multiple).toBe(true);
});

test("file input with both accept and multiple", () => {
  const result = compile('<body><input type="file" accept=".jpg" multiple></body>', '');
  const fileCtrl = result.controls.find((c) => c.kind === ControlKind.FILE);
  expect(fileCtrl!.accept).toBe(".jpg");
  expect(fileCtrl!.multiple).toBe(true);
});

test("non-file inputs have no accept/multiple", () => {
  const result = compile('<body><input type="text" accept=".txt"><input type="checkbox"></body>', '');
  for (const c of result.controls) {
    expect(c.accept).toBeUndefined();
    expect(c.multiple).toBeUndefined();
  }
});

// --- fileInfo / readFile helpers -----------------------------------------------

const TMP_FILE = join(tmpdir(), "dziry-test-file.txt");
const TMP_CONTENT = "hello dziry";

test("fileInfo returns name, size, type for a text file", async () => {
  writeFileSync(TMP_FILE, TMP_CONTENT);
  try {
    const info = await fileInfo(TMP_FILE);
    expect(info.name).toBe("dziry-test-file.txt");
    expect(info.size).toBe(TMP_CONTENT.length);
    expect(info.type).toBe("text/plain");
  } finally {
    unlinkSync(TMP_FILE);
  }
});

test("fileInfo guesses MIME from extension", async () => {
  writeFileSync(TMP_FILE, "x");
  try {
    const png = TMP_FILE.replace(".txt", ".png");
    writeFileSync(png, "x");
    const info = await fileInfo(png);
    expect(info.type).toBe("image/png");
    unlinkSync(png);
  } finally {
    unlinkSync(TMP_FILE);
  }
});

test("readFile loads bytes", async () => {
  writeFileSync(TMP_FILE, TMP_CONTENT);
  try {
    const bytes = await readFile(TMP_FILE);
    expect(new TextDecoder().decode(bytes)).toBe(TMP_CONTENT);
  } finally {
    unlinkSync(TMP_FILE);
  }
});

test("readFileText loads string content", async () => {
  writeFileSync(TMP_FILE, TMP_CONTENT);
  try {
    const text = await readFileText(TMP_FILE);
    expect(text).toBe(TMP_CONTENT);
  } finally {
    unlinkSync(TMP_FILE);
  }
});

test("fileInfo strips file:// prefix", async () => {
  writeFileSync(TMP_FILE, TMP_CONTENT);
  try {
    const info = await fileInfo(`file://${TMP_FILE.replace(/\\/g, "/")}`);
    expect(info.name).toBe("dziry-test-file.txt");
    expect(info.size).toBe(TMP_CONTENT.length);
  } finally {
    unlinkSync(TMP_FILE);
  }
});
