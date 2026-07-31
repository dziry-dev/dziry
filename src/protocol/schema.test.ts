/**
 * The compiler and the engine each decide what "paint-only" means, and they
 * decide it in different files from different lists.
 *
 * `ir.ts`'s `LAYOUT_FIELDS` is what the compiler uses to tell a conditional
 * class it needs a relayout; `schema.ts`'s `affects` is what the engine uses to
 * decide whether Taffy hears about a patch. They are the same claim about the
 * same field, spelled twice — `padT` on one side, `padTop` on the other — and
 * nothing but this file makes them agree. Disagreement is silent in the
 * dangerous direction: the compiler says a toggle is paint-only, the engine
 * believes it, and a box that should have moved does not.
 */
import { expect, test } from "bun:test";

import { LAYOUT_FIELDS, STYLE_FIELDS } from "../ir.ts";
import { NUMBER_FIELDS } from "../engine/upload.ts";
import { F, FIELD_NAMES, LAYOUT_AFFECTING } from "./generated.ts";

const styles = LAYOUT_AFFECTING.styles;

test("the schema classifies every styles field", () => {
  expect(styles).toBeDefined();
  expect(styles!.length).toBe(FIELD_NAMES.styles.length);
});

test("the engine and the compiler agree on which fields move a box", () => {
  const layout = new Set<string>(LAYOUT_FIELDS);
  const disagreements: string[] = [];

  for (const [schemaName, irName] of NUMBER_FIELDS) {
    const engineSays = styles![F.styles[schemaName]]!;
    const compilerSays = layout.has(irName);
    if (engineSays !== compilerSays) {
      disagreements.push(
        `${schemaName}/${irName}: schema says ${engineSays ? "layout" : "paint"}, ` +
          `ir.ts says ${compilerSays ? "layout" : "paint"}`,
      );
    }
  }

  expect(disagreements).toEqual([]);
});

test("the only unmapped schema fields are the two the IR has not caught up with", () => {
  // `lineClamp` and `overflow` exist in the schema and not in the IR, because
  // the engine implements neither paragraph clamping nor clipping — writing them
  // would be claiming a feature. This pins that list so a *third* one cannot
  // appear unnoticed and go un-uploaded, which is the failure mode of a
  // hand-written mapping table.
  const mapped = new Set(NUMBER_FIELDS.map(([schemaName]) => schemaName as string));
  const unmapped = FIELD_NAMES.styles.filter((name) => !mapped.has(name));
  expect(unmapped).toEqual(["lineClamp", "overflow"]);
});

test("every IR style field reaches the schema", () => {
  // The other direction: a field the compiler resolves but never uploads is a
  // computed value that silently does nothing.
  const mapped = new Set(NUMBER_FIELDS.map(([, irName]) => irName as string));
  const missing = STYLE_FIELDS.map((f) => f[0]).filter((name) => !mapped.has(name));
  expect(missing).toEqual([]);
});
