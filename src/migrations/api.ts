import { call } from "../lib/api";
import type { MigrationLog, MigrationPreview, MigrationRun, MigrationStatus } from "./types";

export const migrationStatus = () => call<MigrationStatus[]>("migration_status");
export const migrationHistory = () => call<MigrationLog[]>("migration_history");
export const previewMigration = (id: string, direction: "up" | "down" = "up") =>
  call<MigrationPreview>("preview_migration", { id, direction });
export const dryRunMigrations = (ids?: string[]) =>
  call<MigrationLog>("dry_run_migrations", { ids: ids ?? null });
/** PostgreSQL stores need `externalBackupConfirmed`: checkpoints do not copy PostgreSQL records. */
export const applyMigrations = (externalBackupConfirmed = false) =>
  call<MigrationRun>("apply_migrations", { externalBackupConfirmed });
export const rollbackMigration = (externalBackupConfirmed = false) =>
  call<MigrationRun>("rollback_migration", { externalBackupConfirmed });
