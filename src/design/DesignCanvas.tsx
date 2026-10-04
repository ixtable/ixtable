import type { SyntheticEvent } from "react";
import { GridCanvas, GridItem } from "../grid";
import type { Placement } from "../grid/types";
import { controlConstraints } from "./constraints";
import { controlKindLabel, type DesignControl, type DesignForm } from "./schema";

type Props = {
  form: DesignForm;
  selectedId?: string;
  onSelect: (id: string) => void;
  activeTabs: Record<string, string>;
  onActiveTab: (tabsId: string, tabId: string) => void;
  onPlacement: (id: string, placement: Placement) => void;
};

const stop = (event: SyntheticEvent) => event.stopPropagation();

/** Design-time canvas: the form grid and nested container grids, all editable. */
export function DesignCanvas(props: Props) {
  return <CanvasGrid {...props} parent={null} />;
}

function CanvasGrid(props: Props & { parent: DesignControl | null; tab?: string }) {
  const { form, parent, tab, selectedId, onSelect, onPlacement } = props;
  const layout = parent?.layout ?? form.layout;
  const items = form.controls.filter(
    (c) => (c.parent?.id ?? null) === (parent?.id ?? null) && (!tab || c.parent?.tab === tab),
  );
  return (
    <GridCanvas
      layout={layout}
      editable
      selectedId={selectedId}
      onSelect={onSelect}
      onResize={onPlacement}
      onMove={onPlacement}
      label={parent ? `${parent.label} layout` : `${form.name} layout`}
    >
      {items.map((control) => (
        <GridItem
          key={control.id}
          id={control.id}
          placement={control.placement}
          label={control.label}
          constraints={controlConstraints(control.kind, layout.columns.length)}
        >
          <ControlCard {...props} control={control} />
        </GridItem>
      ))}
    </GridCanvas>
  );
}

function summary(control: DesignControl): string {
  if (control.kind === "label") return control.text ?? "";
  if (control.kind === "relationship" && control.relationship)
    return `${control.binding?.column ?? "?"} → ${control.relationship.table}.${control.relationship.displayColumn}`;
  if (control.kind === "relatedList" && control.related)
    return `${control.related.table} by ${control.related.foreignKey}`;
  if (control.kind === "computed")
    return control.computed ? `= ${control.computed}` : "No expression";
  if (control.kind === "button") return control.actionId ? "Runs an action" : "No action";
  return control.binding?.column ?? "Unbound";
}

function ControlCard(props: Props & { control: DesignControl }) {
  const { control, activeTabs, onActiveTab } = props;
  const conditional = control.visibleWhen || control.enabledWhen;
  const header = (
    <div className="fd-card-head">
      <b>{control.label}</b>
      <span>
        {controlKindLabel(control.kind)}
        {control.validation?.required ? " · required" : ""}
        {conditional ? " · conditional" : ""}
      </span>
    </div>
  );
  if (control.kind === "section")
    return (
      <div className="fd-card fd-container">
        {header}
        <div onKeyDown={stop} onClick={stop}>
          <CanvasGrid {...props} parent={control} />
        </div>
      </div>
    );
  if (control.kind === "tabs") {
    const tabs = control.tabs ?? [];
    const active = activeTabs[control.id] ?? tabs[0]?.id;
    return (
      <div className="fd-card fd-container">
        {header}
        <div
          className="fd-tabstrip"
          role="group"
          aria-label={`${control.label} tabs`}
          onClick={stop}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={tab.id === active}
              onKeyDown={stop}
              onClick={() => onActiveTab(control.id, tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {active && (
          <div onKeyDown={stop} onClick={stop}>
            <CanvasGrid {...props} parent={control} tab={active} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="fd-card">
      {header}
      <small>{summary(control)}</small>
    </div>
  );
}
