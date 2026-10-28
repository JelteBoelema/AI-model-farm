// Creator lifecycle. Every mutation validates input, checks the acting user's role (defence in
// depth on top of the server-action permission), uses compare-and-set status updates and audits.

import type { AutonomyMode, BudgetPeriod, CreatorStatus, Prisma } from "@prisma/client";
import { can, type Permission } from "@/lib/rbac";
import {
  AUTONOMY_RANK,
  characterDraftSchema,
  creatorProfileSchema,
  type CharacterDraftInput,
  type CreatorProfileInput,
} from "@/lib/schemas/creator";
import { assertTransition } from "@/lib/state-machines";
import { db } from "../db";
import { recordAudit } from "../audit";
import { DomainError } from "../errors";
import type { ActingUser } from "./users";

export const LIVE_PUBLISHING_STATUSES = ["SCHEDULED", "QUEUED", "PUBLISHING", "AWAITING_CONFIRMATION"] as const;

function require(by: ActingUser, permission: Permission) {
  if (!can(by.role, permission)) throw new DomainError("You do not have permission for this action.");
}

/** JSON with sorted keys: jsonb does not preserve key order, so plain JSON.stringify misreports changes. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base || "creator";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set(
    (await db.creator.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((c) => c.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function profileData(input: CreatorProfileInput) {
  return {
    name: input.name,
    niche: input.niche,
    targetAudience: input.targetAudience,
    language: input.language,
    targetRegions: input.targetRegions,
    personality: input.personality,
    toneOfVoice: input.toneOfVoice,
    backstory: input.backstory,
    contentPillars: input.contentPillars as Prisma.InputJsonValue,
    contentFormats: input.contentFormats,
    timezone: input.timezone,
    publishingSchedule: input.publishingSchedule as Prisma.InputJsonValue,
  };
}

/** Creates a DRAFT creator; an optional character proposal becomes draft character version 1. */
export async function createCreator(
  by: ActingUser,
  raw: CreatorProfileInput,
  meta: { proposalSource?: string; character?: CharacterDraftInput } = {},
) {
  require(by, "creators:edit");
  const input = creatorProfileSchema.parse(raw);
  const character = meta.character ? characterDraftSchema.parse(meta.character) : null;
  const slug = await uniqueSlug(input.name);
  return db.$transaction(async (tx) => {
    const creator = await tx.creator.create({
      data: { ...profileData(input), slug, status: "DRAFT", createdById: by.id },
      select: { id: true, slug: true },
    });
    if (character) {
      await tx.characterProfile.create({
        data: {
          creatorId: creator.id,
          version: 1,
          status: "DRAFT",
          appearance: character.appearance as Prisma.InputJsonValue,
          identityPrompt: character.identityPrompt,
          negativePrompt: character.negativePrompt,
          consistencyStrategy: character.consistencyStrategy as Prisma.InputJsonValue,
        },
      });
    }
    await recordAudit(
      by.actor,
      { action: "creator.created", entityType: "creator", entityId: creator.id, metadata: { slug, proposalSource: meta.proposalSource ?? "manual" } },
      tx,
    );
    return creator;
  });
}

export async function updateCreator(by: ActingUser, creatorId: string, raw: CreatorProfileInput) {
  require(by, "creators:edit");
  const input = creatorProfileSchema.parse(raw);
  const current = await db.creator.findUnique({ where: { id: creatorId } });
  if (!current) throw new DomainError("Creator not found");
  if (current.status === "ARCHIVED") throw new DomainError("Archived creators cannot be edited");

  const data = profileData(input);
  const changed = (Object.keys(data) as (keyof typeof data)[]).filter(
    (k) => stableJson(data[k]) !== stableJson(current[k as keyof typeof current]),
  );
  if (changed.length === 0) return;
  await db.$transaction(async (tx) => {
    const res = await tx.creator.updateMany({ where: { id: creatorId, status: { not: "ARCHIVED" } }, data });
    if (res.count !== 1) throw new DomainError("Creator was archived meanwhile");
    await recordAudit(by.actor, { action: "creator.updated", entityType: "creator", entityId: creatorId, metadata: { fields: changed } }, tx);
  });
}

export type StatusAction = "activate" | "pause" | "resume" | "archive";

const TARGET: Record<StatusAction, CreatorStatus> = { activate: "ACTIVE", pause: "PAUSED", resume: "ACTIVE", archive: "ARCHIVED" };
// Pausing is a brake every operator may pull; resuming mirrors the control-switch rule (admin).
const PERMISSION: Record<StatusAction, Permission> = { activate: "creators:edit", pause: "controls:pause", resume: "controls:resume", archive: "creators:edit" };
const AUDIT_ACTION: Record<StatusAction, string> = { activate: "creator.activated", pause: "creator.paused", resume: "creator.resumed", archive: "creator.archived" };

export async function changeCreatorStatus(by: ActingUser, creatorId: string, action: StatusAction, reason?: string) {
  require(by, PERMISSION[action]);
  const creator = await db.creator.findUnique({ where: { id: creatorId }, select: { status: true } });
  if (!creator) throw new DomainError("Creator not found");
  const to = TARGET[action];
  if ((action === "activate" && creator.status !== "DRAFT") || (action === "resume" && creator.status !== "PAUSED"))
    throw new DomainError(`Cannot ${action} a creator that is ${creator.status.toLowerCase()}`);
  assertTransition("creator", creator.status, to);

  if (action === "activate") {
    const approved = await db.characterProfile.count({ where: { creatorId, status: "APPROVED" } });
    if (approved === 0) throw new DomainError("Approve a character profile before activating this creator");
  }
  if (action === "archive") {
    const live = await db.publishingJob.count({ where: { contentItem: { creatorId }, status: { in: [...LIVE_PUBLISHING_STATUSES] } } });
    if (live > 0) throw new DomainError(`Cancel or finish ${live} scheduled publication(s) before archiving`);
  }

  await db.$transaction(async (tx) => {
    const res = await tx.creator.updateMany({
      where: { id: creatorId, status: creator.status },
      data: { status: to, archivedAt: to === "ARCHIVED" ? new Date() : undefined },
    });
    if (res.count !== 1) throw new DomainError("The creator changed meanwhile; reload and try again");
    await recordAudit(
      by.actor,
      { action: AUDIT_ACTION[action], entityType: "creator", entityId: creatorId, metadata: { from: creator.status, to, reason: reason?.trim() || undefined } },
      tx,
    );
  });
}

/**
 * Copies settings into a new DRAFT creator. The visual identity, social accounts and content are not
 * copied: a duplicate is a template for a new, distinct character.
 */
export async function duplicateCreator(by: ActingUser, creatorId: string) {
  require(by, "creators:edit");
  const src = await db.creator.findUnique({ where: { id: creatorId } });
  if (!src) throw new DomainError("Creator not found");
  const budgets = await db.budgetPolicy.findMany({ where: { scope: "CREATOR", targetId: creatorId } });
  const name = `${src.name} (copy)`.slice(0, 60);
  const slug = await uniqueSlug(name);
  return db.$transaction(async (tx) => {
    const copy = await tx.creator.create({
      data: {
        slug,
        name,
        niche: src.niche,
        targetAudience: src.targetAudience,
        language: src.language,
        targetRegions: src.targetRegions,
        personality: src.personality,
        toneOfVoice: src.toneOfVoice,
        backstory: src.backstory,
        contentPillars: src.contentPillars as Prisma.InputJsonValue,
        contentFormats: src.contentFormats,
        promptSettings: src.promptSettings as Prisma.InputJsonValue,
        publishingSchedule: src.publishingSchedule as Prisma.InputJsonValue,
        timezone: src.timezone,
        autonomyMode: src.autonomyMode,
        status: "DRAFT",
        createdById: by.id,
      },
      select: { id: true, slug: true },
    });
    // Budget limits only restrict spending, so copying them is always safe.
    for (const b of budgets) {
      await tx.budgetPolicy.create({
        data: { scope: "CREATOR", targetId: copy.id, period: b.period, limitMicros: b.limitMicros, warnAtPercent: b.warnAtPercent, autoPause: b.autoPause, updatedById: by.id },
      });
    }
    await recordAudit(by.actor, { action: "creator.duplicated", entityType: "creator", entityId: copy.id, metadata: { sourceId: creatorId } }, tx);
    return copy;
  });
}

export async function setAutonomyMode(by: ActingUser, creatorId: string, mode: AutonomyMode) {
  require(by, "creators:edit");
  const creator = await db.creator.findUnique({ where: { id: creatorId }, select: { autonomyMode: true, status: true } });
  if (!creator) throw new DomainError("Creator not found");
  if (creator.status === "ARCHIVED") throw new DomainError("Archived creators cannot be changed");
  if (creator.autonomyMode === mode) return;
  if (AUTONOMY_RANK[mode] > AUTONOMY_RANK[creator.autonomyMode]) require(by, "autonomy:raise");
  await db.$transaction(async (tx) => {
    await tx.creator.update({ where: { id: creatorId }, data: { autonomyMode: mode } });
    await recordAudit(by.actor, { action: "creator.autonomy_changed", entityType: "creator", entityId: creatorId, metadata: { from: creator.autonomyMode, to: mode } }, tx);
  });
}

/**
 * Hard spending limit for one creator. Adding or lowering a limit restricts spending (admin);
 * raising or removing one increases what may be spent (owner only).
 */
export async function setCreatorBudget(by: ActingUser, creatorId: string, period: BudgetPeriod, limitMicros: bigint | null) {
  if (limitMicros !== null && limitMicros < 0n) throw new DomainError("A budget cannot be negative");
  const creator = await db.creator.findUnique({ where: { id: creatorId }, select: { id: true } });
  if (!creator) throw new DomainError("Creator not found");
  const existing = await db.budgetPolicy.findFirst({ where: { scope: "CREATOR", targetId: creatorId, period } });
  const from = existing?.limitMicros ?? null;
  if (from === limitMicros) return;
  const raises = limitMicros === null || (from !== null && limitMicros > from);
  require(by, raises ? "budgets:raise" : "budgets:lower");

  await db.$transaction(async (tx) => {
    if (limitMicros === null) await tx.budgetPolicy.delete({ where: { id: existing!.id } });
    else if (existing) await tx.budgetPolicy.update({ where: { id: existing.id }, data: { limitMicros, updatedById: by.id } });
    else await tx.budgetPolicy.create({ data: { scope: "CREATOR", targetId: creatorId, period, limitMicros, updatedById: by.id } });
    await recordAudit(
      by.actor,
      { action: raises ? "budget.raised" : "budget.lowered", entityType: "creator", entityId: creatorId, metadata: { period, fromMicros: from, toMicros: limitMicros } },
      tx,
    );
  });
}
