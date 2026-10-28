import { defineConfig, devices } from "@playwright/test";

// Isolated schema per run inside the e2e database; created by global setup with `migrate deploy`.
process.env.E2E_SCHEMA ??= `e2e_${Date.now()}`;
const base = process.env.E2E_DATABASE_URL ?? "postgresql://creatorfarm:creatorfarm@localhost:5432/creatorfarm_e2e";
export const E2E_DATABASE_URL = `${base}${base.includes("?") ? "&" : "?"}schema=${process.env.E2E_SCHEMA}`;
const PORT = Number(process.env.E2E_PORT ?? 3100);

export const E2E_ENV = {
  DATABASE_URL: E2E_DATABASE_URL,
  REDIS_URL: process.env.E2E_REDIS_URL ?? "redis://localhost:6379/14",
  QUEUE_PREFIX: "cf-e2e",
  AUTH_SECRET: "e2e-secret-0123456789abcdef0123456789abcdef",
  AUTH_URL: `http://localhost:${PORT}`,
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: "./.data/e2e-storage",
  MOCK_MODE: "true",
  LOG_LEVEL: "warn",
  LOGIN_MAX_ATTEMPTS: "20",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /responsive\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `pnpm exec next start -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health/live`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: E2E_ENV,
    },
    {
      // Generation and maintenance workers: prompt tests run through the queue.
      command: "pnpm exec tsx src/workers/main.ts",
      url: "http://localhost:9480/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...E2E_ENV, WORKER_HEALTH_PORT: "9480", WORKER_QUEUES: "generation,scheduler" },
    },
  ],
});
