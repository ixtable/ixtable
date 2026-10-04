import { useState } from "react";
import { asTauriError } from "../lib/api";
import { previewMigration } from "./api";
import type { Migration, MigrationPreview } from "./types";

/** Edits one migration. Applied migrations are immutable: only their name can change. */
export function MigrationEditor({
  migration,
  others,
  applied,
  isNew,
  onSave,
  onDelete,
  onClose,
}: {
  migration: Migration;
  others: Migration[];
  applied: boolean;
  isNew: boolean;
  onSave: (next: Migration) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Migration>(migration);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [error, setError] = useState("");
  const set = (patch: Partial<Migration>) => setDraft((d) => ({ ...d, ...patch }));
  const deps = draft.dependsOn ?? [];
  const run = (task: () => Promise<void>) => {
    setError("");
    task().catch((e) => setError(asTauriError(e).message));
  };
  return (
    <section className="migration-editor" aria-label={`Edit migration ${migration.name}`}>
      <h3>{isNew ? "New migration" : `Edit ${migration.name}`}</h3>
      <p className="text-slate-600">
        Id <code>{draft.id}</code> never changes.{" "}
        {applied && "This migration is applied, so its SQL is locked; add a new migration instead."}
      </p>
      <label>
        Name
        <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label>
        Order
        <input
          type="number"
          min={0}
          disabled={applied}
          value={draft.order ?? 0}
          onChange={(e) => set({ order: Number(e.target.value) || 0 })}
        />
      </label>
      <label>
        Target store
        {/* Migrations run on the embedded SQLite store; `any` is its legacy spelling and
            `postgres` stays selectable only so an old migration can be switched to SQLite. */}
        <select
          disabled={applied}
          value={draft.targetStore === "postgres" ? "postgres" : "sqlite"}
          onChange={(e) => set({ targetStore: e.target.value })}
        >
          <option value="sqlite">Embedded SQLite</option>
          {draft.targetStore === "postgres" && (
            <option value="postgres">PostgreSQL (not supported)</option>
          )}
        </select>
      </label>
      {!!others.length && (
        <fieldset className="column-picker">
          <legend>Depends on</legend>
          {others.map((o) => (
            <label key={o.id}>
              <input
                type="checkbox"
                disabled={applied}
                checked={deps.includes(o.id)}
                onChange={(e) =>
                  set({
                    dependsOn: e.target.checked ? [...deps, o.id] : deps.filter((d) => d !== o.id),
                  })
                }
              />
              {o.name}
            </label>
          ))}
        </fieldset>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={!!draft.reversible}
          disabled={applied}
          onChange={(e) => set({ reversible: e.target.checked })}
        />
        Reversible (requires down SQL)
      </label>
      <label>
        Up SQL
        <textarea
          spellCheck={false}
          readOnly={applied}
          value={draft.up ?? ""}
          onChange={(e) => set({ up: e.target.value })}
        />
      </label>
      <label>
        Down SQL
        <textarea
          spellCheck={false}
          readOnly={applied && !!migration.down}
          value={draft.down ?? ""}
          onChange={(e) => set({ down: e.target.value || null })}
        />
      </label>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {preview && (
        <div aria-label="SQL preview">
          <b>
            {preview.statements.length} statement{preview.statements.length === 1 ? "" : "s"} on{" "}
            {preview.store}, in {preview.transactional ? "one transaction" : "autocommit"}
          </b>
          <pre className="migration-log">{preview.statements.join("\n")}</pre>
          {preview.warnings.map((w) => (
            <p className="schema-note" key={w}>
              {w}
            </p>
          ))}
        </div>
      )}
      <div className="settings-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
        {!isNew && (
          <button
            type="button"
            onClick={() => run(async () => setPreview(await previewMigration(draft.id)))}
          >
            Preview SQL
          </button>
        )}
        {!isNew && !applied && (
          <button type="button" onClick={() => run(onDelete)}>
            Delete migration
          </button>
        )}
        <button
          type="button"
          className="save"
          disabled={!draft.name.trim()}
          onClick={() => run(() => onSave(draft))}
        >
          Save migration
        </button>
      </div>
    </section>
  );
}
