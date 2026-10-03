import { Columns3, ListFilter, Rows3, Shapes, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { inspectTable, readTablePage } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import type { DataValue, DbColumn, DbObject, DbPage } from "../lib/types";
import {
  type ControlKind,
  type DesignControl,
  type DesignSchema,
  layoutStyle,
  newControl,
  placementStyle,
} from "./schema";

type Props = { preview: boolean; objects: DbObject[] };
const valueText = (value?: DataValue) => (value?.type === "null" ? "" : String(value?.value ?? ""));

export function DesignStudio({ preview, objects }: Props) {
  const { config, update } = useDocumentConfig();
  const [selected, setSelected] = useState<string>();
  const [columns, setColumns] = useState<DbColumn[]>([]);
  const [rows, setRows] = useState<DbPage>();
  const design = config.design;
  const form = design?.forms[0];
  const control = form?.controls.find((item) => item.id === selected);

  useEffect(() => {
    if (!form?.table) {
      setColumns([]);
      setRows(undefined);
      return;
    }
    void inspectTable(form.table).then((schema) => setColumns(schema.columns));
    void readTablePage(form.table, { limit: 25 }).then(setRows);
  }, [form?.table]);

  const saveDesign = (next: DesignSchema) =>
    update((draft) => ({ ...draft, design: next }), "Edit form").catch(() => undefined);
  const changeForm = (patch: Partial<NonNullable<typeof form>>) =>
    form &&
    design &&
    saveDesign({ ...design, forms: [{ ...form, ...patch }, ...design.forms.slice(1)] });
  const changeControl = (patch: Partial<DesignControl>) =>
    control &&
    changeForm({
      controls: form?.controls.map((item) =>
        item.id === control.id ? { ...item, ...patch } : item,
      ),
    });
  const bound = useMemo(() => form?.controls.filter((item) => item.binding), [form]);

  if (!form) return <section className="studio-canvas">Loading design…</section>;
  if (preview) return <DesignPreview form={form} controls={bound ?? []} rows={rows} />;
  return (
    <section className="form-studio" aria-label="Form builder">
      <aside className="studio-components">
        <small>COMPONENTS</small>
        {(
          [
            [Rows3, "Text field", "text"],
            [ListFilter, "Select", "select"],
            [Columns3, "Number", "number"],
            [Shapes, "Section", "section"],
          ] as const
        ).map(([Icon, label, kind]) => (
          <button
            key={kind}
            onClick={() => {
              const item = newControl(kind as ControlKind, form);
              setSelected(item.id);
              void changeForm({ controls: [...form.controls, item] });
            }}
          >
            <Icon />
            {label}
          </button>
        ))}
      </aside>
      <div className="studio-canvas">
        <div className="form-card">
          <small>{form.name.toUpperCase()}</small>
          <h2>{form.name}</h2>
          <div style={layoutStyle(form.layout)}>
            {form.controls.map((item, index) => (
              <div
                role="button"
                tabIndex={0}
                className={`design-control ${selected === item.id ? "selected" : ""}`}
                key={item.id}
                style={placementStyle(item.placement)}
                onClick={() => setSelected(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setSelected(item.id);
                }}
              >
                <b>{item.label}</b>
                <span>
                  {item.binding ? `${item.binding.table}.${item.binding.column}` : item.kind}
                </span>
                <span className="move-controls">
                  <button
                    disabled={!index}
                    onClick={(event) => {
                      event.stopPropagation();
                      const controls = [...form.controls];
                      [controls[index - 1], controls[index]] = [
                        controls[index],
                        controls[index - 1],
                      ];
                      void changeForm({ controls });
                    }}
                  >
                    ↑
                  </button>
                  <button
                    disabled={index === form.controls.length - 1}
                    onClick={(event) => {
                      event.stopPropagation();
                      const controls = [...form.controls];
                      [controls[index + 1], controls[index]] = [
                        controls[index],
                        controls[index + 1],
                      ];
                      void changeForm({ controls });
                    }}
                  >
                    ↓
                  </button>
                </span>
              </div>
            ))}
            {!form.controls.length && <p>Add a component to start building this form.</p>}
          </div>
        </div>
      </div>
      <aside className="studio-properties">
        <small>PROPERTIES</small>
        <b>{control ? "Control" : "Form"}</b>
        {!control && (
          <>
            <label>
              Form name
              <input
                value={form.name}
                onChange={(e) => void changeForm({ name: e.target.value })}
              />
            </label>
            <label>
              Data table
              <select
                aria-label="Data table"
                value={form.table ?? ""}
                onChange={(e) => void changeForm({ table: e.target.value || null })}
              >
                <option value="">Unbound</option>
                {objects
                  .filter((o) => o.objectType === "table" || o.objectType === "view")
                  .map((o) => (
                    <option key={o.name}>{o.name}</option>
                  ))}
              </select>
            </label>
          </>
        )}
        {control && (
          <>
            <label>
              Label
              <input
                value={control.label}
                onChange={(e) => void changeControl({ label: e.target.value })}
              />
            </label>
            <label>
              Column
              <select
                aria-label="Bound column"
                value={control.binding?.column ?? ""}
                onChange={(e) =>
                  void changeControl({
                    binding:
                      e.target.value && form.table
                        ? { table: form.table, column: e.target.value }
                        : null,
                  })
                }
              >
                <option value="">Unbound</option>
                {columns.map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
              </select>
            </label>
            <label>
              Column span
              <input
                type="number"
                min="1"
                max={form.layout.columns.length}
                aria-label="Column span"
                value={control.placement.columnSpan}
                onChange={(e) =>
                  void changeControl({
                    placement: {
                      ...control.placement,
                      columnSpan: Number(e.target.value) || 1,
                    },
                  })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={control.validation.required}
                onChange={(e) =>
                  void changeControl({
                    validation: { ...control.validation, required: e.target.checked },
                  })
                }
              />{" "}
              Required
            </label>
            <button
              onClick={() => {
                void changeForm({
                  controls: form.controls.filter((item) => item.id !== control.id),
                });
                setSelected(undefined);
              }}
            >
              <Trash2 />
              Delete control
            </button>
          </>
        )}
      </aside>
    </section>
  );
}

function DesignPreview({
  form,
  controls,
  rows,
}: {
  form: NonNullable<DesignSchema["forms"][number]>;
  controls: DesignControl[];
  rows?: DbPage;
}) {
  return (
    <section className="app-preview" aria-label={`${form.name} preview`}>
      <div className="preview-app-head">
        <div>
          <small>LIVE APP</small>
          <h2>{form.name}</h2>
        </div>
      </div>
      <div className="preview-records">
        <div
          className="preview-record-head"
          style={{ gridTemplateColumns: `repeat(${Math.max(controls.length, 1)}, 1fr)` }}
        >
          {controls.map((item) => (
            <span key={item.id}>{item.label}</span>
          ))}
        </div>
        {rows?.rows.map((row, index) => (
          <div
            className="preview-record"
            style={{ gridTemplateColumns: `repeat(${Math.max(controls.length, 1)}, 1fr)` }}
            key={index}
          >
            {controls.map((item) => (
              <span key={item.id}>
                {valueText(
                  row[rows.columns.findIndex((column) => column.name === item.binding?.column)],
                )}
              </span>
            ))}
          </div>
        ))}
        {!rows?.rows.length && <p>No live records to display.</p>}
      </div>
    </section>
  );
}
