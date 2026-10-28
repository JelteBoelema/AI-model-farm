// Operational metrics for CloudWatch. The scheduler worker writes them every minute to stdout in
// CloudWatch Embedded Metric Format (EMF): the awslogs log driver turns those lines into metrics,
// without an SDK or credentials. Alarms (infra/alarms.json, applied by Terraform) and worker
// autoscaling use them.

import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../db";
import { DEAD_LETTER_QUEUE, QUEUE_NAMES, QUEUES, WORKER_ROLES, type QueueName, type WorkerRole } from "./definitions";
import { getQueue } from "./queues";
import { listHeartbeats } from "./worker";

export interface QueueMetrics {
  queue: QueueName;
  backlog: number;
  active: number;
  failed: number;
  oldestWaitingSeconds: number;
}

export interface FarmMetrics {
  at: Date;
  queues: QueueMetrics[];
  workersAlive: Record<WorkerRole, number>;
  deadLetterJobs: number;
  stuckJobs: number;
  publishingFailedLastHour: number;
  budgetPausesActive: number;
  accountsNeedingReconnect: number;
}

const GENERATION_QUEUE_BY_KIND = { TEXT: "generation-text", MODERATION: "generation-text", IMAGE: "generation-image", VIDEO: "generation-video", SPEECH: "generation-video", LIPSYNC: "generation-video", MEDIA_PROCESSING: "media-processing" } as const;

export async function collectMetrics(now = new Date()): Promise<FarmMetrics> {
  const queues = await Promise.all(
    QUEUE_NAMES.map(async (queue) => {
      const q = getQueue(queue);
      const c = await q.getJobCounts("waiting", "delayed", "prioritized", "active", "failed");
      const [oldest] = await q.getJobs(["waiting", "prioritized"], 0, 0, true);
      return {
        queue,
        backlog: (c.waiting ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0),
        active: c.active ?? 0,
        failed: c.failed ?? 0,
        oldestWaitingSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.timestamp) / 1000)) : 0,
      };
    }),
  );
  const alive = (await listHeartbeats(now.getTime())).filter((h) => h.alive);
  const workersAlive = Object.fromEntries(WORKER_ROLES.map((role) => [role, alive.filter((h) => h.queues.some((q) => QUEUES[q as QueueName]?.workerRole === role)).length])) as Record<WorkerRole, number>;
  const dl = await getQueue(DEAD_LETTER_QUEUE).getJobCounts("waiting", "delayed", "prioritized", "paused");
  const running = await db.generationJob.findMany({ where: { status: "RUNNING", providerJobId: null }, select: { kind: true, startedAt: true, updatedAt: true } });
  const stuckJobs = running.filter((j) => now.getTime() - (j.startedAt ?? j.updatedAt).getTime() > QUEUES[GENERATION_QUEUE_BY_KIND[j.kind]].stuckAfterMs).length;
  const [publishingFailedLastHour, budgetPausesActive, accountsNeedingReconnect] = await Promise.all([
    db.publishingJob.count({ where: { status: "FAILED", updatedAt: { gte: new Date(now.getTime() - 3_600_000) } } }),
    db.controlSwitch.count({ where: { paused: true, reason: { startsWith: "Budget limit reached" } } }),
    db.socialAccount.count({ where: { status: { in: ["TOKEN_EXPIRED", "REVOKED"] } } }),
  ]);
  return {
    at: now,
    queues,
    workersAlive,
    deadLetterJobs: Object.values(dl).reduce((a, b) => a + (b ?? 0), 0),
    stuckJobs,
    publishingFailedLastHour,
    budgetPausesActive,
    accountsNeedingReconnect,
  };
}

export interface AlarmDefinition {
  name: string;
  metric: string;
  perQueue?: boolean;
  perRole?: boolean;
  comparison: "GreaterThanThreshold" | "LessThanThreshold";
  threshold: number;
  evaluationPeriods: number;
  statistic: string;
  missingData: "breaching" | "notBreaching";
  severity: "critical" | "warning";
  runbook: string;
  description: string;
}

export const NAMESPACE = "CreatorFarm";

export function loadAlarms(): { namespace: string; alarms: AlarmDefinition[] } {
  return JSON.parse(readFileSync(path.join(process.cwd(), "infra/alarms.json"), "utf8"));
}

type Point = { metric: string; dims: Record<string, string>; value: number };

/** Every value as metric + dimensions (the same shape the alarms use). */
export function points(m: FarmMetrics): Point[] {
  return [
    ...m.queues.flatMap((q) => [
      { metric: "QueueBacklog", dims: { Queue: q.queue }, value: q.backlog },
      { metric: "QueueActive", dims: { Queue: q.queue }, value: q.active },
      { metric: "OldestWaitingSeconds", dims: { Queue: q.queue }, value: q.oldestWaitingSeconds },
    ]),
    ...Object.entries(m.workersAlive).map(([role, value]) => ({ metric: "WorkersAlive", dims: { Role: role }, value })),
    { metric: "DeadLetterJobs", dims: {}, value: m.deadLetterJobs },
    { metric: "StuckJobs", dims: {}, value: m.stuckJobs },
    { metric: "PublishingFailedLastHour", dims: {}, value: m.publishingFailedLastHour },
    { metric: "BudgetPausesActive", dims: {}, value: m.budgetPausesActive },
    { metric: "AccountsNeedingReconnect", dims: {}, value: m.accountsNeedingReconnect },
  ];
}

/** EMF log lines: one per dimension set. */
export function toEmf(m: FarmMetrics): string[] {
  const groups = new Map<string, Point[]>();
  for (const p of points(m)) {
    const key = JSON.stringify(p.dims);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.entries()].map(([key, ps]) => {
    const dims = JSON.parse(key) as Record<string, string>;
    return JSON.stringify({
      _aws: {
        Timestamp: m.at.getTime(),
        CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [Object.keys(dims)], Metrics: ps.map((p) => ({ Name: p.metric, Unit: p.metric.endsWith("Seconds") ? "Seconds" : "Count" })) }],
      },
      ...dims,
      ...Object.fromEntries(ps.map((p) => [p.metric, p.value])),
    });
  });
}

/** Which alarms the current values would put in ALARM (one evaluation period). */
export function breachingAlarms(m: FarmMetrics, alarms: AlarmDefinition[]): { alarm: string; dims: Record<string, string>; value: number }[] {
  const out: { alarm: string; dims: Record<string, string>; value: number }[] = [];
  for (const a of alarms)
    for (const p of points(m).filter((x) => x.metric === a.metric)) {
      const breach = a.comparison === "GreaterThanThreshold" ? p.value > a.threshold : p.value < a.threshold;
      if (breach) out.push({ alarm: a.name, dims: p.dims, value: p.value });
    }
  return out;
}

/** Scheduler job: write this minute's metrics. */
export async function publishMetrics(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {
  const m = await collectMetrics();
  for (const line of toEmf(m)) write(line);
  return { lines: toEmf(m).length };
}
