/** A form placed on a dashboard, bound to a record for detail/edit modes. */
import { useEffect, useMemo, useRef, useState } from "react";
import { DATABASE_CHANGED_EVENT } from "../automation/context";
import { evaluate } from "../expr";
import { useDocumentConfig } from "../lib/config-store";
import { RECORDS_CHANGED_EVENT } from "../lib/records";
import { firstRecordId, loadRecord, sourceParams } from "../runtime/data";
import { FormRenderer } from "../runtime/FormRenderer";
import { useRuntimeNavigation } from "../runtime/navigation";
import { resolveForm } from "../runtime/registry";
import { embeddableModes } from "./model";
import type { DashboardComponent } from "./types";

const GONE = Symbol("gone");

type Binding =
  | { status: "loading" }
  | { status: "ready"; recordId?: unknown }
  | { status: "empty" }
  | { status: "gone" }
  | { status: "error"; message: string };

/**
 * Renders the component's form with the dashboard `params` in scope. Detail and
 * edit modes open the record named by `recordId` (an expression over `params`
 * and `app`), or the first row of the form's source when it is blank; that row
 * is looked up again after record writes, but only while the form has no unsaved
 * edits; a shown table record that was deleted gets a message instead of a switch.
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
  // Query-sourced forms take a whole row, so a stored key expression is ignored.
  const expression = form?.source?.kind === "table" ? (component.recordId?.trim() ?? "") : "";
  const [binding, setBinding] = useState<Binding>({ status: needsRecord ? "loading" : "ready" });
  const [version, setVersion] = useState(0);
  const dirty = useRef(false);
  const stale = useRef(false);
  const shown = useRef<unknown>(undefined);
  const onDirty = (next: boolean) => {
    dirty.current = next;
    if (!next && stale.current) {
      stale.current = false;
      setVersion((v) => v + 1);
    }
  };
  // Re-resolve only when the bound values change, not on every new params object.
  const paramsKey = JSON.stringify(params);
  const stableParams = useMemo(() => JSON.parse(paramsKey) as Record<string, unknown>, [paramsKey]);

  useEffect(() => {
    if (!needsRecord || expression) return;
    const bump = () => {
      // Pin the record while it has unsaved edits; re-resolve once it is clean.
      if (dirty.current) stale.current = true;
      else setVersion((v) => v + 1);
    };
    window.addEventListener(RECORDS_CHANGED_EVENT, bump);
    window.addEventListener(DATABASE_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener(RECORDS_CHANGED_EVENT, bump);
      window.removeEventListener(DATABASE_CHANGED_EVENT, bump);
    };
  }, [needsRecord, expression]);

  // New filter values pick a new first row; a deleted record only matters for the same values.
  const shownFor = useRef(stableParams);

  useEffect(() => {
    if (!form || !needsRecord || !supported) return;
    let live = true;
    if (shownFor.current !== stableParams) {
      shownFor.current = stableParams;
      shown.current = undefined;
    }
    const table = form.source?.kind === "table" ? form.source.table : null;
    const previous = expression ? undefined : shown.current;
    Promise.resolve()
      .then(async () => {
        if (previous === undefined || !table) return true;
        return (await loadRecord(table, previous)) != null;
      })
      .then((exists) => {
        if (!exists) return GONE;
        return expression
          ? evaluate(expression, { params: stableParams, app })
          : firstRecordId(form, sourceParams(form, { app, params: stableParams }));
      })
      .then((recordId) => {
        if (!live) return;
        if (recordId === GONE) {
          setBinding({ status: "gone" });
          return;
        }
        if (!expression) shown.current = recordId ?? undefined;
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
    case "gone":
      return (
        <p className="dash-error" role="alert">
          The record shown here was deleted.{" "}
          <button
            type="button"
            onClick={() => {
              shown.current = undefined;
              setVersion((v) => v + 1);
            }}
          >
            Show first record
          </button>
        </p>
      );
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
          onDirty={onDirty}
        />
      );
  }
}
