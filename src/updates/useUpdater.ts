import { useCallback, useEffect, useRef, useState } from "react";
import { asTauriError, type TauriError } from "../lib/api";
import {
  checkForUpdate,
  installUpdate,
  relaunchApp,
  setUpdateSettings,
  updateProgress,
  updateSettings,
} from "./api";
import type { AvailableUpdate, UpdateChannel, UpdateProgress, UpdateSettings } from "./types";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "installing"
  | "installed"
  | "error";

// The latest check result, shared by the start-up notice and the Updates tab.
let lastCheck: AvailableUpdate | null = null;
let startupCheck: Promise<AvailableUpdate | null> | null = null;

/** Checks once per launch when the auto-check preference is on. Never downloads. */
export function checkOnStartup(): Promise<AvailableUpdate | null> {
  startupCheck ??= updateSettings()
    .then((settings) => (settings.autoCheck ? checkForUpdate() : null))
    .then((found) => {
      lastCheck = found;
      return found;
    })
    // A failed background check stays quiet; Settings → Updates shows errors.
    .catch(() => null);
  return startupCheck;
}

/** Forgets earlier check results (a channel switch, tests). */
export function resetUpdateState() {
  lastCheck = null;
  startupCheck = null;
}

const PROGRESS_POLL_MS = 250;

/**
 * Updates tab state: settings, check, and install. `beforeInstall` protects open
 * work (save or cancel) and resolves false to abort.
 */
export function useUpdater(beforeInstall: () => Promise<boolean>) {
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [available, setAvailable] = useState<AvailableUpdate | null>(lastCheck);
  const [status, setStatus] = useState<UpdateStatus>(lastCheck ? "available" : "idle");
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<TauriError | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = () => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
  };
  useEffect(() => stopPolling, []);
  useEffect(() => {
    updateSettings()
      .then(setSettings)
      .catch((reason: unknown) => setError(asTauriError(reason)));
  }, []);

  const fail = (reason: unknown) => {
    setError(asTauriError(reason));
    setStatus("error");
  };

  const save = useCallback(async (patch: { channel?: UpdateChannel; autoCheck?: boolean }) => {
    setError(null);
    try {
      setSettings(await setUpdateSettings(patch));
      if (patch.channel) {
        // A release found on the other channel no longer applies.
        resetUpdateState();
        setAvailable(null);
        setStatus("idle");
      }
    } catch (reason) {
      setError(asTauriError(reason));
    }
  }, []);

  const check = async () => {
    setError(null);
    setStatus("checking");
    try {
      const found = await checkForUpdate();
      lastCheck = found;
      setAvailable(found);
      setStatus(found ? "available" : "current");
    } catch (reason) {
      fail(reason);
    }
  };

  const relaunch = async () => {
    setError(null);
    try {
      await relaunchApp();
    } catch (reason) {
      setError(asTauriError(reason));
    }
  };

  const install = async () => {
    setError(null);
    if (!(await beforeInstall())) return;
    setStatus("installing");
    setProgress({ phase: "downloading", downloaded: 0, total: null });
    poll.current = setInterval(() => {
      updateProgress()
        .then(setProgress)
        .catch(() => undefined);
    }, PROGRESS_POLL_MS);
    try {
      await installUpdate();
    } catch (reason) {
      stopPolling();
      setProgress(null);
      // The pending update is consumed by a failed install; check again to retry.
      lastCheck = null;
      setAvailable(null);
      fail(reason);
      return;
    }
    stopPolling();
    setProgress(await updateProgress().catch(() => null));
    lastCheck = null;
    setStatus("installed");
    await relaunch();
  };

  return { settings, available, status, progress, error, save, check, install, relaunch };
}
