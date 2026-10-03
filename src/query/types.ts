export interface QueryParameter {
  name: string;
  logicalType: string;
  defaultValue?: unknown;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  filterState?: unknown;
  parameters?: QueryParameter[];
  builder?: unknown;
}
