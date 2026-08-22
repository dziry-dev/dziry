/**
 * Re-exports `guards/architecture/data.ts` to the docs site as global data.
 *
 * That file is already the single source of truth for the architecture map, and
 * `bun run arch:check` validates it: every claim that names a file carries a
 * citation, and a renamed guard script or a moved source file fails that run. So the
 * docs read it rather than restating it — a second prose copy of the pipeline would
 * be a second thing to update, and the one that quietly stops being true.
 *
 * `data.ts` is pure data with no imports, which is what makes this a five-line
 * plugin instead of a bundler problem.
 */
import { join } from "node:path";
import type { LoadContext, Plugin } from "@docusaurus/types";
import {
  BETS,
  DOCS,
  FIGURE_ORDER,
  GUARDS,
  LAYERS,
  MILESTONES,
  STAGES,
  TABLE_ROLES,
} from "../../../guards/architecture/data.ts";

export type ArchData = {
  layers: typeof LAYERS;
  stages: typeof STAGES;
  tableRoles: typeof TABLE_ROLES;
  bets: typeof BETS;
  guards: typeof GUARDS;
  milestones: typeof MILESTONES;
  figures: typeof FIGURE_ORDER;
  docs: typeof DOCS;
};

export default function archDataPlugin(context: LoadContext): Plugin<ArchData> {
  return {
    name: "dziry-arch-data",

    async loadContent() {
      return {
        layers: LAYERS,
        stages: STAGES,
        tableRoles: TABLE_ROLES,
        bets: BETS,
        guards: GUARDS,
        milestones: MILESTONES,
        figures: FIGURE_ORDER,
        docs: DOCS,
      };
    },

    async contentLoaded({ content, actions }) {
      actions.setGlobalData(content);
    },

    getPathsToWatch() {
      return [join(context.siteDir, "..", "guards", "architecture", "data.ts")];
    },
  };
}
