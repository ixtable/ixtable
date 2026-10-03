import { type ComponentType, createElement, useEffect, useState } from "react";
import * as dashboardsModule from "../dashboards";
import type { NavigationItem } from "../design/schema";
import { useDocumentConfig } from "../lib/config-store";
import type { TableSchema } from "../lib/types";
import { ReportPreview } from "../reports";
import { tableSchema } from "./data";
import { FormRenderer } from "./FormRenderer";
import {
  canOpen,
  pageFor,
  RuntimeContext,
  type RuntimePage,
  startPage,
  useRuntimeNavigation,
  useRuntimeState,
  visibleNavigation,
} from "./navigation";
import { assignedRuntimeRole } from "./rbac";
import { tableForms } from "./registry";
import "./runtime.css";

type Embeddable = ComponentType<Record<string, unknown>>;
const exported = (module: unknown, name: string) =>
  (module as Record<string, unknown>)[name] as Embeddable | undefined;

/** Renders a component another feature exports (reports, dashboards) when it exists. */
function Embedded({
  module,
  name,
  missing,
  ...props
}: { module: unknown; name: string; missing: string } & Record<string, unknown>) {
  const component = exported(module, name);
  return component ? createElement(component, props) : <p className="rt-muted">{missing}</p>;
}

/** Run mode: the application as its users see it, with navigation, start page, and role preview. */
export function RunMode() {
  const { config } = useDocumentConfig();
  const runtime = useRuntimeState(config);
  const page = runtime.page ?? startPage(config, runtime.roleId);
  const navigation = visibleNavigation(config.design?.navigation ?? [], config, runtime.roleId);
  const roles = config.roles ?? [];
  return (
    <RuntimeContext.Provider value={runtime}>
      <header className="titlebar">
        <div>
          <p>PROJECT / RUNTIME · {config.name}</p>
          <h1>Runtime</h1>
        </div>
        <div className="header-actions">
          {assignedRuntimeRole() ? (
            <span className="rt-role">Role: {assignedRuntimeRole()?.name}</span>
          ) : (
            <label className="rt-role">
              Preview as role
              <select
                value={runtime.roleId ?? ""}
                onChange={(e) => runtime.setRoleId(e.target.value || null)}
              >
                <option value="">Developer (full access)</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>
      <div className="rt-app">
        <nav className="rt-nav" aria-label="Application navigation">
          {navigation.length ? (
            <NavList items={navigation} active={page?.navId} />
          ) : (
            <p className="rt-muted">Nothing to show for this role.</p>
          )}
        </nav>
        <section className="rt-page" aria-label="Application page">
          {runtime.notice && (
            <p
              className={runtime.notice.tone === "error" ? "rt-error" : "rt-status"}
              role={runtime.notice.tone === "error" ? "alert" : "status"}
            >
              {runtime.notice.message}
            </p>
          )}
          {runtime.canGoBack && (
            <button type="button" className="rt-back" onClick={runtime.back}>
              ← Previous page
            </button>
          )}
          {page ? (
            <PageView
              key={`${runtime.roleId ?? ""}:${runtime.visit}:${JSON.stringify(page)}`}
              page={page}
            />
          ) : (
            <p className="rt-muted">This application has no pages yet.</p>
          )}
        </section>
      </div>
    </RuntimeContext.Provider>
  );
}

function NavList({ items, active }: { items: NavigationItem[]; active?: string }) {
  const { navigate } = useRuntimeNavigation();
  return (
    <ul>
      {items.map((item) => {
        const page = pageFor(item);
        return (
          <li key={item.id}>
            {item.kind === "group" ? (
              <details open>
                <summary>{item.label}</summary>
                <NavList items={item.children ?? []} active={active} />
              </details>
            ) : (
              <button
                type="button"
                aria-current={active === item.id ? "page" : undefined}
                onClick={() => page && navigate(page)}
              >
                {item.label}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One runtime page; RBAC is re-checked here so direct navigation (actions) is enforced too. */
export function PageView({ page }: { page: RuntimePage }) {
  const { config } = useDocumentConfig();
  const { roleId } = useRuntimeNavigation();
  if (!canOpen(config, roleId, page))
    return (
      <p className="rt-error" role="alert">
        You do not have access to this page.
      </p>
    );
  switch (page.kind) {
    case "form":
      return (
        <FormRenderer
          formId={page.id}
          mode={page.mode as "list" | undefined}
          recordId={page.recordId}
        />
      );
    case "table":
      return <TablePage table={page.id} />;
    case "report":
      return <ReportPreview reportId={page.id} params={page.params} />;
    case "dashboard":
      return (
        <Embedded
          module={dashboardsModule}
          name="DashboardView"
          missing="Dashboards are not available in this build."
          dashboardId={page.id}
        />
      );
    default:
      return null;
  }
}

/** A table navigation item: the generated CRUD forms for the table, built in memory. */
function TablePage({ table }: { table: string }) {
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    tableSchema(table)
      .then(setSchema)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [table]);
  if (error)
    return (
      <p className="rt-error" role="alert">
        {error}
      </p>
    );
  if (!schema) return <p className="rt-muted">Loading…</p>;
  return <FormRenderer formId={tableForms(schema).list.id} mode="list" />;
}
