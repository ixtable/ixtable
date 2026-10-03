import { ModePlaceholder } from "../shell/FeaturePlaceholder";

/** Query mode (PRD §12): visual query builder and SQL. Placeholder until the Queries feature lands. */
export function QueryMode() {
  return (
    <ModePlaceholder
      title="Query"
      description="Build saved queries visually or in SQL. Use New query in Data mode for SQL today."
    />
  );
}
