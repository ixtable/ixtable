import { type KeyboardEvent, useId, useState } from "react";
import { asTauriError } from "../lib/api";
import type { CreateForeignKeySpec, TableSchema } from "../lib/types";
import { applyTableChanges, previewTableChanges } from "../schema/api";
import { ForeignKeyEditor } from "../schema/ConstraintEditors";
import { ImpactDialog } from "../schema/ImpactDialog";
import type { ChangePlan, StoreCapabilities } from "../schema/types";
import type { DrawnRelationship } from "./relationships";

/**
 * Creates a relationship from the diagram: the relationship editor opens prefilled with the
 * drawn columns so the user picks more columns and the referential actions, then the change
 * is previewed and applied like any other schema change.
 */
export function RelateDialog({
  schemas,
  capabilities,
  drawn,
  childTable: initialChild,
  onApplied,
  onCancel,
}: {
  schemas: TableSchema[];
  capabilities: StoreCapabilities | null;
  drawn?: DrawnRelationship | null;
  childTable: string;
  onApplied: (childTable: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [child, setChild] = useState(drawn?.childTable ?? initialChild);
  const [preview, setPreview] = useState<{ fk: CreateForeignKeySpec; plan: ChangePlan } | null>(
    null,
  );
  // The last previewed relationship, restored when the preview is cancelled.
  const [draft, setDraft] = useState<CreateForeignKeySpec | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const columns = schemas.find((s) => s.name === child)?.columns.map((c) => c.name) ?? [];
  const op = (foreignKey: CreateForeignKeySpec) => [
    { operation: "add_foreign_key" as const, foreignKey },
  ];
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(asTauriError(e).message);
    } finally {
      setBusy(false);
    }
  };
  if (preview)
    return (
      <ImpactDialog
        title={`Relate ${child} (${preview.fk.columns.join(", ")}) to ${preview.fk.targetTable}?`}
        plan={preview.plan}
        confirmLabel="Create relationship"
        busy={busy}
        error={error}
        onCancel={() => {
          setError("");
          setPreview(null);
        }}
        onConfirm={() =>
          run(async () => {
            await applyTableChanges(child, op(preview.fk));
            await onApplied(child);
          })
        }
      />
    );
  const initial =
    draft ??
    (drawn && drawn.childTable === child
      ? {
          columns: [drawn.childColumn],
          targetTable: drawn.parentTable,
          targetColumns: [drawn.parentColumn],
        }
      : undefined);
  return (
    <div className="schema-dialog-backdrop">
      <div
        className="schema-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e: KeyboardEvent) => e.key === "Escape" && onCancel()}
      >
        <h2 id={titleId}>New relationship</h2>
        <label className="grid gap-1">
          Referencing table
          <select value={child} onChange={(e) => {
            setDraft(null);
            setChild(e.target.value);
          }}>
            {schemas.map((s) => (
              <option key={s.name}>{s.name}</option>
            ))}
          </select>
        </label>
        <ForeignKeyEditor
          key={child}
          columns={columns}
          tables={schemas}
          actions={capabilities?.foreignKeyActions}
          initial={initial}
          addLabel="Preview relationship"
          onAdd={(fk) =>
            run(async () => {
              setDraft(fk);
              setPreview({ fk, plan: await previewTableChanges(child, op(fk)) });
            })
          }
        />
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="settings-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
