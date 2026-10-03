import { useState } from "react";
import type { Placement } from "../grid/types";
import type { DbObject } from "../lib/types";
import { ControlProperties } from "./ControlProperties";
import { DesignCanvas } from "./DesignCanvas";
import { DesignPreview } from "./DesignPreview";
import "./design.css";
import { FormList } from "./FormList";
import { FormProperties } from "./FormProperties";
import { LayoutSettings } from "./LayoutSettings";
import { NavigationEditor } from "./NavigationEditor";
import { addControl, setLayout, targetContainer } from "./operations";
import {
  CONTROL_KINDS,
  controlKindLabel,
  type FormMode,
  formTable,
  isContainerKind,
} from "./schema";
import { useColumns } from "./useColumns";
import { useDesignEditor } from "./useDesignEditor";

type View = "form" | "navigation" | "preview";

/** Form designer: form list, palette, editable grid canvas, properties, navigation, and preview. */
export function DesignStudio({ objects }: { objects: DbObject[] }) {
  const { design, editForm } = useDesignEditor();
  const [formId, setFormId] = useState<string | undefined>(design.forms[0]?.id);
  const [selected, setSelected] = useState<string>();
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>("form");
  const [previewMode, setPreviewMode] = useState<FormMode>("list");
  const form = design.forms.find((f) => f.id === formId) ?? design.forms[0];
  const columns = useColumns(formTable(form));
  const control = form?.controls.find((c) => c.id === selected);

  const selectForm = (id: string) => {
    setFormId(id);
    setSelected(undefined);
  };
  const add = (kind: (typeof CONTROL_KINDS)[number]) => {
    if (!form) return;
    const parent = targetContainer(form, selected, activeTabs);
    const { control: created } = addControl(form, kind, parent);
    setSelected(created.id);
    editForm(
      form.id,
      (f) => ({
        ...f,
        controls: [
          ...f.controls,
          { ...created, placement: addControl(f, kind, parent).control.placement },
        ],
      }),
      "Add control",
    );
  };
  const place = (id: string, placement: Placement) =>
    form &&
    editForm(
      form.id,
      (f) => ({ ...f, controls: f.controls.map((c) => (c.id === id ? { ...c, placement } : c)) }),
      "Resize control",
    );
  const modes = form?.modes.length ? form.modes : (["list"] as FormMode[]);
  const mode = modes.includes(previewMode) ? previewMode : modes[0];

  return (
    <section className="form-studio" aria-label="Form builder">
      <aside className="studio-components fd-left">
        <FormList selectedId={form?.id} onSelect={selectForm} objects={objects} />
        <div className="fd-palette" role="group" aria-label="Components">
          <small>COMPONENTS</small>
          {CONTROL_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-label={`Add ${controlKindLabel(kind)}`}
              disabled={!form}
              onClick={() => add(kind)}
            >
              {controlKindLabel(kind)}
            </button>
          ))}
        </div>
      </aside>
      <div className="studio-canvas">
        <div className="fd-toolbar" role="toolbar" aria-label="Designer view">
          {(["form", "navigation", "preview"] as View[]).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={view === item}
              onClick={() => setView(item)}
            >
              {item === "form" ? "Layout" : item === "navigation" ? "Navigation" : "Preview"}
            </button>
          ))}
          {view === "preview" && (
            <label>
              Preview mode
              <select value={mode} onChange={(e) => setPreviewMode(e.target.value as FormMode)}>
                {modes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {view === "navigation" && <NavigationEditor objects={objects} />}
        {view === "preview" && form && (
          <DesignPreview key={`${form.id}:${mode}`} form={form} mode={mode} />
        )}
        {view === "form" &&
          (form ? (
            <div className="form-card fd-card-wide">
              <small>
                {form.source?.kind === "query"
                  ? "READ-ONLY FORM"
                  : (formTable(form) ?? "UNBOUND").toUpperCase()}
              </small>
              <h2>{form.name}</h2>
              <p className="fd-hint">
                Enter selects a control, Alt+Arrow resizes, Alt+Shift+Arrow moves.
              </p>
              <DesignCanvas
                form={form}
                selectedId={selected}
                onSelect={setSelected}
                activeTabs={activeTabs}
                onActiveTab={(tabsId, tabId) => setActiveTabs((t) => ({ ...t, [tabsId]: tabId }))}
                onPlacement={place}
              />
              {!form.controls.length && <p>Add a component to start building this form.</p>}
            </div>
          ) : (
            <p className="fd-hint">Create a form or generate one from a table.</p>
          ))}
      </div>
      <aside className="studio-properties" aria-label="Properties">
        <small>PROPERTIES</small>
        {form && (
          <>
            <b>{control ? "Control" : "Form"}</b>
            {control && (
              <button type="button" className="fd-link" onClick={() => setSelected(undefined)}>
                Back to form properties
              </button>
            )}
            {control ? (
              <ControlProperties
                key={control.id}
                form={form}
                control={control}
                columns={columns}
                objects={objects}
                onDeleted={() => setSelected(undefined)}
              />
            ) : (
              <FormProperties
                form={form}
                objects={objects}
                columns={columns}
                layoutSettings={
                  <LayoutSettings
                    layout={form.layout}
                    onChange={(layout) =>
                      editForm(form.id, (f) => setLayout(f, null, layout), "Edit grid")
                    }
                  />
                }
              />
            )}
            {control && isContainerKind(control.kind) && control.layout && (
              <LayoutSettings
                title="Container grid"
                layout={control.layout}
                onChange={(layout) =>
                  editForm(form.id, (f) => setLayout(f, control.id, layout), "Edit grid")
                }
              />
            )}
          </>
        )}
      </aside>
    </section>
  );
}
