import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installCrashCapture } from "./persistence/crash";
import "./styles.css";
// Before any editor mounts: bundled Monaco, no CDN.
import "./query/monaco-local";

installCrashCapture();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
