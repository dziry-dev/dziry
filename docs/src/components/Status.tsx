/**
 * `<Status of="signal" />` — a badge whose value comes from `API.md`.
 *
 * Not a prop you set. The whole point is that the docs cannot claim a surface works
 * while the tracking table says otherwise, so the only thing a page chooses is
 * *which* surface it is talking about.
 *
 * An unknown name throws during the build. That is deliberate and it is the useful
 * half: it means you cannot document an API that the status table has never heard
 * of, and when a row is renamed in `API.md` every page pointing at it fails loudly
 * instead of quietly losing its badge.
 */
import React from "react";
import { usePluginData } from "@docusaurus/useGlobalData";
import type { ApiStatus, StatusKind } from "../plugins/api-status";

const LABEL: Record<StatusKind, string> = {
  done: "done",
  partial: "partial",
  planned: "planned",
};

export function useApiStatus(): ApiStatus {
  return usePluginData("dziry-api-status") as ApiStatus;
}

export default function Status({ of, note }: { of: string; note?: boolean }): React.JSX.Element {
  const data = useApiStatus();
  const entry = data.byKey[of];

  if (!entry) {
    const known = Object.keys(data.byKey).sort().slice(0, 24).join(", ");
    throw new Error(
      `<Status of="${of}" /> — no such row in API.md.\n` +
        `  Badges are read from the status table so the docs cannot outrun it. Either add\n` +
        `  the surface to that table, or use a name it already has.\n` +
        `  Known keys include: ${known}…`,
    );
  }

  return (
    <>
      <span className={`status status--${entry.status}`} title={entry.note || undefined}>
        {LABEL[entry.status]}
      </span>
      {note && entry.note ? <em> — {entry.note}</em> : null}
    </>
  );
}

/**
 * The whole table, rendered. Used by the API index so there is exactly one list of
 * what works and it is the one in `API.md`.
 */
export function StatusTable(): React.JSX.Element {
  const { rows } = useApiStatus();
  return (
    <table>
      <thead>
        <tr>
          <th>Surface</th>
          <th>Status</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td dangerouslySetInnerHTML={{ __html: inlineCode(r.label) }} />
            <td>
              <span className={`status status--${r.status}`}>{LABEL[r.status]}</span>
            </td>
            <td dangerouslySetInnerHTML={{ __html: inlineCode(r.note) }} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Markdown backticks to `<code>`, and nothing else.
 *
 * The input is `API.md`, a file in this repo written by the people building it —
 * not user input — but it still reaches `dangerouslySetInnerHTML`, so everything is
 * escaped first and only the backtick spans are turned back into markup.
 */
function inlineCode(s: string): string {
  const escaped = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
}
