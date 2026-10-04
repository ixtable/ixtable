/// <reference types="vite/client" />
// Monaco from the app bundle instead of @monaco-editor/loader's default CDN
// (cdn.jsdelivr.net): the desktop app works offline and its CSP allows only
// 'self' scripts (docs/release/security.md). SQL is the only language used.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/languages/definitions/sql/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
