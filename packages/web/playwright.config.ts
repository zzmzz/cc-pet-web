import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e-results",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    port: 1420,
    reuseExistingServer: true,
    timeout: 15_000,
  },
  projects: [
    {
      name: "mobile-webkit",
      testMatch: ["**/mobile-*.spec.ts", "**/login-gate.spec.ts", "**/session-switch.spec.ts"],
      use: { ...devices["iPhone 14"] },
    },
    {
      name: "desktop-chromium",
      testMatch: ["**/desktop-*.spec.ts", "**/login-gate.spec.ts", "**/session-switch.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
  ],
});
