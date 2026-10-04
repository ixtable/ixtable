import { useCallback, useEffect, useState } from "react";
import { humanize } from "../design/generate";
import { type DesignControl, type DesignForm, type FormMode, relatedKeys } from "../design/schema";
import { readTablePage } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import { deleteRecord } from "../lib/records";
import type { DataValue, TableSchema } from "../lib/types";
import { useConfirm } from "./Confirm";
import { useLookupLabels } from "./lookups";
import type { BodyContext } from "./FormBody";
import { FormRenderer } from "./FormRenderer";
import { recordIdFor, tableSchema } from "./data";
import { useRuntimeNavigation } from "./navigation";
import { can } from "./rbac";
import { isDesignedForm, resolveForm, tableForms } from "./registry";
import { BooleanCell } from "./BooleanCell";
import {
  displayText,
  isBooleanColumn,
  namedValues,
  type RecordValues,
  rowObject,
  toColumnValue,
} from "./values";

type Rows = { records: RecordValues[]; identities: DataValue[][] };
type Editing = { mode: FormMode; recordId?: unknown } | null;

/** One-level master/detail: child rows whose foreign key matches the current record. */
export function RelatedRecords({ ctx, control }: { ctx: BodyContext; control: DesignControl }) {
  const related = control.related;
  const { config } = useDocumentConfig();
  const { roleId } = useRuntimeNavigation();
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [rows, setRows] = useState<Rows | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState("");
  // Messages of the embedded child form, shown here because that form closes on save.
  const [message, setMessage] = useState("");
  const [dialog, confirm] = useConfirm();
  const keys = related ? relatedKeys(related) : [];
  // Child column → the parent record's value it must equal.
  const link = Object.fromEntries(keys.map((key) => [key.column, ctx.scope.record[key.target]]));
  const linkSignature = JSON.stringify(link);
  const childForm: DesignForm | null = !related
    ? null
    : related.formId
      ? resolveForm(config, related.formId)
      : schema
        ? tableForms(schema).detail
        : null;
  const columns = !related
    ? []
    : related.columns.length
      ? related.columns
      : (schema?.columns.map((c) => c.name).filter((c) => !(c in link)) ?? []);
  const lookup = useLookupLabels(
    related?.table ?? null,
    columns,
    (column) => childForm?.controls.find((c) => c.binding?.column === column),
    rows?.records,
  );
  const saved = !!ctx.identity && keys.length > 0 && keys.every((key) => link[key.column] != null);

  const load = useCallback(async () => {
    if (!related || !saved) return;
    try {
      const child = await tableSchema(related.table);
      const values = JSON.parse(linkSignature) as Record<string, unknown>;
      const page = await readTablePage(related.table, {
        limit: 200,
        filters: Object.entries(values).map(([column, value]) => ({
          column,
          operator: "eq" as const,
          value: toColumnValue(value, child.columns.find((c) => c.name === column)?.declaredType),
        })),
      });
      setSchema(child);
      setRows({
        records: page.rows.map((row) => rowObject(page.columns, row)),
        identities: page.identities,
      });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [related, saved, linkSignature]);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  if (!related) return null;
  const label = control.label || humanize(related.table);
  if (!saved)
    return (
      <section className="rt-related" aria-label={label}>
        <h3>{label}</h3>
        <p className="rt-muted">Save this record to add {label.toLowerCase()}.</p>
      </section>
    );
  const subject =
    childForm && isDesignedForm(config, childForm)
      ? { kind: "form", id: childForm.id }
      : { kind: "table", id: related.table };
  const allowed = (op: "create" | "update" | "delete") =>
    can(config, roleId, subject.kind, subject.id, op);
  const booleanColumn = (column: string) =>
    isBooleanColumn(
      childForm?.controls.filter((c) => c.binding?.column === column) ?? [],
      schema?.columns.find((c) => c.name === column),
    );
  const columnLabel = (column: string) =>
    childForm?.controls.find((c) => c.binding?.column === column)?.label ?? humanize(column);

  const remove = async (index: number) => {
    if (!rows || !(await confirm(`Delete this ${label.toLowerCase()} row?`))) return;
    try {
      if (!allowed("delete")) throw new Error("This role cannot delete these records.");
      const record = rows.records[index];
      const columns = schema?.columns.filter((c) => !c.generated && c.name in record) ?? [];
      await deleteRecord(related.table, rows.identities[index], {
        expected: namedValues(record, columns),
        old: record,
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="rt-related" aria-label={label}>
      <div className="rt-related-head">
        <h3>{label}</h3>
        {allowed("create") && childForm && !editing && (
          <button
            type="button"
            onClick={() => {
              setMessage("");
              setEditing({ mode: "create" });
            }}
          >
            Add {label.toLowerCase()}
          </button>
        )}
      </div>
      {error && (
        <p className="rt-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="rt-status" role="status">
          {message}
        </p>
      )}
      <table className="rt-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {columnLabel(column)}
              </th>
            ))}
            <th scope="col">
              <span className="sr-only">Row actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows?.records.map((record, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column}>
                  {booleanColumn(column) ? (
                    <BooleanCell value={record[column]} />
                  ) : (
                    (lookup(column, record) ?? displayText(record[column]))
                  )}
                </td>
              ))}
              <td className="rt-row-actions">
                {allowed("update") && childForm && schema && (
                  <button
                    type="button"
                    aria-label={`Edit ${label.toLowerCase()} row ${index + 1}`}
                    onClick={() =>
                      setEditing({
                        mode: "edit",
                        recordId: recordIdFor(schema, record, rows.identities[index]),
                      })
                    }
                  >
                    Edit
                  </button>
                )}
                {allowed("delete") && (
                  <button
                    type="button"
                    aria-label={`Delete ${label.toLowerCase()} row ${index + 1}`}
                    onClick={() => {
                      remove(index).catch(() => undefined);
                    }}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows && !rows.records.length && (
            <tr>
              <td colSpan={columns.length + 1} className="rt-muted">
                No {label.toLowerCase()} yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {editing && childForm && (
        <div className="rt-embedded" role="group" aria-label={`${label} record`}>
          <FormRenderer
            formId={childForm.id}
            mode={editing.mode}
            recordId={editing.recordId}
            link={link}
            embedded
            onNotify={(text, tone) => {
              if (tone === "error") setError(text);
              else setMessage(`${label}: ${text}`);
            }}
            onDone={() => {
              setEditing(null);
              load().catch(() => undefined);
            }}
          />
        </div>
      )}
      {dialog}
    </section>
  );
}
