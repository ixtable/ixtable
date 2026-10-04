import type { Issue } from "../lib/types";
import type { ArchiveSizeReport } from "../persistence/types";
import type { Permissions } from "../runtime/types";

/** `DocumentConfig.cloud`: the cloud application a Studio document publishes to. */
export interface CloudLink {
  appId: string;
  orgId: string;
  // Published version this document is based on (`expectedHeadVersionId`).
  headVersionId?: string | null;
}

/** `cloud_config`: where ixtable Cloud is for this build. */
export interface CloudConfig {
  url: string;
  anonKey: string;
  siteUrl: string;
  configured: boolean;
  publicKeyFingerprint?: string | null;
}

export interface Organization {
  id: string;
  name: string;
  role: "owner" | "admin" | "billing" | "member";
}

export interface CloudApp {
  id: string;
  orgId: string;
  ownerId: string;
  name: string;
  documentId: string;
  backupsEnabled: boolean;
  headVersionId: string | null;
}

export interface AppVersion {
  id: string;
  version: string;
  createdAt: string;
  archiveSha256: string;
  archiveSize: number;
  releaseNotes: string;
  status: "pending" | "published" | "withdrawn";
  minRuntimeVersion: string;
  resolution?: string | null;
}

/** An app the signed-in user may run (active membership). */
export interface MemberApp {
  appId: string;
  name: string;
  roleId: string;
  roleName: string;
  status: "active" | "revoked";
}

export interface SecuritySummary {
  store: "sqlite" | "postgres";
  credentialMode?: "shared" | "perUser" | null;
  tls: boolean;
  sslmode?: string | null;
  insecureOverrideConfirmed: boolean;
  insecureOverrideConfirmedAt?: string | null;
  sharedCredentialWarning: boolean;
  entityPoliciesResolved: boolean;
}

/** `cloud_publish_preflight`. */
export interface Preflight {
  size: ArchiveSizeReport;
  issues: Issue[];
  blockers: string[];
  warnings: string[];
  security: SecuritySummary;
  migrations: { id: string; name: string }[];
  unresolvedEntities: string[];
  version: string;
  releaseNotes: string;
  minRuntimeVersion?: string | null;
}

export interface UploadResult {
  uploadId: string;
  path: string;
  sha256: string;
  size: number;
  installationId?: string | null;
}

export interface TransferProgress {
  done: number;
  total: number;
  phase: string;
}

export interface LocalInstallation {
  appId: string;
  installationId: string;
  deviceName: string;
  documentId?: string | null;
  appName?: string | null;
  version?: string | null;
  versionId?: string | null;
}

/** `cloud_runtime_info`: identity of an open cloud installation. */
export interface CloudRuntimeInfo {
  appId: string;
  appName: string;
  versionId: string;
  version: string;
  userId: string;
  email: string;
  roleId: string | null;
  roleName: string | null;
  rolePermissions: Partial<Permissions> | null;
  /** The signed manifest says this user is the app's Developer/Owner. */
  owner?: boolean;
  installationId: string;
  fingerprint: string;
  issuedAt: string;
  expiresAt: string;
  publicKeyFingerprint: string;
  postgres: boolean;
  datasourceId: string;
  grantExpiresAt?: string | null;
}

export interface GrantResult {
  needed: boolean;
  expiresAt?: string | null;
  attached: boolean;
  error?: string | null;
}

export interface DesktopAuthStart {
  state: string;
  url: string;
  opened: boolean;
}

export interface DesktopAuthPoll {
  status: "pending" | "approved";
  session?: {
    access_token: string;
    refresh_token: string;
    expires_at?: number;
    user?: unknown;
  } | null;
}

/** A runtime installation backup (`installation_backups` row, RLS: own or app admin). */
export interface InstallationBackup {
  id: string;
  installationId: string;
  archiveSha256: string;
  archiveSize: number;
  createdAt: string;
}

export interface RestoreTarget {
  signedUrl: string;
  sha256: string;
  size: number;
  isPostgres: boolean;
  warning?: string | null;
}
