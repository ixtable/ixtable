/**
 * Results of the UI performance harness, written as `ui.json` next to the Rust
 * harness's `rust.json` (docs/decisions/performance-budgets.md).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT_DIR = process.env.IXTABLE_PERF_OUT ?? join(ROOT, "reports", "perf");
export const FIXTURE = join(OUT_DIR, "perf-fixture.ixt");
export const hasFixture = () => existsSync(FIXTURE);

/** Timed samples per scenario (after one untimed warm-up). */
export const SAMPLES = 7;

type Result = {
  id: string;
  target: string;
  budgetMs: number | null;
  medianMs: number;
  p95Ms: number;
  samplesMs: number[];
  note: string;
};
const results: Result[] = [];

const round = (ms: number) => Math.round(ms * 10) / 10;

export function record(
  id: string,
  target: string,
  budgetMs: number | null,
  samples: number[],
  note: string,
) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => round(sorted[Math.round((sorted.length - 1) * q)]);
  const result = {
    id,
    target,
    budgetMs,
    medianMs: pick(0.5),
    p95Ms: pick(0.95),
    samplesMs: samples.map(round),
    note,
  };
  console.log(`perf ${JSON.stringify(result)}`);
  results.push(result);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, "ui.json"),
    JSON.stringify({ suite: "ui", environment: "jsdom + tauri-test bridge", results }, null, 2),
  );
}

/** Runs `run` once untimed, then `SAMPLES` times, returning the timed durations in ms. */
export async function sample(run: () => Promise<number>): Promise<number[]> {
  await run();
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(await run());
  return samples;
}
