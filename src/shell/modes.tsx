import {
  Code2,
  Database,
  FileText,
  LayoutDashboard,
  type LucideIcon,
  Play,
  Settings,
  Shapes,
  Zap,
} from "lucide-react";
import type { ComponentType } from "react";
import { AutomationMode } from "../automation";
import { DashboardsMode } from "../dashboards";
import { DataMode, DataSidebar } from "../data";
import { DesignMode, DesignSidebar } from "../design";
import { QueryMode } from "../query";
import { ReportsMode } from "../reports";
import { RunMode } from "../runtime";
import { AppSettings } from "./AppSettings";

export type ModeId =
  | "data"
  | "query"
  | "design"
  | "reports"
  | "dashboards"
  | "automation"
  | "app"
  | "run";

export interface ModeDefinition {
  id: ModeId;
  label: string;
  icon: LucideIcon;
  /** Main workspace body; reads shell state with `useShell()` and definitions with `useDocumentConfig()`. */
  Component: ComponentType;
  /** Optional sidebar content shown under the mode switch. */
  Sidebar?: ComponentType;
  /** Extra class on the `<main>` workspace element. */
  workspaceClassName?: string;
}

/** Studio modes in display order. `activeMode` in DocumentConfig stores the `id`. */
export const modes: readonly ModeDefinition[] = [
  {
    id: "data",
    label: "Data",
    icon: Database,
    Component: DataMode,
    Sidebar: DataSidebar,
    workspaceClassName: "data-workspace",
  },
  { id: "query", label: "Query", icon: Code2, Component: QueryMode },
  { id: "design", label: "Design", icon: Shapes, Component: DesignMode, Sidebar: DesignSidebar },
  { id: "reports", label: "Reports", icon: FileText, Component: ReportsMode },
  { id: "dashboards", label: "Dashboards", icon: LayoutDashboard, Component: DashboardsMode },
  { id: "automation", label: "Automation", icon: Zap, Component: AutomationMode },
  { id: "app", label: "Settings", icon: Settings, Component: AppSettings },
  { id: "run", label: "Runtime", icon: Play, Component: RunMode },
];

export const findMode = (id: string): ModeDefinition =>
  modes.find((mode) => mode.id === id) ?? modes[0];
