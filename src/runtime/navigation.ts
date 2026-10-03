import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { humanize } from "../design/generate";
import type { FormMode, NavigationItem } from "../design/schema";
import type { DocumentConfig } from "../lib/types";
import { assignedRuntimeRole, can, findRole } from "./rbac";

export type PageKind = "form" | "report" | "dashboard" | "table";
export type RuntimePage = {
  kind: PageKind;
  id: string;
  mode?: FormMode | string;
  recordId?: unknown;
  params?: Record<string, unknown>;
  /** Navigation item that opened the page, for highlighting. */
  navId?: string;
};
export type Notice = { message: string; tone: "info" | "error" };

export interface RuntimeNavigation {
  page: RuntimePage | null;
  navigate: (page: RuntimePage) => void;
  back: () => void;
  canGoBack: boolean;
  /** The page `back` returns to (for its label); null when there is none. */
  previous?: RuntimePage | null;
  /** Role being previewed; null is the developer (full access). */
  roleId: string | null;
  setRoleId: (roleId: string | null) => void;
  /** `app` expression scope: app state plus `user` and `role`. */
  app: Record<string, unknown>;
  setAppState: (key: string, value: unknown) => void;
  notice: Notice | null;
  notify: (message: string, tone?: Notice["tone"]) => void;
  /** False when a FormRenderer is used outside Run mode (for example in a dashboard). */
  attached: boolean;
  /** Bumped on every navigation, so choosing the open page again starts it fresh. */
  visit?: number;
}

export const RuntimeContext = createContext<RuntimeNavigation | null>(null);

const detached: RuntimeNavigation = {
  page: null,
  navigate: () => undefined,
  back: () => undefined,
  canGoBack: false,
  previous: null,
  roleId: null,
  setRoleId: () => undefined,
  app: { user: { name: "Developer" }, role: null },
  setAppState: () => undefined,
  notice: null,
  notify: () => undefined,
  attached: false,
  visit: 0,
};

/** Runtime navigation, role, and app state. Outside Run mode returns a detached developer context. */
export function useRuntimeNavigation(): RuntimeNavigation {
  return useContext(RuntimeContext) ?? detached;
}

/** Page opened by a navigation item. */
export const pageFor = (item: NavigationItem): RuntimePage | null =>
  item.kind === "group" || !item.targetId
    ? null
    : {
        kind: item.kind,
        id: item.targetId,
        mode: item.mode ?? undefined,
        navId: item.id,
      };

/** True when the role may open what the navigation item points at. */
export function canOpen(config: DocumentConfig, roleId: string | null, page: RuntimePage) {
  return can(config, roleId, page.kind, page.id, "read");
}

/** Navigation filtered by RBAC: items need `view` on the item and `read` on the target; empty groups drop out. */
export function visibleNavigation(
  items: NavigationItem[],
  config: DocumentConfig,
  roleId: string | null,
): NavigationItem[] {
  return items.flatMap((item) => {
    if (!can(config, roleId, "navigation", item.id, "view")) return [];
    if (item.kind === "group") {
      const children = visibleNavigation(item.children ?? [], config, roleId);
      return children.length ? [{ ...item, children }] : [];
    }
    const page = pageFor(item);
    return page && canOpen(config, roleId, page) ? [item] : [];
  });
}

/** State behind `RuntimeContext` for Run mode. */
export function useRuntimeState(config: DocumentConfig): RuntimeNavigation {
  const [history, setHistory] = useState<RuntimePage[]>([]);
  // A cloud runtime user has exactly the role ixtable Cloud assigned.
  const assigned = assignedRuntimeRole();
  const [previewRole, setRole] = useState<string | null>(null);
  const roleId = assigned ? assigned.id : previewRole;
  const [state, setState] = useState<Record<string, unknown>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [visit, setVisit] = useState(0);
  // Choosing a navigation item starts a new trail; pages opened from content (actions) stack on it.
  const navigate = useCallback((page: RuntimePage) => {
    setNotice(null);
    setVisit((n) => n + 1);
    setHistory((items) => (page.navId ? [page] : [...items.slice(-49), page]));
  }, []);
  const back = useCallback(() => {
    setVisit((n) => n + 1);
    setHistory((items) => items.slice(0, -1));
  }, []);
  const setRoleId = useCallback((next: string | null) => {
    if (assignedRuntimeRole()) return;
    setRole(next);
    setNotice(null);
    setVisit((n) => n + 1);
    setHistory([]);
  }, []);
  const setAppState = useCallback(
    (key: string, value: unknown) => setState((items) => ({ ...items, [key]: value })),
    [],
  );
  const notify = useCallback(
    (message: string, tone: Notice["tone"] = "info") => setNotice({ message, tone }),
    [],
  );
  const roleName = findRole(config, roleId)?.name ?? null;
  // A trail rooted at a navigation item goes back no further than that item.
  const canGoBack = history.length > 1 || (history.length === 1 && !history[0].navId);
  const previous = !canGoBack
    ? null
    : history.length > 1
      ? history[history.length - 2]
      : startPage(config, roleId);
  const app = useMemo(
    () => ({
      ...state,
      user: assigned?.user ?? { name: roleName ? `${roleName} preview` : "Developer" },
      role: roleName,
    }),
    [state, roleName, assigned],
  );
  return {
    page: history.at(-1) ?? null,
    navigate,
    back,
    canGoBack,
    previous,
    roleId,
    setRoleId,
    app,
    setAppState,
    notice,
    notify,
    attached: true,
    visit,
  };
}

/** The start page for a role: the design's start page when visible, else the first visible item. */
export function startPage(config: DocumentConfig, roleId: string | null): RuntimePage | null {
  const visible = flattenVisible(
    visibleNavigation(config.design?.navigation ?? [], config, roleId),
  );
  const preferred = visible.find((item) => item.id === config.design?.startPage);
  const item = preferred ?? visible.find((entry) => entry.kind !== "group");
  return item ? pageFor(item) : null;
}

const flattenVisible = (items: NavigationItem[]): NavigationItem[] =>
  items.flatMap((item) => [item, ...flattenVisible(item.children ?? [])]);

/** A page's title for back links: its navigation label, else the target's name. */
export function pageTitle(config: DocumentConfig, page: RuntimePage): string {
  const item = page.navId
    ? flattenVisible(config.design?.navigation ?? []).find((entry) => entry.id === page.navId)
    : undefined;
  if (item?.label) return item.label;
  const named = (items: { id: string; name: string }[] | undefined) =>
    items?.find((entry) => entry.id === page.id)?.name;
  const name =
    page.kind === "form"
      ? named(config.design?.forms)
      : page.kind === "report"
        ? named(config.reports)
        : page.kind === "dashboard"
          ? named(config.dashboards)
          : humanize(page.id);
  return name || "previous page";
}
