import { useState } from "react";
import { AppShell } from "./shell/AppShell";
import { useOpenRequests } from "./shell/openRequests";
import { StartScreen } from "./shell/StartScreen";
import type { SessionState } from "./lib/types";

export default function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  // Files the OS asks to open: the launch argument, then later launches (single instance).
  const { request, handled } = useOpenRequests();
  if (!session)
    return <StartScreen onOpened={setSession} openRequest={request} onRequestHandled={handled} />;
  return (
    <AppShell
      key={session.sessionId}
      initial={session}
      onClosed={() => setSession(null)}
      onOpened={setSession}
      openRequest={request}
      onRequestHandled={handled}
    />
  );
}
