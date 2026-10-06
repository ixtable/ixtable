import { LayoutTemplate } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionState } from "../lib/types";
import { createFromTemplate, listTemplates, type TemplateInfo } from "../templates/api";

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
    // The list can arrive after the start screen unmounts (a document opened, or a test
    // environment torn down); updating state then would throw outside React.
    let active = true;
    listTemplates()
      .then((list) => active && setTemplates(list))
      .catch(() => active && setTemplates([]));
    return () => {
      active = false;
    };
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
