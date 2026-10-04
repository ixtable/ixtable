import { call } from "../lib/api";
import type { SessionState } from "../lib/types";
import type {
  BundleInfo,
  BundleSummary,
  ExportOptions,
  InstalledBundle,
  PendingMigration,
  ResetPreview,
} from "./types";

export const exportRuntimeBundle = (path: string, options: ExportOptions) =>
  call<BundleInfo>("export_runtime_bundle", { path, options });
export const inspectRuntimeBundle = (path: string) =>
  call<BundleSummary>("inspect_runtime_bundle", { path });
export const openRuntimeBundle = (
  path: string,
  password?: string,
  allowDowngrade = false,
  expectedSha256?: string,
) =>
  call<SessionState>("open_runtime_bundle", {
    path,
    password: password || null,
    allowDowngrade,
    expectedSha256: expectedSha256 ?? null,
  });
export const updateRuntimeInstallation = (
  path: string,
  password: string,
  allowDowngrade: boolean,
  expectedSha256: string,
) =>
  call<SessionState>("update_runtime_installation", {
    path,
    password: password || null,
    allowDowngrade,
    expectedSha256,
  });
export const previewRuntimeUpdate = (path: string, password?: string) =>
  call<PendingMigration[]>("preview_runtime_update", { path, password: password || null });
export const runtimeInstallationInfo = () => call<InstalledBundle>("runtime_installation_info");
export const previewInstallationReset = () => call<ResetPreview>("preview_installation_reset");
export const resetRuntimeInstallationData = () =>
  call<SessionState>("reset_runtime_installation_data", { confirmed: true });
export const documentState = () => call<SessionState>("document_state");
