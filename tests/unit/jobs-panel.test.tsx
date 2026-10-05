import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config-store", () => ({
  useDocumentConfig: () => ({ config: { triggers: [], actions: [] } }),
}));

const pending: Array<{ status: string | null; resolve: (jobs: unknown[]) => void }> = [];
vi.mock("../../src/automation/api", () => ({
  JOBS_CHANGED_EVENT: "ixtable:jobs-changed",
  notifyJobsChanged: () => undefined,
  cancelJob: vi.fn(),
  retryJob: vi.fn(),
  jobAttempts: vi.fn(async () => []),
  listJobs: ({ status }: { status: string | null }) =>
    new Promise((resolve) => pending.push({ status, resolve })),
}));

const { JobsPanel } = await import("../../src/automation/JobsPanel");

const job = (id: string, status: string) => ({
  id,
  triggerId: "t1",
  actionId: "a1",
  status,
  attempts: 1,
  maxAttempts: 3,
  nextRunAt: null,
  lastError: null,
  createdAt: "2026-10-05T00:00:00Z",
  updatedAt: "2026-10-05T00:00:00Z",
});

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});

it("shows the list for the current filter when an older request answers last", async () => {
  render(<JobsPanel refreshMs={60_000} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  await user.selectOptions(screen.getByLabelText("Status"), "cancelled");
  await waitFor(() => expect(pending.map((p) => p.status)).toEqual([null, "cancelled"]));

  await act(async () => pending[1].resolve([job("j-cancelled", "cancelled")]));
  await act(async () => pending[0].resolve([job("j-queued", "queued")]));

  const table = await screen.findByRole("table", { name: "Jobs" });
  expect(table).toHaveTextContent("cancelled");
  expect(table).not.toHaveTextContent("queued");
});
