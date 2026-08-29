import { describe, expect, it } from "vitest";
import { AgentChatLog } from "../../src/logs/conversation";
import { LogStore } from "../../src/logs/store";
import { formatAgentMessage, screenDiff } from "../../src/logs/tui";

describe("screenDiff", () => {
  it("treats the full first screen as new agent text", () => {
    expect(screenDiff("", "Welcome\n> ")).toBe("Welcome\n> ");
  });

  it("keeps only text that appears below the snapshot", () => {
    const before = "Welcome\n>\n";
    const after =
      "Welcome\n> list tables\nI'll list the tables.\n───────────────\n>\n───────────────";
    expect(screenDiff(before, after)).toContain("I'll list the tables.");
    expect(screenDiff(before, after)).not.toContain("Welcome");
  });
});

describe("formatAgentMessage", () => {
  it("strips echoed user input and the trailing TUI input box", () => {
    const screen = [
      "list tables",
      "I'll inspect the schema.",
      "───────────────",
      "> ",
      "───────────────",
    ].join("\n");
    expect(formatAgentMessage(screen, "list tables")).toBe("I'll inspect the schema.");
  });
});

describe("AgentChatLog", () => {
  it("splits snapshots into an updating agent message after each user turn", () => {
    const chat = new AgentChatLog("claude", () => 1);
    chat.snapshot("Welcome to Claude\n───────────────\n>\n───────────────");
    expect(chat.list()).toEqual([{ id: 0, role: "agent", message: "Welcome to Claude", time: 1 }]);
    const before = "Welcome to Claude\n───────────────\n>\n───────────────";
    chat.sendUser("list tables", before);
    chat.snapshot(
      [
        "Welcome to Claude",
        "list tables",
        "Found 2 tables.",
        "───────────────",
        "> ",
        "───────────────",
      ].join("\n"),
    );
    chat.snapshot(
      [
        "Welcome to Claude",
        "list tables",
        "Found 2 tables.\nCustomers and Orders.",
        "───────────────",
        "> ",
        "───────────────",
      ].join("\n"),
    );
    const messages = chat.list();
    expect(messages.map((m) => m.role)).toEqual(["agent", "user", "agent"]);
    expect(messages[2].message).toBe("Found 2 tables.\nCustomers and Orders.");
  });
});

describe("LogStore", () => {
  it("records agent terminals and ignores shell terminals", () => {
    const store = new LogStore();
    store.openTerminal({ id: "sh-1", kind: "shell", title: "bash" });
    store.openTerminal({ id: "ag-1", kind: "agent", title: "Claude" });
    store.openTerminal({ id: "ag-2", kind: "agent", title: "Codex", agentType: "codex" });
    store.snapshot("sh-1", "ls\nfile.txt");
    store.snapshot("ag-1", "Hello\n───────────────\n>\n───────────────");
    expect(store.sources().map((s) => s.title)).toEqual(["Claude", "Codex"]);
    expect(store.messages("sh-1")).toEqual([]);
    expect(store.messages("ag-1")[0].message).toBe("Hello");
  });
});
