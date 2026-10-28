// Content Factory: what operators do with content items. Creating single items and batches,
// starting and resuming production, regenerating a shot, reviewing media and approving content.
// The pipeline itself (jobs, chaining, cost) lives in content-pipeline.ts.

import type { ContentFormat, ContentStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { FORMAT_SPECS, isProducible } from "@/lib/content-pipeline";
import { can, type Permission } from "@/lib/rbac";
import { assertTransition } from "@/lib/state-machines";
import { recordAudit } from "../audit";
import { db } from "../db";
import { DomainError } from "../errors";
import { ACTIVE_JOB_STATUSES, finalVideo, formatSpec, resumeItem, scheduleNextStep, scheduleTakes, shotList } from "./content-pipeline";
import type { ActingUser } from "./users";

function require(by: ActingUser, permission: Permission) {
  if (!can(by.role, permission)) throw new DomainError("You do not have permission for this action.");
}

const CONTENT_FORMATS = ["IMAGE_POST", "CAROUSEL", "STORY", "SHORT_VIDEO", "TALKING_HEAD"] as const satisfies readonly ContentFormat[];
const STARTABLE: ContentStatus[] = ["IDEA", "BRIEFED", "SCRIPTED", "PROMPTED"];
const REVIEWABLE: ContentStatus[] = ["QC_REVIEW", "READY"];

const target = {
  creatorId: z.string().uuid("Choose a creator"),
  campaignId: z.string().uuid().nullable().default(null),
  format: z.enum(CONTENT_FORMATS),
  shots: z.coerce.number().int().min(1).max(10).optional(),
};

export const createContentSchema = z.object({
  ...target,
  title: z.string().trim().min(3, "Give the item a title").max(120),
  idea: z.string().trim().max(2000).default(""),
  produce: z.boolean().default(false),
});

export const createBatchSchema = z.object({
  ...target,
  name: z.string().trim().min(3, "Name the batch").max(80),
  ideas: z
    .array(z.string().trim().min(3).max(300))
    .min(1, "Add at least one idea")
    .max(20, "At most 20 ideas per batch"),
  produce: z.boolean().default(false),
});

async function assertTarget(input: { creatorId: string; campaignId: string | null; format: ContentFormat; shots?: number }) {
  const creator = await db.creator.findUnique({ where: { id: input.creatorId }, select: { status: true } });
  if (!creator) throw new DomainError("Creator not found");
  if (creator.status === "ARCHIVED") throw new DomainError("The creator is archived");
  if (input.campaignId) {
    const link = await db.campaignCreator.findUnique({ where: { campaignId_creatorId: { campaignId: input.campaignId, creatorId: input.creatorId } }, include: { campaign: { select: { status: true } } } });
    if (!link) throw new DomainError("This creator is not part of the campaign");
    if (["COMPLETED", "ARCHIVED"].includes(link.campaign.status)) throw new DomainError("The campaign is closed");
  }
  const spec = FORMAT_SPECS[input.format];
  if (spec && input.shots !== undefined && (input.shots < spec.minShots || input.shots > spec.maxShots))
    throw new DomainError(`A ${spec.label.toLowerCase()} has ${spec.minShots === spec.maxShots ? spec.minShots : `${spec.minShots}–${spec.maxShots}`} ${spec.kind === "video" ? "scene(s)" : "image(s)"}`);
}

async function maxGenerations() {
  const policy = await db.autonomyPolicy.findFirst({ where: { scope: "GLOBAL" }, select: { maxGenerationsPerItem: true } });
  return policy?.maxGenerationsPerItem ?? 6;
}

function initialScript(format: ContentFormat, shots?: number): Prisma.InputJsonValue {
  const spec = FORMAT_SPECS[format];
  return spec ? { requestedShots: shots ?? spec.defaultShots } : {};
}

export async function createContent(by: ActingUser, raw: z.input<typeof createContentSchema>) {
  require(by, "content:edit");
  const input = createContentSchema.parse(raw);
  await assertTarget(input);
  const item = await db.$transaction(async (tx) => {
    const created = await tx.contentItem.create({
      data: {
        creatorId: input.creatorId,
        campaignId: input.campaignId,
        title: input.title,
        idea: input.idea,
        format: input.format,
        script: initialScript(input.format, input.shots),
        maxGenerations: await maxGenerations(),
        createdById: by.id,
      },
    });
    await recordAudit(by.actor, { action: "content.created", entityType: "content_item", entityId: created.id, metadata: { format: input.format, creatorId: input.creatorId } }, tx);
    return created;
  });
  if (input.produce) await startProduction(by, item.id);
  return item;
}

export async function createBatch(by: ActingUser, raw: z.input<typeof createBatchSchema>) {
  require(by, "content:edit");
  const input = createBatchSchema.parse(raw);
  await assertTarget(input);
  const limit = await maxGenerations();
  const batch = await db.$transaction(async (tx) => {
    const b = await tx.contentBatch.create({ data: { name: input.name, createdById: by.id } });
    await tx.contentItem.createMany({
      data: input.ideas.map((idea) => ({
        creatorId: input.creatorId,
        campaignId: input.campaignId,
        batchId: b.id,
        title: idea.length > 80 ? `${idea.slice(0, 77)}…` : idea,
        idea,
        format: input.format,
        script: initialScript(input.format, input.shots),
        maxGenerations: limit,
        createdById: by.id,
      })),
    });
    await recordAudit(by.actor, { action: "content.batch_created", entityType: "content_batch", entityId: b.id, metadata: { items: input.ideas.length, format: input.format, creatorId: input.creatorId } }, tx);
    return b;
  });
  if (input.produce) await produceBatch(by, batch.id);
  return batch;
}

/** Starts (or continues) production of every item in the batch that can run; returns how many started. */
export async function produceBatch(by: ActingUser, batchId: string) {
  require(by, "generation:run");
  const items = await db.contentItem.findMany({ where: { batchId, status: { in: STARTABLE } }, select: { id: true } });
  let started = 0;
  const errors: string[] = [];
  for (const i of items) {
    try {
      await startProduction(by, i.id);
      started++;
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      errors.push(err.message);
    }
  }
  if (started === 0 && errors.length) throw new DomainError(errors[0]!);
  return { started, skipped: items.length - started };
}

async function loadForAction(itemId: string) {
  const item = await db.contentItem.findUnique({ where: { id: itemId }, include: { creator: { select: { status: true, name: true } } } });
  if (!item) throw new DomainError("Content item not found");
  return item;
}

async function assertIdle(itemId: string) {
  const active = await db.generationJob.count({ where: { contentItemId: itemId, status: { in: [...ACTIVE_JOB_STATUSES] } } });
  if (active > 0) throw new DomainError("This item is already in production");
}

/** Runs the pipeline from wherever the item is up to quality control. */
export async function startProduction(by: ActingUser, itemId: string) {
  require(by, "generation:run");
  const item = await loadForAction(itemId);
  if (!isProducible(item.format)) formatSpec(item); // throws the explanation
  if (!STARTABLE.includes(item.status)) throw new DomainError(`An item in status ${item.status.toLowerCase().replaceAll("_", " ")} cannot be started`);
  if (item.creator.status !== "ACTIVE") throw new DomainError(`${item.creator.name} is ${item.creator.status.toLowerCase()}; activate the creator first`);
  const profile = await db.characterProfile.findFirst({ where: { creatorId: item.creatorId, status: "APPROVED" }, select: { id: true } });
  if (!profile) throw new DomainError("The creator has no approved character profile (Character Studio)");
  if (item.failedStep) throw new DomainError("A step failed; use Resume");
  await assertIdle(itemId);
  await recordAudit(by.actor, { action: "content.production_started", entityType: "content_item", entityId: itemId, metadata: { from: item.status } });
  await scheduleNextStep(itemId);
}

export async function resumeProduction(by: ActingUser, itemId: string) {
  require(by, "generation:run");
  const item = await loadForAction(itemId);
  if (item.creator.status !== "ACTIVE") throw new DomainError(`${item.creator.name} is ${item.creator.status.toLowerCase()}; activate the creator first`);
  await assertIdle(itemId);
  await recordAudit(by.actor, { action: "content.production_resumed", entityType: "content_item", entityId: itemId, metadata: { step: item.failedStep } });
  await resumeItem(itemId);
}

/**
 * New take for one shot (photo) or scene (video clip). Counts against the item's generation limit;
 * the other shots keep their takes, and assembly and QC run again afterwards.
 */
export async function regenerateShot(by: ActingUser, itemId: string, shot: number) {
  require(by, "generation:run");
  const item = await loadForAction(itemId);
  if (!REVIEWABLE.includes(item.status)) throw new DomainError("Shots can be regenerated during review only");
  if (item.creator.status !== "ACTIVE") throw new DomainError(`${item.creator.name} is ${item.creator.status.toLowerCase()}; activate the creator first`);
  if (!shotList(item)[shot]) throw new DomainError("Unknown shot");
  await assertIdle(itemId);
  await scheduleTakes(itemId, [shot], item.status);
  await recordAudit(by.actor, { action: "content.shot_regenerated", entityType: "content_item", entityId: itemId, metadata: { shot } });
}

async function loadReviewAsset(assetId: string) {
  const asset = await db.mediaAsset.findUnique({ where: { id: assetId }, include: { contentItem: { select: { id: true, status: true } } } });
  if (!asset) throw new DomainError("Media asset not found");
  return asset;
}

/** Approving a take makes it the one used for its shot; a previously approved take is rejected. */
export async function approveMedia(by: ActingUser, assetId: string) {
  require(by, "content:approve");
  const asset = await loadReviewAsset(assetId);
  if (asset.source === "UPLOADED") throw new DomainError("Reference uploads are reviewed in Character Studio");
  if (asset.contentItem && !REVIEWABLE.includes(asset.contentItem.status)) throw new DomainError("The content item is not in review");
  assertTransition("media", asset.status, "APPROVED");
  await db.$transaction(async (tx) => {
    if (asset.contentItemId && asset.shotIndex !== null) {
      const previous = await tx.mediaAsset.findMany({ where: { contentItemId: asset.contentItemId, shotIndex: asset.shotIndex, kind: asset.kind, status: "APPROVED", id: { not: asset.id } }, select: { id: true } });
      for (const p of previous) {
        assertTransition("media", "APPROVED", "REJECTED");
        await tx.mediaAsset.update({ where: { id: p.id }, data: { status: "REJECTED" } });
      }
    }
    await tx.mediaAsset.update({ where: { id: asset.id }, data: { status: "APPROVED" } });
    await tx.approval.create({ data: { subjectType: "MEDIA_ASSET", subjectId: asset.id, decision: "APPROVED", requestedBy: "SYSTEM", decidedById: by.id, decidedAt: new Date() } });
    await recordAudit(by.actor, { action: "media.approved", entityType: "media_asset", entityId: asset.id, metadata: { contentItemId: asset.contentItemId, shot: asset.shotIndex, isMock: asset.isMock } }, tx);
  });
}

export async function rejectMedia(by: ActingUser, assetId: string, reason: string) {
  require(by, "content:approve");
  const asset = await loadReviewAsset(assetId);
  if (asset.source === "UPLOADED") throw new DomainError("Reference uploads are reviewed in Character Studio");
  assertTransition("media", asset.status, "REJECTED");
  const why = z.string().trim().max(500).parse(reason);
  await db.$transaction(async (tx) => {
    await tx.mediaAsset.update({ where: { id: asset.id }, data: { status: "REJECTED" } });
    await tx.approval.create({ data: { subjectType: "MEDIA_ASSET", subjectId: asset.id, decision: "REJECTED", requestedBy: "SYSTEM", decidedById: by.id, decidedAt: new Date(), reason: why || null } });
    await recordAudit(by.actor, { action: "media.rejected", entityType: "media_asset", entityId: asset.id, metadata: { contentItemId: asset.contentItemId, shot: asset.shotIndex, reason: why } }, tx);
  });
}

/**
 * Approves the content item. Every shot needs an approved take; shots without one get their latest
 * successful take approved. Approving despite failed quality control needs a written reason.
 */
export async function approveContent(by: ActingUser, itemId: string, overrideReason = "") {
  require(by, "content:approve");
  const item = await loadForAction(itemId);
  if (!REVIEWABLE.includes(item.status)) throw new DomainError("Only items in review can be approved");
  const reason = z.string().trim().max(500).parse(overrideReason);
  if (item.status === "QC_REVIEW" && reason.length < 5) throw new DomainError("Quality control did not pass: explain why you approve anyway");
  await assertIdle(itemId);
  const shots = shotList(item);
  const video = formatSpec(item).kind === "video";
  const assets = await db.mediaAsset.findMany({ where: { contentItemId: itemId, source: "GENERATED", kind: video ? "VIDEO" : "IMAGE", shotIndex: { not: null } }, orderBy: { createdAt: "desc" } });
  const picks: string[] = [];
  let sceneClips: string[] = [];
  if (video) {
    // What gets published is the assembled video, so each scene's approved clip is the one in it.
    const final = await finalVideo(itemId);
    if (!final) throw new DomainError("There is no assembled video yet");
    const used = ((final.paramsSnapshot as { scenes?: { clip: string }[] } | null)?.scenes ?? []).map((x) => x.clip);
    for (let i = 0; i < shots.length; i++) {
      const approved = assets.find((a) => a.shotIndex === i && a.status === "APPROVED");
      if (approved && approved.id !== used[i]) throw new DomainError(`The approved clip of scene ${i + 1} is not in the assembled video; regenerate the scene to assemble again`);
      if (!approved && used[i]) {
        if (assets.find((a) => a.id === used[i])?.status === "REJECTED") throw new DomainError(`The clip of scene ${i + 1} in the assembled video was rejected; regenerate the scene`);
        picks.push(used[i]!);
      }
      if (!approved && !used[i]) throw new DomainError(`Scene ${i + 1} has no clip to approve`);
    }
    if (final.status === "PENDING_REVIEW") picks.push(final.id);
    sceneClips = used;
  } else {
    for (let i = 0; i < shots.length; i++) {
      const forShot = assets.filter((a) => a.shotIndex === i);
      if (forShot.some((a) => a.status === "APPROVED")) continue;
      const latest = forShot.find((a) => a.status === "PENDING_REVIEW");
      if (!latest) throw new DomainError(`Shot ${i + 1} has no image to approve; regenerate it`);
      picks.push(latest.id);
    }
  }
  await db.$transaction(async (tx) => {
    for (const id of picks) {
      await tx.mediaAsset.update({ where: { id }, data: { status: "APPROVED" } });
      await recordAudit(by.actor, { action: "media.approved", entityType: "media_asset", entityId: id, metadata: { contentItemId: itemId, via: "content_approval" } }, tx);
    }
    for (const [position, clip] of sceneClips.entries()) await tx.videoScene.updateMany({ where: { contentItemId: itemId, position }, data: { approvedAssetId: clip } });
    if (item.status === "QC_REVIEW") assertTransition("content", "QC_REVIEW", "READY");
    assertTransition("content", "READY", "APPROVED");
    const { count } = await tx.contentItem.updateMany({ where: { id: itemId, status: item.status }, data: { status: "APPROVED" } });
    if (count !== 1) throw new DomainError("The item changed meanwhile; reload and try again");
    await tx.approval.create({
      data: { subjectType: "CONTENT_ITEM", subjectId: itemId, decision: "APPROVED", requestedBy: "SYSTEM", decidedById: by.id, decidedAt: new Date(), reason: reason || null, payload: { qcOverride: item.status === "QC_REVIEW" } },
    });
    await recordAudit(by.actor, { action: "content.approved", entityType: "content_item", entityId: itemId, metadata: { qcOverride: item.status === "QC_REVIEW", reason } }, tx);
  });
}

export async function rejectContent(by: ActingUser, itemId: string, reason: string) {
  require(by, "content:approve");
  const item = await loadForAction(itemId);
  assertTransition("content", item.status, "REJECTED");
  const why = z.string().trim().min(3, "Give a reason").max(500).parse(reason);
  await assertIdle(itemId);
  await db.$transaction(async (tx) => {
    await tx.contentItem.update({ where: { id: itemId }, data: { status: "REJECTED" } });
    await tx.approval.create({ data: { subjectType: "CONTENT_ITEM", subjectId: itemId, decision: "REJECTED", requestedBy: "SYSTEM", decidedById: by.id, decidedAt: new Date(), reason: why } });
    await recordAudit(by.actor, { action: "content.rejected", entityType: "content_item", entityId: itemId, metadata: { reason: why, from: item.status } }, tx);
  });
}

export async function archiveContent(by: ActingUser, itemId: string) {
  require(by, "content:edit");
  const item = await loadForAction(itemId);
  assertTransition("content", item.status, "ARCHIVED");
  await assertIdle(itemId);
  await db.$transaction(async (tx) => {
    await tx.contentItem.update({ where: { id: itemId }, data: { status: "ARCHIVED" } });
    await recordAudit(by.actor, { action: "content.archived", entityType: "content_item", entityId: itemId, metadata: { from: item.status } }, tx);
  });
}

// ─────────────────────────────── Cost reporting ───────────────────────────────

export interface UsableAssetCost {
  /** Real (non-mock) spend attributed to content items in the window. */
  spentMicros: bigint;
  estimatedMicros: bigint;
  usableAssets: number;
  /** null when nothing usable was produced (cost per asset is undefined, not zero). */
  perAssetMicros: bigint | null;
}

/**
 * Cost per usable asset: everything spent on content (including rejected takes, failed attempts and
 * QC) divided by the approved generated assets. Mock work costs nothing and is not booked.
 */
export async function costPerUsableAsset(where: { since?: Date | null; creatorId?: string | null; campaignId?: string | null; contentItemId?: string | null } = {}): Promise<UsableAssetCost> {
  const items: Prisma.ContentItemWhereInput = {
    ...(where.creatorId ? { creatorId: where.creatorId } : {}),
    ...(where.campaignId ? { campaignId: where.campaignId } : {}),
    ...(where.contentItemId ? { id: where.contentItemId } : {}),
  };
  const [spent, estimated, usable] = await Promise.all([
    db.costLedger.aggregate({ where: { contentItemId: { not: null }, contentItem: items, isMock: false, ...(where.since ? { occurredAt: { gte: where.since } } : {}) }, _sum: { amountMicros: true } }),
    db.costLedger.aggregate({ where: { contentItemId: { not: null }, contentItem: items, isMock: false, basis: "ESTIMATED", ...(where.since ? { occurredAt: { gte: where.since } } : {}) }, _sum: { amountMicros: true } }),
    db.mediaAsset.count({ where: { contentItemId: { not: null }, contentItem: items, source: "GENERATED", status: "APPROVED", ...(where.since ? { createdAt: { gte: where.since } } : {}) } }),
  ]);
  const spentMicros = spent._sum.amountMicros ?? 0n;
  return { spentMicros, estimatedMicros: estimated._sum.amountMicros ?? 0n, usableAssets: usable, perAssetMicros: usable > 0 ? spentMicros / BigInt(usable) : null };
}
