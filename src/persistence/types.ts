import type { SessionState } from "../lib/types";

/** Application asset metadata (PRD §18); content stays in the archive/workspace. */
export interface Attachment {
  id: string;
  displayName: string;
  mediaType: string;
  checksum: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetImport {
  asset: Attachment;
  // Identical content already existed; its asset id was reused.
  deduplicated: boolean;
  state: SessionState;
}

export interface OrphanCleanup {
  removed: Attachment[];
  state: SessionState;
}

export interface SizeEntry {
  section: "records" | "config" | "assets" | string;
  id: string;
  name: string;
  bytes: number;
}

export interface ArchiveSizeReport {
  totalBytes: number;
  recordsBytes: number;
  configBytes: number;
  assetsBytes: number;
  otherBytes: number;
  // Fraction (0–1) of the archive taken by assets.
  assetShare: number;
  largest: SizeEntry[];
  cloudLimitBytes: number;
  overCloudLimit: boolean;
  measured: "saved" | "snapshot";
}

export interface CheckpointInfo {
  id: string;
  documentId: string;
  reason: string;
  createdAt: string;
  path: string;
  size: number;
}

export interface RecoveryRecord {
  sessionId: string;
  documentId: string;
  workspace: string;
  documentPath?: string | null;
  updatedAt: string;
  dirty: boolean;
  name?: string | null;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  area: string;
  message: string;
}
