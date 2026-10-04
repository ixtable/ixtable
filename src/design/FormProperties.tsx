import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { DbObject } from "../lib/types";
import { newId } from "../lib/utils";
import { ExpressionField } from "./ExpressionField";
import { type DesignForm, FORM_MODES, type FormMode } from "./schema";
import { useDesignEditor } from "./useDesignEditor";

/** Properties of the selected form: source, modes, list settings, validation rules, grid. */
export function FormProperties({
  form,
  objects,
  columns,
  layoutSettings,
}: {
  form: DesignForm;
  objects: DbObject[];
  columns: string[];
  layoutSettings: ReactNode;
}) {
  const { config, design, editForm } = useDesignEditor();
  const change = (patch: Partial<DesignForm>, label = "Edit form") =>
    editForm(form.id, (f) => ({ ...f, ...patch }), label);
  const source = form.source;
  const queries = config.savedQueries ?? [];
  const toggleMode = (mode: FormMode, on: boolean) =>
    change({
      modes: on
        ? FORM_MODES.filter((m) => m === mode || form.modes.includes(m))
        : form.modes.filter((m) => m !== mode),
    });

  return (
    <>
      <label>
        Form name
        <input
          value={form.name}
          onChange={(e) => change({ name: e.target.value }, "Rename form")}
        />
      </label>
      <label>
        Source
        <select
          aria-label="Source kind"
          value={source?.kind ?? ""}
          onChange={(e) => {
            const kind = e.target.value;
            change({
              source:
                kind === "query"
                  ? { kind: "query", queryId: queries[0]?.id ?? "" }
                  : kind === "table"
                    ? { kind: "table", table: "" }
                    : null,
              modes:
                kind === "query"
                  ? form.modes.filter((m) => m === "list" || m === "detail")
                  : form.modes,
            });
          }}
        >
          <option value="">Unbound</option>
          <option value="table">Table</option>
          <option value="query">Saved query (read-only)</option>
        </select>
      </label>
      {source?.kind !== "query" && (
        <label>
          Data table
          <select
            aria-label="Data table"
            value={source?.table ?? ""}
            onChange={(e) =>
              change({ source: e.target.value ? { kind: "table", table: e.target.value } : null })
            }
          >
            <option value="">Unbound</option>
            {objects
              .filter((o) => o.objectType === "table" || o.objectType === "view")
              .map((o) => (
                <option key={o.name}>{o.name}</option>
              ))}
          </select>
        </label>
      )}
      {source?.kind === "query" && (
        <label>
          Saved query
          <select
            value={source.queryId ?? ""}
            onChange={(e) => change({ source: { kind: "query", queryId: e.target.value } })}
          >
            {queries.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset className="fd-fieldset">
        <legend>Modes</legend>
        {FORM_MODES.map((mode) => (
          <label key={mode} className="fd-check">
            <input
              type="checkbox"
              checked={form.modes.includes(mode)}
              disabled={source?.kind === "query" && (mode === "create" || mode === "edit")}
              onChange={(e) => toggleMode(mode, e.target.checked)}
            />
            {mode[0].toUpperCase() + mode.slice(1)} mode
          </label>
        ))}
      </fieldset>
      {form.modes.includes("list") && (
        <fieldset className="fd-fieldset">
          <legend>List</legend>
          <label>
            Rows per page
            <input
              type="number"
              min={1}
              max={500}
              value={form.pageSize}
              onChange={(e) => change({ pageSize: Math.max(1, Number(e.target.value) || 25) })}
            />
          </label>
          <label>
            Row opens
            <select
              aria-label="Detail form"
              value={form.detailFormId ?? ""}
              onChange={(e) => change({ detailFormId: e.target.value || null })}
            >
              <option value="">This form</option>
              {design.forms
                .filter((f) => f.id !== form.id)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          </label>
          {columns.map((column) => (
            <label key={column} className="fd-check">
              <input
                type="checkbox"
                aria-label={`List column ${column}`}
                checked={form.listColumns.includes(column)}
                onChange={(e) =>
                  change({
                    listColumns: e.target.checked
                      ? columns.filter((c) => c === column || form.listColumns.includes(c))
                      : form.listColumns.filter((c) => c !== column),
                  })
                }
              />
              {column}
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className="fd-fieldset">
        <legend>Form validation</legend>
        {form.rules.map((rule, index) => (
          <div key={rule.id} className="fd-rule">
            <ExpressionField
              label={`Rule ${index + 1}`}
              value={rule.expression}
              columns={columns}
              placeholder="record.end >= record.start"
              onChange={(expression) =>
                change({
                  rules: form.rules.map((r) =>
                    r.id === rule.id ? { ...r, expression: expression ?? "" } : r,
                  ),
                })
              }
            />
            <label>
              Rule {index + 1} message
              <input
                value={rule.message}
                onChange={(e) =>
                  change({
                    rules: form.rules.map((r) =>
                      r.id === rule.id ? { ...r, message: e.target.value } : r,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              aria-label={`Remove rule ${index + 1}`}
              onClick={() => change({ rules: form.rules.filter((r) => r.id !== rule.id) })}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            change({ rules: [...form.rules, { id: newId(), expression: "", message: "" }] })
          }
        >
          <Plus aria-hidden="true" />
          Add rule
        </button>
      </fieldset>
      {layoutSettings}
    </>
  );
}
