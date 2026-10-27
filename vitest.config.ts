import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(__dirname, "src") };

// Every run gets its own throw-away schema, so tests never reset or touch existing data.
process.env.TEST_DB_SCHEMA ??= `itest_${Date.now()}`;
const baseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://creatorfarm:creatorfarm@localhost:5432/creatorfarm_test";
const databaseUrl = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}schema=${process.env.TEST_DB_SCHEMA}`;
process.env.TEST_DATABASE_URL_RESOLVED = databaseUrl;

const testEnv = {
  NODE_ENV: "test" as const,
  APP_ENV: "test",
  DATABASE_URL: databaseUrl,
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
  QUEUE_PREFIX: "cf-test",
  AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: "./.data/test-storage",
  MOCK_MODE: "true",
  LOG_LEVEL: "error",
  LOGIN_MAX_ATTEMPTS: "3",
};

export default defineConfig({
  resolve: { alias },
  test: {
    // Integration tests share one database schema and Redis DB; run files sequentially.
    fileParallelism: false,
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node", env: testEnv },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          env: testEnv,
          globalSetup: ["tests/setup/integration-global.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
