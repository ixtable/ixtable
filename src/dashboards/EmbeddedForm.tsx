/** A form placed on a dashboard, bound to a record for detail/edit modes. */
import { useEffect, useMemo, useState } from "react";
import { DATABASE_CHANGED_EVENT } from "../automation/context";
import { evaluate } from "../expr";
import { useDocumentConfig } from "../lib/config-store";
import { RECORDS_CHANGED_EVENT } from "../lib/records";
import { firstRecordId, sourceParams } from "../runtime/data";
import { FormRenderer } from "../runtime/FormRenderer";
import { useRuntimeNavigation } from "../runtime/navigation";
import { resolveForm } from "../runtime/registry";
import { embeddableModes } from "./model";
import type { DashboardComponent } from "./types";

type Binding =
  | { status: "loading" }
  | { status: "ready"; recordId?: unknown }
  | { status: "empty" }
  | { status: "error"; message: string };

/**
 * Renders the component's form with the dashboard `params` in scope. Detail and
 * edit modes open the record named by `recordId` (an expression over `params`
 * and `app`), or the first row of the form's source when it is blank; that row
 * is looked up again after record writes.
 */
export function EmbeddedForm({
  component,
  params,
}: {
  component: DashboardComponent;
  params: Record<string, unknown>;
}) {
  const { config } = useDocumentConfig();
  const { app } = useRuntimeNavigation();
  const form = component.formId ? resolveForm(config, component.formId) : null;
  const mode = component.mode ?? form?.modes[0] ?? "list";
  const needsRecord = mode === "detail" || mode === "edit";
  const supported = !form || embeddableModes(form).includes(mode);
  const expression = component.recordId?.trim() ?? "";
  const [binding, setBinding] = useState<Binding>({ status: needsRecord ? "loading" : "ready" });
  const [version, setVersion] = useState(0);
  // Re-resolve only when the bound values change, not on every new params object.
  const paramsKey = JSON.stringify(params);
  const stableParams = useMemo(() => JSON.parse(paramsKey) as Record<string, unknown>, [paramsKey]);

  useEffect(() => {
    if (!needsRecord || expression) return;
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(RECORDS_CHANGED_EVENT, bump);
    window.addEventListener(DATABASE_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener(RECORDS_CHANGED_EVENT, bump);
      window.removeEventListener(DATABASE_CHANGED_EVENT, bump);
    };
  }, [needsRecord, expression]);

  useEffect(() => {
    if (!form || !needsRecord || !supported) return;
    let live = true;
    Promise.resolve()
      .then(() =>
        expression
          ? evaluate(expression, { params: stableParams, app })
          : firstRecordId(form, sourceParams(form, { app, params: stableParams })),
      )
      .then((recordId) => {
        if (!live) return;
        setBinding(
          recordId == null || recordId === "" ? { status: "empty" } : { status: "ready", recordId },
        );
      })
      .catch((reason) => {
        if (live)
          setBinding({
            status: "error",
            message: reason instanceof Error ? reason.message : String(reason),
          });
      });
    return () => {
      live = false;
    };
  }, [form, needsRecord, supported, expression, stableParams, app, version]);

  if (!form)
    return (
      <p className="dash-error" role="alert">
        This form does not exist.
      </p>
    );
  if (!supported)
    return (
      <p className="dash-error" role="alert">
        {form.name} cannot open in {mode} mode.
      </p>
    );
  if (!needsRecord) return <FormRenderer formId={form.id} mode={mode} params={stableParams} />;
  switch (binding.status) {
    case "loading":
      return <p className="dash-muted">Loading…</p>;
    case "empty":
      return <p className="dash-muted">No record to show.</p>;
    case "error":
      return (
        <p className="dash-error" role="alert">
          {binding.message}
        </p>
      );
    default:
      return (
        <FormRenderer
          formId={form.id}
          mode={mode}
          recordId={binding.recordId}
          params={stableParams}
        />
      );
  }
}
