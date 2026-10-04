import { AlertTriangle } from "lucide-react";
import { useId, useState } from "react";
import { DialogFrame } from "../components/DialogFrame";
import { modeLabel } from "./logical";
import type { ChangePlan, TableImpact } from "./types";

/**
 * Impact preview required before destructive schema changes and table rebuilds (PRD §11):
 * affected rows, dependents, the per-operation mode, and the exact SQL that will run.
 */
export function ImpactDialog({
  title,
  plan,
  impact,
  confirmLabel,
  acknowledgement,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  plan?: ChangePlan | null;
  impact?: TableImpact | null;
  confirmLabel: string;
  // Asks for this acknowledgement even when nothing is destroyed, e.g. dependents of a rename.
  acknowledgement?: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const confirmId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const shown = impact ?? plan?.impact ?? null;
  const destructive = plan ? plan.destructive || plan.rebuild : true;
  const confirmRequired = destructive || !!acknowledgement;
  const statements = plan?.statements ?? shown?.statements ?? [];
  return (
    <div className="schema-dialog-backdrop">
      <DialogFrame
        className="schema-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClose={onCancel}
      >
        <h2 id={titleId}>
          <AlertTriangle aria-hidden="true" />
          {title}
        </h2>
        {plan && (
          <ul aria-label="Pending operations" className="schema-ops">
            {plan.operations.map((op, i) => (
              <li key={i}>
                <span>{op.summary}</span>
                <span className={`mode-badge ${op.mode}`}>{modeLabel(op.mode)}</span>
                {op.destructive && <span className="mode-badge destructive">Destructive</span>}
              </li>
            ))}
          </ul>
        )}
        {plan?.rebuild && (
          <p className="schema-note">
            This store cannot make every change in place, so the table is recreated: its rows are
            copied into a new table inside one transaction, indexes are recreated, and relationships
            are checked before committing.
          </p>
        )}
        {shown && (
          <dl className="impact-facts" aria-label="Impact">
            <dt>Rows in {shown.table}</dt>
            <dd>{shown.rows.toLocaleString()}</dd>
            <dt>Tables referencing it</dt>
            <dd>
              {shown.inboundForeignKeys.length
                ? shown.inboundForeignKeys
                    .map(
                      (f) =>
                        `${f.table} (${f.columns.join(", ")}): ${f.rows} row${f.rows === 1 ? "" : "s"}, on delete ${f.onDelete}`,
                    )
                    .join("; ")
                : "None"}
            </dd>
            <dt>Indexes</dt>
            <dd>{shown.indexes.length ? shown.indexes.join(", ") : "None"}</dd>
            <dt>Dependent definitions</dt>
            <dd>
              {shown.dependents.length
                ? shown.dependents.map((d) => `${d.kind} “${d.name}”`).join(", ")
                : "None"}
            </dd>
          </dl>
        )}
        {plan?.warnings.map((w) => (
          <p key={w} className="schema-note warning">
            {w}
          </p>
        ))}
        <label className="grid gap-1">
          Generated SQL
          <textarea readOnly value={statements.join(";\n") + (statements.length ? ";" : "")} />
        </label>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {confirmRequired && (
          <label className="flex items-center gap-2" htmlFor={confirmId}>
            <input
              id={confirmId}
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            {destructive
              ? "I reviewed the impact; data removed by this change cannot be recovered except from a checkpoint."
              : acknowledgement}
          </label>
        )}
        <div className="settings-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="save"
            disabled={busy || (confirmRequired && !acknowledged)}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </DialogFrame>
    </div>
  );
}
