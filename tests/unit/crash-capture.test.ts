import { describe, expect, it, vi } from "vitest";
import { describeCrash, installCrashCapture } from "../../src/persistence/crash";

type Listener = (event: Event) => void;

const fakeWindow = () => {
  const listeners = new Map<string, Listener>();
  const target = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Window;
  const fire = (type: string, event: Event) => listeners.get(type)?.(event);
  return { target, fire, listeners };
};

const rejection = (reason: unknown) =>
  Object.assign(new Event("unhandledrejection"), { reason }) as PromiseRejectionEvent;

describe("crash capture", () => {
  it("logs uncaught errors and unhandled rejections until uninstalled", () => {
    const { target, fire, listeners } = fakeWindow();
    const log = vi.fn().mockResolvedValue(undefined);
    const uninstall = installCrashCapture(target, log);
    const boom = new Error("boom");
    fire("error", new ErrorEvent("error", { error: boom, message: "boom" }));
    fire("unhandledrejection", rejection("token=abc"));
    fire(
      "error",
      new ErrorEvent("error", { message: "Script error.", filename: "a.js", lineno: 3, colno: 4 }),
    );
    expect(log.mock.calls).toEqual([
      ["error", "crash", `uncaught error: ${boom.stack}`],
      ["error", "crash", "unhandled rejection: token=abc"],
      ["error", "crash", "uncaught error: Script error. (a.js:3:4)"],
    ]);
    uninstall();
    expect(listeners.size).toBe(0);
  });

  it("never throws when logging itself fails", async () => {
    const { target, fire } = fakeWindow();
    const log = vi.fn().mockRejectedValue(new Error("no bridge"));
    installCrashCapture(target, log);
    expect(() => fire("unhandledrejection", rejection({ code: 1 }))).not.toThrow();
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith("error", "crash", 'unhandled rejection: {"code":1}');
  });

  it("describes any rejection reason", () => {
    expect(describeCrash("plain")).toBe("plain");
    expect(describeCrash(undefined)).toBe("undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeCrash(cyclic)).toBe("[object Object]");
  });
});
