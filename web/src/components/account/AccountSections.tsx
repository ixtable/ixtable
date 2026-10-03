import React, { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { useAuth } from "@site/src/contexts/AuthContext";
import { formatDate, useCloudApi } from "@site/src/lib/cloud";
import { Badge, ErrorNotice, Notice, Section } from "../cloud/ui";
import { useAction, useAsync } from "../cloud/useAsync";

const PROVIDER_NAMES: Record<string, string> = {
  email: "Email and password",
  google: "Google",
  azure: "Microsoft",
};

export function ProfileSection({ user }: { user: User }): ReactNode {
  const api = useCloudApi();
  const nameId = useId();
  const profile = useAsync(() => api.q().myProfile(user.id), [api, user.id]);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(profile.data?.display_name ?? ""), [profile.data]);
  const save = useAction(async () => {
    await api.q().updateProfile(user.id, name.trim());
    setSaved(true);
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    save.run();
  };
  return (
    <Section title="Profile">
      <dl className="cloud-dl">
        <dt>Email</dt>
        <dd data-testid="account-email">{user.email}</dd>
        <dt>User id</dt>
        <dd className="cloud-code" data-testid="account-user-id">
          {user.id}
        </dd>
        <dt>Member since</dt>
        <dd>{formatDate(user.created_at)}</dd>
      </dl>
      <form className="cloud-inline-form" onSubmit={submit} aria-label="Display name">
        <div className="cloud-field">
          <label htmlFor={nameId}>Display name</label>
          <input
            id={nameId}
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <button type="submit" className="button button--secondary" disabled={save.pending}>
          Save name
        </button>
      </form>
      <ErrorNotice error={save.error} />
      {saved && <Notice tone="success">Display name saved.</Notice>}
    </Section>
  );
}

export function PasswordSection(): ReactNode {
  const { updatePassword } = useAuth();
  const passwordId = useId();
  const confirmId = useId();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setMessage({ tone: "danger", text: "The passwords do not match." });
      return;
    }
    setPending(true);
    const result = await updatePassword(password);
    setPending(false);
    setMessage(
      result.error
        ? { tone: "danger", text: result.error }
        : { tone: "success", text: "Password changed." },
    );
    if (!result.error) {
      setPassword("");
      setConfirm("");
    }
  };
  return (
    <Section title="Password" description="Desktop sessions stay signed in until they next renew.">
      <form className="cloud-inline-form" onSubmit={submit} aria-label="Change password">
        <div className="cloud-field">
          <label htmlFor={passwordId}>New password</label>
          <input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="cloud-field">
          <label htmlFor={confirmId}>Repeat new password</label>
          <input
            id={confirmId}
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        <button type="submit" className="button button--secondary" disabled={pending}>
          Change password
        </button>
      </form>
      {message && (
        <Notice tone={message.tone} testId="password-change-result">
          {message.text}
        </Notice>
      )}
    </Section>
  );
}

export function ProvidersSection({ user }: { user: User }): ReactNode {
  const identities = user.identities ?? [];
  return (
    <Section
      title="Sign-in methods"
      description="Methods linked to this account. Each one signs in to the same account."
    >
      <ul>
        {identities.length === 0 && <li>{PROVIDER_NAMES.email}</li>}
        {identities.map((identity) => (
          <li key={identity.identity_id ?? identity.id}>
            {PROVIDER_NAMES[identity.provider] ?? identity.provider} <Badge>linked</Badge>{" "}
            <span className="cloud-muted">since {formatDate(identity.created_at)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
