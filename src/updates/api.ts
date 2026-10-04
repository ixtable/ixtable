import { call } from "../lib/api";
import type { AvailableUpdate, UpdateChannel, UpdateProgress, UpdateSettings } from "./types";

/** Rust side of in-app updates (`src-tauri/src/updater`). */
export const updateSettings = () => call<UpdateSettings>("update_settings");
export const setUpdateSettings = (patch: { channel?: UpdateChannel; autoCheck?: boolean }) =>
  call<UpdateSettings>("set_update_settings", patch);

// These need the running app's updater plugin (not available in the test bridge).
export const checkForUpdate = () => call<AvailableUpdate | null>("check_for_update");
/** Downloads, verifies the signature, and installs; rejects with UPDATE_SIGNATURE_INVALID. */
export const installUpdate = () => call<void>("install_update");
export const updateProgress = () => call<UpdateProgress>("update_progress");
export const relaunchApp = () => call<void>("relaunch_app");
