import { useEffect, useState } from "react";
import { registerRecordHook } from "../lib/records";
import type { SessionState } from "../lib/types";
import { autosaveDocument, documentState } from "./api";
import { AutosaveController, type AutosaveView } from "./autosave";

export interface Autosave {
  view: AutosaveView;
  controller: AutosaveController;
}

/**
 * Owns the document's autosave controller. `onState` receives each SessionState an
 * autosave returns and must be stable. Record writes and database changes count as
 * edits; feed every other SessionState through `controller.sync`.
 */
export function useAutosave(
  onState: (state: SessionState) => void,
  initial: SessionState,
): Autosave {
  const [view, setView] = useState<AutosaveView>({
    status: "clean",
    eligible: false,
    lastSavedAt: null,
    error: null,
  });
  const [controller] = useState(
    () => new AutosaveController({ save: autosaveDocument, onState, onChange: setView }),
  );
  useEffect(() => {
    controller.resume();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => controller.sync(initial), [controller, initial]);
  useEffect(() => {
    // Ask the backend: database events also fire for reloads that change nothing.
    const changed = () => {
      documentState()
        .then((state) => controller.sync(state))
        .catch(() => undefined);
    };
    const unregister = registerRecordHook({ after: changed });
    window.addEventListener("ixtable:database-changed", changed);
    return () => {
      unregister();
      window.removeEventListener("ixtable:database-changed", changed);
    };
  }, [controller]);
  return { view, controller };
}
