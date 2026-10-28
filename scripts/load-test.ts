// Load test at the target size: 50 creators, each producing, approving and publishing a day's
// content through the real queues and workers (mock providers and mock platform, so nothing is
// billed or published), then statistics collection; optionally HTTP load on the built web app.
//
//   pnpm build && pnpm test:load --web            # full run (≈ 10 minutes)
//   pnpm test:load --creators 10 --items 2        # quick run
//
// Runs in its own database schema (load_<timestamp>), Redis DB 13 and queue prefix. Keeps the
// schema with --keep (the restore drill can use it). Writes a JSON report (--out).

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const CREATORS = Number(arg("creators", "50"));
const ITEMS = Number(arg("items", "6"));
const WEB_USERS = Number(arg("users", "10"));
const WEB_SECONDS = Number(arg("seconds", "60"));
// Pause between a user's clicks, and the latency target for the web phase.
const THINK_MS = Number(arg("think", "1000"));
const WEB_P95_TARGET_MS = Number(arg("p95", "1500"));
const OUT = arg("out", `.data/load-test-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`);
const BASE = process.env.LOAD_DATABASE_URL ?? "postgresql://creatorfarm:creatorfarm@localhost:5432/creatorfarm_test";
const SCHEMA = `load_${Date.now()}`;
const OWNER = { email: "owner@load.local", password: "load-test-owner-password" };
const PORT = 3100;

Object.assign(process.env, {
  DATABASE_URL: `${BASE}${BASE.includes("?") ? "&" : "?"}schema=${SCHEMA}&connection_limit=30`,
  REDIS_URL: process.env.LOAD_REDIS_URL ?? "redis://localhost:6379/13",
  QUEUE_PREFIX: "cf-load",
  AUTH_SECRET: "load-test-secret-0123456789abcdef0123456789",
  AUTH_URL: `http://localhost:${PORT}`,
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: "./.data/load-storage",
  MOCK_MODE: "true",
  LOG_LEVEL: "error",
  LOGIN_MAX_ATTEMPTS: "1000",
  RATE_LIMIT_ACTIONS_PER_MINUTE: "100000",
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : null);
const since = (t: number) => Math.round((Date.now() - t) / 100) / 10;
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function main() {
  const report: Record<string, unknown> = { schema: SCHEMA, creators: CREATORS, itemsPerCreator: ITEMS, startedAt: new Date().toISOString(), errors: [] as string[] };
  const errors = report.errors as string[];
  const env = { ...process.env };
  execSync("pnpm exec prisma migrate deploy", { env, stdio: "pipe" });
  execSync("pnpm exec tsx prisma/seed.ts", { env: { ...env, SEED_OWNER_EMAIL: OWNER.email, SEED_OWNER_PASSWORD: OWNER.password, SEED_MONTHLY_BUDGET_EUR: "1000" }, stdio: "pipe" });

  const { db } = await import("../src/server/db");
  const { redis } = await import("../src/server/redis");
  const { createWorker } = await import("../src/server/queue/worker");
  const { closeQueues, getQueue } = await import("../src/server/queue/queues");
  const { DEAD_LETTER_QUEUE } = await import("../src/server/queue/definitions");
  const { contentProcessors } = await import("../src/server/services/content-pipeline");
  const { publishingProcessors } = await import("../src/server/services/publishing");
  const { analyticsProcessors, collectAllNow } = await import("../src/server/services/analytics-collect");
  const { computeInsights } = await import("../src/server/services/insights");
  const { approveContent, createContent } = await import("../src/server/services/content");
  const { publishNow } = await import("../src/server/services/publishing");
  const { completeConnect, startConnect } = await import("../src/server/services/social");
  const { mockConsentCode } = await import("../src/server/platforms/mock");
  await redis().flushdb();

  const owner = await db.user.findUniqueOrThrow({ where: { email: OWNER.email } });
  const by = { id: owner.id, role: owner.role, actor: { type: "USER" as const, id: owner.id, label: owner.email } };

  // ── Setup: 50 creators with an approved character, pillars, daily slots and a mock account ──
  let t = Date.now();
  const creators: { id: string; accountId: string }[] = [];
  for (let i = 0; i < CREATORS; i++) {
    const c = await db.creator.create({
      data: {
        slug: `load-${i}`,
        name: `Load Creator ${String(i + 1).padStart(2, "0")}`,
        niche: "lifestyle",
        targetAudience: "adults 25–40",
        language: "nl-NL",
        targetRegions: ["NL"],
        personality: "warm",
        toneOfVoice: "friendly",
        backstory: "fictional",
        contentFormats: ["IMAGE_POST"],
        contentPillars: [{ name: "Coffee", description: "" }, { name: "Rain", description: "" }, { name: "City", description: "" }],
        publishingSchedule: { slots: [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) => ["09:00", "13:00", "18:00"].map((time) => ({ platform: "INSTAGRAM", weekday, time }))) },
        status: "ACTIVE",
        autonomyMode: "MANUAL",
      },
    });
    await db.characterProfile.create({ data: { creatorId: c.id, version: 1, status: "APPROVED", identityPrompt: "Synthetic adult character", approvedAt: new Date() } });
    const url = await startConnect(by, { creatorId: c.id, platform: "INSTAGRAM" }, `http://localhost:${PORT}`);
    const state = new URL(url, "http://x").searchParams.get("state")!;
    const account = await completeConnect(by, { platform: "INSTAGRAM", state, code: mockConsentCode(`load_${i}`), error: null });
    creators.push({ id: c.id, accountId: account.id });
  }
  // The day's posts go out at once here: platform posting limits are relaxed for the test (they are
  // covered by the publishing tests) so publishing throughput is what gets measured.
  await db.socialAccount.updateMany({ where: { id: { in: creators.map((c) => c.accountId) } }, data: { maxPostsPerDay: 50, minGapMinutes: 0 } });
  await db.autonomyPolicy.updateMany({ where: { scope: "GLOBAL" }, data: { maxPostsPerDay: 50 } });
  report.setupSeconds = since(t);
  log(`setup: ${CREATORS} creators in ${report.setupSeconds}s`);

  // ── Workers in this process (same processors and concurrency as production) ──
  const workers = [
    createWorker("generation-text", contentProcessors),
    createWorker("generation-image", contentProcessors),
    createWorker("generation-video", contentProcessors),
    createWorker("media-processing", contentProcessors),
    createWorker("publishing", publishingProcessors),
    createWorker("analytics", analyticsProcessors),
  ];

  // ── Phase A: production of the day's items ──
  t = Date.now();
  const items: string[] = [];
  for (const c of creators)
    for (let n = 0; n < ITEMS; n++) items.push((await createContent(by, { creatorId: c.id, format: "IMAGE_POST", title: `Day plan ${n + 1}`, pillar: ["Coffee", "Rain", "City"][n % 3]!, produce: true })).id);
  log(`queued ${items.length} items in ${since(t)}s`);
  const deadline = Date.now() + 40 * 60_000;
  for (;;) {
    const done = await db.contentItem.groupBy({ by: ["status"], where: { id: { in: items } }, _count: true });
    const failed = await db.contentItem.count({ where: { id: { in: items }, failedStep: { not: null } } });
    const ready = done.filter((d) => ["READY", "QC_REVIEW"].includes(d.status)).reduce((s, d) => s + d._count, 0);
    if (ready + failed >= items.length || Date.now() > deadline) {
      report.production = { items: items.length, ready, failed, seconds: since(t), itemsPerMinute: Math.round((ready / ((Date.now() - t) / 60_000)) * 10) / 10, statuses: Object.fromEntries(done.map((d) => [d.status, d._count])) };
      if (failed) errors.push(`${failed} item(s) stopped at a failed step`);
      if (ready + failed < items.length) errors.push("production did not finish within 40 minutes");
      break;
    }
    await sleep(3000);
  }
  log(`production: ${JSON.stringify(report.production)}`);

  const steps = await db.generationJob.findMany({ where: { contentItemId: { in: items }, status: "SUCCEEDED" }, select: { step: true, startedAt: true, finishedAt: true, createdAt: true } });
  const byStep: Record<string, { n: number; p50Ms: number | null; p95Ms: number | null; queueP95Ms: number | null }> = {};
  for (const s of [...new Set(steps.map((x) => x.step))]) {
    const run = steps.filter((x) => x.step === s && x.startedAt && x.finishedAt).map((x) => x.finishedAt!.getTime() - x.startedAt!.getTime());
    const wait = steps.filter((x) => x.step === s && x.startedAt).map((x) => x.startedAt!.getTime() - x.createdAt.getTime());
    byStep[s] = { n: run.length, p50Ms: pct(run, 50), p95Ms: pct(run, 95), queueP95Ms: pct(wait, 95) };
  }
  report.steps = byStep;
  const failedJobs = await db.generationJob.count({ where: { contentItemId: { in: items }, status: { in: ["FAILED", "BLOCKED_POLICY", "BLOCKED_BUDGET"] } } });
  report.failedJobs = failedJobs;
  if (failedJobs) errors.push(`${failedJobs} generation job(s) failed`);

  // ── Phase B: approve and publish everything that is ready ──
  t = Date.now();
  const ready = await db.contentItem.findMany({ where: { id: { in: items }, status: "READY" }, select: { id: true, creatorId: true } });
  const accountOf = new Map(creators.map((c) => [c.id, c.accountId]));
  for (const item of ready) {
    try {
      await approveContent(by, item.id);
      await publishNow(by, { contentItemId: item.id, socialAccountId: accountOf.get(item.creatorId)! });
    } catch (err) {
      errors.push(`approve/publish ${item.id}: ${(err as Error).message}`);
    }
  }
  for (;;) {
    const open = await db.publishingJob.count({ where: { contentItemId: { in: items }, status: { in: ["SCHEDULED", "QUEUED", "PUBLISHING", "AWAITING_CONFIRMATION"] } } });
    if (open === 0 || Date.now() > deadline) break;
    await sleep(2000);
  }
  const published = await db.publishingJob.count({ where: { contentItemId: { in: items }, status: "PUBLISHED" } });
  const notPublished = await db.publishingJob.groupBy({ by: ["status"], where: { contentItemId: { in: items }, status: { not: "PUBLISHED" } }, _count: true });
  const posts = await db.mockPlatformPost.count({ where: { socialAccountId: { in: creators.map((c) => c.accountId) } } });
  report.publishing = { approved: ready.length, published, mockPosts: posts, notPublished: Object.fromEntries(notPublished.map((d) => [d.status, d._count])), seconds: since(t) };
  if (published !== ready.length) errors.push(`${ready.length - published} publication(s) not published`);
  if (posts !== published) errors.push(`platform has ${posts} posts for ${published} publications (duplicates or losses)`);
  log(`publishing: ${JSON.stringify(report.publishing)}`);

  // ── Phase C: statistics two hours later ──
  t = Date.now();
  await db.publishingJob.updateMany({ where: { contentItemId: { in: items }, status: "PUBLISHED" }, data: { confirmedAt: new Date(Date.now() - 2 * 3_600_000) } });
  await db.mockPlatformPost.updateMany({ where: { socialAccountId: { in: creators.map((c) => c.accountId) } }, data: { publishedAt: new Date(Date.now() - 2 * 3_600_000) } });
  const collected = await collectAllNow();
  const insights = await computeInsights();
  report.analytics = { ...collected, ...insights, seconds: since(t) };
  if (collected.posts !== published) errors.push(`collected ${collected.posts} post snapshots for ${published} posts`);
  if (collected.problems.length) errors.push(...collected.problems);
  log(`analytics: ${JSON.stringify(report.analytics)}`);

  const dl = await getQueue(DEAD_LETTER_QUEUE).count();
  report.deadLetterJobs = dl;
  if (dl) errors.push(`${dl} dead-lettered job(s)`);
  await Promise.all(workers.map((w) => w.close()));

  // ── Phase D: HTTP load on the built app ──
  if (flag("web")) report.web = await webLoad(errors);

  const size = await db.$queryRawUnsafe<{ size: string }[]>(`SELECT pg_size_pretty(sum(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)))::bigint) AS size FROM pg_tables WHERE schemaname = '${SCHEMA}'`);
  report.databaseSize = size[0]?.size;
  report.finishedAt = new Date().toISOString();
  report.passed = errors.length === 0;
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log(`report: ${OUT} — ${report.passed ? "PASSED" : `FAILED (${errors.length} error(s))`}`);

  await closeQueues();
  redis().disconnect();
  if (!flag("keep")) await db.$executeRawUnsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
  else log(`kept schema ${SCHEMA}`);
  await db.$disconnect();
  if (!report.passed) process.exitCode = 1;
}

async function webLoad(errors: string[]) {
  const server: ChildProcess = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], { env: { ...process.env, NODE_ENV: "production" }, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://localhost:${PORT}/api/health/live`)).ok) break;
      } catch {}
      await sleep(1000);
    }
    const cookies = new Map<string, string>();
    const keep = (res: Response) => {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const [k, ...v] = pair!.split("=");
        cookies.set(k!, v.join("="));
      }
    };
    const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const csrfRes = await fetch(`http://localhost:${PORT}/api/auth/csrf`);
    keep(csrfRes);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const login = await fetch(`http://localhost:${PORT}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
      body: new URLSearchParams({ csrfToken, email: OWNER.email, password: OWNER.password, callbackUrl: "/" }),
    });
    keep(login);
    if (![...cookies.keys()].some((k) => k.includes("session-token"))) throw new Error(`sign-in failed (${login.status})`);

    const paths = ["/", "/content", "/calendar", "/analytics?origin=mock&period=all", "/creators", "/costs", "/workflows", "/social", "/api/health"];
    const latencies: Record<string, number[]> = {};
    const statuses: Record<string, number> = {};
    let requests = 0;
    const end = Date.now() + WEB_SECONDS * 1000;
    await Promise.all(
      Array.from({ length: WEB_USERS }, async (_, u) => {
        for (let i = u; Date.now() < end; i++) {
          const path = paths[i % paths.length]!;
          const t0 = performance.now();
          try {
            const res = await fetch(`http://localhost:${PORT}${path}`, { headers: { cookie: cookieHeader() }, redirect: "manual" });
            await res.arrayBuffer();
            statuses[res.status] = (statuses[res.status] ?? 0) + 1;
            (latencies[path] ??= []).push(performance.now() - t0);
          } catch (err) {
            statuses.network = (statuses.network ?? 0) + 1;
            void err;
          }
          requests++;
          await sleep(THINK_MS);
        }
      }),
    );
    const all = Object.values(latencies).flat();
    const bad = Object.entries(statuses).filter(([s]) => s === "network" || Number(s) >= 400).reduce((n, [, c]) => n + c, 0);
    if (bad) errors.push(`${bad} HTTP request(s) failed: ${JSON.stringify(statuses)}`);
    if ((pct(all, 95) ?? 0) > WEB_P95_TARGET_MS) errors.push(`web p95 ${Math.round(pct(all, 95)!)} ms above the ${WEB_P95_TARGET_MS} ms target`);
    const result = {
      users: WEB_USERS,
      thinkMs: THINK_MS,
      seconds: WEB_SECONDS,
      p95TargetMs: WEB_P95_TARGET_MS,
      requests,
      requestsPerSecond: Math.round((requests / WEB_SECONDS) * 10) / 10,
      statuses,
      p50Ms: Math.round(pct(all, 50) ?? 0),
      p95Ms: Math.round(pct(all, 95) ?? 0),
      p99Ms: Math.round(pct(all, 99) ?? 0),
      perPathP95Ms: Object.fromEntries(Object.entries(latencies).map(([p, xs]) => [p, Math.round(pct(xs, 95) ?? 0)])),
    };
    log(`web: ${JSON.stringify(result)}`);
    return result;
  } finally {
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  }
}

main()
  // Worker connections keep the event loop alive; the report is written, so stop here.
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
