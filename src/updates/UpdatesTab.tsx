import { useContext, useState } from "react";
import { documentState } from "../persistence/api";
import { DialogFrame } from "../components/DialogFrame";
import { ShellContext } from "../shell/context";
import { UpdatesPanel } from "./UpdatesPanel";

type Pending = { resolve: (ok: boolean) => void; failed: boolean };

/**
 * Settings → Updates. Installing never discards open work: unsaved changes are
 * saved first (after asking), and the install is cancelled if they stay unsaved.
 */
export function UpdatesTab() {
  const shell = useContext(ShellContext);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);

  const beforeInstall = async () => {
    // Start screen: no document is open.
    if (!shell) return true;
    let state = await documentState().catch(() => null);
    if (state && !state.dirty) return true;
    // A titled document saves in place without asking (the autosave path).
    if (state?.autosaveEligible) {
      await shell.save().catch(() => undefined);
      state = await documentState().catch(() => null);
      if (state && !state.dirty) return true;
    }
    const failed = !!state?.autosaveEligible;
    return new Promise<boolean>((resolve) => setPending({ resolve, failed }));
  };

  const answer = async (saveFirst: boolean) => {
    if (!pending || !shell) return;
    if (!saveFirst) {
      setPending(null);
      pending.resolve(false);
      return;
    }
    setSaving(true);
    await shell.save().catch(() => undefined);
    const state = await documentState().catch(() => null);
    setSaving(false);
    if (state && !state.dirty) {
      setPending(null);
      pending.resolve(true);
    } else setPending({ ...pending, failed: true });
  };

  return (
    <>
      {pending && (
        <DialogFrame
          className="updates-confirm"
          role="alertdialog"
          aria-modal="true"
          busy={saving}
          onClose={() => {
            answer(false).catch(() => undefined);
          }}
          aria-labelledby="updates-confirm-title"
          aria-describedby="updates-confirm-text"
        >
          <b id="updates-confirm-title">Save changes before updating?</b>
          <p id="updates-confirm-text">
            {pending.failed
              ? "Your changes were not saved, so the update was not installed. Save, or cancel and try later."
              : "ixtable relaunches after installing. Your unsaved changes are saved first."}
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="save"
              data-autofocus
              disabled={saving}
              onClick={() => answer(true)}
            >
              Save and install
            </button>
            <button type="button" disabled={saving} onClick={() => answer(false)}>
              Cancel
            </button>
          </div>
        </DialogFrame>
      )}
      <UpdatesPanel beforeInstall={beforeInstall} />
    </>
  );
}
