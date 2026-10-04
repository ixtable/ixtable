import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { keyGrant, releaseCredentials, runtimeInfo } from "./api";
import { getApp, requireSession } from "./client";
import { CloudErrorNotice } from "./CloudErrorNotice";
import { type CloudError, toCloudError } from "./errors";
import { InstallationBackups } from "./InstallationBackups";
import { openCloudApp } from "./open";
import {
  cloudRuntime,
  requestOpenSession,
  setCloudRuntime,
  subscribeCloudRuntime,
} from "./session";
import { TransferBar } from "./TransferBar";
import { useTransfer } from "./transfer";
import "./cloud.css";

/** Renew the 24-hour key grant this long before it expires. */
const RENEW_BEFORE_MS = 60 * 60 * 1000;
const short = (fingerprint: string) => fingerprint.slice(0, 16);

/**
 * Sidebar block of a cloud runtime session: licensee and fingerprint, role,
 * sync (auto-update), PostgreSQL key grant with renewal, and installation backup.
 */
export function CloudRuntimeBar() {
  const active = useSyncExternalStore(subscribeCloudRuntime, cloudRuntime);
  const info = active?.info;
  const [grant, setGrant] = useState<{ expiresAt: string | null; error: string | null } | null>(
    null,
  );
  const [revoked, setRevoked] = useState(false);
  const [backups, setBackups] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<CloudError | null>(null);
  const { progress, track } = useTransfer();
  const [renewAt, setRenewAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const requestGrant = useCallback(async () => {
    if (!info?.postgres) return;
    try {
      const session = await requireSession();
      const result = await keyGrant(session.access_token);
      setGrant({ expiresAt: result.expiresAt ?? null, error: result.error ?? null });
      setRevoked(false);
      window.dispatchEvent(new Event("ixtable:database-changed"));
      if (result.expiresAt) setRenewAt(Date.parse(result.expiresAt) - RENEW_BEFORE_MS);
    } catch (reason) {
      const e = await toCloudError(reason);
      if (e.code === "REVOKED" || e.code === "FORBIDDEN") {
        setRevoked(true);
        await releaseCredentials().catch(() => undefined);
        window.dispatchEvent(new Event("ixtable:database-changed"));
      }
      setError(e);
    }
  }, [info?.postgres]);

  // First grant on open, then renew before each grant expires (24-hour interval).
  useEffect(() => {
    requestGrant().catch(() => undefined);
  }, [requestGrant, tick]);
  useEffect(() => {
    if (renewAt == null) return;
    const wait = Math.min(Math.max(60_000, renewAt - Date.now()), 2 ** 31 - 1);
    const timer = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [renewAt]);
  useEffect(() => {
    if (!info) return;
    getApp(info.appId)
      .then((app) => setBackups(!!app?.backupsEnabled))
      .catch(() => setBackups(false));
  }, [info]);

  if (!info) return null;
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(await toCloudError(reason));
    } finally {
      setBusy("");
    }
  };
  const sync = () =>
    run("Checking for updates…", async () => {
      const { state, notice: message } = await openCloudApp(info.appId, track);
      setNotice(message || "You have the newest published version.");
      if (state.sessionId !== active?.sessionId) requestOpenSession(state);
      else setCloudRuntime(state.sessionId, await runtimeInfo());
    });

  return (
    <section className="runtime-bar cloud-runtime-bar" aria-label="Cloud application">
      <div className="document-label">
        <small>CLOUD APPLICATION</small>
        <strong>{info.appName}</strong>
        <span>Version {info.version}</span>
        <span>Role: {info.roleName ?? "none"}</span>
      </div>
      <p className="cloud-license">
        Licensed to {info.email} · fingerprint {short(info.fingerprint)}
      </p>
      {info.postgres && (
        <p className="cloud-muted" role="status">
          {revoked
            ? "Access revoked: the database credential was removed."
            : grant?.expiresAt
              ? `Database access authorized until ${new Date(grant.expiresAt).toLocaleString()}`
              : "Requesting database access…"}
        </p>
      )}
      {revoked && (
        <p className="error" role="alert">
          Your access to this application was revoked by its developer. Contact them to restore it.
        </p>
      )}
      <button type="button" className="runtime-bar-action" disabled={!!busy} onClick={sync}>
        Sync now
      </button>
      {backups && <InstallationBackups appId={info.appId} installationId={info.installationId} />}
      {busy && <p role="status">{busy}</p>}
      <TransferBar progress={progress} label="Transfer progress" />
      {notice && (
        <p role="status" className="cloud-update-notice">
          {notice}
        </p>
      )}
      {error && !revoked && <CloudErrorNotice error={error} />}
    </section>
  );
}
