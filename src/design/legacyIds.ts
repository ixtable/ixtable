import type { DocumentConfig } from "../lib/types";
import { newId } from "../lib/utils";

/** Id the old default design gave its form and its navigation item (not a UUID). */
export const LEGACY_DEFAULT_ID = "main";

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const list = (value: unknown): Json[] =>
  Array.isArray(value) ? value.map(obj).filter((item): item is Json => item !== null) : [];
const isLegacy = (value: unknown) => value === LEGACY_DEFAULT_ID;

const anyNav = (items: unknown, test: (item: Json) => boolean): boolean =>
  list(items).some((item) => test(item) || anyNav(item.children, test));

/** True when the config still has the legacy `main` form or navigation id. */
export function hasLegacyIds(config: Pick<DocumentConfig, "design">): boolean {
  const design = obj(config.design);
  return (
    list(design?.forms).some((form) => isLegacy(form.id)) ||
    anyNav(design?.navigation, (item) => isLegacy(item.id))
  );
}

/**
 * Rewrites the legacy `main` form and navigation ids to UUIDv7 ids with every reference:
 * navigation targets, `startPage`, `detailFormId`, related-list forms, `openForm` and
 * `navigate` action steps, dashboard form components, and role permissions. Mirrors
 * `rekey_legacy_ids` in src-tauri/src/design/upgrade.rs (Studio runs it on open).
 * Returns the config unchanged (same object) when there is nothing to rewrite.
 */
export function upgradeLegacyIds<T extends Pick<DocumentConfig, "design">>(
  config: T,
  makeId: () => string = newId,
): T {
  if (!hasLegacyIds(config)) return config;
  const design = obj(config.design);
  const form = list(design?.forms).some((f) => isLegacy(f.id)) ? makeId() : null;
  const nav = anyNav(design?.navigation, (item) => isLegacy(item.id)) ? makeId() : null;
  const next = structuredClone(config) as T & Json;
  const swap = (holder: Json | null, key: string, to: string | null) => {
    if (holder && to && isLegacy(holder[key])) holder[key] = to;
  };
  const nextDesign = obj(next.design);
  for (const f of list(nextDesign?.forms)) {
    swap(f, "id", form);
    swap(f, "detailFormId", form);
    for (const control of list(f.controls)) swap(obj(control.related), "formId", form);
  }
  const rekeyNav = (items: unknown) => {
    for (const item of list(items)) {
      swap(item, "id", nav);
      // Navigation kind defaults to form.
      if ((item.kind ?? "form") === "form") swap(item, "targetId", form);
      rekeyNav(item.children);
    }
  };
  rekeyNav(nextDesign?.navigation);
  swap(nextDesign, "startPage", nav);
  const rekeySteps = (steps: unknown) => {
    for (const step of list(steps)) {
      if (step.kind === "openForm") swap(step, "formId", form);
      const target = obj(step.target);
      if (step.kind === "navigate" && target?.kind === "form") swap(target, "id", form);
      rekeySteps(step.then);
      rekeySteps(step.else);
    }
  };
  for (const action of list(next.actions)) rekeySteps(action.steps);
  for (const dashboard of list(next.dashboards))
    for (const component of list(dashboard.components)) swap(component, "formId", form);
  for (const role of list(next.roles)) {
    const permissions = obj(role.permissions);
    if (!permissions) continue;
    if (Array.isArray(permissions.navigation) && nav)
      permissions.navigation = permissions.navigation.map((id) => (isLegacy(id) ? nav : id));
    for (const object of list(permissions.objects))
      if (object.kind === "form") swap(object, "id", form);
  }
  return next;
}
