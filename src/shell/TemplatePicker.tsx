import { LayoutTemplate } from "lucide-react";
import { useEffect, useState } from "react";
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
/** The template's definitions as DocumentConfig YAML (what Settings › YAML shows). */
export const readTemplateConfig = (templateId: string) =>
  call<string>("read_template_config", { templateId });

/**
 * Start-screen section listing the golden applications (PRD §26). Choosing one
 * creates a new untitled document from it; the document opens in Runtime.
 */
export function TemplatePicker({
  disabled,
  run,
}: {
  disabled: boolean;
  // The start screen's action runner: shows progress and opens the returned session.
  run: (label: string, action: () => Promise<SessionState | null>) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  if (!templates.length) return null;
  return (
    <section className="start-section template-section" aria-labelledby="start-from-template">
      <div>
        <h2 id="start-from-template">Start from a template</h2>
      </div>
      <ul className="recent-list template-list">
        {templates.map((template) => (
          <li key={template.id}>
            <button
              disabled={disabled}
              aria-label={`Create ${template.name} from template`}
              onClick={() =>
                run(`Creating ${template.name}…`, () => createFromTemplate(template.id))
              }
            >
              <LayoutTemplate />
              <span>
                <b>{template.name}</b>
                <small>{template.description}</small>
              </span>
              <small className="template-version">v{template.version}</small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
