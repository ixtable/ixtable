import { call } from "../lib/api";
import type { SessionState } from "../lib/types";
import type {
  BundleInfo,
  BundleSummary,
  ExportOptions,
  InstalledBundle,
  ResetPreview,
} from "./types";

export const exportRuntimeBundle = (path: string, options: ExportOptions) =>
  call<BundleInfo>("export_runtime_bundle", { path, options });
export const inspectRuntimeBundle = (path: string) =>
  call<BundleSummary>("inspect_runtime_bundle", { path });
export const openRuntimeBundle = (path: string, password?: string, allowDowngrade = false) =>
  call<SessionState>("open_runtime_bundle", {
    path,
    password: password || null,
    allowDowngrade,
  });
export const updateRuntimeInstallation = (
  path: string,
  password?: string,
  allowDowngrade = false,
) =>
  call<SessionState>("update_runtime_installation", {
    path,
    password: password || null,
    allowDowngrade,
  });
export const runtimeInstallationInfo = () => call<InstalledBundle>("runtime_installation_info");
export const previewInstallationReset = () => call<ResetPreview>("preview_installation_reset");
export const resetRuntimeInstallationData = () =>
  call<SessionState>("reset_runtime_installation_data", { confirmed: true });
export const documentState = () => call<SessionState>("document_state");
