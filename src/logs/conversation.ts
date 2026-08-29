import { type AgentType, formatAgentMessage, screenDiff } from "./tui";

export type ChatRole = "user" | "agent";

export type ChatMessage = {
  id: number;
  role: ChatRole;
  message: string;
  time: number;
};

export class AgentChatLog {
  private messages: ChatMessage[] = [];
  private screenBeforeLastUserMessage = "";
  private writingMessage = false;

  constructor(
    readonly agentType: AgentType = "claude",
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(screen: string) {
    if (this.writingMessage) return;
    this.updateLastAgentMessage(screen, this.now());
  }

  sendUser(text: string, screenBefore: string) {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("User message must be non-empty");
    this.updateLastAgentMessage(screenBefore, this.now());
    this.writingMessage = true;
    this.screenBeforeLastUserMessage = screenBefore;
    this.messages.push({
      id: this.messages.length,
      role: "user",
      message: trimmed,
      time: this.now(),
    });
    this.writingMessage = false;
  }

  list(): ChatMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  private last(role: ChatRole): ChatMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === role) return this.messages[i];
    }
    return undefined;
  }

  private updateLastAgentMessage(screen: string, time: number) {
    let agentMessage = screenDiff(this.screenBeforeLastUserMessage, screen, this.agentType);
    agentMessage = formatAgentMessage(
      agentMessage,
      this.last("user")?.message ?? "",
      this.agentType,
    );
    const shouldCreate =
      this.messages.length === 0 || this.messages[this.messages.length - 1].role === "user";
    const lastAgent = this.last("agent");
    if (lastAgent?.message === agentMessage) return;
    const next: ChatMessage = {
      id: this.messages.length,
      role: "agent",
      message: agentMessage,
      time,
    };
    if (shouldCreate) this.messages.push(next);
    else this.messages[this.messages.length - 1] = next;
    this.messages[this.messages.length - 1].id = this.messages.length - 1;
  }
}
