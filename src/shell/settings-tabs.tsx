import type { ComponentType } from "react";
import { CloudTab } from "../cloud";
import { FileSourcesTab } from "../import";
import { AssetsTab, LogsTab } from "../persistence";
import { ReleaseTab } from "../release";
import { RolesTab } from "../runtime";
import { MigrationsTab } from "../migrations";
import { DatasourceTab, EntitiesTab } from "../schema";
import { ProblemsTab } from "./ProblemsTab";
import { YamlTab } from "./YamlTab";

export type SettingsTabId =
  | "assets"
  | "release"
  | "cloud"
  | "datasource"
  | "entities"
  | "files"
  | "migrations"
  | "roles"
  | "yaml"
  | "problems"
  | "logs";

export interface SettingsTabDefinition {
  id: SettingsTabId;
  label: string;
  Component: ComponentType;
}

/** Tabs of the `app` mode, in display order. Each Component lives in its owning feature dir. */
export const settingsTabs: readonly SettingsTabDefinition[] = [
  { id: "assets", label: "Assets", Component: AssetsTab },
  { id: "release", label: "Release", Component: ReleaseTab },
  { id: "cloud", label: "Cloud", Component: CloudTab },
  { id: "datasource", label: "Datasource", Component: DatasourceTab },
  { id: "entities", label: "Entities", Component: EntitiesTab },
  { id: "files", label: "File sources", Component: FileSourcesTab },
  { id: "migrations", label: "Migrations", Component: MigrationsTab },
  { id: "roles", label: "Roles", Component: RolesTab },
  { id: "yaml", label: "YAML", Component: YamlTab },
  { id: "problems", label: "Problems", Component: ProblemsTab },
  { id: "logs", label: "Logs", Component: LogsTab },
];
