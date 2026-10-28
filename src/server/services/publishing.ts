// Publishing: scheduling approved content on connected accounts, dispatching due posts and running
// them on the publishing workers. Rules:
//  - only approved content, only on approved connections, never mock media on a real account;
//  - per-account daily limits and minimum gaps (in the creator's time zone) are hard conflicts;
//  - a missing permission or unsupported format becomes NEEDS_MANUAL_ACTION with the export
//    package as the supported alternative;
//  - publishing is idempotent: platform progress (container ids) is stored before the next step, and
//    whenever the outcome of a publish call is unknown the platform is asked first (AWAITING_CONFIRMATION),
//    so a restart or timeout never posts twice.

import { Prisma, type ContentItem, type ContentStatus, type PublishingJob, type PublishingStatus, type SocialAccount } from "@prisma/client";
import { UnrecoverableError, type Job } from "bullmq";
import { z } from "zod";
import { FORMAT_SPECS } from "@/lib/content-pipeline";
import { can, type Permission } from "@/lib/rbac";
import { assertTransition, canTransition } from "@/lib/state-machines";
import { addDays, dayKey, weekdayOf, zonedToUtc } from "@/lib/time";
import { publishingScheduleSchema } from "@/lib/schemas/creator";
import { recordAudit, SYSTEM_ACTOR, type Actor } from "../audit";
import { findActivePause } from "../controls";
import { db } from "../db";
import { DomainError } from "../errors";
import { logger } from "../logger";
import { platformAdapter } from "../platforms/registry";
import { PlatformError, type PostMedia, type PublishFormat } from "../platforms/types";
import { enqueue } from "../queue/queues";
import { storage } from "../storage";
import { accountTokens, markTokenExpired } from "./social";
import type { ActingUser } from "./users";

const LIVE: PublishingStatus[] = ["SCHEDULED", "QUEUED", "PUBLISHING", "AWAITING_CONFIRMATION", "PUBLISHED", "FAILED", "NEEDS_MANUAL_ACTION"];
/** Jobs that occupy a slot on the account (count towards limits and gaps). */
const OCCUPYING: PublishingStatus[] = ["SCHEDULED", "QUEUED", "PUBLISHING", "AWAITING_CONFIRMATION", "PUBLISHED"];
const CONTAINER_POLL_MS = 10_000;
const RECONCILE_DELAY_MS = 30_000;
export const MAX_PUBLISH_ATTEMPTS = 4;

function require(by: ActingUser, permission: Permission) {
  if (!can(by.role, permission)) throw new DomainError("You do not have permission for this action.");
}

type Account = SocialAccount & { creator: { timezone: string; name: string; publishingSchedule: Prisma.JsonValue } };

async function loadAccount(id: string): Promise<Account> {
  const a = await db.socialAccount.findUnique({ where: { id }, include: { creator: { select: { timezone: true, name: true, publishingSchedule: true } } } });
  if (!a) throw new DomainError("Social account not found");
  return a;
}

const publishFormat = (item: Pick<ContentItem, "format">): PublishFormat => {
  if (!FORMAT_SPECS[item.format]) throw new DomainError(`${item.format.toLowerCase().replaceAll("_", " ")} cannot be published yet`);
  return item.format as PublishFormat;
};

/** Approved media in publishing order: the final video, or the approved image per shot. */
async function publishableMedia(item: ContentItem) {
  const spec = FORMAT_SPECS[item.format];
  if (spec?.kind === "video") {
    const final = await db.mediaAsset.findFirst({ where: { contentItemId: item.id, kind: "VIDEO", shotIndex: null, status: "APPROVED" }, orderBy: { createdAt: "desc" } });
    if (!final) throw new DomainError("The item has no approved final video");
    return [final];
  }
  const images = await db.mediaAsset.findMany({ where: { contentItemId: item.id, kind: "IMAGE", status: "APPROVED", shotIndex: { not: null } }, orderBy: { shotIndex: "asc" } });
  if (images.length === 0) throw new DomainError("The item has no approved images");
  return images;
}

export function captionFor(item: Pick<ContentItem, "caption" | "hashtags">) {
  const tags = item.hashtags.map((h) => `#${h}`).join(" ");
  return [item.caption.trim(), tags].filter(Boolean).join("\n\n");
}

export interface Conflict {
  kind: "daily_limit" | "too_close";
  message: string;
}

/** Hard scheduling conflicts on an account: daily limit and minimum gap, in the creator's time zone. */
export async function conflictsFor(account: Account, at: Date, excludeJobId?: string): Promise<Conflict[]> {
  const tz = account.creator.timezone;
  const policy = await db.autonomyPolicy.findFirst({ where: { scope: "GLOBAL" }, select: { maxPostsPerDay: true } });
  const limit = Math.min(account.maxPostsPerDay, policy?.maxPostsPerDay ?? Number.POSITIVE_INFINITY);
  const around = await db.publishingJob.findMany({
    where: {
      socialAccountId: account.id,
      status: { in: OCCUPYING },
      scheduledFor: { gte: new Date(at.getTime() - 36 * 3_600_000), lte: new Date(at.getTime() + 36 * 3_600_000) },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
    },
    select: { scheduledFor: true },
  });
  const conflicts: Conflict[] = [];
  const day = dayKey(at, tz);
  const sameDay = around.filter((j) => dayKey(j.scheduledFor, tz) === day).length;
  if (sameDay >= limit) conflicts.push({ kind: "daily_limit", message: `@${account.handle} already has ${sameDay} post(s) on ${day} (limit ${limit} per day)` });
  const gapMs = account.minGapMinutes * 60_000;
  const close = around.find((j) => Math.abs(j.scheduledFor.getTime() - at.getTime()) < gapMs);
  if (close) conflicts.push({ kind: "too_close", message: `Less than ${account.minGapMinutes} minutes from another post on @${account.handle}` });
  return conflicts;
}

/** Derives the item's publication status from its jobs. */
export async function syncItemStatus(itemId: string, tx: Prisma.TransactionClient | typeof db = db) {
  const item = await tx.contentItem.findUnique({ where: { id: itemId }, select: { status: true } });
  if (!item || !["APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED"].includes(item.status)) return;
  const jobs = await tx.publishingJob.findMany({ where: { contentItemId: itemId, status: { in: LIVE } }, select: { status: true } });
  const has = (...s: PublishingStatus[]) => jobs.some((j) => s.includes(j.status));
  let target: ContentStatus;
  if (jobs.length === 0) target = "APPROVED";
  else if (has("QUEUED", "PUBLISHING", "AWAITING_CONFIRMATION")) target = "PUBLISHING";
  // Waiting for a person (manual publishing, reconnect) still counts as planned.
  else if (has("SCHEDULED", "NEEDS_MANUAL_ACTION")) target = "SCHEDULED";
  else if (has("FAILED")) target = "FAILED";
  else target = "PUBLISHED";
  if (target === item.status) return;
  if (!canTransition("content", item.status, target)) {
    logger.warn({ itemId, from: item.status, to: target }, "publication status change not allowed");
    return;
  }
  await tx.contentItem.update({ where: { id: itemId }, data: { status: target } });
}

export const scheduleSchema = z.object({
  contentItemId: z.string().uuid(),
  socialAccountId: z.string().uuid(),
  scheduledFor: z.coerce.date(),
});

/** Schedules one approved item on one account (or records why it needs a person). */
export async function schedulePublication(by: ActingUser, raw: z.input<typeof scheduleSchema>, now = new Date()) {
  require(by, "publishing:schedule");
  const input = scheduleSchema.parse(raw);
  const item = await db.contentItem.findUnique({ where: { id: input.contentItemId } });
  if (!item) throw new DomainError("Content item not found");
  if (!["APPROVED", "SCHEDULED", "FAILED"].includes(item.status)) throw new DomainError("Only approved content can be scheduled");
  const account = await loadAccount(input.socialAccountId);
  if (account.creatorId !== item.creatorId) throw new DomainError("This account belongs to another creator");
  if (account.status === "PENDING_APPROVAL") throw new DomainError("The owner has not approved this account link yet");
  if (!["CONNECTED", "INSUFFICIENT_SCOPE"].includes(account.status)) throw new DomainError(`@${account.handle} is not connected (${account.status.toLowerCase().replaceAll("_", " ")})`);
  if (input.scheduledFor.getTime() < now.getTime() - 60_000) throw new DomainError("Choose a time in the future");
  const format = publishFormat(item);
  const media = await publishableMedia(item);
  if (media.some((m) => m.isMock) && !account.isMock) throw new DomainError("Mock media can never be published to a real account");

  const capability = (account.capabilities as Record<string, { ok?: boolean; reason?: string }> | null)?.[format];
  const manual = !capability?.ok ? (capability?.reason ?? `@${account.handle} cannot publish a ${format.toLowerCase().replaceAll("_", " ")} through the API`) : null;
  if (!manual) {
    const conflicts = await conflictsFor(account, input.scheduledFor);
    if (conflicts.length) throw new DomainError(conflicts.map((c) => c.message).join("; "));
  }

  if (await db.publishingJob.findFirst({ where: { contentItemId: item.id, socialAccountId: account.id, status: { not: "CANCELLED" } }, select: { id: true } }))
    throw new DomainError(`This item is already scheduled on @${account.handle}`);
  const n = (await db.publishingJob.count({ where: { contentItemId: item.id, socialAccountId: account.id } })) + 1;
  try {
    return await db.$transaction(async (tx) => {
      const job = await tx.publishingJob.create({
        data: {
          contentItemId: item.id,
          socialAccountId: account.id,
          platform: account.platform,
          scheduledFor: input.scheduledFor,
          status: manual ? "NEEDS_MANUAL_ACTION" : "SCHEDULED",
          idempotencyKey: `publish:${item.id}:${account.id}:${n}`,
          mediaAssetIds: media.map((m) => m.id),
          caption: captionFor(item),
          isMock: account.isMock,
          createdById: by.id,
          lastError: manual ? { kind: "insufficient_scope", message: `${manual}. Use the export package to publish by hand.` } : undefined,
        },
      });
      await syncItemStatus(item.id, tx);
      await recordAudit(by.actor, { action: "publishing.scheduled", entityType: "publishing_job", entityId: job.id, metadata: { contentItemId: item.id, account: account.handle, scheduledFor: input.scheduledFor.toISOString(), manual: !!manual, mock: account.isMock } }, tx);
      return job;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new DomainError(`This item is already scheduled on @${account.handle}`);
    throw err;
  }
}

/** Next free schedule slots (creator's weekly slots for the platform, in their time zone). */
export async function nextFreeSlots(account: Account, count: number, from: Date): Promise<Date[]> {
  const schedule = publishingScheduleSchema.safeParse(account.creator.publishingSchedule);
  const slots = (schedule.success ? schedule.data.slots : []).filter((s) => s.platform === account.platform);
  if (slots.length === 0) throw new DomainError(`${account.creator.name} has no ${account.platform.toLowerCase()} publishing slots; add them to the creator's schedule`);
  const tz = account.creator.timezone;
  const found: Date[] = [];
  let day = dayKey(from, tz);
  for (let i = 0; i < 120 && found.length < count; i++, day = addDays(day, 1)) {
    const wd = weekdayOf(day);
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    for (const slot of slots.filter((s) => s.weekday === wd).sort((a, b) => a.time.localeCompare(b.time))) {
      const [hh, mm] = slot.time.split(":").map(Number) as [number, number];
      const at = zonedToUtc(y, m, d, hh, mm, tz);
      if (at <= from) continue;
      // Slots already used in this run count as taken.
      const taken = found.some((f) => Math.abs(f.getTime() - at.getTime()) < account.minGapMinutes * 60_000 || dayKey(f, tz) === dayKey(at, tz) && found.filter((x) => dayKey(x, tz) === dayKey(at, tz)).length >= account.maxPostsPerDay);
      if (taken || (await conflictsFor(account, at)).length) continue;
      found.push(at);
      if (found.length === count) break;
    }
  }
  return found;
}

export const bulkScheduleSchema = z.object({
  socialAccountId: z.string().uuid(),
  contentItemIds: z.array(z.string().uuid()).min(1).max(50),
  from: z.coerce.date().optional(),
});

/** Spreads approved items over the creator's next free slots. */
export async function bulkSchedule(by: ActingUser, raw: z.input<typeof bulkScheduleSchema>, now = new Date()) {
  require(by, "publishing:schedule");
  const input = bulkScheduleSchema.parse(raw);
  const account = await loadAccount(input.socialAccountId);
  const slots = await nextFreeSlots(account, input.contentItemIds.length, input.from && input.from > now ? input.from : now);
  if (slots.length < input.contentItemIds.length) throw new DomainError(`Only ${slots.length} free slot(s) found in the next 120 days`);
  const results: { contentItemId: string; jobId?: string; scheduledFor?: Date; error?: string }[] = [];
  for (const [i, contentItemId] of input.contentItemIds.entries()) {
    try {
      const job = await schedulePublication(by, { contentItemId, socialAccountId: account.id, scheduledFor: slots[i]! }, now);
      results.push({ contentItemId, jobId: job.id, scheduledFor: job.scheduledFor });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      results.push({ contentItemId, error: err.message });
    }
  }
  return results;
}

async function loadJob(jobId: string) {
  const job = await db.publishingJob.findUnique({ where: { id: jobId } });
  if (!job) throw new DomainError("Publication not found");
  return job;
}

export async function reschedulePublication(by: ActingUser, jobId: string, when: Date, now = new Date()) {
  require(by, "publishing:schedule");
  const job = await loadJob(jobId);
  if (job.status !== "SCHEDULED") throw new DomainError("Only scheduled publications can be moved");
  if (when.getTime() < now.getTime() - 60_000) throw new DomainError("Choose a time in the future");
  const conflicts = await conflictsFor(await loadAccount(job.socialAccountId), when, job.id);
  if (conflicts.length) throw new DomainError(conflicts.map((c) => c.message).join("; "));
  const { count } = await db.publishingJob.updateMany({ where: { id: jobId, status: "SCHEDULED" }, data: { scheduledFor: when } });
  if (count !== 1) throw new DomainError("The publication changed meanwhile; reload and try again");
  await recordAudit(by.actor, { action: "publishing.rescheduled", entityType: "publishing_job", entityId: jobId, metadata: { from: job.scheduledFor.toISOString(), to: when.toISOString() } });
}

export async function cancelPublication(by: ActingUser, jobId: string) {
  require(by, "publishing:schedule");
  const job = await loadJob(jobId);
  assertTransition("publishing", job.status, "CANCELLED");
  await db.$transaction(async (tx) => {
    const { count } = await tx.publishingJob.updateMany({ where: { id: jobId, status: job.status }, data: { status: "CANCELLED" } });
    if (count !== 1) throw new DomainError("The publication changed meanwhile; reload and try again");
    await syncItemStatus(job.contentItemId, tx);
    await recordAudit(by.actor, { action: "publishing.cancelled", entityType: "publishing_job", entityId: jobId, metadata: { from: job.status } }, tx);
  });
}

/** Retry a failed publication or one that needed a person (e.g. after reconnecting). */
export async function retryPublication(by: ActingUser, jobId: string) {
  require(by, "publishing:schedule");
  const job = await loadJob(jobId);
  if (job.status !== "FAILED" && job.status !== "NEEDS_MANUAL_ACTION") throw new DomainError("Only failed publications can be retried");
  const account = await loadAccount(job.socialAccountId);
  if (account.status !== "CONNECTED") throw new DomainError(`@${account.handle} is not ready to publish (${account.status.toLowerCase().replaceAll("_", " ")})`);
  await db.$transaction(async (tx) => {
    assertTransition("publishing", job.status, "QUEUED");
    await tx.publishingJob.update({ where: { id: jobId }, data: { status: "QUEUED", attempt: 0, lastError: Prisma.DbNull, remoteState: {} } });
    await syncItemStatus(job.contentItemId, tx);
    await recordAudit(by.actor, { action: "publishing.retried", entityType: "publishing_job", entityId: jobId }, tx);
  });
  await queuePublish(jobId, `retry${Date.now()}`);
}

/** The person published it by hand (export package): record the post. */
export async function markPublishedManually(by: ActingUser, jobId: string, urlRaw: string) {
  require(by, "publishing:schedule");
  const job = await loadJob(jobId);
  if (job.status !== "NEEDS_MANUAL_ACTION") throw new DomainError("Only publications that need manual action can be marked as published");
  const url = z.string().url().refine((u) => u.startsWith("https://"), "Use the https link of the post").parse(urlRaw);
  await db.$transaction(async (tx) => {
    assertTransition("publishing", "NEEDS_MANUAL_ACTION", "PUBLISHED");
    await tx.publishingJob.update({ where: { id: jobId }, data: { status: "PUBLISHED", externalUrl: url, confirmedAt: new Date(), remoteState: { manual: true } } });
    await syncItemStatus(job.contentItemId, tx);
    await recordAudit(by.actor, { action: "publishing.marked_manual", entityType: "publishing_job", entityId: jobId, metadata: { url } }, tx);
  });
}

// ─────────────────────────────── Dispatch & worker ───────────────────────────────

export interface PublishJobData {
  jobId: string;
}

async function queuePublish(jobId: string, suffix: string, delayMs?: number) {
  await enqueue("publishing", "publish.run", { jobId } satisfies PublishJobData, { idempotencyKey: `publish-run:${jobId}:${suffix}`, ...(delayMs ? { delay: delayMs } : {}) });
}

/** Queues one due post unless it is paused; returns whether it was queued. */
async function dispatchOne(job: { id: string; contentItemId: string; contentItem: { creatorId: string; campaignId: string | null } }) {
  const pause = await findActivePause({ chain: "publishing", creatorId: job.contentItem.creatorId, campaignId: job.contentItem.campaignId });
  if (pause) return false; // stays scheduled; goes out when resumed
  const moved = await db.$transaction(async (tx) => {
    const { count } = await tx.publishingJob.updateMany({ where: { id: job.id, status: "SCHEDULED" }, data: { status: "QUEUED" } });
    if (count === 1) await syncItemStatus(job.contentItemId, tx);
    return count === 1;
  });
  if (moved) await queuePublish(job.id, "dispatch");
  return moved;
}

/** Every minute: queue due posts (unless paused) and re-check posts whose outcome is unknown. */
export async function dispatchDuePublications(now = new Date()) {
  const due = await db.publishingJob.findMany({
    // Seeded demo publications are illustrations, never sent anywhere.
    where: { status: "SCHEDULED", scheduledFor: { lte: now }, contentItem: { isDemo: false } },
    include: { contentItem: { select: { creatorId: true, campaignId: true } } },
    orderBy: { scheduledFor: "asc" },
    take: 200,
  });
  let queued = 0;
  for (const job of due) if (await dispatchOne(job)) queued++;
  const unknown = await db.publishingJob.findMany({ where: { status: "AWAITING_CONFIRMATION", updatedAt: { lte: new Date(now.getTime() - RECONCILE_DELAY_MS) } }, select: { id: true } });
  for (const j of unknown) await queuePublish(j.id, `reconcile${Math.floor(now.getTime() / 60_000)}`);
  return { queued, paused: due.length - queued, reconciling: unknown.length };
}

/** Schedules for now and queues immediately (same checks as scheduling). */
export async function publishNow(by: ActingUser, raw: { contentItemId: string; socialAccountId: string }) {
  const now = new Date();
  const job = await schedulePublication(by, { ...raw, scheduledFor: now }, now);
  if (job.status !== "SCHEDULED") return job;
  const item = await db.contentItem.findUniqueOrThrow({ where: { id: job.contentItemId }, select: { creatorId: true, campaignId: true } });
  if (!(await dispatchOne({ id: job.id, contentItemId: job.contentItemId, contentItem: item }))) throw new DomainError("Publishing is paused for this creator or campaign; the post stays scheduled");
  return job;
}

async function setJob(job: PublishingJob, to: PublishingStatus, data: Prisma.PublishingJobUpdateInput = {}) {
  assertTransition("publishing", job.status, to);
  return db.$transaction(async (tx) => {
    const { count } = await tx.publishingJob.updateMany({ where: { id: job.id, status: job.status }, data: { ...(data as Prisma.PublishingJobUpdateManyMutationInput), status: to } });
    if (count !== 1) return false;
    await syncItemStatus(job.contentItemId, tx);
    return true;
  });
}

async function mediaFor(job: PublishingJob): Promise<PostMedia[]> {
  const assets = await db.mediaAsset.findMany({ where: { id: { in: job.mediaAssetIds } } });
  const ordered = job.mediaAssetIds.map((id) => assets.find((a) => a.id === id)).filter((a) => !!a);
  if (ordered.length !== job.mediaAssetIds.length) throw new PlatformError("invalid", "Media of this publication no longer exist");
  // Platforms fetch media themselves: an hour-long signed URL (S3) is enough for container creation.
  return Promise.all(ordered.map(async (a) => ({ kind: a.kind === "VIDEO" ? ("video" as const) : ("image" as const), url: await storage().previewUrl(a.storageKey, 3600), mimeType: a.mimeType })));
}

async function needsPerson(job: PublishingJob, account: SocialAccount, err: PlatformError | DomainError) {
  const kind = err instanceof PlatformError ? err.kind : "invalid";
  if (kind === "auth") await markTokenExpired(account.id, err.message);
  if (kind === "insufficient_scope") await db.socialAccount.update({ where: { id: account.id }, data: { status: "INSUFFICIENT_SCOPE" } });
  const ok = await setJob(job, "NEEDS_MANUAL_ACTION", { lastError: { kind, message: `${err.message}. Reconnect or publish by hand with the export package.` } });
  if (ok)
    await db.notification.create({
      data: { severity: "WARNING", type: "publishing.needs_manual_action", title: `Publication on @${account.handle} needs you`, body: err.message.slice(0, 300), link: `/content/${job.contentItemId}` },
    });
  await recordAudit(SYSTEM_ACTOR, { action: "publishing.needs_manual_action", entityType: "publishing_job", entityId: job.id, metadata: { kind, message: err.message.slice(0, 200) } });
}

async function published(job: PublishingJob, result: { externalPostId: string; url: string | null }, actor: Actor = SYSTEM_ACTOR) {
  await setJob(job, "PUBLISHED", { externalPostId: result.externalPostId, externalUrl: result.url, confirmedAt: new Date(), lastError: Prisma.DbNull });
  await recordAudit(actor, { action: "publishing.published", entityType: "publishing_job", entityId: job.id, metadata: { externalPostId: result.externalPostId, mock: job.isMock } });
}

/**
 * Runs one step of a publication. A job is re-entered (container processing, retries, restarts);
 * every re-entry continues from the stored platform state instead of starting over.
 */
export async function runPublishJob(data: PublishJobData, attemptsMade: number, signal: AbortSignal) {
  let job = await db.publishingJob.findUnique({ where: { id: data.jobId } });
  if (!job || !["QUEUED", "PUBLISHING", "AWAITING_CONFIRMATION"].includes(job.status)) return { skipped: true };
  const account = await db.socialAccount.findUniqueOrThrow({ where: { id: job.socialAccountId } });
  const item = await db.contentItem.findUniqueOrThrow({ where: { id: job.contentItemId }, select: { creatorId: true, campaignId: true } });
  const remote = (job.remoteState ?? {}) as { publishId?: string; containerIds?: string[]; publishAttemptedAt?: string };

  try {
    if (account.status !== "CONNECTED") throw new PlatformError(account.status === "TOKEN_EXPIRED" ? "auth" : "insufficient_scope", `@${account.handle} is not ready to publish (${account.status.toLowerCase().replaceAll("_", " ")})`);
    if (job.isMock !== account.isMock) throw new DomainError("The publication and the account disagree about mock mode");
    const adapter = platformAdapter(account.platform, account.isMock);
    const { tokens, platformAccount } = await accountTokens(account);

    // Outcome unknown (timeout or crash after the publish call): ask the platform before anything else.
    if (job.status === "AWAITING_CONFIRMATION" || (job.status === "PUBLISHING" && remote.publishAttemptedAt)) {
      const found = remote.publishId ? await adapter.findPublished(tokens, platformAccount, { publishId: remote.publishId, caption: job.caption, since: job.submittedAt ?? job.createdAt }, signal) : null;
      if (found) {
        if (job.status === "PUBLISHING") {
          await setJob(job, "AWAITING_CONFIRMATION");
          job = (await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } }))!;
        }
        await published(job, found);
        return { published: found.externalPostId, verified: true };
      }
      // Verified as not published: safe to try again (through FAILED → QUEUED).
      if (job.status === "PUBLISHING") await setJob(job, "AWAITING_CONFIRMATION");
      job = (await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } }))!;
      await setJob(job, "FAILED", { lastError: { kind: "not_published", message: "Verified with the platform: not published; retrying" }, remoteState: { ...remote, publishAttemptedAt: undefined } as Prisma.InputJsonValue });
      job = (await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } }))!;
      if (job.attempt >= MAX_PUBLISH_ATTEMPTS) return { failed: true };
      await setJob(job, "QUEUED");
      await queuePublish(job.id, `after-verify${job.attempt}`, CONTAINER_POLL_MS);
      return { requeued: true };
    }

    if (job.status === "QUEUED") {
      const pause = await findActivePause({ chain: "publishing", creatorId: item.creatorId, campaignId: item.campaignId });
      if (pause) {
        await setJob(job, "SCHEDULED");
        return { paused: pause.reason };
      }
      await setJob(job, "PUBLISHING", { attempt: { increment: 1 }, submittedAt: job.submittedAt ?? new Date() });
      job = (await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } }))!;
    }

    let state = remote;
    if (!state.publishId) {
      const created = await adapter.createContainers(tokens, platformAccount, { format: (await db.contentItem.findUniqueOrThrow({ where: { id: job.contentItemId } })).format as PublishFormat, media: await mediaFor(job), caption: job.caption }, signal);
      state = { publishId: created.publishId, containerIds: created.containerIds };
      await db.publishingJob.update({ where: { id: job.id }, data: { remoteState: state as Prisma.InputJsonValue } });
    }
    const ready = await adapter.containerStatus(tokens, state.publishId!, signal);
    if (ready.state === "pending") {
      await queuePublish(job.id, `container${Date.now()}`, CONTAINER_POLL_MS);
      return { processing: true };
    }
    if (ready.state === "failed") throw new PlatformError("invalid", `The platform could not process the media: ${ready.reason}`);

    // Mark the attempt before calling publish: a crash after this point is verified, never repeated blindly.
    await db.publishingJob.update({ where: { id: job.id }, data: { remoteState: { ...state, publishAttemptedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
    const result = await adapter.publish(tokens, platformAccount, state.publishId!, signal);
    await published(job, result);
    return { published: result.externalPostId };
  } catch (err) {
    job = (await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } }))!;
    if (err instanceof PlatformError && err.kind === "timeout" && job.status === "PUBLISHING") {
      await setJob(job, "AWAITING_CONFIRMATION", { lastError: { kind: "timeout", message: err.message } });
      await queuePublish(job.id, `reconcile-now${job.attempt}`, RECONCILE_DELAY_MS);
      return { awaitingConfirmation: true };
    }
    if ((err instanceof PlatformError && err.needsHuman) || err instanceof DomainError) {
      if (canTransition("publishing", job.status, "NEEDS_MANUAL_ACTION")) await needsPerson(job, account, err as PlatformError | DomainError);
      else if (job.status === "PUBLISHING") {
        await setJob(job, "FAILED", { lastError: { kind: err instanceof PlatformError ? err.kind : "invalid", message: err.message } });
        const failed = (await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } }))!;
        await needsPerson(failed, account, err as PlatformError | DomainError);
      }
      throw new UnrecoverableError(err.message);
    }
    // Retryable: the job goes back to the queue (FAILED → QUEUED) until attempts run out.
    const message = err instanceof PlatformError ? err.message : "Unexpected error while publishing";
    if (!(err instanceof PlatformError)) logger.error({ jobId: job.id, err: (err as Error).message }, "publishing failed");
    if (job.status === "PUBLISHING") await setJob(job, "FAILED", { lastError: { kind: err instanceof PlatformError ? err.kind : "internal", message } });
    const failed = (await db.publishingJob.findUniqueOrThrow({ where: { id: job.id } }))!;
    if (failed.status === "FAILED" && failed.attempt < MAX_PUBLISH_ATTEMPTS && attemptsMade + 1 < MAX_PUBLISH_ATTEMPTS) {
      await setJob(failed, "QUEUED");
      const delay = err instanceof PlatformError && err.options.retryAfterMs ? err.options.retryAfterMs : 30_000 * 2 ** failed.attempt;
      await queuePublish(job.id, `retry${failed.attempt}`, delay);
      return { retrying: true };
    }
    await db.notification.create({ data: { severity: "WARNING", type: "publishing.failed", title: `Publication on @${account.handle} failed`, body: message.slice(0, 300), link: `/content/${job.contentItemId}` } });
    throw new UnrecoverableError(message);
  }
}

export const publishingProcessors = {
  "publish.run": (job: Job<PublishJobData>, signal: AbortSignal) => runPublishJob(job.data, job.attemptsMade, signal),
};
