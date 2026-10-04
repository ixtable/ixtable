import type { DbObject } from "../../lib/types";
import type { QueryParameter } from "../types";
import { FieldsPanel } from "./FieldsPanel";
import { FiltersPanel } from "./FiltersPanel";
import type { BuilderModel } from "./model";
import { SortPanel } from "./SortPanel";
import { SourcesPanel } from "./SourcesPanel";
import { useSchemas } from "./useSchemas";

/** The visual query builder: sources and joins, fields, filters, having, sort. */
export function BuilderEditor({
  model,
  objects,
  parameters,
  onChange,
}: {
  model: BuilderModel;
  objects: DbObject[];
  parameters: QueryParameter[];
  onChange: (model: BuilderModel) => void;
}) {
  const schemas = useSchemas(objects);
  const tables = objects
    .filter((o) => o.objectType === "table" || o.objectType === "view")
    .map((o) => o.name);
  return (
    <div className="query-builder">
      <SourcesPanel model={model} tables={tables} schemas={schemas} onChange={onChange} />
      {model.sources.length > 0 && (
        <>
          <FieldsPanel model={model} schemas={schemas} onChange={onChange} />
          <FiltersPanel
            model={model}
            schemas={schemas}
            parameters={parameters}
            onChange={onChange}
          />
          <FiltersPanel
            model={model}
            schemas={schemas}
            parameters={parameters}
            having
            onChange={onChange}
          />
          <SortPanel model={model} onChange={onChange} />
        </>
      )}
    </div>
  );
}
