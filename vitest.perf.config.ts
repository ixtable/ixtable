import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";

// UI half of the performance harness (docs/decisions/performance-budgets.md). Run after
// `IXTABLE_PERF=1 cargo test --lib perf_tests`, which writes the fixture it opens.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/integration/setup.ts"],
    include: ["tests/perf/**/*.perf.test.tsx"],
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
