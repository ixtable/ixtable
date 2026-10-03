import type { GridLayout, Placement } from "../grid/types";
import { newId } from "../lib/utils";
import {
  type ControlKind,
  type ControlParent,
  type DesignControl,
  type DesignForm,
  type DesignSchema,
  flattenNavigation,
  isContainerKind,
  type NavigationItem,
  newControl,
} from "./schema";

/** Keeps a placement inside a grid with `columns` base columns. */
export function clampPlacement(placement: Placement, columns: number): Placement {
  if (placement.region) return placement;
  const count = Math.max(1, columns);
  const columnSpan = Math.min(Math.max(1, placement.columnSpan), count);
  const column = Math.min(Math.max(1, placement.column), count - columnSpan + 1);
  return { ...placement, column, columnSpan };
}

/** Ids of a control and everything nested inside it (sections, tab pages). */
export function descendants(form: DesignForm, id: string, tab?: string): Set<string> {
  const out = new Set<string>(tab ? [] : [id]);
  let frontier = form.controls.filter(
    (c) => c.parent?.id === id && (tab === undefined || c.parent?.tab === tab),
  );
  while (frontier.length) {
    frontier.forEach((c) => out.add(c.id));
    frontier = form.controls.filter((c) => c.parent && frontier.some((f) => f.id === c.parent?.id));
  }
  return out;
}

export const removeControl = (form: DesignForm, id: string): DesignForm => {
  const gone = descendants(form, id);
  return { ...form, controls: form.controls.filter((c) => !gone.has(c.id)) };
};

/** Removes a tab page from a tab group together with the controls on it. */
export function removeTab(form: DesignForm, tabsId: string, tabId: string): DesignForm {
  const gone = descendants(form, tabsId, tabId);
  return {
    ...form,
    controls: form.controls
      .filter((c) => !gone.has(c.id))
      .map((c) =>
        c.id === tabsId ? { ...c, tabs: (c.tabs ?? []).filter((t) => t.id !== tabId) } : c,
      ),
  };
}

/** Replaces a container's (or the form's) grid and clamps the controls placed on it. */
export function setLayout(
  form: DesignForm,
  containerId: string | null,
  layout: GridLayout,
): DesignForm {
  const columns = layout.columns.length;
  return {
    ...form,
    layout: containerId ? form.layout : layout,
    controls: form.controls.map((control) => {
      const onGrid = (control.parent?.id ?? null) === containerId;
      const next = control.id === containerId ? { ...control, layout } : control;
      return onGrid ? { ...next, placement: clampPlacement(next.placement, columns) } : next;
    }),
  };
}

/** Sets the number of equal-width base columns. */
export const withColumnCount = (layout: GridLayout, count: number): GridLayout => ({
  ...layout,
  columns: Array.from({ length: Math.max(1, Math.min(24, count)) }, () => ({
    kind: "fr" as const,
    value: 1,
    min: null,
    max: null,
  })),
});

/** Adds a control of `kind` to the container `parent` (the form grid when null). */
export function addControl(
  form: DesignForm,
  kind: ControlKind,
  parent: ControlParent | null,
): { form: DesignForm; control: DesignControl } {
  const control = newControl(kind, form, parent);
  return { form: { ...form, controls: [...form.controls, control] }, control };
}

/** Moves a control into another container, placing it at the first free slot there. */
export function moveToContainer(
  form: DesignForm,
  id: string,
  parent: ControlParent | null,
): DesignForm {
  const control = form.controls.find((c) => c.id === id);
  if (!control || (parent && descendants(form, id).has(parent.id))) return form;
  const others = { ...form, controls: form.controls.filter((c) => c.id !== id) };
  const placed = newControl(control.kind, others, parent).placement;
  return {
    ...form,
    controls: form.controls.map((c) =>
      c.id === id
        ? {
            ...c,
            parent,
            placement: {
              ...placed,
              columnSpan: Math.min(c.placement.columnSpan, placed.columnSpan),
            },
          }
        : c,
    ),
  };
}

/** A deep copy with fresh ids for the form, its controls, tabs, and rules. */
export function duplicateForm(form: DesignForm, name = `${form.name} copy`): DesignForm {
  const ids = new Map(form.controls.map((c) => [c.id, newId()]));
  const tabs = new Map(
    form.controls.flatMap((c) => (c.tabs ?? []).map((t) => [t.id, newId()] as const)),
  );
  return {
    ...structuredClone(form),
    id: newId(),
    name,
    rules: form.rules.map((rule) => ({ ...rule, id: newId() })),
    controls: form.controls.map((control) => ({
      ...structuredClone(control),
      id: ids.get(control.id) ?? newId(),
      tabs: control.tabs?.map((t) => ({ ...t, id: tabs.get(t.id) ?? newId() })),
      parent: control.parent
        ? {
            id: ids.get(control.parent.id) ?? control.parent.id,
            tab: control.parent.tab ? (tabs.get(control.parent.tab) ?? control.parent.tab) : null,
          }
        : null,
    })),
  };
}

const pruneNavigation = (items: NavigationItem[], formId: string): NavigationItem[] =>
  items
    .filter((item) => !(item.kind === "form" && item.targetId === formId))
    .map((item) => ({ ...item, children: pruneNavigation(item.children ?? [], formId) }));

/** Deletes a form and every reference to it (navigation, detail forms, related lists). */
export function deleteForm(design: DesignSchema, formId: string): DesignSchema {
  const navigation = pruneNavigation(design.navigation, formId);
  const stillThere = (id?: string | null) =>
    !!id && flattenNavigation(navigation).some((item) => item.id === id);
  return {
    ...design,
    forms: design.forms
      .filter((form) => form.id !== formId)
      .map((form) => ({
        ...form,
        detailFormId: form.detailFormId === formId ? null : (form.detailFormId ?? null),
        controls: form.controls.map((c) =>
          c.related?.formId === formId ? { ...c, related: { ...c.related, formId: null } } : c,
        ),
      })),
    navigation,
    startPage: stillThere(design.startPage)
      ? design.startPage
      : (flattenNavigation(navigation).find((item) => item.kind !== "group")?.id ?? null),
  };
}

/** Container a new control should go into, given the selected control and active tab per tab group. */
export function targetContainer(
  form: DesignForm,
  selectedId: string | undefined,
  activeTabs: Record<string, string>,
): ControlParent | null {
  const selected = form.controls.find((c) => c.id === selectedId);
  if (!selected) return null;
  if (isContainerKind(selected.kind)) {
    if (selected.kind === "section") return { id: selected.id, tab: null };
    const tab = activeTabs[selected.id] ?? selected.tabs?.[0]?.id;
    return tab ? { id: selected.id, tab } : null;
  }
  return selected.parent ?? null;
}

/** Applies `change` to the navigation item `id` anywhere in the tree. */
export function mapNavigation(
  items: NavigationItem[],
  id: string,
  change: (item: NavigationItem) => NavigationItem,
): NavigationItem[] {
  return items.map((item) =>
    item.id === id
      ? change(item)
      : { ...item, children: mapNavigation(item.children ?? [], id, change) },
  );
}

/** Removes the item `id` (and its children) from the tree; returns the tree and the removed item. */
export function takeNavigation(
  items: NavigationItem[],
  id: string,
): { items: NavigationItem[]; taken: NavigationItem | null } {
  let taken: NavigationItem | null = null;
  const walk = (list: NavigationItem[]): NavigationItem[] =>
    list.flatMap((item) => {
      if (item.id === id) {
        taken = item;
        return [];
      }
      return [{ ...item, children: walk(item.children ?? []) }];
    });
  const next = walk(items);
  return { items: next, taken };
}

/** Moves an item up or down among its siblings. */
export function shiftNavigation(
  items: NavigationItem[],
  id: string,
  delta: number,
): NavigationItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }
  return items.map((item) => ({
    ...item,
    children: shiftNavigation(item.children ?? [], id, delta),
  }));
}

/** Moves an item into a group (or to the top level when `groupId` is null). */
export function regroupNavigation(
  items: NavigationItem[],
  id: string,
  groupId: string | null,
): NavigationItem[] {
  if (groupId === id) return items;
  const { items: rest, taken } = takeNavigation(items, id);
  if (!taken) return items;
  const moved: NavigationItem = taken;
  if (!groupId) return [...rest, moved];
  if (flattenNavigation(moved.children ?? []).some((child) => child.id === groupId)) return items;
  return mapNavigation(rest, groupId, (group) => ({
    ...group,
    children: [...(group.children ?? []), moved],
  }));
}
