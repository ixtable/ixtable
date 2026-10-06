import { call } from "../lib/api";
import type { SessionState } from "../lib/types";
import type {
  CloudConfig,
  CloudRuntimeInfo,
  DesktopAuthPoll,
  DesktopAuthStart,
  GrantResult,
  LocalInstallation,
  Preflight,
  TransferProgress,
  UploadResult,
} from "./types";

/** Rust side of ixtable Cloud (`src-tauri/src/cloud`). */
export const cloudConfig = () => call<CloudConfig>("cloud_config");

// supabase-js session storage sealed in the local secret store.
export const authStorageGet = (key: string) =>
  call<string | null>("cloud_auth_storage_get", { key });
export const authStorageSet = (key: string, value: string) =>
  call<void>("cloud_auth_storage_set", { key, value });
export const authStorageRemove = (key: string) => call<void>("cloud_auth_storage_remove", { key });

export const desktopAuthStart = (provider: "google" | "azure") =>
  call<DesktopAuthStart>("cloud_desktop_auth_start", { provider });
export const desktopAuthPoll = (state: string) =>
  call<DesktopAuthPoll>("cloud_desktop_auth_poll", { state });
export const signOutLocal = () => call<void>("cloud_sign_out_local");

export const publishPreflight = (runtimeUsers: number) =>
  call<Preflight>("cloud_publish_preflight", { runtimeUsers });
export const uploadArchive = (
  accessToken: string,
  appId: string,
  kind: "version" | "backup",
  transferId: string,
) => call<UploadResult>("cloud_upload_archive", { accessToken, appId, kind, transferId });
export const uploadCredential = (
  accessToken: string,
  appId: string,
  scope: "shared" | "user",
  userId: string | null,
  password: string | null,
  username: string | null = null,
) =>
  call<{ envelopeId?: string }>("cloud_upload_credential", {
    accessToken,
    appId,
    scope,
    userId,
    password,
    username,
  });
export const restoreCopy = (
  signedUrl: string,
  sha256: string,
  size: number,
  versionId: string | null,
  transferId: string,
) => call<SessionState>("cloud_restore_copy", { signedUrl, sha256, size, versionId, transferId });
export const transferProgress = (transferId: string) =>
  call<TransferProgress | null>("cloud_transfer_progress", { transferId });

export const installedApps = () => call<LocalInstallation[]>("cloud_installed_apps");
export const installApp = (
  accessToken: string,
  appId: string,
  userId: string,
  email: string,
  transferId: string,
) => call<SessionState>("cloud_install_app", { accessToken, appId, userId, email, transferId });
export const openInstalled = (appId: string) =>
  call<SessionState>("cloud_open_installed", { appId });
export const runtimeInfo = () => call<CloudRuntimeInfo>("cloud_runtime_info");
export const keyGrant = (accessToken: string) =>
  call<GrantResult>("cloud_key_grant", { accessToken });
export const releaseCredentials = () => call<void>("cloud_release_credentials");
