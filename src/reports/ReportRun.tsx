import { type FormEvent, useState } from "react";
import { DialogFrame } from "../components/DialogFrame";
import { useDocumentConfig } from "../lib/config-store";
import type { QueryParameter } from "../query/types";
import { ReportPreview } from "./ReportPreview";
import { display, inputType, parseParameter, reportParameters } from "./parameters";
import type { Report } from "./types";
import "./reports.css";

/** Asks for a report's parameter values, prefilled with the given values or defaults. */
export function ParameterPrompt({
  report,
  parameters,
  initial,
  onRun,
  onCancel,
}: {
  report: Report;
  parameters: QueryParameter[];
  initial: Record<string, unknown>;
  onRun: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [raw, setRaw] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      parameters.map((p) => {
        const value = p.name in initial ? initial[p.name] : p.defaultValue;
        return [p.name, p.logicalType === "boolean" ? value === true : display(value)];
      }),
    ),
  );
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const values: Record<string, unknown> = {};
    for (const p of parameters) {
      const parsed = parseParameter(p, raw[p.name]);
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      values[p.name] = parsed.value;
    }
    onRun(values);
  };
  return (
    <DialogFrame
      className="report-params"
      role="dialog"
      aria-modal="true"
      aria-label={`${report.name} parameters`}
      onClose={onCancel}
    >
      <form onSubmit={submit}>
        <h3>{report.name}</h3>
        <p>Enter the values to run this report with.</p>
        {parameters.map((p, i) => (
          <label key={p.name} className={p.logicalType === "boolean" ? "inline" : undefined}>
            {p.logicalType === "boolean" ? (
              <input
                type="checkbox"
                checked={raw[p.name] === true}
                data-autofocus={i === 0 ? true : undefined}
                onChange={(e) => setRaw({ ...raw, [p.name]: e.target.checked })}
              />
            ) : null}
            {p.name}
            {p.required ? " (required)" : ""}
            {p.logicalType !== "boolean" && (
              <input
                type={inputType(p.logicalType)}
                step={p.logicalType === "number" ? "any" : undefined}
                value={String(raw[p.name] ?? "")}
                data-autofocus={i === 0 ? true : undefined}
                onChange={(e) => setRaw({ ...raw, [p.name]: e.target.value })}
              />
            )}
          </label>
        ))}
        {error && <p role="alert">{error}</p>}
        <div className="report-params-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Run report
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

/**
 * A report opened from Runtime navigation or an action. When the report's
 * queries declare parameters the opener didn't supply, it first prompts for
 * them (prefilled with defaults), then shows the preview.
 */
export function ReportRun({
  reportId,
  params,
}: {
  reportId: string;
  params?: Record<string, unknown>;
}) {
  const { config } = useDocumentConfig();
  const report = config.reports.find((r) => r.id === reportId);
  const parameters = report ? reportParameters(report, config.savedQueries) : [];
  const given = params ?? {};
  // A required parameter passed as null still needs a value, so it prompts too.
  const complete = parameters.every(
    (p) => p.name in given && (!p.required || (given[p.name] ?? null) !== null),
  );
  const [values, setValues] = useState<Record<string, unknown> | null>(complete ? given : null);
  const [prompting, setPrompting] = useState(!complete);
  if (!report) return <ReportPreview reportId={reportId} params={params} />;
  return (
    <>
      {parameters.length > 0 && !prompting && (
        <div className="report-params-bar">
          {values === null && <span role="status">The report was not run.</span>}
          <button type="button" onClick={() => setPrompting(true)}>
            {values === null ? "Enter parameters…" : "Change parameters…"}
          </button>
        </div>
      )}
      {prompting && (
        <ParameterPrompt
          report={report}
          parameters={parameters}
          initial={values ?? given}
          onRun={(entered) => {
            setValues({ ...given, ...entered });
            setPrompting(false);
          }}
          onCancel={() => setPrompting(false)}
        />
      )}
      {values !== null && <ReportPreview reportId={reportId} params={values} />}
    </>
  );
}
