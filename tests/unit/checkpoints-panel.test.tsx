import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { CheckpointInfo } from "../../src/persistence/types";

const checkpoint: CheckpointInfo = {
  id: "c1",
  documentId: "d1",
  reason: "manual",
  createdAt: "2026-10-03T12:00:00Z",
  path: "/tmp/c1.ixt",
  size: 2048,
};

let releaseInitial: (list: CheckpointInfo[]) => void = () => undefined;
const listCheckpoints = vi
  .fn<() => Promise<CheckpointInfo[]>>()
  .mockImplementationOnce(() => new Promise((resolve) => (releaseInitial = resolve)))
  .mockResolvedValue([checkpoint]);

vi.mock("../../src/shell/context", () => ({ useShell: () => ({ doc: { name: "CRM" } }) }));
vi.mock("../../src/persistence/api", () => ({
  listCheckpoints: () => listCheckpoints(),
  createCheckpoint: vi.fn().mockResolvedValue(undefined),
  restoreCheckpointAsCopy: vi.fn(),
}));

const { CheckpointsPanel } = await import("../../src/persistence/CheckpointsPanel");

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});

it("lists a new checkpoint before announcing it, and a late mount-time listing cannot hide it", async () => {
  render(<CheckpointsPanel />);
  await user.click(screen.getByRole("button", { name: "Create checkpoint" }));
  expect(await screen.findByText("Checkpoint created.")).toBeInTheDocument();
  const list = screen.getByRole("list", { name: "Checkpoints" });
  expect(within(list).getByText(/manual/)).toBeInTheDocument();

  releaseInitial([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByRole("list", { name: "Checkpoints" })).toHaveTextContent("manual");
  expect(screen.queryByText("No checkpoints yet.")).not.toBeInTheDocument();
});
