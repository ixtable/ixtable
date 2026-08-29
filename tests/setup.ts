import "@testing-library/jest-dom/vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { vi } from "vitest";

const require = createRequire(import.meta.url);
const bridgePath = join(process.cwd(), "src-tauri/target/index.cjs");
export const tauriTest = existsSync(bridgePath)
  ? (require(bridgePath) as {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    })
  : {
      invoke: async () => {
        throw new Error("Tauri test bridge is not built");
      },
    };
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriTest.invoke }));
globalThis.ResizeObserver = class ResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb([{ target, contentRect: { width: 1000, height: 300 } } as ResizeObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
};
