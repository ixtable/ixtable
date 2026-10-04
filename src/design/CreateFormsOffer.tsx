import { useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { GenerateAppButton } from "./GenerateAppButton";
import "./design.css";
import { formTable, upgradeDesign } from "./schema";

/**
 * Offered in Data mode right after a table is created: generate its list and detail
 * forms and a navigation item with the same generator as "Generate app from tables".
 * Hidden once any form uses the table.
 */
export function CreateFormsOffer({ table, onDismiss }: { table: string; onDismiss: () => void }) {
  const { config } = useDocumentConfig();
  const [done, setDone] = useState(false);
  const covered = upgradeDesign(config.design).forms.some((form) => formTable(form) === table);
  if (done)
    return (
      <p className="create-forms-offer" role="status">
        Forms for {table} are ready in Design and Run mode.
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </p>
    );
  if (covered) return null;
  return (
    <div className="create-forms-offer" role="region" aria-label={`Forms for ${table}`}>
      <span>Table {table} created. Build its screens now?</span>
      <GenerateAppButton
        tables={[table]}
        label={`Create forms for ${table}`}
        onDone={() => setDone(true)}
      />
      <button type="button" onClick={onDismiss}>
        Not now
      </button>
    </div>
  );
}
