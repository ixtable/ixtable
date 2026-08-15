const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

export function supabaseAvailable(): boolean {
  return process.env.E2E_SUPABASE_AVAILABLE === 'true';
}

export function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

interface MailpitMessageSummary {
  ID: string;
  To: {Address: string}[];
}

interface MailpitMessagesResponse {
  messages: MailpitMessageSummary[];
}

interface MailpitMessageDetail {
  Text: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Mailpit request to ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Polls Mailpit (the local Supabase dev stack's email capture service) for the
 * most recent message sent to `email` and extracts the first link from its
 * plain-text body, which is the Supabase password recovery link.
 */
export async function waitForRecoveryLink(email: string, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const {messages} = await fetchJson<MailpitMessagesResponse>(`${MAILPIT_URL}/api/v1/messages`);
    const match = messages.find((message) => message.To.some((to) => to.Address === email));

    if (match) {
      const detail = await fetchJson<MailpitMessageDetail>(`${MAILPIT_URL}/api/v1/message/${match.ID}`);
      const linkMatch = detail.Text.match(/https?:\/\/\S+/);
      if (linkMatch) {
        return linkMatch[0];
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for a recovery email to ${email}`);
}
