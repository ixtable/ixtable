import { useDocumentConfig } from "../lib/config-store";
import { useShell } from "../shell/context";
import { ObjectBrowser } from "../shell/ObjectBrowser";
import { DatabaseWorkbench } from "./DatabaseWorkbench";

/** Data mode: tables, schema designer, relationships, and the record grid. */
export function DataMode() {
  return <DatabaseWorkbench />;
}

export function DataSidebar() {
  const shell = useShell();
  const { config } = useDocumentConfig();
  return (
    <ObjectBrowser
      objects={shell.objects}
      queries={config.savedQueries}
      loading={shell.metadataLoading}
      error={shell.metadataError}
      active={shell.selection}
      onSelect={shell.select}
    />
  );
}
