import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runAction } from "../automation/runner";
import type { DesignControl, DesignForm, FormMode } from "../design/schema";
import { isInputKind } from "../design/schema";
import { useDocumentConfig } from "../lib/config-store";
import { deleteRecord, insertRecord, updateRecord } from "../lib/records";
import type { DataValue, TableSchema } from "../lib/types";
import { useConfirm } from "./Confirm";
import { type BodyContext, ControlGrid } from "./FormBody";
import { loadRecord, recordIdFor, tableSchema } from "./data";
import {
  compute,
  defaultRecord,
  type FormErrors,
  type FormScope,
  hasErrors,
  validateControl,
  validateForm,
  visibleControls,
} from "./formState";
import { useRuntimeNavigation } from "./navigation";
import { can, PermissionError } from "./rbac";
import { isDesignedForm } from "./registry";
import { fromDataValue, namedValues, type RecordValues, sameValue } from "./values";

export type Link = { column: string; value: unknown };
export type OpenTarget = { formId: string; mode: FormMode; recordId?: unknown };

type Notice = { text: string; tone: "info" | "error" };

type Props = {
  form: DesignForm;
  mode: Exclude<FormMode, "list">;
  recordId?: unknown;
  link?: Link;
  embedded?: boolean;
  onMode: (mode: FormMode, recordId?: unknown) => void;
  onClose: () => void;
  onNavigate: (target: { kind: string; id: string; mode?: string; recordId?: unknown }) => void;
};

const message = (reason: unknown) => {
  if (reason && typeof reason === "object" && "code" in reason && reason.code === "CONFLICT")
    return "Someone else changed this record since you opened it. Go back and open it again to see the latest values.";
  return reason instanceof Error ? reason.message : String(reason);
};

/** Detail, create, and edit modes of a form on the grid renderer. */
export function RecordView({
  form,
  mode,
  recordId,
  link,
  embedded = false,
  onMode,
  onClose,
  onNavigate,
}: Props) {
  const { config } = useDocumentConfig();
  const runtime = useRuntimeNavigation();
  const { roleId, app } = runtime;
  const table = form.source?.kind === "table" ? (form.source.table ?? null) : null;
  const readOnlySource = !table;
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [record, setRecord] = useState<RecordValues>({});
  const [original, setOriginal] = useState<RecordValues>({});
  const [identity, setIdentity] = useState<DataValue[] | null>(null);
  const [formState, setFormState] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  // Load and save problems; reset whenever the record (re)loads.
  const [status, setStatus] = useState<Notice | null>(null);
  // Result of the last button action; independent of record loads (a refresh keeps it).
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  // Bumped when an action changed the shown record, so detail mode reloads it.
  const [reload, setReload] = useState(0);
  // The record is loading until the load for exactly this form/mode/record has finished,
  // so a just-switched view never shows (or runs actions on) the previous view's values.
  const loadKey = JSON.stringify([form.id, mode, table, recordId ?? null, reload]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== loadKey;
  const [dialog, confirm] = useConfirm();
  const heading = useRef<HTMLHeadingElement>(null);

  const subject = isDesignedForm(config, form)
    ? { kind: "form", id: form.id }
    : { kind: "table", id: table ?? "" };
  const allowed = (op: "create" | "update" | "delete") => {
    if (readOnlySource) return false;
    if (op === "create" && !form.modes.includes("create")) return false;
    if (op === "update" && !form.modes.includes("edit")) return false;
    return can(config, roleId, subject.kind, subject.id, op);
  };
  const inputs = useRef({ app, link, recordId, form });
  useEffect(() => {
    inputs.current = { app, link, recordId, form };
  });

  useEffect(() => {
    let live = true;
    const { app, link, recordId, form } = inputs.current;
    const done = () => live && setLoadedKey(loadKey);
    setStatus(null);
    setErrors({ fields: {}, form: [] });
    if (table)
      tableSchema(table)
        .then((s) => live && setSchema(s))
        .catch(() => undefined);
    if (mode === "create") {
      const initial = defaultRecord(form, { form: {}, app });
      if (link) initial[link.column] = link.value;
      setRecord(initial);
      setOriginal({});
      setIdentity(null);
      done();
      return () => {
        live = false;
      };
    }
    if (!table) {
      setRecord((recordId as RecordValues) ?? {});
      done();
      return () => {
        live = false;
      };
    }
    loadRecord(table, recordId)
      .then((loaded) => {
        if (!live) return;
        setRecord(loaded?.record ?? {});
        setOriginal(loaded?.record ?? {});
        setIdentity(loaded?.identity ?? null);
        if (!loaded) setStatus({ text: "This record no longer exists.", tone: "error" });
      })
      .catch((reason) => live && setStatus({ text: message(reason), tone: "error" }))
      .finally(done);
    return () => {
      live = false;
    };
    // loadKey covers form, mode, table, record, and reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  useEffect(() => {
    if (!loading) heading.current?.focus();
  }, [loading, mode]);

  const scope: FormScope = useMemo(
    () => ({ record, form: formState, app }),
    [record, formState, app],
  );
  const visible = useMemo(() => visibleControls(form, scope), [form, scope]);
  const readOnly = mode === "detail" || readOnlySource;
  const locked = useMemo(() => {
    const set = new Set<string>();
    if (link) set.add(link.column);
    if (mode === "edit" && schema)
      schema.columns.filter((c) => c.primaryKeyPosition > 0).forEach((c) => set.add(c.name));
    return set;
  }, [link, mode, schema]);

  const setField = useCallback((column: string, value: unknown) => {
    setRecord((current) => ({ ...current, [column]: value }));
  }, []);
  const blur = (control: DesignControl) => {
    const column = control.binding?.column;
    if (!column || readOnly) return;
    const problem = validateControl(control, scope.record[column], scope);
    setErrors((current) => {
      const fields = { ...current.fields };
      if (problem) fields[control.id] = problem;
      else delete fields[control.id];
      return { ...current, fields };
    });
  };

  /** Record values to write: bound inputs plus derived (computed) bound fields. */
  const valuesToWrite = (): RecordValues => {
    const values: RecordValues = { ...record };
    for (const control of form.controls) {
      const column = control.binding?.column;
      if (column && control.computed && isInputKind(control.kind))
        values[column] = compute(control.computed, scope).value;
    }
    return values;
  };

  /** Original values for the optimistic concurrency check (PRD §19). */
  const expectedValues = () =>
    schema
      ? namedValues(
          original,
          schema.columns.filter((c) => !c.generated && c.name in original),
        )
      : [];

  const save = async () => {
    const result = validateForm(form, scope);
    setErrors(result);
    if (hasErrors(result)) {
      setStatus({ text: "Fix the highlighted problems before saving.", tone: "error" });
      return;
    }
    if (!table || !schema) return;
    setNotice(null);
    setBusy(true);
    try {
      const values = valuesToWrite();
      if (mode === "create") {
        if (!allowed("create")) throw new PermissionError("This role cannot create records here.");
        const keys = new Set(
          schema.columns
            .filter((c) => c.primaryKeyPosition > 0 && values[c.name] == null)
            .map((c) => c.name),
        );
        const columns = schema.columns.filter(
          (c) => !keys.has(c.name) && values[c.name] != null && !c.generated,
        );
        const id = await insertRecord(table, namedValues(values, columns));
        const keyNames = schema.columns.filter((c) => c.primaryKeyPosition > 0).map((c) => c.name);
        const saved = { ...values };
        keyNames.forEach((name, i) => {
          if (saved[name] == null) saved[name] = fromDataValue(id[i]);
        });
        runtime.notify("Record created.");
        if (embedded) onClose();
        else onMode("detail", recordIdFor(schema, saved, id));
      } else {
        if (!allowed("update")) throw new PermissionError("This role cannot change records here.");
        if (!identity) throw new Error("This record cannot be identified for saving.");
        const changed = schema.columns.filter(
          (c) => !c.generated && c.name in values && !sameValue(values[c.name], original[c.name]),
        );
        if (changed.length)
          await updateRecord(table, namedValues(values, changed), identity, {
            expected: expectedValues(),
            old: original,
          });
        runtime.notify("Changes saved.");
        if (embedded) onClose();
        else onMode("detail", recordId);
      }
    } catch (reason) {
      setStatus({ text: message(reason), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!table || !identity) return;
    if (!(await confirm("Delete this record? This cannot be undone."))) return;
    try {
      if (!allowed("delete")) throw new PermissionError("This role cannot delete records here.");
      await deleteRecord(table, identity, { expected: expectedValues(), old: original });
      runtime.notify("Record deleted.");
      onClose();
    } catch (reason) {
      setStatus({ text: message(reason), tone: "error" });
    }
  };

  const runButton = async (control: DesignControl) => {
    if (!control.actionId || !ready) return;
    setNotice(null);
    setRunning(true);
    const result = await runAction(control.actionId, {
      config,
      record: { ...record },
      form: formState,
      app,
      navigate: (target) => onNavigate(target),
      setState: (where, key, value) =>
        where === "form"
          ? setFormState((s) => ({ ...s, [key]: value }))
          : runtime.setAppState(key, value),
      confirm,
      notify: (text, tone = "info") => {
        setNotice({ text, tone });
        runtime.notify(text, tone);
      },
      authorize: (kind, id, op) => can(config, roleId, kind, id, op as "read"),
      refresh: () => (mode === "detail" ? setReload((n) => n + 1) : onMode(mode, recordId)),
    })
      .catch((reason) => ({ ok: false, error: message(reason) }))
      .finally(() => setRunning(false));
    if (!result.ok && result.error) setNotice({ text: result.error, tone: "error" });
  };
  // Actions run only on a fully loaded record (and one at a time).
  const ready = !loading && !running && !busy && (mode === "create" || !table || identity !== null);

  const ctx: BodyContext = {
    form,
    scope,
    visible,
    errors: errors.fields,
    readOnly,
    locked,
    embedded,
    identity,
    setField,
    blur,
    runButton: (control) => {
      runButton(control).catch(() => undefined);
    },
    canRunButton: (control) =>
      !control.actionId || (ready && can(config, roleId, "action", control.actionId, "execute")),
  };
  const title =
    mode === "create" ? `New ${form.name}` : mode === "edit" ? `Edit ${form.name}` : form.name;
  const Tag = embedded ? "h4" : "h2";

  return (
    <section
      className="rt-record"
      role="form"
      aria-label={title}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key !== "Enter" || readOnly || target.tagName !== "INPUT") return;
        if ((target as HTMLInputElement).type === "search") return;
        event.preventDefault();
        event.stopPropagation();
        save().catch(() => undefined);
      }}
    >
      <div className="rt-record-head">
        <Tag ref={heading} tabIndex={-1}>
          {title}
        </Tag>
        <div className="rt-actions">
          {mode === "detail" && allowed("update") && form.modes.includes("edit") && (
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                onMode("edit", recordId);
              }}
              disabled={!identity}
            >
              Edit
            </button>
          )}
          {mode === "detail" && allowed("delete") && (
            <button
              type="button"
              onClick={() => remove().catch(() => undefined)}
              disabled={!identity}
            >
              Delete
            </button>
          )}
          {mode === "detail" && (
            <button type="button" onClick={onClose}>
              {embedded ? "Close" : "Back"}
            </button>
          )}
        </div>
      </div>
      {[status, notice].map(
        (item, index) =>
          item && (
            <p
              key={index}
              className={item.tone === "error" ? "rt-error" : "rt-status"}
              role={item.tone === "error" ? "alert" : "status"}
            >
              {item.text}
            </p>
          ),
      )}
      {errors.form.length > 0 && (
        <ul className="rt-form-errors" aria-label="Form errors">
          {errors.form.map((text) => (
            <li key={text} role="alert">
              {text}
            </li>
          ))}
        </ul>
      )}
      {loading ? (
        <p className="rt-muted">Loading record…</p>
      ) : (
        <ControlGrid ctx={ctx} parent={null} />
      )}
      {!readOnly && (
        <div className="rt-actions rt-footer">
          <button
            type="button"
            onClick={() => (mode === "edit" ? onMode("detail", recordId) : onClose())}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || loading}
            onClick={() => save().catch(() => undefined)}
          >
            {mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      )}
      {dialog}
    </section>
  );
}
