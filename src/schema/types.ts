export interface DatasourceConfig {
  kind: "sqlite" | "postgres" | (string & {});
}

export interface EntitySettings {
  id: string;
  table: string;
}
