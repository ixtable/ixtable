import { ModePlaceholder } from "../shell/FeaturePlaceholder";

/** Reports mode (PRD §15). Placeholder until the Reports feature lands. */
export function ReportsMode() {
  return (
    <ModePlaceholder
      title="Reports"
      description="Design paginated reports from saved queries, then preview, print, or export PDF."
    />
  );
}
