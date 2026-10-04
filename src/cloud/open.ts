import type { SessionState } from "../lib/types";
import { runtimeInstallationInfo } from "../release/api";
import { installApp, installedApps, openInstalled, runtimeInfo } from "./api";
import { invokeFunction, requireSession, versionReleaseNotes } from "./client";
import type { SyncCheck } from "./contract";
import { CloudError, toCloudError } from "./errors";
import { setCloudRuntime } from "./session";

export type OpenResult = { state: SessionState; notice: string };

/** Codes that mean "the cloud could not be asked", so the installed version may run. */
const OFFLINE = new Set(["CLOUD_OFFLINE", "CLOUD_TIMEOUT", "CLOUD_UNAVAILABLE"]);

/**
 * Post-update notice (PRD §22.3): the version, the migrations that ran on this
 * installation's records, and the release notes. Notes and migrations are best
 * effort; the update itself already succeeded.
 */
export async function updateNotice(versionId: string | null, version: string): Promise<string> {
  const info = await runtimeInstallationInfo().catch(() => null);
  // The record says this apply did not change versions (e.g. already installed).
  if (info && info.lastAction !== "update" && info.lastAction !== "downgrade") {
    return `Running version ${info.version}.`;
  }
  const notes = versionId ? await versionReleaseNotes(versionId).catch(() => "") : "";
  const migrations = info?.appliedMigrations ?? [];
  let text = `Updated to version ${version}. Your records were kept.`;
  text += migrations.length
    ? ` Migrations applied: ${migrations.join(", ")}.`
    : " No migrations were needed.";
  if (notes.trim()) text += `\nRelease notes:\n${notes.trim()}`;
  return text;
}

/**
 * Opens a cloud app for its runtime user (PRD §22.3): installs it on first
 * use; otherwise `sync-check` and, when a newer checkpoint is published,
 * updates through the verified install flow before opening. Offline, the
 * last installed version runs. A revoked or unentitled user is told so.
 */
export async function openCloudApp(
  appId: string,
  track: <T>(run: (transferId: string) => Promise<T>) => Promise<T>,
): Promise<OpenResult> {
  const installed = (await installedApps()).find((app) => app.appId === appId);
  let state: SessionState;
  let notice = "";
  const install = async () => {
    const session = await requireSession();
    return track((id) =>
      installApp(session.access_token, appId, session.user.id, session.user.email ?? "", id),
    );
  };
  if (!installed) {
    state = await install();
    notice = "Installed from ixtable Cloud.";
  } else {
    let sync: SyncCheck | null = null;
    try {
      sync = await invokeFunction("sync-check", {
        appId,
        installedVersionId: installed.versionId ?? null,
        installationId: installed.installationId,
      });
    } catch (reason) {
      const error = await toCloudError(reason);
      if (!OFFLINE.has(error.code)) throw error;
      notice = `Offline: running the installed version ${installed.version ?? ""}.`.replace(
        " .",
        ".",
      );
    }
    if (sync && !sync.upToDate) {
      try {
        state = await install();
        notice = await updateNotice(
          sync.latest?.versionId ?? null,
          sync.latest?.version ?? state.bundleVersion ?? "",
        );
      } catch (reason) {
        const error = await toCloudError(reason);
        // A failed update leaves the previous version installed; run it and say why.
        if (error.code === "REVOKED" || error.code === "FORBIDDEN") throw error;
        state = await openInstalled(appId);
        notice = `The update could not be installed (${error.message}). Running version ${installed.version ?? ""}.`;
      }
    } else {
      state = await openInstalled(appId);
    }
  }
  const info = await runtimeInfo();
  if (info.appId !== appId)
    throw new CloudError("INSTALLATION_CORRUPT", "Opened the wrong application.");
  setCloudRuntime(state.sessionId, info);
  return { state, notice };
}
