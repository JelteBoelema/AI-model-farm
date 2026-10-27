// Read models for the dashboard. Every figure is labelled by origin: measured (from a real
// provider/platform response), estimated (conservative, flagged), mock or demo. Mock costs are never
// mixed into real spend.

import { Prisma, type ContentStatus } from "@prisma/client";
import { periodStart, type DashboardFilters } from "@/lib/filters";
import { db } from "../db";

export async function getFilterOptions() {
  const [creators, campaigns] = await Promise.all([
    db.creator.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true, isDemo: true }, orderBy: { name: "asc" } }),
    db.campaign.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, name: true, isDemo: true }, orderBy: { name: "asc" } }),
  ]);
  return { creators, campaigns };
}

export function contentWhere(f: DashboardFilters, now = new Date()): Prisma.ContentItemWhereInput {
  const since = periodStart(f.period, now);
  return {
    ...(f.creator ? { creatorId: f.creator } : {}),
    ...(f.campaign ? { campaignId: f.campaign } : {}),
    ...(f.platform ? { publishingJobs: { some: { platform: f.platform } } } : {}),
    ...(since ? { createdAt: { gte: since } } : {}),
  };
}

export function ledgerWhere(f: DashboardFilters, now = new Date()): Prisma.CostLedgerWhereInput {
  const since = periodStart(f.period, now);
  return {
    ...(f.creator ? { creatorId: f.creator } : {}),
    ...(f.campaign ? { campaignId: f.campaign } : {}),
    ...(since ? { occurredAt: { gte: since } } : {}),
  };
}

export interface SpendBreakdown {
  measuredMicros: bigint;
  estimatedMicros: bigint;
  mockMicros: bigint;
  entries: number;
}

export async function getSpend(where: Prisma.CostLedgerWhereInput): Promise<SpendBreakdown> {
  const rows = await db.costLedger.groupBy({ by: ["basis", "isMock"], where, _sum: { amountMicros: true }, _count: true });
  const out: SpendBreakdown = { measuredMicros: 0n, estimatedMicros: 0n, mockMicros: 0n, entries: 0 };
  for (const r of rows) {
    const amount = r._sum.amountMicros ?? 0n;
    out.entries += r._count;
    if (r.isMock) out.mockMicros += amount;
    else if (r.basis === "ESTIMATED") out.estimatedMicros += amount;
    else out.measuredMicros += amount;
  }
  return out;
}

export async function getDailySpend(f: DashboardFilters, days = 30, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const conditions = [Prisma.sql`occurred_at >= ${start}`, Prisma.sql`is_mock = false`];
  if (f.creator) conditions.push(Prisma.sql`creator_id = ${f.creator}::uuid`);
  if (f.campaign) conditions.push(Prisma.sql`campaign_id = ${f.campaign}::uuid`);
  const rows = await db.$queryRaw<{ day: Date; measured: bigint; estimated: bigint }[]>`
    SELECT date_trunc('day', occurred_at AT TIME ZONE 'UTC') AS day,
           COALESCE(SUM(amount_micros) FILTER (WHERE basis <> 'ESTIMATED'), 0)::bigint AS measured,
           COALESCE(SUM(amount_micros) FILTER (WHERE basis = 'ESTIMATED'), 0)::bigint AS estimated
    FROM cost_ledger
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY 1 ORDER BY 1`;
  const byDay = new Map(rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), r]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    return { day: key, measuredMicros: row?.measured ?? 0n, estimatedMicros: row?.estimated ?? 0n };
  });
}

export const PIPELINE_STAGES: ContentStatus[] = [
  "IDEA",
  "BRIEFED",
  "SCRIPTED",
  "PROMPTED",
  "GENERATING",
  "QC_REVIEW",
  "READY",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
];

export async function getOverview(f: DashboardFilters, now = new Date()) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
  const creatorScope = f.creator ? { id: f.creator } : {};

  const [
    creatorsByStatus,
    demoCreators,
    contentByStatus,
    upcoming,
    spend,
    monthSpend,
    globalBudget,
    heldReservations,
    pendingApprovals,
    jobsByStatus,
    recentAudit,
    pausedSwitches,
  ] = await Promise.all([
    db.creator.groupBy({ by: ["status"], where: creatorScope, _count: true }),
    db.creator.count({ where: { ...creatorScope, isDemo: true, status: { not: "ARCHIVED" } } }),
    db.contentItem.groupBy({ by: ["status"], where: contentWhere(f, now), _count: true }),
    db.publishingJob.findMany({
      where: {
        status: { in: ["SCHEDULED", "QUEUED"] },
        scheduledFor: { gte: now, lte: weekAhead },
        ...(f.platform ? { platform: f.platform } : {}),
        contentItem: { ...(f.creator ? { creatorId: f.creator } : {}), ...(f.campaign ? { campaignId: f.campaign } : {}) },
      },
      orderBy: { scheduledFor: "asc" },
      take: 6,
      select: {
        id: true,
        platform: true,
        scheduledFor: true,
        status: true,
        isMock: true,
        contentItem: { select: { title: true, isDemo: true, creator: { select: { name: true } } } },
      },
    }),
    getSpend(ledgerWhere(f, now)),
    getSpend({ ...ledgerWhere({ ...f, period: "all" }), occurredAt: { gte: monthStart } }),
    db.budgetPolicy.findFirst({ where: { scope: "GLOBAL", period: "MONTH" } }),
    db.budgetReservation.aggregate({ where: { status: "HELD" }, _sum: { amountMicros: true } }),
    db.approval.count({ where: { decision: "PENDING" } }),
    db.generationJob.groupBy({
      by: ["status"],
      where: { ...(f.creator ? { creatorId: f.creator } : {}), ...(periodStart(f.period, now) ? { createdAt: { gte: periodStart(f.period, now)! } } : {}) },
      _count: true,
    }),
    db.auditLog.findMany({ orderBy: { occurredAt: "desc" }, take: 8 }),
    db.controlSwitch.findMany({ where: { paused: true } }),
  ]);

  const count = <T extends { _count: number }>(rows: T[], pick: (r: T) => boolean) => rows.filter(pick).reduce((s, r) => s + r._count, 0);

  return {
    creators: {
      active: count(creatorsByStatus, (r) => r.status === "ACTIVE"),
      paused: count(creatorsByStatus, (r) => r.status === "PAUSED"),
      draft: count(creatorsByStatus, (r) => r.status === "DRAFT"),
      total: count(creatorsByStatus, (r) => r.status !== "ARCHIVED"),
      demo: demoCreators,
    },
    pipeline: PIPELINE_STAGES.map((stage) => ({ stage, count: count(contentByStatus, (r) => r.status === stage) })),
    contentTotal: count(contentByStatus, () => true),
    upcoming,
    spend,
    monthSpend,
    monthlyBudgetMicros: globalBudget?.limitMicros ?? null,
    heldMicros: heldReservations._sum.amountMicros ?? 0n,
    pendingApprovals,
    jobs: {
      running: count(jobsByStatus, (r) => r.status === "RUNNING" || r.status === "QUEUED"),
      failed: count(jobsByStatus, (r) => r.status === "FAILED" || r.status === "DEAD_LETTER"),
      blocked: count(jobsByStatus, (r) => r.status === "BLOCKED_BUDGET" || r.status === "BLOCKED_POLICY"),
      succeeded: count(jobsByStatus, (r) => r.status === "SUCCEEDED"),
    },
    recentAudit,
    pausedSwitches,
  };
}
