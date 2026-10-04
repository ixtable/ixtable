import type { DesignControl, DesignForm } from "../design/schema";
import { isInputKind } from "../design/schema";
import { check, evaluate, evaluateBoolean, formatValue } from "../expr";
import type { RecordValues } from "./values";

/** Expression scope for forms: `record`, `form` (form state), `app` (app state incl. user/role), `value`. */
export type FormScope = {
  record: RecordValues;
  form: Record<string, unknown>;
  app: Record<string, unknown>;
  value?: unknown;
};

const present = (src?: string | null): src is string => !!src && src.trim() !== "";

/** Names an expression in this form may use; `record.<column>` limits record fields to known columns. */
export function knownNames(columns?: string[]): string[] {
  const record = columns?.length ? columns.map((c) => `record.${c}`) : ["record"];
  return [...record, "form", "app", "value"];
}

/** Diagnostics text for an expression field in the designer ("" when valid). */
export function expressionProblem(src: string | null | undefined, columns?: string[]): string {
  if (!present(src)) return "";
  const diagnostics = check(src, knownNames(columns));
  return diagnostics.map((d) => d.message).join("; ");
}

/** Evaluates a condition; a blank expression gives `fallback`, an error gives false. */
export function condition(
  src: string | null | undefined,
  scope: FormScope,
  fallback = true,
): boolean {
  if (!present(src)) return fallback;
  try {
    return evaluateBoolean(src, scope);
  } catch {
    return false;
  }
}

export type Computed = { value: unknown; error?: string };

export function compute(src: string | null | undefined, scope: FormScope): Computed {
  if (!present(src)) return { value: null };
  try {
    return { value: evaluate(src, scope) };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Formats a value with the control's pattern, falling back to plain text. */
export function formatted(value: unknown, pattern?: string | null): string {
  if (value === null || value === undefined) return "";
  if (pattern) {
    try {
      return formatValue(value, pattern);
    } catch {
      return String(value);
    }
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

const isBlank = (value: unknown) =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/** One control's validation message, or null when valid. */
export function validateControl(
  control: DesignControl,
  value: unknown,
  scope: FormScope,
): string | null {
  const rules = control.validation ?? { required: false };
  const custom = rules.message?.trim();
  const label = control.label || control.binding?.column || "This field";
  if (isBlank(value)) {
    return rules.required ? custom || `${label} is required.` : null;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (rules.min != null && Number.isFinite(number) && number < rules.min)
    return custom || `${label} must be at least ${rules.min}.`;
  if (rules.max != null && Number.isFinite(number) && number > rules.max)
    return custom || `${label} must be at most ${rules.max}.`;
  if (rules.pattern && !matchesPattern(rules.pattern, value))
    return custom || `${label} is not in the expected format.`;
  if (present(rules.expression) && !condition(rules.expression, { ...scope, value }, true))
    return custom || `${label} is not valid.`;
  return null;
}

/** Whole-value regex match; an invalid pattern never blocks saving. */
function matchesPattern(pattern: string, value: unknown): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(String(value));
  } catch {
    return true;
  }
}

/** Text of a value for list cells, using a control's format when one is given. */
export const cellText = (value: unknown, control?: DesignControl) =>
  formatted(value, control?.format);

/**
 * Controls for which `own(control)` holds and holds for every ancestor container, so a hidden
 * or disabled section or tab group passes that state to everything inside it.
 */
function inherited(form: DesignForm, own: (control: DesignControl) => boolean): Set<string> {
  const byId = new Map(form.controls.map((control) => [control.id, control]));
  const memo = new Map<string, boolean>();
  const holds = (control: DesignControl, depth = 0): boolean => {
    const known = memo.get(control.id);
    if (known !== undefined) return known;
    const parent = control.parent ? byId.get(control.parent.id) : undefined;
    const result = own(control) && (!parent || depth > 20 || holds(parent, depth + 1));
    memo.set(control.id, result);
    return result;
  };
  return new Set(form.controls.filter((control) => holds(control)).map((c) => c.id));
}

/** Container visibility: a control is hidden when it or any ancestor container is hidden. */
export const visibleControls = (form: DesignForm, scope: FormScope): Set<string> =>
  inherited(form, (control) => condition(control.visibleWhen, scope));

/** Container enabled state: a control is disabled when it or any ancestor container is. */
export const enabledControls = (form: DesignForm, scope: FormScope): Set<string> =>
  inherited(form, (control) => condition(control.enabledWhen, scope));

export type FormErrors = { fields: Record<string, string>; form: string[] };

/** Validates every visible bound control and the form-level rules. */
export function validateForm(form: DesignForm, scope: FormScope): FormErrors {
  const visible = visibleControls(form, scope);
  const fields: Record<string, string> = {};
  for (const control of form.controls) {
    if (!visible.has(control.id) || !isInputKind(control.kind) || control.readOnly) continue;
    const column = control.binding?.column;
    const message = validateControl(control, column ? scope.record[column] : null, scope);
    if (message) fields[control.id] = message;
  }
  const messages = form.rules
    .filter((rule) => present(rule.expression) && !condition(rule.expression, scope, true))
    .map((rule) => rule.message || "The record is not valid.");
  return { fields, form: messages };
}

export const hasErrors = (errors: FormErrors) =>
  Object.keys(errors.fields).length > 0 || errors.form.length > 0;

/** Initial values for create mode from controls' default-value expressions. */
export function defaultRecord(form: DesignForm, scope: Omit<FormScope, "record">): RecordValues {
  const record: RecordValues = {};
  for (const control of form.controls) {
    const column = control.binding?.column;
    if (!column || !present(control.defaultValue)) continue;
    record[column] = compute(control.defaultValue, { ...scope, record }).value;
  }
  return record;
}
