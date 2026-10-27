// Validated runtime configuration. Parsed lazily on first access so `next build` does not need
// production secrets, and fails fast with a readable message when something is missing.

import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const DEV_SECRET_MARKER = "dev-only";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
    APP_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, "APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
    // Mock mode routes every AI provider and social platform call to explicit mock adapters.
    MOCK_MODE: bool.default(true),
    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("./.data/storage"),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: bool.default(false),
    SECRETS_DRIVER: z.enum(["env", "aws"]).default("env"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    WORKER_QUEUES: z.string().optional(),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(9464),
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === "production") {
      if (env.AUTH_SECRET.includes(DEV_SECRET_MARKER))
        ctx.addIssue({ code: "custom", path: ["AUTH_SECRET"], message: "development secret used in production" });
      if (env.STORAGE_DRIVER !== "s3")
        ctx.addIssue({ code: "custom", path: ["STORAGE_DRIVER"], message: "production requires s3 storage" });
      if (env.SECRETS_DRIVER !== "aws")
        ctx.addIssue({ code: "custom", path: ["SECRETS_DRIVER"], message: "production requires a secrets manager" });
    }
    if (env.STORAGE_DRIVER === "s3" && (!env.S3_BUCKET || !env.S3_REGION))
      ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "S3_BUCKET and S3_REGION are required for s3 storage" });
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test hook: forget the cached env after mutating process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
