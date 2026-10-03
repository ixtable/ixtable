import { defineConfig, devices } from "@playwright/test";

// The site is served on 127.0.0.1:3001 because that is the origin the local
// Supabase stack allows for auth redirects and Edge Function CORS.
const SITE = "http://127.0.0.1:3001";

export default defineConfig({
  testDir: "./e2e",
  // The service-qa harness has its own config (playwright.service-qa.config.ts).
  testIgnore: ["**/service-qa/**", "**/service-qa.spec.ts"],
  timeout: 20 * 1000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "html",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: SITE,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    command: process.env.CI
      ? "npm run serve -- --port 3001 --host 127.0.0.1"
      : "npm run build && npm run serve -- --port 3001 --host 127.0.0.1",
    url: SITE,
    reuseExistingServer: !process.env.CI,
    timeout: 180 * 1000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
