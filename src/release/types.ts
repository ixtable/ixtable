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
