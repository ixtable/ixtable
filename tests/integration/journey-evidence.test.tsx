import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { withJourney } from "./golden/journey";

const evidence = join(
  dirname(fileURLToPath(import.meta.url)),
  "golden",
  ".evidence",
  "evidence-check-fails.json",
);

afterEach(() => {
  rmSync(evidence, { force: true });
});

test("a failed journey writes its error, reproduction steps, and the log tail", async () => {
  await expect(
    withJourney("evidence-check", "fails", async (journey) => {
      await journey.step("open the app", async () => {});
      await journey.step("break", async () => {
        throw new Error("boom");
      });
    }),
  ).rejects.toThrow("boom");
  expect(existsSync(evidence)).toBe(true);
  const written = JSON.parse(readFileSync(evidence, "utf8"));
  expect(written.status).toBe("failed");
  expect(written.error).toBe("boom");
  expect(written.reproduction).toEqual(["1. open the app", "2. break"]);
  expect(Array.isArray(written.logTail)).toBe(true);
});

test("a passing journey writes no log tail", async () => {
  await withJourney("evidence-check", "fails", async (journey) => {
    await journey.step("open the app", async () => {});
  });
  const written = JSON.parse(readFileSync(evidence, "utf8"));
  expect(written.status).toBe("passed");
  expect(written.logTail).toBeUndefined();
});
