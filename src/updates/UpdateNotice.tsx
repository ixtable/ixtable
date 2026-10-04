import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AvailableUpdate } from "./types";
import { UpdatesTab } from "./UpdatesTab";
import { checkOnStartup } from "./useUpdater";

/**
 * Start-up update check (when enabled in Settings → Updates). Only tells the
 * user; installing always waits for them.
 */
export function UpdateNotice() {
  const [found, setFound] = useState<AvailableUpdate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    checkOnStartup().then((update) => live && setFound(update));
    return () => {
      live = false;
    };
  }, []);
  if (!found || dismissed) return null;
  return (
    <div className="update-notice">
      <div className="update-banner" role="status">
        <span>ixtable {found.version} is available.</span>
        <button aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide update" : "Review update"}
        </button>
        <button aria-label="Dismiss update notice" onClick={() => setDismissed(true)}>
          <X />
        </button>
      </div>
      {open && <UpdatesTab />}
    </div>
  );
}
