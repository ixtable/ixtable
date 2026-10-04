import { Trash2 } from "lucide-react";
import { ActionPicker } from "../automation/ActionPicker";
import type { DbObject } from "../lib/types";
import { ExpressionField } from "./ExpressionField";
import { clampPlacement, moveToContainer, removeControl } from "./operations";
import {
  type ControlParent,
  containerLayout,
  controlKindLabel,
  type DesignControl,
  type DesignForm,
  isInputKind,
} from "./schema";
import { ColumnSelect, RelatedListProperties, TabsProperties } from "./KindProperties";
import { useColumns } from "./useColumns";
import { useDesignEditor } from "./useDesignEditor";

const numberOrNull = (value: string) => (value === "" ? null : Number(value));
const parentKey = (parent?: ControlParent | null) =>
  parent ? `${parent.id}|${parent.tab ?? ""}` : "";

/** Properties of the selected control, including expression fields with live diagnostics. */
export function ControlProperties({
  form,
  control,
  columns,
  objects,
  onDeleted,
}: {
  form: DesignForm;
  control: DesignControl;
  columns: string[];
  objects: DbObject[];
  onDeleted: () => void;
}) {
  const { editForm, editControl } = useDesignEditor();
  const change = (patch: Partial<DesignControl>, label?: string) =>
    editControl(form.id, control.id, patch, label);
  const tables = objects.filter((o) => o.objectType === "table").map((o) => o.name);
  const lookupColumns = useColumns(control.relationship?.table);
  const containers = form.controls.filter(
    (c) => c.id !== control.id && (c.kind === "section" || c.kind === "tabs"),
  );
  type ContainerOption = { key: string; label: string; parent: ControlParent };
  const containerOptions = containers.flatMap((c): ContainerOption[] =>
    c.kind === "section"
      ? [{ key: parentKey({ id: c.id }), label: c.label, parent: { id: c.id, tab: null } }]
      : (c.tabs ?? []).map((t) => ({
          key: parentKey({ id: c.id, tab: t.id }),
          label: `${c.label} › ${t.label}`,
          parent: { id: c.id, tab: t.id },
        })),
  );
  const validation = control.validation ?? { required: false };
  const setValidation = (patch: Partial<DesignControl["validation"]>) =>
    change({ validation: { ...validation, ...patch } }, "Edit validation");
  const input = isInputKind(control.kind);
  const span = (field: "column" | "row" | "columnSpan" | "rowSpan", label: string) => (
    <label>
      {label}
      <input
        type="number"
        min={1}
        value={control.placement[field]}
        onChange={(e) =>
          change(
            {
              placement: clampPlacement(
                { ...control.placement, [field]: Math.max(1, Number(e.target.value) || 1) },
                containerLayout(form, control.parent).columns.length,
              ),
            },
            "Move control",
          )
        }
      />
    </label>
  );

  return (
    <>
      <label>
        Label
        <input
          value={control.label}
          onChange={(e) => change({ label: e.target.value }, "Rename control")}
        />
      </label>
      <p className="fd-hint">{controlKindLabel(control.kind)}</p>
      {control.kind === "label" && (
        <label>
          Text
          <input value={control.text ?? ""} onChange={(e) => change({ text: e.target.value })} />
        </label>
      )}
      {(input || control.kind === "computed") && (
        <label>
          Column
          <select
            aria-label="Bound column"
            value={control.binding?.column ?? ""}
            onChange={(e) =>
              change({ binding: e.target.value ? { column: e.target.value } : null })
            }
          >
            <option value="">Unbound</option>
            {columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        Container
        <select
          value={parentKey(control.parent)}
          onChange={(e) =>
            editForm(
              form.id,
              (f) =>
                moveToContainer(
                  f,
                  control.id,
                  containerOptions.find((o) => o.key === e.target.value)?.parent ?? null,
                ),
              "Move control",
            )
          }
        >
          <option value="">Form</option>
          {containerOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="fd-row">
        {span("column", "Column")}
        {span("row", "Row")}
      </div>
      <div className="fd-row">
        {span("columnSpan", "Column span")}
        {span("rowSpan", "Row span")}
      </div>
      {control.kind === "select" && (
        <>
          <label>
            Options (one per line, value=label)
            <textarea
              rows={4}
              value={(control.options ?? [])
                .map((o) => (o.label && o.label !== o.value ? `${o.value}=${o.label}` : o.value))
                .join("\n")}
              onChange={(e) =>
                change({
                  options: e.target.value
                    .split("\n")
                    .filter((line) => line.trim())
                    .map((line) => {
                      const [value, ...label] = line.split("=");
                      return { value: value.trim(), label: label.join("=").trim() || value.trim() };
                    }),
                })
              }
            />
          </label>
          <label>
            Options from saved query
            <select
              value={control.optionsQueryId ?? ""}
              onChange={(e) => change({ optionsQueryId: e.target.value || null })}
            >
              <option value="">None (use the list above)</option>
              <OptionsQueries />
            </select>
          </label>
        </>
      )}
      {control.kind === "relationship" && (
        <fieldset className="fd-fieldset">
          <legend>Lookup</legend>
          <label>
            Lookup table
            <select
              value={control.relationship?.table ?? ""}
              onChange={(e) =>
                change({
                  relationship: { table: e.target.value, valueColumn: "", displayColumn: "" },
                })
              }
            >
              <option value="">—</option>
              {tables.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <ColumnSelect
            label="Value column"
            value={control.relationship?.valueColumn}
            columns={lookupColumns}
            onChange={(valueColumn) =>
              control.relationship &&
              change({ relationship: { ...control.relationship, valueColumn } })
            }
          />
          <ColumnSelect
            label="Display column"
            value={control.relationship?.displayColumn}
            columns={lookupColumns}
            onChange={(displayColumn) =>
              control.relationship &&
              change({ relationship: { ...control.relationship, displayColumn } })
            }
          />
        </fieldset>
      )}
      {control.kind === "button" && (
        <ActionPicker
          value={control.actionId}
          onChange={(actionId) => change({ actionId })}
          label="Button action"
        />
      )}
      {control.kind === "tabs" && <TabsProperties form={form} control={control} />}
      {control.kind === "relatedList" && (
        <RelatedListProperties form={form} control={control} columns={columns} tables={tables} />
      )}
      {control.kind === "image" && (
        <label>
          Asset id
          <input
            value={control.assetId ?? ""}
            onChange={(e) => change({ assetId: e.target.value || null })}
          />
        </label>
      )}
      {input && (
        <fieldset className="fd-fieldset">
          <legend>Validation</legend>
          <label className="fd-check">
            <input
              type="checkbox"
              checked={validation.required}
              onChange={(e) => setValidation({ required: e.target.checked })}
            />
            Required
          </label>
          {(control.kind === "number" || control.kind === "decimal") && (
            <div className="fd-row">
              <label>
                Minimum
                <input
                  type="number"
                  value={validation.min ?? ""}
                  onChange={(e) => setValidation({ min: numberOrNull(e.target.value) })}
                />
              </label>
              <label>
                Maximum
                <input
                  type="number"
                  value={validation.max ?? ""}
                  onChange={(e) => setValidation({ max: numberOrNull(e.target.value) })}
                />
              </label>
            </div>
          )}
          {(control.kind === "text" || control.kind === "multiline") && (
            <label>
              Pattern
              <input
                value={validation.pattern ?? ""}
                onChange={(e) => setValidation({ pattern: e.target.value || null })}
              />
            </label>
          )}
          <ExpressionField
            label="Validation rule"
            value={validation.expression}
            columns={columns}
            placeholder="value > 0"
            onChange={(expression) => setValidation({ expression })}
          />
          <label>
            Error message
            <input
              value={validation.message ?? ""}
              onChange={(e) => setValidation({ message: e.target.value || null })}
            />
          </label>
        </fieldset>
      )}
      <fieldset className="fd-fieldset">
        <legend>Behavior</legend>
        <ExpressionField
          label="Visible when"
          value={control.visibleWhen}
          columns={columns}
          onChange={(visibleWhen) => change({ visibleWhen })}
        />
        <ExpressionField
          label="Enabled when"
          value={control.enabledWhen}
          columns={columns}
          onChange={(enabledWhen) => change({ enabledWhen })}
        />
        {(input || control.kind === "computed") && (
          <ExpressionField
            label={control.kind === "computed" ? "Expression" : "Computed value"}
            value={control.computed}
            columns={columns}
            onChange={(computed) => change({ computed })}
          />
        )}
        {input && (
          <ExpressionField
            label="Default value"
            value={control.defaultValue}
            columns={columns}
            onChange={(defaultValue) => change({ defaultValue })}
          />
        )}
        {(input || control.kind === "computed") && (
          <label>
            Format
            <input
              placeholder="#,##0.00"
              value={control.format ?? ""}
              onChange={(e) => change({ format: e.target.value || null })}
            />
          </label>
        )}
        {input && (
          <label className="fd-check">
            <input
              type="checkbox"
              checked={!!control.readOnly}
              onChange={(e) => change({ readOnly: e.target.checked })}
            />
            Read only
          </label>
        )}
        {control.kind === "boolean" && (
          <label className="fd-check">
            <input
              type="checkbox"
              checked={control.variant === "toggle"}
              onChange={(e) => change({ variant: e.target.checked ? "toggle" : null })}
            />
            Show as switch
          </label>
        )}
      </fieldset>
      <button
        type="button"
        onClick={() => {
          onDeleted();
          editForm(form.id, (f) => removeControl(f, control.id), "Delete control");
        }}
      >
        <Trash2 aria-hidden="true" />
        Delete control
      </button>
    </>
  );
}

function OptionsQueries() {
  const { config } = useDesignEditor();
  return (
    <>
      {(config.savedQueries ?? []).map((q) => (
        <option key={q.id} value={q.id}>
          {q.name}
        </option>
      ))}
    </>
  );
}
