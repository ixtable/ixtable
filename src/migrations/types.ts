/**
 * A declared SQL migration (PRD §24). `id` is immutable; `order` is explicit.
 * Migrations target the embedded SQLite store: `any` is a legacy spelling of `sqlite`,
 * and `postgres` is a validation error (PostgreSQL migrations are out of MVP scope).
 */
export interface Migration {
  id: string;
  name: string;
  order?: number;
  targetStore?: "sqlite" | "postgres" | "any" | (string & {});
  up?: string;
  down?: string | null;
  reversible?: boolean;
  dependsOn?: string[];
}

export interface MigrationLog {
  migrationId: string;
  name: string;
  direction: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  log: string[];
  health: string[];
  error: string | null;
  recovery: string | null;
}

export interface MigrationStatus {
  id: string;
  name: string;
  order: number;
  applied: boolean;
  appliesToStore: boolean;
  modified: boolean;
}

export interface MigrationRun {
  ok: boolean;
  checkpoint: { id: string; createdAt: string; reason: string } | null;
  logs: MigrationLog[];
}

export interface MigrationPreview {
  id: string;
  direction: string;
  sql: string;
  statements: string[];
  warnings: string[];
  store: string;
  transactional: boolean;
}
