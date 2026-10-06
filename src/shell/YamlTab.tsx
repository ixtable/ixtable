import { useEffect, useState } from "react";
import {
  applyDocumentConfigYaml,
  asTauriError,
  readDocumentConfigYaml,
  type TauriError,
} from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import { useShell } from "./context";

/** Code-first view of DocumentConfig: applying YAML replaces the config (PRD §8). */
export function YamlTab() {
  const { config, reload, settled } = useDocumentConfig();
  const { applySession } = useShell();
  const [yaml, setYaml] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TauriError | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (edited) return;
    let current = true;
    settled()
      .then(readDocumentConfigYaml)
      .then((text) => current && setYaml(text))
      .catch((reason: unknown) => current && setError(asTauriError(reason)));
    return () => {
      current = false;
    };
  }, [config, edited, settled]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      // Queued edits must land first, or one written after the YAML would replace it.
      await settled();
      applySession(await applyDocumentConfigYaml(yaml));
      await reload("Apply YAML");
      setEdited(false);
      setStatus("YAML applied.");
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-panel yaml-panel">
      <h2>Configuration YAML</h2>
      <p>
        Every definition in this application as YAML. Applying replaces the whole configuration;
        Undo restores the previous one.
      </p>
      <textarea
        aria-label="Configuration YAML"
        spellCheck={false}
        value={yaml}
        onChange={(event) => {
          setYaml(event.target.value);
          setEdited(true);
          setStatus("");
        }}
      />
      {error && (
        <div className="error" role="alert">
          <b>{error.code}</b>
          <span>{error.message}</span>
        </div>
      )}
      {status && <p role="status">{status}</p>}
      <div className="settings-actions">
        <button className="save" disabled={busy || !edited} onClick={apply}>
          Apply YAML
        </button>
        <button
          disabled={busy || !edited}
          onClick={() => {
            setEdited(false);
            setError(null);
          }}
        >
          Discard edits
        </button>
      </div>
    </div>
  );
}
