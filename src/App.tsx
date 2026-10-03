import { useState } from "react";
import { AppShell } from "./shell/AppShell";
import { StartScreen } from "./shell/StartScreen";
import type { SessionState } from "./lib/types";

export default function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  if (!session) return <StartScreen onOpened={setSession} />;
  return <AppShell key={session.sessionId} initial={session} onClosed={() => setSession(null)} />;
}
