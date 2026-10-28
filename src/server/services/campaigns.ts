// Campaign management: plans that group content across creators with their own budget, prompt pins
// and pause switch. Pausing a campaign stops its generation and publishing through the kill switch.

import type { BudgetPeriod, CampaignStatus } from "@prisma/client";
import { z } from "zod";
import { can, type Permission } from "@/lib/rbac";
import { assertTransition } from "@/lib/state-machines";
import { recordAudit } from "../audit";
import { setControlSwitch } from "../controls";
import { db } from "../db";
import { DomainError } from "../errors";
import { assertHuman } from "./policy";
import type { ActingUser } from "./users";

function require(by: ActingUser, permission: Permission) {
  if (!can(by.role, permission)) throw new DomainError("You do not have permission for this action.");
}

export const campaignSchema = z
  .object({
    name: z.string().trim().min(3, "Name the campaign").max(80),
    objective: z.string().trim().max(300).default(""),
    brief: z.string().trim().max(4000).default(""),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
    creatorIds: z.array(z.string().uuid()).max(50).default([]),
  })
  .refine((c) => !c.startsAt || !c.endsAt || c.startsAt < c.endsAt, { message: "The campaign must end after it starts", path: ["endsAt"] });

async function assertCreators(ids: string[]) {
  if (ids.length === 0) return;
  const found = await db.creator.count({ where: { id: { in: ids }, status: { not: "ARCHIVED" } } });
  if (found !== new Set(ids).size) throw new DomainError("Unknown or archived creator in the selection");
}

export async function createCampaign(by: ActingUser, raw: z.input<typeof campaignSchema>) {
  require(by, "content:edit");
  const input = campaignSchema.parse(raw);
  await assertCreators(input.creatorIds);
  return db.$transaction(async (tx) => {
    const c = await tx.campaign.create({ data: { name: input.name, objective: input.objective, brief: input.brief, startsAt: input.startsAt, endsAt: input.endsAt } });
    if (input.creatorIds.length) await tx.campaignCreator.createMany({ data: [...new Set(input.creatorIds)].map((creatorId) => ({ campaignId: c.id, creatorId })) });
    await recordAudit(by.actor, { action: "campaign.created", entityType: "campaign", entityId: c.id, metadata: { name: c.name, creators: input.creatorIds.length } }, tx);
    return c;
  });
}

export async function updateCampaign(by: ActingUser, campaignId: string, raw: z.input<typeof campaignSchema>) {
  require(by, "content:edit");
  const input = campaignSchema.parse(raw);
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, include: { creators: true } });
  if (!campaign) throw new DomainError("Campaign not found");
  if (["COMPLETED", "ARCHIVED"].includes(campaign.status)) throw new DomainError("Closed campaigns cannot be edited");
  await assertCreators(input.creatorIds);
  const removed = campaign.creators.map((c) => c.creatorId).filter((id) => !input.creatorIds.includes(id));
  if (removed.length) {
    const used = await db.contentItem.count({ where: { campaignId, creatorId: { in: removed }, status: { notIn: ["ARCHIVED", "REJECTED"] } } });
    if (used) throw new DomainError("A creator with open content in this campaign cannot be removed");
  }
  await db.$transaction(async (tx) => {
    await tx.campaign.update({ where: { id: campaignId }, data: { name: input.name, objective: input.objective, brief: input.brief, startsAt: input.startsAt, endsAt: input.endsAt } });
    await tx.campaignCreator.deleteMany({ where: { campaignId, creatorId: { notIn: input.creatorIds } } });
    await tx.campaignCreator.createMany({ data: input.creatorIds.map((creatorId) => ({ campaignId, creatorId })), skipDuplicates: true });
    await recordAudit(by.actor, { action: "campaign.updated", entityType: "campaign", entityId: campaignId, metadata: { creators: input.creatorIds.length, removed } }, tx);
  });
}

const ACTIONS: Record<string, { to: CampaignStatus; permission: Permission }> = {
  activate: { to: "ACTIVE", permission: "content:edit" },
  pause: { to: "PAUSED", permission: "controls:pause" },
  resume: { to: "ACTIVE", permission: "controls:resume" },
  complete: { to: "COMPLETED", permission: "content:edit" },
  archive: { to: "ARCHIVED", permission: "content:edit" },
};

export async function changeCampaignStatus(by: ActingUser, campaignId: string, action: keyof typeof ACTIONS, reason = "") {
  const spec = ACTIONS[action];
  if (!spec) throw new DomainError("Unknown action");
  assertHuman(by.actor);
  require(by, spec.permission);
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new DomainError("Campaign not found");
  if (action === "resume" && campaign.status !== "PAUSED") throw new DomainError("The campaign is not paused");
  if (action === "activate" && campaign.status !== "DRAFT") throw new DomainError(campaign.status === "PAUSED" ? "Use resume (admin) for a paused campaign" : "Only draft campaigns can be activated");
  assertTransition("campaign", campaign.status, spec.to);
  const why = reason.trim() || `Campaign ${action}d by ${by.actor.label}`;
  // The kill switch is what workers check: pausing stops queued generation and publishing at once.
  if (action === "pause") await setControlSwitch(by.actor, { scope: "CAMPAIGN", targetId: campaignId, paused: true, reason: why });
  if (action === "resume" || (campaign.status === "PAUSED" && spec.to !== "PAUSED")) await setControlSwitch(by.actor, { scope: "CAMPAIGN", targetId: campaignId, paused: false, reason: why });
  await db.campaign.update({ where: { id: campaignId }, data: { status: spec.to } });
  await recordAudit(by.actor, { action: `campaign.${action}`, entityType: "campaign", entityId: campaignId, metadata: { from: campaign.status, to: spec.to, reason: why } });
}

/** Same rule as creator budgets: lowering or setting a cap is an admin decision; raising or removing one is the owner's. */
export async function setCampaignBudget(by: ActingUser, campaignId: string, period: BudgetPeriod, limitMicros: bigint | null) {
  assertHuman(by.actor);
  if (limitMicros !== null && limitMicros < 0n) throw new DomainError("A budget cannot be negative");
  if (!(await db.campaign.findUnique({ where: { id: campaignId }, select: { id: true } }))) throw new DomainError("Campaign not found");
  const existing = await db.budgetPolicy.findFirst({ where: { scope: "CAMPAIGN", targetId: campaignId, period } });
  const from = existing?.limitMicros ?? null;
  if (from === limitMicros) return;
  const raises = limitMicros === null || (from !== null && limitMicros > from);
  require(by, raises ? "budgets:raise" : "budgets:lower");
  await db.$transaction(async (tx) => {
    if (limitMicros === null) await tx.budgetPolicy.delete({ where: { id: existing!.id } });
    else if (existing) await tx.budgetPolicy.update({ where: { id: existing.id }, data: { limitMicros, updatedById: by.id } });
    else await tx.budgetPolicy.create({ data: { scope: "CAMPAIGN", targetId: campaignId, period, limitMicros, updatedById: by.id } });
    await recordAudit(by.actor, { action: raises ? "budget.raised" : "budget.lowered", entityType: "campaign", entityId: campaignId, metadata: { period, fromMicros: from, toMicros: limitMicros } }, tx);
  });
}
