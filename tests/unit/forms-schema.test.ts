import { describe, expect, it } from "vitest";
import {
  deleteForm,
  descendants,
  duplicateForm,
  moveToContainer,
  regroupNavigation,
  removeControl,
  removeTab,
  setLayout,
  shiftNavigation,
  targetContainer,
  withColumnCount,
} from "../../src/design/operations";
import {
  DESIGN_SCHEMA_VERSION,
  type DesignSchema,
  flattenNavigation,
  newControl,
  newForm,
  nextPlacement,
  upgradeDesign,
} from "../../src/design/schema";

const v2 = {
  version: 2,
  forms: [
    {
      id: "f",
      name: "Customers",
      table: "customers",
      controls: [
        {
          id: "c",
          kind: "checkbox",
          label: "Active",
          binding: { table: "customers", column: "active" },
          validation: { required: true },
          placement: { column: 1, row: 1, columnSpan: 6, rowSpan: 1 },
        },
      ],
    },
  ],
  navigation: [{ id: "n", label: "Customers", formId: "f" }],
};

describe("design schema upgrade", () => {
  it("upgrades a v2 design to the current shape", () => {
    const design = upgradeDesign(v2);
    expect(design.version).toBe(DESIGN_SCHEMA_VERSION);
    const form = design.forms[0];
    expect(form.source).toEqual({ kind: "table", table: "customers" });
    expect(form.modes).toEqual(["list", "detail", "create", "edit"]);
    expect(form.rules).toEqual([]);
    expect(form.layout.columns).toHaveLength(12);
    expect(form.controls[0].kind).toBe("boolean");
    expect(form.controls[0].binding?.column).toBe("active");
    expect(form.controls[0].placement).toEqual({
      column: 1,
      row: 1,
      columnSpan: 6,
      rowSpan: 1,
      region: null,
    });
    expect(design.navigation[0]).toMatchObject({ kind: "form", targetId: "f", children: [] });
    expect(design.startPage).toBe("n");
  });

  it("keeps a current design as is and fills missing defaults", () => {
    const design = upgradeDesign({ version: 3, forms: [{ id: "a", name: "A" }], startPage: null });
    expect(design.startPage).toBeNull();
    expect(design.forms[0]).toMatchObject({ source: null, pageSize: 25, listColumns: [] });
    expect(upgradeDesign(undefined)).toEqual({
      version: DESIGN_SCHEMA_VERSION,
      forms: [],
      navigation: [],
      startPage: null,
    });
  });
});

describe("form operations", () => {
  const build = () => {
    const form = newForm("Orders", { kind: "table", table: "orders" });
    const tabs = newControl("tabs", form);
    form.controls.push(tabs);
    const tab = tabs.tabs?.[0]?.id ?? "";
    const inner = newControl("text", form, { id: tabs.id, tab });
    form.controls.push(inner);
    const section = newControl("section", form);
    form.controls.push(section);
    return { form, tabs, tab, inner, section };
  };

  it("places new controls in the first free slot of their container", () => {
    const { form, tabs, tab, inner } = build();
    expect(inner.placement).toMatchObject({ column: 1, row: 1, columnSpan: 6 });
    const second = newControl("number", form, { id: tabs.id, tab });
    expect(second.placement).toMatchObject({ column: 7, row: 1 });
    expect(nextPlacement(form)).toMatchObject({ column: 1, row: 3, columnSpan: 12 });
  });

  it("removes containers with their children and tabs with their controls", () => {
    const { form, tabs, tab, inner } = build();
    expect(descendants(form, tabs.id)).toEqual(new Set([tabs.id, inner.id]));
    expect(removeControl(form, tabs.id).controls.map((c) => c.id)).not.toContain(inner.id);
    const withoutTab = removeTab(form, tabs.id, tab);
    expect(withoutTab.controls.find((c) => c.id === inner.id)).toBeUndefined();
    expect(withoutTab.controls.find((c) => c.id === tabs.id)?.tabs).toHaveLength(1);
  });

  it("clamps placements when a grid loses columns", () => {
    const { form, inner, tabs } = build();
    const narrowed = setLayout(form, null, withColumnCount(form.layout, 4));
    expect(narrowed.layout.columns).toHaveLength(4);
    expect(narrowed.controls.find((c) => c.id === tabs.id)?.placement).toMatchObject({
      column: 1,
      columnSpan: 4,
    });
    expect(narrowed.controls.find((c) => c.id === inner.id)?.placement.columnSpan).toBe(6);
    const container = setLayout(form, tabs.id, withColumnCount(form.layout, 2));
    expect(container.controls.find((c) => c.id === inner.id)?.placement.columnSpan).toBe(2);
  });

  it("changes the column count without rewriting authored tracks", () => {
    const { form } = build();
    const layout = {
      ...form.layout,
      columns: [
        { kind: "fixed" as const, value: 200, min: null, max: null },
        { kind: "content" as const, value: null, min: 80, max: 300 },
        { kind: "fr" as const, value: 2, min: null, max: null },
      ],
    };
    const wider = withColumnCount(layout, 5);
    expect(wider.columns.slice(0, 3)).toEqual(layout.columns);
    expect(wider.columns.slice(3)).toEqual([
      { kind: "fr", value: 1, min: null, max: null },
      { kind: "fr", value: 1, min: null, max: null },
    ]);
    expect(withColumnCount(layout, 2).columns).toEqual(layout.columns.slice(0, 2));
    expect(withColumnCount(layout, 0).columns).toEqual(layout.columns.slice(0, 1));
    expect(withColumnCount(layout, 99).columns).toHaveLength(24);
  });

  it("duplicates a form with fresh, consistently remapped ids", () => {
    const { form, tabs, inner } = build();
    const copy = duplicateForm(form);
    expect(copy.id).not.toBe(form.id);
    const copiedTabs = copy.controls.find((c) => c.kind === "tabs");
    const copiedInner = copy.controls.find((c) => c.kind === "text");
    expect(copiedTabs?.id).not.toBe(tabs.id);
    expect(copiedInner?.parent?.id).toBe(copiedTabs?.id);
    expect(copiedInner?.parent?.tab).toBe(copiedTabs?.tabs?.[0].id);
    expect(copiedInner?.id).not.toBe(inner.id);
  });

  it("moves controls between containers but never into themselves", () => {
    const { form, section, inner, tabs } = build();
    const moved = moveToContainer(form, inner.id, { id: section.id, tab: null });
    expect(moved.controls.find((c) => c.id === inner.id)?.parent).toEqual({
      id: section.id,
      tab: null,
    });
    expect(moveToContainer(form, tabs.id, { id: tabs.id, tab: null })).toBe(form);
  });

  it("targets the selected container, or the selected control's container", () => {
    const { form, tabs, tab, inner, section } = build();
    expect(targetContainer(form, undefined, {})).toBeNull();
    expect(targetContainer(form, section.id, {})).toEqual({ id: section.id, tab: null });
    expect(targetContainer(form, tabs.id, {})).toEqual({ id: tabs.id, tab });
    expect(targetContainer(form, inner.id, {})).toEqual({ id: tabs.id, tab });
  });

  it("deletes a form and its references", () => {
    const list = newForm("List");
    const detail = newForm("Detail");
    list.detailFormId = detail.id;
    const design: DesignSchema = {
      version: 3,
      forms: [list, detail],
      navigation: [
        {
          id: "g",
          label: "Group",
          kind: "group",
          children: [{ id: "d", label: "D", kind: "form", targetId: detail.id }],
        },
        { id: "l", label: "L", kind: "form", targetId: list.id },
      ],
      startPage: "d",
    };
    const next = deleteForm(design, detail.id);
    expect(next.forms.map((f) => f.id)).toEqual([list.id]);
    expect(next.forms[0].detailFormId).toBeNull();
    expect(flattenNavigation(next.navigation).map((i) => i.id)).toEqual(["g", "l"]);
    expect(next.startPage).toBe("l");
  });

  it("reorders and regroups navigation items", () => {
    const items = [
      { id: "a", label: "A", kind: "form" as const, targetId: "f" },
      { id: "g", label: "G", kind: "group" as const, children: [] },
    ];
    expect(shiftNavigation(items, "g", -1).map((i) => i.id)).toEqual(["g", "a"]);
    const grouped = regroupNavigation(items, "a", "g");
    expect(grouped).toHaveLength(1);
    expect(grouped[0].children?.map((i) => i.id)).toEqual(["a"]);
    expect(regroupNavigation(grouped, "a", null).map((i) => i.id)).toEqual(["g", "a"]);
    expect(regroupNavigation(grouped, "g", "g")).toBe(grouped);
  });
});
