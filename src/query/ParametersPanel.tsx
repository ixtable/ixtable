import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { PARAMETER_TYPES, type QueryParameter } from "./types";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const showDefault = (value: unknown) =>
  value === null || value === undefined ? "" : String(value);

/** Declares query parameters: name, logical type, default value, required flag. */
export function ParametersPanel({
  parameters,
  referenced,
  onChange,
}: {
  parameters: QueryParameter[];
  /** Placeholder names used by the query; undeclared ones get an Add button. */
  referenced: string[];
  onChange: (parameters: QueryParameter[]) => void;
}) {
  const [name, setName] = useState("");
  const declared = new Set(parameters.map((p) => p.name));
  const missing = referenced.filter((n) => !declared.has(n));
  const valid = NAME.test(name) && !declared.has(name);
  const patch = (index: number, change: Partial<QueryParameter>) =>
    onChange(parameters.map((p, i) => (i === index ? { ...p, ...change } : p)));
  const add = (paramName: string) =>
    onChange([...parameters, { name: paramName, logicalType: "text", required: false }]);
  return (
    <section className="query-panel" aria-labelledby="query-parameters-heading">
      <h3 id="query-parameters-heading">Parameters</h3>
      {!parameters.length && <small>No parameters. Use $name in filters or SQL.</small>}
      {parameters.map((p, i) => (
        <div className="query-row" key={p.name || i}>
          <code>${p.name}</code>
          <select
            aria-label={`Type of ${p.name}`}
            value={p.logicalType}
            onChange={(e) => patch(i, { logicalType: e.target.value })}
          >
            {PARAMETER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            aria-label={`Default for ${p.name}`}
            placeholder="Default"
            value={showDefault(p.defaultValue)}
            onChange={(e) =>
              patch(i, { defaultValue: e.target.value === "" ? null : e.target.value })
            }
          />
          <label className="query-check">
            <input
              type="checkbox"
              aria-label={`Required ${p.name}`}
              checked={!!p.required}
              onChange={(e) => patch(i, { required: e.target.checked })}
            />
            Required
          </label>
          <button
            type="button"
            aria-label={`Remove parameter ${p.name}`}
            onClick={() => onChange(parameters.filter((_, j) => j !== i))}
          >
            <Trash2 />
          </button>
        </div>
      ))}
      {missing.map((n) => (
        <button type="button" key={n} onClick={() => add(n)}>
          <Plus />
          Declare ${n}
        </button>
      ))}
      <form
        className="query-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          add(name);
          setName("");
        }}
      >
        <input
          aria-label="New parameter name"
          placeholder="parameter_name"
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
        />
        <button type="submit" disabled={!valid}>
          <Plus />
          Add parameter
        </button>
      </form>
    </section>
  );
}

/** Run-time values for parameters; empty fields fall back to defaults. */
export function ParameterValues({
  parameters,
  values,
  onChange,
}: {
  parameters: QueryParameter[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  if (!parameters.length) return null;
  return (
    <fieldset className="query-param-values">
      <legend>Run with</legend>
      {parameters.map((p) => (
        <label key={p.name}>
          <span>
            {p.name}
            {p.required && " *"}
          </span>
          {p.logicalType === "boolean" ? (
            <select
              aria-label={`Value for ${p.name}`}
              value={values[p.name] ?? ""}
              onChange={(e) => onChange({ ...values, [p.name]: e.target.value })}
            >
              <option value="">Default ({showDefault(p.defaultValue) || "none"})</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              aria-label={`Value for ${p.name}`}
              type={p.logicalType === "date" ? "date" : "text"}
              placeholder={showDefault(p.defaultValue) || p.logicalType}
              value={values[p.name] ?? ""}
              onChange={(e) => onChange({ ...values, [p.name]: e.target.value })}
            />
          )}
        </label>
      ))}
    </fieldset>
  );
}
