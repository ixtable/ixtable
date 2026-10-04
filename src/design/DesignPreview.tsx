import { useEffect, useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { firstRecordId, sourceParams } from "../runtime/data";
import { useRuntimeNavigation } from "../runtime/navigation";
import { FormRenderer } from "../runtime/FormRenderer";
import type { DesignForm, FormMode } from "./schema";

/** Design-time preview of the selected form in one mode, with live data. */
export function DesignPreview({ form, mode }: { form: DesignForm; mode: FormMode }) {
  const { config } = useDocumentConfig();
  const { app } = useRuntimeNavigation();
  const needsRecord = mode === "detail" || mode === "edit";
  const [recordId, setRecordId] = useState<unknown>(undefined);
  const [state, setState] = useState<"loading" | "ready" | "empty">("loading");

  useEffect(() => {
    let live = true;
    if (!needsRecord) {
      setState("ready");
      return;
    }
    setState("loading");
    Promise.resolve()
      .then(() => {
        const scope = { app, params: {} };
        return firstRecordId(form, sourceParams(form, scope), scope);
      })
      .then((id) => {
        if (!live) return;
        setRecordId(id);
        setState(id == null ? "empty" : "ready");
      })
      .catch(() => live && setState("empty"));
    return () => {
      live = false;
    };
  }, [config, form, needsRecord, app]);

  return (
    <section className="app-preview fd-preview" aria-label={`${form.name} preview`}>
      {state === "loading" && <p className="rt-muted">Loading preview…</p>}
      {state === "empty" && <p className="rt-muted">No live records to display.</p>}
      {state === "ready" && (
        <FormRenderer formId={form.id} mode={mode} recordId={needsRecord ? recordId : undefined} />
      )}
    </section>
  );
}
