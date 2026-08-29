import { AgentChatLog, type ChatMessage } from "./conversation";
import type { AgentType } from "./tui";

export type TerminalKind = "agent" | "shell";

export type LogSource = {
  id: string;
  group: "agent-chats";
  title: string;
  terminalId: string;
};

export type OpenTerminalInput = {
  id: string;
  kind: TerminalKind;
  title: string;
  agentType?: AgentType;
};

type AgentEntry = { title: string; chat: AgentChatLog };

export class LogStore {
  private agents = new Map<string, AgentEntry>();
  private listeners = new Set<() => void>();
  private sourceSnapshot: LogSource[] = [];

  openTerminal(input: OpenTerminalInput) {
    if (input.kind !== "agent") return;
    if (this.agents.has(input.id)) return;
    this.agents.set(input.id, {
      title: input.title,
      chat: new AgentChatLog(input.agentType ?? "claude"),
    });
    this.emit();
  }

  snapshot(terminalId: string, screen: string) {
    const entry = this.agents.get(terminalId);
    if (!entry) return;
    entry.chat.snapshot(screen);
    this.emit();
  }

  sendUser(terminalId: string, text: string, screenBefore: string) {
    const entry = this.agents.get(terminalId);
    if (!entry) return;
    entry.chat.sendUser(text, screenBefore);
    this.emit();
  }

  sources(): LogSource[] {
    return this.sourceSnapshot;
  }

  messages(terminalId: string): ChatMessage[] {
    return this.agents.get(terminalId)?.chat.list() ?? [];
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reset() {
    this.agents.clear();
    this.sourceSnapshot = [];
    this.emit();
  }

  private emit() {
    this.sourceSnapshot = [...this.agents.entries()].map(([id, entry]) => ({
      id,
      group: "agent-chats" as const,
      title: entry.title,
      terminalId: id,
    }));
    this.listeners.forEach((listener) => listener());
  }
}

export const logStore = new LogStore();
