// Creates a fresh schema for this run (named itest_<timestamp> by vitest.config.ts), applies all
// migrations with the non-destructive `migrate deploy`, and drops only that schema afterwards.

import { execSync } from "node:child_process";
import { Redis } from "ioredis";
import { PrismaClient } from "@prisma/client";

const SCHEMA_PATTERN = /^itest_\d+$/;

export default async function setup() {
  const schema = process.env.TEST_DB_SCHEMA!;
  const url = process.env.TEST_DATABASE_URL_RESOLVED!;
  if (!SCHEMA_PATTERN.test(schema)) throw new Error(`Unexpected test schema name: ${schema}`);

  execSync("pnpm exec prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });

  const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15");
  await redis.flushdb(); // DB 15 is reserved for tests
  await redis.quit();

  return async function teardown() {
    if (process.env.KEEP_TEST_SCHEMA) return;
    const client = new PrismaClient({ datasourceUrl: url });
    await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.$disconnect();
  };
}
