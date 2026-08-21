/**
 * The guard scripts, listed from `architecture/data.ts`.
 *
 * Not hand-written here, because `bun run arch:check` validates that list against
 * `package.json` — a renamed script fails that run. A prose table in a Markdown file
 * would have no such check, and the guards are exactly the thing whose names must
 * still work when someone copies them out of the docs.
 */
import React from "react";
import { usePluginData } from "@docusaurus/useGlobalData";
import type { ArchData } from "../plugins/arch-data";

export function useArchData(): ArchData {
  return usePluginData("dziry-arch-data") as ArchData;
}

export default function Guards(): React.JSX.Element {
  const { guards } = useArchData();

  return (
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Proves</th>
          <th>Oracle</th>
        </tr>
      </thead>
      <tbody>
        {guards.map((g) => (
          <tr key={g.script}>
            <td>
              <code>bun run {g.script}</code>
              <br />
              <small>{g.title}</small>
            </td>
            <td>{g.what}</td>
            <td>{g.oracle ? <em>{g.oracle}</em> : <span title="Checked against itself — an internal invariant, not an external authority">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The compile pipeline, by phase. Used by the internals overview. */
export function Pipeline({ phase }: { phase?: "build" | "boundary" | "frame" }): React.JSX.Element {
  const { stages } = useArchData();
  const shown = phase ? stages.filter((s) => s.phase === phase) : stages;

  return (
    <ol>
      {shown.map((s) => (
        <li key={s.id}>
          <strong>{s.title}</strong> — {s.summary}
          {s.invariant ? (
            <>
              <br />
              <small>
                <strong>Invariant:</strong> {s.invariant}
              </small>
            </>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Who writes and who reads each shared-memory table. */
export function TableRoles(): React.JSX.Element {
  const { tableRoles } = useArchData();

  return (
    <table>
      <thead>
        <tr>
          <th>Table</th>
          <th>Written by</th>
          <th>Read by</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(tableRoles).map(([name, r]) => (
          <tr key={name}>
            <td>
              <code>{name}</code>
            </td>
            <td>{r.writer}</td>
            <td>{r.reader}</td>
            <td>{r.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
