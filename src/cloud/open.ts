import type { SessionState } from "../lib/types";
import { installApp, installedApps, openInstalled, runtimeInfo } from "./api";
import { invokeFunction, requireSession } from "./client";
import type { SyncCheck } from "./contract";
import { CloudError, toCloudError } from "./errors";
import { setCloudRuntime } from "./session";

export type OpenResult = { state: SessionState; notice: string };

/** Codes that mean "the cloud could not be asked", so the installed version may run. */
const OFFLINE = new Set(["CLOUD_OFFLINE", "CLOUD_TIMEOUT", "CLOUD_UNAVAILABLE"]);

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
        notice = `Updated to version ${sync.latest?.version ?? ""}. Your records were kept.`;
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
