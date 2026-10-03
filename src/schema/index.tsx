import { TabPlaceholder } from "../shell/FeaturePlaceholder";

export function DatasourceTab() {
  return (
    <TabPlaceholder
      title="Datasource"
      description="Choose the SQLite or PostgreSQL record store for this application."
    />
  );
}

export function EntitiesTab() {
  return (
    <TabPlaceholder title="Entities" description="Set the record-conflict policy for each table." />
  );
}
