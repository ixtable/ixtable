import React, { useId, useState, type ReactNode } from "react";
import { formatDate, shortId, useCloudApi } from "@site/src/lib/cloud";
import { Empty, ErrorNotice, Loading, TableWrap } from "../ui";
import { useAsync } from "../useAsync";
import type { AppTabProps } from "./types";

const CATEGORIES: [string, string][] = [
  ["", "All events"],
  ["app.", "App"],
  ["role.", "Roles"],
  ["member.", "Members"],
  ["invitation.", "Invitations"],
  ["version.", "Versions"],
  ["bundle.", "Bundles"],
  ["auth.", "Authentication"],
  ["key.", "Key grants"],
  ["credential.", "Credentials"],
  ["archive.", "Archive uploads"],
  ["backup.", "Backups"],
  ["billing.", "Billing"],
];

function summarize(details: Record<string, unknown> | null): string {
  if (!details) return "";
  return Object.entries(details)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    )
    .join(", ");
}

/** Append-only cloud audit history (PRD §25), filtered server-side by category and date. */
export default function AuditTab({ app }: AppTabProps): ReactNode {
  const api = useCloudApi();
  const categoryId = useId();
  const sinceId = useId();
  const searchId = useId();
  const [category, setCategory] = useState("");
  const [since, setSince] = useState("");
  const [search, setSearch] = useState("");
  const state = useAsync(async () => {
    const events = await api.q().auditEvents({
      appId: app.id,
      action: category || undefined,
      since: since ? new Date(since).toISOString() : undefined,
    });
    const profiles = await api.q().profiles(events.map((event) => event.actor_id ?? ""));
    return { events, profiles };
  }, [api, app.id, category, since]);

  const needle = search.trim().toLowerCase();
  const rows = (state.data?.events ?? []).filter((event) => {
    if (!needle) return true;
    const actor = state.data?.profiles[event.actor_id ?? ""]?.email ?? "";
    return [event.action, event.target ?? "", actor, summarize(event.details)]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  return (
    <>
      <form
        className="cloud-inline-form"
        aria-label="Filter audit history"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="cloud-field">
          <label htmlFor={categoryId}>Category</label>
          <select
            id={categoryId}
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            {CATEGORIES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="cloud-field">
          <label htmlFor={sinceId}>Since</label>
          <input
            id={sinceId}
            type="date"
            value={since}
            onChange={(event) => setSince(event.target.value)}
          />
        </div>
        <div className="cloud-field">
          <label htmlFor={searchId}>Search</label>
          <input
            id={searchId}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </form>
      <ErrorNotice error={state.error} />
      {state.loading && !state.data ? (
        <Loading label="Loading audit history" />
      ) : rows.length === 0 ? (
        <Empty>No audit events match.</Empty>
      ) : (
        <TableWrap label="Audit history">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Target</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr key={event.id}>
                <td>{formatDate(event.at)}</td>
                <td>
                  {state.data?.profiles[event.actor_id ?? ""]?.email ||
                    (event.actor_id ? shortId(event.actor_id) : "System")}
                </td>
                <td className="cloud-code">{event.action}</td>
                <td className="cloud-code">{event.target ?? ""}</td>
                <td className="cloud-code">{summarize(event.details)}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <p className="cloud-muted">
        Showing the newest 200 events. Audit events cannot be edited or deleted.
      </p>
    </>
  );
}
