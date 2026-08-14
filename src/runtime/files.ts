/**
 * Reading a file the user picked — the worker-side half of `input[type=file]`.
 *
 * The file dialog runs on the engine thread; the answer comes back as a path
 * string. This module is what turns that string into something useful: a
 * `FileInfo` with the metadata a browser's `File` object carries, and a
 * `readFile` that loads the bytes.
 *
 * Why not just `Bun.file`? It works, but it returns a `BunFile` whose API is
 * Bun-shaped. This wraps it in the smallest surface a UI author needs, and it
 * is where the path-normalisation rules live (strip `file://`, handle Windows
 * separators) so every caller does not repeat them.
 */

export type FileInfo = {
  /** Absolute path on disk. */
  path: string;
  /** File name without directory — what a browser calls `file.name`. */
  name: string;
  /** Byte size. */
  size: number;
  /** MIME type guessed from the extension, or "application/octet-stream". */
  type: string;
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
};

/**
 * Derives a `FileInfo` from a path. Reads the file's size from disk.
 * Works on the worker thread — no engine handle needed.
 */
export async function fileInfo(path: string): Promise<FileInfo> {
  const normalised = path.replace(/^file:\/\//, "").replace(/\//g, "\\");
  const name = normalised.split("\\").pop() ?? normalised;
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  const file = Bun.file(normalised);
  const size = file.size;
  return {
    path: normalised,
    name,
    size,
    type: MIME_BY_EXT[ext] ?? "application/octet-stream",
  };
}

/**
 * Reads the whole file as bytes. For an image picked via
 * `accept="image/*"` the bytes are what `<img src>` needs.
 */
export async function readFile(path: string): Promise<Uint8Array> {
  const normalised = path.replace(/^file:\/\//, "").replace(/\//g, "\\");
  return new Uint8Array(await Bun.file(normalised).arrayBuffer());
}

/**
 * Reads the whole file as text, for `accept=".txt,.json,.csv"` picks.
 */
export async function readFileText(path: string): Promise<string> {
  const normalised = path.replace(/^file:\/\//, "").replace(/\//g, "\\");
  return Bun.file(normalised).text();
}
