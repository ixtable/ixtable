import { describe, expect, it } from "vitest";
import { newControl, newForm } from "../../src/design/schema";
import {
  compute,
  condition,
  defaultRecord,
  enabledControls,
  expressionProblem,
  hasErrors,
  validateControl,
  validateForm,
  visibleControls,
} from "../../src/runtime/formState";
import { namedValues, toColumnValue } from "../../src/runtime/values";

const scope = (record: Record<string, unknown> = {}) => ({ record, form: {}, app: { role: null } });

const form = () => {
  const f = newForm("Orders", { kind: "table", table: "orders" });
  const name = {
    ...newControl("text", f),
    label: "Name",
    binding: { column: "name" },
    validation: { required: true },
  };
  f.controls.push(name);
  const qty = {
    ...newControl("number", f),
    label: "Quantity",
    binding: { column: "qty" },
    validation: {
      required: false,
      min: 1,
      max: 10,
      expression: "value % 2 = 0",
      message: "Use an even quantity.",
    },
  };
  f.controls.push(qty);
  const section = { ...newControl("section", f), visibleWhen: "record.kind = 'company'" };
  f.controls.push(section);
  const vat = {
    ...newControl("text", f, { id: section.id }),
    label: "VAT",
    binding: { column: "vat" },
    validation: { required: true },
  };
  f.controls.push(vat);
  f.rules.push({
    id: "r",
    expression: "record.qty is null or record.qty < 8",
    message: "Too many.",
  });
  return { f, name, qty, section, vat };
};

describe("form validation and expressions", () => {
  it("validates required, range, and expression rules with custom messages", () => {
    const { qty, name } = form();
    expect(validateControl(name, "  ", scope())).toBe("Name is required.");
    expect(validateControl(name, "Acme", scope())).toBeNull();
    expect(validateControl(qty, 0, scope())).toBe("Use an even quantity.");
    expect(validateControl(qty, 3, scope())).toBe("Use an even quantity.");
    expect(validateControl(qty, 4, scope())).toBeNull();
    expect(validateControl({ ...qty, validation: { required: false, max: 5 } }, 6, scope())).toBe(
      "Quantity must be at most 5.",
    );
    expect(
      validateControl(
        { ...name, validation: { required: false, pattern: "[A-Z]+" } },
        "abc",
        scope(),
      ),
    ).toBe("Name is not in the expected format.");
  });

  it("skips hidden containers and checks form rules", () => {
    const { f, name, vat, section } = form();
    const person = scope({ kind: "person", qty: 8 });
    expect(visibleControls(f, person).has(section.id)).toBe(false);
    expect(visibleControls(f, person).has(vat.id)).toBe(false);
    const errors = validateForm(f, person);
    expect(Object.keys(errors.fields)).toEqual([name.id]);
    expect(errors.form).toEqual(["Too many."]);
    const company = validateForm(f, scope({ kind: "company", name: "Acme", qty: 2 }));
    expect(Object.keys(company.fields)).toEqual([vat.id]);
    expect(
      hasErrors(validateForm(f, scope({ kind: "company", name: "A", qty: 2, vat: "X" }))),
    ).toBe(false);
  });

  it("evaluates conditions, computed values, and defaults safely", () => {
    expect(condition(null, scope())).toBe(true);
    expect(condition("record.a > 1", scope({ a: 2 }))).toBe(true);
    expect(condition("record.a +", scope())).toBe(false);
    expect(compute("record.qty * record.price", scope({ qty: 3, price: 2.5 })).value).toBe(7.5);
    expect(compute("'a' * 2", scope()).error).toBeTruthy();
    const f = newForm("X");
    f.controls.push({
      ...newControl("text", f),
      binding: { column: "status" },
      defaultValue: "'open'",
    });
    f.controls.push({
      ...newControl("text", f),
      binding: { column: "label" },
      defaultValue: "upper(record.status)",
    });
    expect(defaultRecord(f, { form: {}, app: {} })).toEqual({ status: "open", label: "OPEN" });
  });

  it("reports expression problems for the designer", () => {
    expect(expressionProblem("record.qty > 1", ["qty"])).toBe("");
    expect(expressionProblem("record.nope > 1", ["qty"])).toContain("Unknown field");
    expect(expressionProblem("foo(1)")).toContain("Unknown function");
    expect(expressionProblem("")).toBe("");
  });

  it("converts form values to typed column values", () => {
    expect(toColumnValue("", "TEXT")).toEqual({ type: "null" });
    expect(toColumnValue("12", "INTEGER")).toEqual({ type: "integer", value: 12 });
    expect(toColumnValue("1,250.5", "REAL")).toEqual({ type: "real", value: 1250.5 });
    expect(toColumnValue(true, "BOOLEAN")).toEqual({ type: "boolean", value: true });
    expect(toColumnValue(true, "TEXT")).toEqual({ type: "integer", value: 1 });
    expect(toColumnValue("2026-01-02", "DATE")).toEqual({ type: "date", value: "2026-01-02" });
    expect(
      namedValues({ a: "x", b: 2, c: 3 }, [
        { name: "a", declaredType: "TEXT" },
        { name: "b", declaredType: "INTEGER" },
      ]),
    ).toEqual([
      { column: "a", value: { type: "text", value: "x" } },
      { column: "b", value: { type: "integer", value: 2 } },
    ]);
  });

  it("passes a container's disabled state to everything inside it", () => {
    const f = newForm("Orders", { kind: "table", table: "orders" });
    const tabs = { ...newControl("tabs", f), enabledWhen: "record.open" };
    f.controls.push(tabs);
    const page = { id: tabs.id, tab: tabs.tabs?.[0]?.id };
    const section = newControl("section", f, page);
    f.controls.push(section);
    const inner = { ...newControl("text", f, { id: section.id }), binding: { column: "name" } };
    const button = newControl("button", f, { id: section.id });
    const list = newControl("relatedList", f, page);
    const own = { ...newControl("number", f), enabledWhen: "record.qty > 1" };
    const outside = newControl("text", f);
    f.controls.push(inner, button, list, own, outside);
    const nested = [tabs, section, inner, button, list].map((c) => c.id);
    const closed = enabledControls(f, scope({ open: false, qty: 5 }));
    expect(nested.filter((id) => closed.has(id))).toEqual([]);
    expect(closed.has(own.id)).toBe(true);
    expect(closed.has(outside.id)).toBe(true);
    const open = enabledControls(f, scope({ open: true, qty: 0 }));
    expect(nested.filter((id) => open.has(id))).toEqual(nested);
    expect(open.has(own.id)).toBe(false);
    // Visibility is independent of enabled state.
    expect(visibleControls(f, scope({ open: false })).has(inner.id)).toBe(true);
  });

  it("does not validate controls the user cannot change", () => {
    const f = newForm("Orders", { kind: "table", table: "orders" });
    const section = { ...newControl("section", f), enabledWhen: "record.open" };
    const name = { ...newControl("text", f, { id: section.id }), binding: { column: "name" } };
    f.controls.push(section, { ...name, validation: { ...name.validation, required: true } });
    expect(hasErrors(validateForm(f, scope({ open: false })))).toBe(false);
    expect(Object.keys(validateForm(f, scope({ open: true })).fields)).toEqual([name.id]);
  });
});
