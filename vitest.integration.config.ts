import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/integration/setup.ts"],
    include: ["tests/integration/**/*.test.tsx"],
    pool: "forks",
    maxWorkers: 2,
    minWorkers: 1,
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
