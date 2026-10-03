import { TabPlaceholder } from "../shell/FeaturePlaceholder";

export function AssetsTab() {
  return (
    <TabPlaceholder
      title="Assets"
      description="Import, export, and clean up application assets stored in the archive."
    />
  );
}

export function LogsTab() {
  return (
    <TabPlaceholder title="Logs" description="Diagnostics for saving, recovery, and the runtime." />
  );
}
