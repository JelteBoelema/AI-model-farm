import { describe, expect, it } from "vitest";
import { parseEnv } from "@/server/env";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "x".repeat(40),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("env", () => {
  it("applies safe defaults: mock mode on, local storage", () => {
    const env = parseEnv(base);
    expect(env.MOCK_MODE).toBe(true);
    expect(env.STORAGE_DRIVER).toBe("local");
  });

  it("parses booleans explicitly", () => {
    expect(parseEnv({ ...base, MOCK_MODE: "false" }).MOCK_MODE).toBe(false);
    expect(() => parseEnv({ ...base, MOCK_MODE: "yes" })).toThrow();
  });

  it("rejects weak secrets and bad keys", () => {
    expect(() => parseEnv({ ...base, AUTH_SECRET: "short" })).toThrow(/AUTH_SECRET/);
    expect(() => parseEnv({ ...base, APP_ENCRYPTION_KEY: "abc" })).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it("enforces production requirements", () => {
    const prod = { ...base, APP_ENV: "production", AUTH_SECRET: `dev-only-${"x".repeat(40)}` };
    expect(() => parseEnv(prod)).toThrow(/development secret/);
    expect(() => parseEnv({ ...prod, AUTH_SECRET: "y".repeat(40) })).toThrow(/s3 storage/);
    expect(
      parseEnv({ ...prod, AUTH_SECRET: "y".repeat(40), STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_REGION: "eu-central-1", SECRETS_DRIVER: "aws" }).APP_ENV,
    ).toBe("production");
  });

  it("never echoes secret values in errors", () => {
    try {
      parseEnv({ ...base, AUTH_SECRET: "super-secret-but-short" });
    } catch (e) {
      expect((e as Error).message).not.toContain("super-secret-but-short");
    }
  });
});
