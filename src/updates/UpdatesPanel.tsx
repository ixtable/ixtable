import { describeProgress, describeUpdateError } from "./format";
import { UPDATE_CHANNELS, type UpdateChannel } from "./types";
import { useUpdater } from "./useUpdater";

const STATUS_TEXT: Partial<Record<string, string>> = {
  checking: "Checking for updates…",
  current: "ixtable is up to date.",
  installing: "Installing update…",
  installed: "Update installed.",
};

/** Version, channel, check, download progress, and install & relaunch (PRD §6.1). */
export function UpdatesPanel({ beforeInstall }: { beforeInstall: () => Promise<boolean> }) {
  const { settings, available, status, progress, error, save, check, install, relaunch } =
    useUpdater(beforeInstall);
  const busy = status === "checking" || status === "installing";
  const channel = UPDATE_CHANNELS.find((item) => item.id === settings?.channel);
  return (
    <div className="settings-panel updates-panel">
      <h2>Updates</h2>
      <dl className="updates-facts">
        <dt>Current version</dt>
        <dd>{settings ? settings.currentVersion : "…"}</dd>
      </dl>
      <div className="updates-fields">
        <label>
          Update channel
          <select
            value={settings?.channel ?? "stable"}
            disabled={!settings || busy}
            onChange={(event) => save({ channel: event.target.value as UpdateChannel })}
          >
            {UPDATE_CHANNELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {channel && <small>{channel.hint}</small>}
        <label className="updates-toggle">
          <input
            type="checkbox"
            checked={settings?.autoCheck ?? true}
            disabled={!settings}
            onChange={(event) => save({ autoCheck: event.target.checked })}
          />
          Check for updates when ixtable starts
        </label>
      </div>
      <div className="settings-actions">
        <button disabled={!settings || busy} onClick={() => check()}>
          Check for updates
        </button>
        <span role="status">{STATUS_TEXT[status] ?? ""}</span>
      </div>
      {available && status !== "installed" && (
        <section className="updates-available" aria-label="Available update">
          <h3>ixtable {available.version} is available</h3>
          <p>
            You have {available.currentVersion}. ixtable saves your open document, installs the
            update, and relaunches.
          </p>
          {available.notes && <pre className="updates-notes">{available.notes}</pre>}
          <button className="save" disabled={busy} onClick={() => install()}>
            Install and relaunch
          </button>
        </section>
      )}
      {progress && status === "installing" && (
        <div className="updates-progress">
          <progress
            aria-label="Update download"
            max={progress.total || 1}
            value={progress.total ? progress.downloaded : undefined}
          />
          <small>{describeProgress(progress)}</small>
        </div>
      )}
      {status === "installed" && (
        <div className="settings-actions">
          <button onClick={() => relaunch()}>Relaunch now</button>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          <b>{error.code}</b>
          <span>{describeUpdateError(error.code, error.message)}</span>
        </div>
      )}
      <p className="updates-security">
        Every update is signed. ixtable checks the signature against the key built into this version
        and refuses any package that fails the check.
      </p>
    </div>
  );
}
