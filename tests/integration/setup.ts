import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, afterAll, vi } from "vitest";
import { createElement } from "react";

// This must be set before loading the native module: Rust initializes its
// process-wide DocumentManager on the first command.
const stateDirectory = mkdtempSync(join(tmpdir(), `ixtable-integration-${process.pid}-`));
process.env.IXTABLE_STATE_DIR = stateDirectory;
const require = createRequire(import.meta.url);
export const testBridge = require("../../src-tauri/target/index.cjs") as {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

vi.mock("@tauri-apps/api/core", () => ({ invoke: testBridge.invoke }));
vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    createElement("textarea", {
      "aria-label": "SQL editor",
      value,
      onChange: (event: any) => onChange(event.target.value),
    }),
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});
globalThis.ResizeObserver = class ResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { width: 1000, height: 500 } } as ResizeObserverEntry],
      this,
    );
  }
  unobserve() {}
  disconnect() {}
};
if (!globalThis.PointerEvent) globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
if (!window.DOMMatrixReadOnly)
  window.DOMMatrixReadOnly = class DOMMatrixReadOnly {
    m22 = 1;
    constructor(_transform?: string) {}
  } as typeof DOMMatrixReadOnly;

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  try {
    await testBridge.invoke("close_document", { windowLabel: "main", force: true });
  } catch {
    /* no active document */
  }
});
afterAll(() => rmSync(stateDirectory, { recursive: true, force: true }));
