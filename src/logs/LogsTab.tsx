import { MessageSquare, ScrollText } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { type LogSource, logStore } from "./store";

function useLogSources() {
  return useSyncExternalStore(
    (onStoreChange) => logStore.subscribe(onStoreChange),
    () => logStore.sources(),
  );
}

export function LogsTab() {
  const sources = useLogSources();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sources.find((s) => s.id === selectedId) ?? sources[0] ?? null;
  const messages = selected ? logStore.messages(selected.id) : [];
  return (
    <section className="logs-tab" aria-label="Logs">
      <aside className="logs-sources" aria-label="Log sources">
        <SourceGroup
          label="Agent chats"
          sources={sources}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
        />
      </aside>
      <div
        className="logs-transcript"
        aria-label={selected ? `${selected.title} chat` : "Chat log"}
      >
        {!selected && (
          <div className="empty-recent logs-empty">
            <p>No agent chat logs yet.</p>
            <small>Each agent terminal appears here. Shell terminals are not recorded.</small>
          </div>
        )}
        {selected && !messages.length && (
          <div className="empty-recent logs-empty">
            <p>Waiting for the first agent output.</p>
          </div>
        )}
        {selected &&
          messages.map((message) => (
            <article
              key={message.id}
              className={`log-message log-${message.role}`}
              aria-label={`${message.role} message`}
            >
              <header>
                <span>{message.role === "user" ? "You" : "Agent"}</span>
              </header>
              <pre>{message.message}</pre>
            </article>
          ))}
      </div>
    </section>
  );
}

function SourceGroup({
  label,
  sources,
  selectedId,
  onSelect,
}: {
  label: string;
  sources: LogSource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="object-group" aria-labelledby="log-group-agent-chats">
      <div className="object-group-heading">
        <ScrollText />
        <h3 id="log-group-agent-chats">{label}</h3>
        <em>{sources.length}</em>
      </div>
      <ul>
        {sources.map((source) => (
          <li key={source.id}>
            <button
              className={selectedId === source.id ? "selected" : ""}
              aria-pressed={selectedId === source.id}
              onClick={() => onSelect(source.id)}
            >
              <MessageSquare />
              <span>{source.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {!sources.length && (
        <small className="object-empty">
          Agent terminals show up here. Shell sessions are omitted.
        </small>
      )}
    </section>
  );
}
