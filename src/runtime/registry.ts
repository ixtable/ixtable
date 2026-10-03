import type { DesignForm } from "../design/schema";
import { generateCrudForms } from "../design/generate";
import type { DocumentConfig, TableSchema } from "../lib/types";

/** Forms generated in memory (table pages, related lists without a form). Never persisted. */
const ephemeral = new Map<string, DesignForm>();
const byTable = new Map<string, { list: DesignForm; detail: DesignForm; signature: string }>();

/** Looks a form up in the design, then among generated in-memory forms. */
export const resolveForm = (config: DocumentConfig, formId: string): DesignForm | null =>
  config.design?.forms.find((form) => form.id === formId) ?? ephemeral.get(formId) ?? null;

/** True for forms defined in the document (permission subject is the form, not its table). */
export const isDesignedForm = (config: DocumentConfig, form: DesignForm) =>
  config.design?.forms.some((item) => item.id === form.id) ?? false;

/**
 * Generated list + detail forms for a table, built with the same generator as
 * "Generate form from table" and cached per table schema.
 */
export function tableForms(schema: TableSchema, children: TableSchema[] = []) {
  const signature = JSON.stringify([schema, children.map((c) => c.name)]);
  const hit = byTable.get(schema.name);
  if (hit && hit.signature === signature) return hit;
  const { list, detail } = generateCrudForms(schema, { children });
  ephemeral.set(list.id, list);
  ephemeral.set(detail.id, detail);
  const entry = { list, detail, signature };
  byTable.set(schema.name, entry);
  return entry;
}
