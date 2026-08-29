import { invoke } from "@tauri-apps/api/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import App from "../../../src/App";
import { logStore } from "../../../src/logs/store";
import { captureDocument } from "../capture";

it("captures the Logs tab with agent chat sources", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: /New document/ }));
  await screen.findByText("Relationship Browser", {}, { timeout: 10_000 });
  logStore.reset();
  logStore.openTerminal({ id: "shell-1", kind: "shell", title: "bash" });
  logStore.openTerminal({ id: "agent-1", kind: "agent", title: "Claude" });
  logStore.snapshot("agent-1", "Welcome\n───────────────\n>\n───────────────");
  logStore.sendUser("agent-1", "show schema", "Welcome\n───────────────\n>\n───────────────");
  logStore.snapshot(
    "agent-1",
    "Welcome\nshow schema\nCustomers has an integer id.\n───────────────\n>\n───────────────",
  );
  await user.click(screen.getByRole("button", { name: "Logs" }));
  expect(await screen.findByRole("heading", { name: "Agent chats" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "bash" })).not.toBeInTheDocument();
  expect(screen.getByRole("article", { name: "agent message" })).toHaveTextContent(
    "Customers has an integer id.",
  );
  await captureDocument(document, {
    name: "app-qa-10-logs",
    expectations: [
      "The Logs tab lists Agent chats as a source group.",
      "The selected agent terminal shows a cleaned user and agent transcript.",
      "Shell terminals are absent from the source list.",
    ],
  });
  await invoke("close_document", { windowLabel: "main", force: true });
  logStore.reset();
});
