import { Cloud } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { SessionState } from "../lib/types";
import { installedApps } from "./api";
import { AcceptInvitation, AccountLine, SignInPanel } from "./auth";
import { useCloudSession } from "./useCloudSession";
import { listMemberApps } from "./client";
import { CloudErrorNotice } from "./CloudErrorNotice";
import { type CloudError, toCloudError } from "./errors";
import { openCloudApp } from "./open";
import { TransferBar } from "./TransferBar";
import { useTransfer } from "./transfer";
import type { LocalInstallation, MemberApp } from "./types";
import "./cloud.css";

type Row = { appId: string; name: string; roleName: string; installed?: LocalInstallation };

/** Start screen "Cloud apps": applications the signed-in user may run (PRD §5 steps 10–13). */
export function CloudApps({
  disabled,
  onOpened,
  onNotice,
}: {
  disabled?: boolean;
  onOpened: (state: SessionState) => void;
  onNotice: (notice: string) => void;
}) {
  const { session, ready } = useCloudSession();
  const [apps, setApps] = useState<Row[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<CloudError | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [revision, setRevision] = useState(0);
  const { progress, track } = useTransfer();
  const titleId = useId();
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) {
      setApps(null);
      return;
    }
    // After a sign-out the panel starts collapsed again.
    setShowSignIn(false);
    let active = true;
    Promise.all([listMemberApps(), installedApps().catch(() => [] as LocalInstallation[])])
      .then(([members, local]) => {
        if (!active) return;
        setOffline(false);
        setApps(merge(members, local));
      })
      .catch(async (reason) => {
        if (!active) return;
        const e = await toCloudError(reason);
        const local = await installedApps().catch(() => [] as LocalInstallation[]);
        setOffline(e.code === "CLOUD_OFFLINE");
        if (e.code !== "CLOUD_OFFLINE") setError(e);
        setApps(merge([], local));
      });
    return () => {
      active = false;
    };
  }, [userId, revision]);

  const open = async (row: Row) => {
    setBusy(row.installed ? `Opening ${row.name}…` : `Installing ${row.name}…`);
    setError(null);
    try {
      const { state, notice } = await openCloudApp(row.appId, track);
      if (notice) onNotice(notice);
      onOpened(state);
    } catch (reason) {
      setError(await toCloudError(reason));
    } finally {
      setBusy("");
    }
  };

  if (!ready) return null;
  return (
    <section className="start-section cloud-apps" aria-labelledby={titleId}>
      <div>
        <h2 id={titleId}>Cloud apps</h2>
        {!session && !showSignIn && (
          <button className="text-button" onClick={() => setShowSignIn(true)}>
            Sign in to ixtable Cloud
          </button>
        )}
      </div>
      {!session ? (
        showSignIn && <SignInPanel purpose="Sign in to run the applications you were invited to." />
      ) : (
        <>
          <AccountLine email={session.user.email ?? session.user.id} />
          <AcceptInvitation onAccepted={() => setRevision((n) => n + 1)} />
          {offline && (
            <p className="cloud-muted" role="status">
              ixtable Cloud is not reachable. Installed applications run offline.
            </p>
          )}
          {apps === null ? (
            <p className="cloud-muted" role="status">
              Loading cloud apps…
            </p>
          ) : apps.length === 0 ? (
            <p className="cloud-muted">No applications have been shared with you yet.</p>
          ) : (
            <ul className="recent-list" aria-label="Cloud applications">
              {apps.map((row) => (
                <li key={row.appId}>
                  <button
                    disabled={disabled || !!busy}
                    aria-label={`${row.installed ? "Open" : "Install"} cloud app ${row.name}`}
                    onClick={() => {
                      open(row).catch(() => undefined);
                    }}
                  >
                    <Cloud />
                    <span>
                      <b>{row.name}</b>
                      <small>
                        {row.roleName ? `Role: ${row.roleName}` : "Runtime user"}
                        {row.installed?.version
                          ? ` · installed ${row.installed.version}`
                          : " · not installed"}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {busy && (
        <div className="progress" role="status">
          {busy}
        </div>
      )}
      <TransferBar progress={progress} label="Download progress" />
      {error && <CloudErrorNotice error={error} />}
    </section>
  );
}

function merge(members: MemberApp[], local: LocalInstallation[]): Row[] {
  const rows: Row[] = members.map((m) => ({
    appId: m.appId,
    name: m.name,
    roleName: m.roleName,
    installed: local.find((l) => l.appId === m.appId),
  }));
  // Offline (or a listing failure): installed apps still run.
  if (!members.length)
    for (const l of local)
      rows.push({ appId: l.appId, name: l.appName ?? l.appId, roleName: "", installed: l });
  return rows;
}
