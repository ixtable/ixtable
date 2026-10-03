import { Construction } from "lucide-react";

/** Temporary body for a mode whose feature has not shipped yet. */
export function ModePlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <section className="feature-placeholder" aria-label={title}>
      <header className="titlebar">
        <div>
          <p>PROJECT / {title.toUpperCase()}</p>
          <h1>{title}</h1>
        </div>
      </header>
      <div className="empty-recent">
        <Construction />
        <b>{title} coming soon</b>
        <span>{description}</span>
      </div>
    </section>
  );
}

/** Temporary body for an application-settings tab. */
export function TabPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="settings-panel">
      <h2>{title}</h2>
      <div className="empty-recent">
        <Construction />
        <b>{title} coming soon</b>
        <span>{description}</span>
      </div>
    </div>
  );
}
