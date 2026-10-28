// Statistics collection. Every hour each connected account gets one collection job; it stores a
// snapshot for every published post whose next checkpoint is due (1 h … 30 days after publication)
// and one account snapshot per day. Snapshots carry their source and origin: mock accounts produce
// MOCK data, never MEASURED (also enforced by a database trigger).

import { Prisma, type SocialAccount } from "@prisma/client";
import { dueCheckpoint } from "@/lib/analytics";
import { db } from "../db";
import { logger } from "../logger";
import { platformAdapter } from "../platforms/registry";
import { PlatformError } from "../platforms/types";
import { enqueue } from "../queue/queues";
import { accountTokens, markTokenExpired } from "./social";

const COLLECTABLE = ["CONNECTED", "INSUFFICIENT_SCOPE"] as const;
const WINDOW_MS = 31 * 86_400_000;
const big = (v: number | null) => (v === null ? null : BigInt(Math.max(0, Math.round(v))));

export interface CollectResult {
  posts: number;
  account: boolean;
  skipped?: string;
}

/** Collects what is due for one account. Safe to repeat: snapshots are keyed per checkpoint. */
export async function collectAccount(accountId: string, now = new Date()): Promise<CollectResult> {
  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account || !(COLLECTABLE as readonly string[]).includes(account.status)) return { posts: 0, account: false, skipped: "not connected" };
  const origin = account.isMock ? "MOCK" : "MEASURED";

  const jobs = await db.publishingJob.findMany({
    where: { socialAccountId: account.id, status: "PUBLISHED", externalPostId: { not: null }, confirmedAt: { gte: new Date(now.getTime() - WINDOW_MS) } },
    select: { id: true, contentItemId: true, externalPostId: true, confirmedAt: true },
  });
  const due = jobs
    .map((j) => ({ ...j, checkpoint: dueCheckpoint(j.confirmedAt!, now) }))
    .filter((j): j is typeof j & { checkpoint: number } => j.checkpoint !== null)
    .map((j) => ({ ...j, key: `post:${j.id}:${j.checkpoint}h` }));
  const taken = new Set((await db.analyticsSnapshot.findMany({ where: { collectionKey: { in: due.map((d) => d.key) } }, select: { collectionKey: true } })).map((s) => s.collectionKey));
  const todo = due.filter((d) => !taken.has(d.key));
  const accountKey = `account:${account.id}:${now.toISOString().slice(0, 10)}`;
  const accountDone = !!(await db.analyticsSnapshot.findUnique({ where: { collectionKey: accountKey }, select: { id: true } }));
  if (todo.length === 0 && accountDone) return { posts: 0, account: false };

  const adapter = platformAdapter(account.platform, account.isMock);
  const signal = AbortSignal.timeout(60_000);
  try {
    const { tokens, platformAccount } = await accountTokens(account);
    let posts = 0;
    if (todo.length) {
      const metrics = new Map((await adapter.postMetrics(tokens, platformAccount, todo.map((t) => t.externalPostId!), signal)).map((m) => [m.externalPostId, m]));
      const rows: Prisma.AnalyticsSnapshotCreateManyInput[] = [];
      for (const t of todo) {
        const m = metrics.get(t.externalPostId!);
        if (!m) continue; // removed on the platform: nothing to record
        rows.push({
          socialAccountId: account.id,
          publishingJobId: t.id,
          contentItemId: t.contentItemId,
          capturedAt: now,
          ageHours: Math.floor((now.getTime() - t.confirmedAt!.getTime()) / 3_600_000),
          origin,
          source: adapter.metricsSource,
          collectionKey: t.key,
          views: big(m.views),
          reach: big(m.reach),
          likes: big(m.likes),
          comments: big(m.comments),
          shares: big(m.shares),
          saves: big(m.saves),
          watchTimeSec: big(m.watchTimeSec),
          avgViewPercent: m.avgViewPercent,
          raw: m.raw as Prisma.InputJsonValue,
        });
      }
      posts = (await db.analyticsSnapshot.createMany({ data: rows, skipDuplicates: true })).count;
    }
    if (!accountDone) {
      const a = await adapter.accountMetrics(tokens, platformAccount, signal);
      await db.analyticsSnapshot.createMany({
        data: [{ socialAccountId: account.id, capturedAt: now, origin, source: adapter.metricsSource, collectionKey: accountKey, followers: big(a.followers), raw: a.raw as Prisma.InputJsonValue }],
        skipDuplicates: true,
      });
    }
    return { posts, account: !accountDone };
  } catch (err) {
    if (err instanceof PlatformError && err.kind === "auth") {
      await markTokenExpired(account.id, `Statistics could not be fetched: ${err.message}`);
      return { posts: 0, account: false, skipped: "token expired" };
    }
    if (err instanceof PlatformError && err.kind === "insufficient_scope") {
      await db.notification.createMany({
        data: [{ severity: "WARNING", type: "analytics.missing_permission", title: `No statistics for @${account.handle}`, body: err.message.slice(0, 300), link: "/social", dedupeKey: `analytics-scope:${account.id}:${now.toISOString().slice(0, 10)}` }],
        skipDuplicates: true,
      });
      return { posts: 0, account: false, skipped: "missing permission" };
    }
    throw err; // transient and rate limits: the queue retries with backoff
  }
}

/** Hourly: one collection job per connected account (deduplicated per hour). */
export async function dispatchCollection(now = new Date()) {
  const accounts = await db.socialAccount.findMany({ where: { status: { in: [...COLLECTABLE] } }, select: { id: true } });
  const hour = now.toISOString().slice(0, 13).replace(/[-T]/g, "");
  for (const a of accounts) await enqueue("analytics", "analytics.collect", { accountId: a.id }, { idempotencyKey: `analytics:${a.id}:${hour}` });
  return { accounts: accounts.length };
}

/** Collects for every connected account now (operator action). */
export async function collectAllNow(now = new Date()) {
  const accounts = await db.socialAccount.findMany({ where: { status: { in: [...COLLECTABLE] } } });
  let posts = 0;
  const problems: string[] = [];
  for (const a of accounts as SocialAccount[]) {
    try {
      const r = await collectAccount(a.id, now);
      posts += r.posts;
      if (r.skipped && r.skipped !== "not connected") problems.push(`@${a.handle}: ${r.skipped}`);
    } catch (err) {
      logger.warn({ accountId: a.id, err: (err as Error).message }, "statistics collection failed");
      problems.push(`@${a.handle}: ${(err as Error).message}`);
    }
  }
  return { accounts: accounts.length, posts, problems };
}

export const analyticsProcessors = {
  "analytics.collect": async (job: { data: { accountId: string } }) => collectAccount(job.data.accountId),
};
