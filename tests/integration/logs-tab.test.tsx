import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { logStore } from "../../src/logs/store";
import { renderNewDocument } from "./helpers";

it("browses agent chat logs from the Logs tab and omits shell terminals", async () => {
  const user = await renderNewDocument();
  logStore.openTerminal({ id: "shell-1", kind: "shell", title: "bash" });
  logStore.openTerminal({ id: "agent-1", kind: "agent", title: "Claude" });
  logStore.openTerminal({ id: "agent-2", kind: "agent", title: "Codex", agentType: "codex" });
  logStore.snapshot("agent-1", "Ready to help\n───────────────\n>\n───────────────");
  logStore.sendUser("agent-1", "list tables", "Ready to help\n───────────────\n>\n───────────────");
  logStore.snapshot(
    "agent-1",
    "Ready to help\nlist tables\nCustomers and Orders.\n───────────────\n>\n───────────────",
  );
  logStore.snapshot("agent-2", "Codex is starting\n");
  await user.click(screen.getByRole("button", { name: "Logs" }));
  const logs = await screen.findByRole("region", { name: "Logs" });
  expect(logs).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Agent chats" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "bash" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Claude" })).toHaveAttribute("aria-pressed", "true");
  const agentMessages = screen.getAllByRole("article", { name: "agent message" });
  expect(agentMessages[0]).toHaveTextContent("Ready to help");
  expect(agentMessages[1]).toHaveTextContent("Customers and Orders.");
  expect(screen.getByRole("article", { name: "user message" })).toHaveTextContent("list tables");
  await user.click(screen.getByRole("button", { name: "Codex" }));
  expect(screen.getByRole("article", { name: "agent message" })).toHaveTextContent(
    "Codex is starting",
  );
  expect(screen.queryByText("list tables")).not.toBeInTheDocument();
});
