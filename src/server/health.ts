import { db } from "./db";
import { redis } from "./redis";
import { storage } from "./storage";

export interface CheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface HealthReport {
  status: "ok" | "degraded";
  checks: Record<"database" | "redis" | "storage", CheckResult>;
}

async function timed(fn: () => Promise<unknown>, timeoutMs = 3000): Promise<CheckResult> {
  const start = performance.now();
  try {
    await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), timeoutMs))]);
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return { ok: false, latencyMs: Math.round(performance.now() - start), error: (err as Error).message };
  }
}

export async function checkHealth(): Promise<HealthReport> {
  const [database, redisCheck, storageCheck] = await Promise.all([
    timed(() => db.$queryRaw`SELECT 1`),
    timed(() => redis().ping()),
    timed(() => storage().healthCheck()),
  ]);
  const checks = { database, redis: redisCheck, storage: storageCheck };
  return { status: Object.values(checks).every((c) => c.ok) ? "ok" : "degraded", checks };
}
