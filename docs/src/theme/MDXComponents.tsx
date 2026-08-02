/**
 * Components every page can use without importing them.
 *
 * Kept to the ones that exist to *prevent drift* — a page should not have to
 * remember an import in order to be checked.
 */
import MDXComponents from "@theme-original/MDXComponents";
import Status, { StatusTable } from "@site/src/components/Status";
import Guards, { Pipeline, TableRoles } from "@site/src/components/Guards";

export default {
  ...MDXComponents,
  Status,
  StatusTable,
  Guards,
  Pipeline,
  TableRoles,
};
