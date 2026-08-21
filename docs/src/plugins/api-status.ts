/**
 * Parses the status table in `API.md` and hands it to the site as global data.
 *
 * `API.md` is the tracking authority for what the authoring API does today — it is
 * where "done", "partial" and "planned" are decided. The docs must not carry a
 * second copy of that judgement, because the second copy is the one that goes stale
 * and it goes stale in the flattering direction: a page keeps saying a feature works
 * for months after the table stopped claiming it.
 *
 * So the badges are read, not written. `<Status of="signal" />` looks the surface up
 * here, and a name that is not in the table is a **build error** rather than a
 * missing badge — documenting a surface the tracking table has never heard of is
 * exactly the drift this exists to catch.
 *
 * Parsed on every build via `loadContent`, so there is no generated file to keep in
 * sync and nothing to forget to regenerate.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadContext, Plugin } from "@docusaurus/types";

export type StatusKind = "done" | "partial" | "planned";

export type ApiStatus = {
  /** Lookup key -> status. Keys are backticked tokens and a slug of the row label. */
  byKey: Record<string, { status: StatusKind; label: string; milestone: string; note: string }>;
  /** Every row, in table order, for the API index page to render whole. */
  rows: { label: string; status: StatusKind; milestone: string; note: string }[];
};

/** `| a | b | c |` -> ["a", "b", "c"] */
function cells(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith("|")) return [];
  return t
    .slice(1, t.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((c) => c.trim());
}

const isDivider = (row: string[]): boolean => row.every((c) => /^:?-{2,}:?$/.test(c));

function classify(statusCell: string): StatusKind | null {
  const s = statusCell.toLowerCase();
  // Order matters: "partial" and "planned" both appear alongside prose, and a row
  // reading "**done** — …" must not be caught by a looser test first.
  if (/\bdone\b/.test(s)) return "done";
  if (/\bpartial\b/.test(s)) return "partial";
  if (/\bplanned\b/.test(s)) return "planned";
  return null;
}

/** `` `signal` `` -> signal; `` `.map(fn, { key })` `` -> map */
function keysIn(label: string): string[] {
  const out = new Set<string>();
  for (const m of label.matchAll(/`([^`]+)`/g)) {
    const raw = m[1]!.trim();
    out.add(raw);
    // The callable/leading-dot forms people actually type in `of="…"`.
    const bare = raw.replace(/^[.<]/, "").replace(/[>(].*$/, "").replace(/=$/, "").trim();
    if (bare) out.add(bare);
  }
  return [...out];
}

const slug = (s: string): string =>
  s
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function parseApiStatus(markdown: string): ApiStatus {
  const lines = markdown.split("\n");
  const byKey: ApiStatus["byKey"] = {};
  const rows: ApiStatus["rows"] = [];

  let inTable = false;
  for (const line of lines) {
    const row = cells(line);
    if (row.length < 2) {
      inTable = false;
      continue;
    }
    if (isDivider(row)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;

    const [label = "", statusCell = "", milestone = ""] = row;
    const status = classify(statusCell);
    if (!status) continue;

    // Everything after the status word is the qualifier — "partial — append and
    // backspace only" is the part a reader most needs, so it is kept.
    const note = statusCell.replace(/\*\*/g, "").replace(/^\s*(done|partial|planned)\s*[—-]?\s*/i, "").trim();
    const entry = { status, label, milestone: milestone === "—" ? "" : milestone, note };
    rows.push(entry);

    for (const k of [...keysIn(label), slug(label)]) {
      // First writer wins: a token appearing in two rows keeps the earlier, more
      // specific one rather than being silently overwritten by a later mention.
      if (k && !byKey[k]) byKey[k] = entry;
    }
  }

  return { byKey, rows };
}

export default function apiStatusPlugin(context: LoadContext): Plugin<ApiStatus> {
  const apiPath = join(context.siteDir, "..", "API.md");

  return {
    name: "dziry-api-status",

    async loadContent() {
      return parseApiStatus(readFileSync(apiPath, "utf8"));
    },

    async contentLoaded({ content, actions }) {
      if (!content.rows.length) {
        throw new Error(
          `dziry-api-status: parsed no status rows from ${apiPath}.\n` +
            `  The docs read their badges from that table, so an empty parse means every\n` +
            `  <Status/> would silently vanish. Either the table moved or its shape changed.`,
        );
      }
      actions.setGlobalData(content);
    },

    getPathsToWatch() {
      return [apiPath];
    },
  };
}
