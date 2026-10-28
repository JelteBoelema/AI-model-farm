// Housekeeping that keeps the database (source of truth) consistent after crashes and restarts.

import type { GenerationKind } from "@prisma/client";
import { assertTransition } from "@/lib/state-machines";
import { db } from "@/server/db";
import { recordAudit, SYSTEM_ACTOR } from "@/server/audit";
import { QUEUES, type QueueName } from "@/server/queue/definitions";
import { markStepFailed } from "@/server/services/content-pipeline";
import type { PipelineStep } from "@/lib/content-pipeline";
import { dispatchDuePublications } from "@/server/services/publishing";
import { refreshExpiringTokens } from "@/server/services/social";
import { runAutopilot } from "@/server/services/autopilot";
import { dispatchCollection } from "@/server/services/analytics-collect";
import { computeInsights } from "@/server/services/insights";
import { publishMetrics } from "@/server/queue/metrics";

export const GENERATION_KIND_QUEUE: Record<GenerationKind, QueueName> = {
  TEXT: "generation-text",
  MODERATION: "generation-text",
  IMAGE: "generation-image",
  VIDEO: "generation-video",
  SPEECH: "generation-video",
  LIPSYNC: "generation-video",
  MEDIA_PROCESSING: "media-processing",
};

/** Release budget held by jobs that never settled (crashed worker, cancelled job). */
export async function expireReservations(now = new Date()): Promise<number> {
  const { count } = await db.budgetReservation.updateMany({
    where: { status: "HELD", expiresAt: { lt: now } },
    data: { status: "RELEASED", settledAt: now },
  });
  if (count > 0) await recordAudit(SYSTEM_ACTOR, { action: "budget.reservations_expired", metadata: { count } });
  return count;
}

export interface StuckReport {
  generationFailed: number;
  publishingAwaitingConfirmation: number;
}

/**
 * Generation jobs that are RUNNING far beyond their queue's limit are marked FAILED (a retry decision
 * is then made by the normal flow, never by re-running blindly). Publications stuck in PUBLISHING go
 * to AWAITING_CONFIRMATION: the remote platform must be queried before anything is re-submitted.
 */
export async function detectStuckJobs(now = new Date()): Promise<StuckReport> {
  const report: StuckReport = { generationFailed: 0, publishingAwaitingConfirmation: 0 };

  const running = await db.generationJob.findMany({
    where: { status: "RUNNING" },
    select: { id: true, kind: true, step: true, contentItemId: true, startedAt: true, updatedAt: true },
  });
  for (const job of running) {
    const limit = QUEUES[GENERATION_KIND_QUEUE[job.kind]].stuckAfterMs;
    const since = job.startedAt ?? job.updatedAt;
    if (now.getTime() - since.getTime() < limit) continue;
    assertTransition("generationJob", "RUNNING", "FAILED");
    const updated = await db.generationJob.updateMany({
      where: { id: job.id, status: "RUNNING" }, // compare-and-set: skip if it finished meanwhile
      data: { status: "FAILED", finishedAt: now, error: { code: "STUCK", message: `No progress for ${limit}ms` } },
    });
    if (updated.count === 1) {
      report.generationFailed++;
      await recordAudit(SYSTEM_ACTOR, { action: "generation_job.marked_stuck", entityType: "generation_job", entityId: job.id });
      // A content pipeline step stops its chain; the operator resumes it from the content item.
      if (job.contentItemId && job.step) await markStepFailed(job.contentItemId, job.step as PipelineStep, "The step made no progress and was stopped");
    }
  }

  const publishLimit = QUEUES.publishing.stuckAfterMs;
  const publishing = await db.publishingJob.findMany({
    where: { status: "PUBLISHING", updatedAt: { lt: new Date(now.getTime() - publishLimit) } },
    select: { id: true },
  });
  for (const job of publishing) {
    assertTransition("publishing", "PUBLISHING", "AWAITING_CONFIRMATION");
    const updated = await db.publishingJob.updateMany({
      where: { id: job.id, status: "PUBLISHING" },
      data: { status: "AWAITING_CONFIRMATION", lastError: { code: "STUCK", message: "Outcome unknown; verify remotely" } },
    });
    if (updated.count === 1) {
      report.publishingAwaitingConfirmation++;
      await recordAudit(SYSTEM_ACTOR, { action: "publishing_job.awaiting_confirmation", entityType: "publishing_job", entityId: job.id });
    }
  }

  if (report.generationFailed + report.publishingAwaitingConfirmation > 0) {
    await db.notification.create({
      data: {
        severity: "WARNING",
        type: "workflow.stuck_jobs",
        title: "Stuck jobs detected",
        body: `${report.generationFailed} generation job(s) marked failed, ${report.publishingAwaitingConfirmation} publication(s) awaiting remote confirmation.`,
        link: "/workflows",
      },
    });
  }
  return report;
}

export const maintenanceProcessors = {
  "reservations.expire": async () => ({ released: await expireReservations() }),
  "jobs.detect-stuck": async () => detectStuckJobs(),
  "publishing.dispatch": async () => dispatchDuePublications(),
  "social.refresh-tokens": async () => refreshExpiringTokens(),
  "autopilot.run": async () => runAutopilot(),
  "analytics.dispatch": async () => dispatchCollection(),
  "analytics.insights": async () => computeInsights(),
  "metrics.publish": async () => publishMetrics(),
};

export const MAINTENANCE_SCHEDULES = [
  { id: "reservations-expire", jobName: "reservations.expire", everyMs: 5 * 60_000 },
  { id: "jobs-detect-stuck", jobName: "jobs.detect-stuck", everyMs: 2 * 60_000 },
  { id: "publishing-dispatch", jobName: "publishing.dispatch", everyMs: 60_000 },
  { id: "social-refresh-tokens", jobName: "social.refresh-tokens", everyMs: 6 * 60 * 60_000 },
  { id: "autopilot-run", jobName: "autopilot.run", everyMs: 30 * 60_000 },
  { id: "analytics-dispatch", jobName: "analytics.dispatch", everyMs: 60 * 60_000 },
  { id: "analytics-insights", jobName: "analytics.insights", everyMs: 6 * 60 * 60_000 },
  { id: "metrics-publish", jobName: "metrics.publish", everyMs: 60_000 },
] as const;
