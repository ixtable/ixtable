import { call } from "../lib/api";
import type { SessionState } from "../lib/types";

/** A golden application template (golden/<id>/app.yaml), as listed by `list_templates`. */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  version: string;
}

export const listTemplates = () => call<TemplateInfo[]>("list_templates");

/** New untitled document with the template's definitions, assets, schema, and seed records. */
export const createFromTemplate = (templateId: string) =>
  call<SessionState>("create_from_template", { templateId });
