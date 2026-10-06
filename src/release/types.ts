export type { ReleaseInfo } from "../lib/types";

/** Result of `export_runtime_bundle`. */
export interface BundleInfo {
  path: string;
  bundleId: string;
  name: string;
  version: string;
  minRuntimeVersion?: string | null;
  createdAt: string;
  size: number;
  sha256: string;
  signerFingerprint: string;
  encrypted: boolean;
}

export interface ExportOptions {
  version: string;
  releaseNotes: string;
  minRuntimeVersion?: string | null;
  password?: string | null;
}

/** Verified header of a bundle file and what opening it would do. */
export interface BundleSummary {
  bundleId: string;
  name: string;
  version: string;
  releaseNotes: string;
  minRuntimeVersion?: string | null;
  encrypted: boolean;
  signerFingerprint: string;
  installedVersion?: string | null;
  action: "install" | "open" | "update" | "downgrade";
  // Migrations an update would run; null for encrypted bundles (see previewRuntimeUpdate).
  pendingMigrations?: PendingMigration[] | null;
  // Why the migration preview could not be read; the bundle can still be applied.
  migrationsUnavailable?: string | null;
  // sha256 of the inspected file, passed back when applying it.
  sha256: string;
}

/** A migration an update would run on the installation's records. */
export interface PendingMigration {
  id: string;
  name: string;
  sql: string;
}

export interface InstalledBundle {
  bundleId: string;
  name: string;
  version: string;
  releaseNotes: string;
  signerFingerprint: string;
  installedAt: string;
  updatedAt: string;
  previousVersion?: string | null;
  // Migrations the last install or update ran on the records.
  appliedMigrations?: string[];
  // What the last apply did: install, open, update, or downgrade.
  lastAction?: "install" | "open" | "update" | "downgrade" | null;
}

export interface TableCount {
  name: string;
  rows: number;
}

export interface ResetPreview {
  bundleId: string;
  name: string;
  version: string;
  current: TableCount[];
  bundled: TableCount[];
  message: string;
}

/** Database login of a manually installed PostgreSQL bundle (never the password). */
export interface RuntimeLoginStatus {
  applies: boolean;
  attached: boolean;
  source: "grant" | "installation" | "studio" | "none";
  user: string;
  host: string;
  database: string;
  sslmode: string;
  serverVerified: boolean;
  needsLogin: boolean;
  reason?: "missing" | "rejected" | null;
  error?: string | null;
}
