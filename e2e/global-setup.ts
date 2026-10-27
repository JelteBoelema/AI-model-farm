import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { E2E_ENV } from "../playwright.config";
import { hashPassword } from "../src/server/auth/password";

export const OWNER = { email: "owner@e2e.local", password: "e2e-owner-password" };
export const VIEWER = { email: "viewer@e2e.local", password: "e2e-viewer-password" };

export default async function globalSetup() {
  const schema = process.env.E2E_SCHEMA!;
  if (!/^e2e_\d+$/.test(schema)) throw new Error(`Unexpected e2e schema: ${schema}`);
  const env = { ...process.env, ...E2E_ENV };
  execSync("pnpm exec prisma migrate deploy", { stdio: "pipe", env });
  execSync("pnpm exec tsx prisma/seed.ts --demo", {
    stdio: "pipe",
    env: { ...env, SEED_OWNER_EMAIL: OWNER.email, SEED_OWNER_PASSWORD: OWNER.password, SEED_MONTHLY_BUDGET_EUR: "250" },
  });

  const db = new PrismaClient({ datasourceUrl: E2E_ENV.DATABASE_URL });
  await db.user.create({ data: { email: VIEWER.email, name: "Vera Viewer", role: "VIEWER", passwordHash: await hashPassword(VIEWER.password) } });
  await db.$disconnect();

  const redis = new Redis(E2E_ENV.REDIS_URL);
  await redis.flushdb(); // DB 14 is reserved for e2e
  await redis.quit();

  return async () => {
    if (process.env.KEEP_E2E_SCHEMA) return;
    const client = new PrismaClient({ datasourceUrl: E2E_ENV.DATABASE_URL });
    await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.$disconnect();
  };
}
