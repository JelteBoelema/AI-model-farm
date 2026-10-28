// Autopilot: plans work for creators within the hard limits people set. It runs as its own service
// identity (actor type AGENT) and only uses the same operator actions a person would: creating and
// producing content, approving content that passed quality control, scheduling into free slots.
// It never changes limits, budgets, autonomy modes, kill switches or account links: none of those
// functions are imported here, and each of them rejects a non-human actor (see policy.assertHuman).
//
//   MANUAL               nothing
//   ASSISTED             new ideas are produced up to review; a person approves and schedules
//   CONTROLLED_AUTONOMY  also approves its own items that passed QC with a high enough score (only
//                        when the policies allow it) and schedules them on connected accounts

import type { ContentFormat, Creator, UserRole } from "@prisma/client";
import { isProducible } from "@/lib/content-pipeline";
import { contentPillarSchema } from "@/lib/schemas/creator";
import { dayKey, zonedToUtc } from "@/lib/time";
import { recordAudit, type Actor } from "../audit";
import { findActivePause } from "../controls";
import { db } from "../db";
import { DomainError } from "../errors";
import { approveContent, createContent } from "./content";
import { effectivePolicy } from "./policy";
import { planningHint, type PlanningHint } from "./planning-hints";
import { nextFreeSlots, schedulePublication } from "./publishing";
import type { ActingUser } from "./users";

export const AUTOPILOT_EMAIL = "autopilot@system.invalid";
const AUTOPILOT_ROLE: UserRole = "OPERATOR";
/** New items per creator per day when no policy sets maxNewItemsPerDay: none, starting is an explicit choice. */
export const DEFAULT_NEW_ITEMS_PER_DAY = 0;

/** The autopilot's service identity: a user row that can never sign in (disabled, no password). */
export async function autopilotUser(): Promise<ActingUser> {
  const user = await db.user.upsert({
    where: { email: AUTOPILOT_EMAIL },
    update: {},
    create: { email: AUTOPILOT_EMAIL, name: "Autopilot", passwordHash: "!", role: AUTOPILOT_ROLE, isSystem: true, disabledAt: new Date() },
  });
  const actor: Actor = { type: "AGENT", id: user.id, label: "autopilot" };
  return { id: user.id, role: AUTOPILOT_ROLE, actor };
}

export interface CreatorRun {
  creatorId: string;
  name: string;
  mode: Creator["autonomyMode"];
  created: number;
  approved: number;
  scheduled: number;
  skipped: string[];
  /** Analytics that shaped the plan (empty: plain rotation). */
  planning: string[];
}

export interface AutopilotRun {
  at: string;
  paused: string | null;
  creators: CreatorRun[];
}

function startOfDay(now: Date, tz: string) {
  const [y, m, d] = dayKey(now, tz).split("-").map(Number) as [number, number, number];
  return zonedToUtc(y, m, d, 0, 0, tz);
}

function pillarsOf(creator: Creator) {
  const pillars = contentPillarSchema.array().safeParse(creator.contentPillars);
  return pillars.success && pillars.data.length ? pillars.data : [{ name: creator.niche, description: "" }];
}

/** Rotates through the creator's content pillars so the plan stays on brand; analytics may pick one. */
function nextIdea(creator: Creator, n: number, hint: PlanningHint | null) {
  const list = pillarsOf(creator);
  const pillar = (hint?.pillar && list.find((p) => p.name === hint.pillar)) || list[n % list.length]!;
  return {
    title: `${pillar.name}: autopilot idea`,
    pillar: pillar.name,
    idea: `Planned by the autopilot for the content pillar "${pillar.name}"${pillar.description ? ` (${pillar.description})` : ""}. Pick a fresh angle that fits ${creator.name}'s niche (${creator.niche}) and audience (${creator.targetAudience}).${hint ? ` Chosen from analytics: ${hint.reason}.` : ""}`,
  };
}

async function planCreator(by: ActingUser, creator: Creator, now: Date): Promise<CreatorRun> {
  const run: CreatorRun = { creatorId: creator.id, name: creator.name, mode: creator.autonomyMode, created: 0, approved: 0, scheduled: 0, skipped: [], planning: [] };
  const pause = await findActivePause({ chain: "generation", creatorId: creator.id });
  const policy = await effectivePolicy({ creatorId: creator.id });

  // 1. New ideas, produced up to review.
  if (pause) run.skipped.push(`paused: ${pause.reason}`);
  else {
    const quota = policy.maxNewItemsPerDay ?? DEFAULT_NEW_ITEMS_PER_DAY;
    if (quota === 0) run.skipped.push("new ideas: no daily quota set (Settings → Autonomy)");
    const today = await db.contentItem.count({ where: { creatorId: creator.id, createdById: by.id, createdAt: { gte: startOfDay(now, creator.timezone) } } });
    const formats = creator.contentFormats.filter(isProducible);
    if (formats.length === 0) run.skipped.push("no producible content format");
    // Rotation continues across days: n counts every item the autopilot planned for this creator.
    const planned = await db.contentItem.count({ where: { creatorId: creator.id, createdById: by.id } });
    for (let i = 0; formats.length > 0 && today + i < quota; i++) {
      const n = planned + i;
      const hint = await planningHint(creator.id, n, { minSample: policy.analyticsMinSample, pillars: pillarsOf(creator).map((p) => p.name), formats });
      const format = (hint?.format as ContentFormat | undefined) ?? formats[0]!;
      try {
        await createContent(by, { creatorId: creator.id, format, ...nextIdea(creator, n, hint), produce: true });
        run.created++;
        if (hint) run.planning.push(hint.reason);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        run.skipped.push(err.message);
        break;
      }
    }
  }
  if (creator.autonomyMode !== "CONTROLLED_AUTONOMY") return run;

  // 2. Approve its own items that passed quality control, only where every policy allows it.
  if (policy.requireHumanApproval) run.skipped.push("approval: the policy requires a person");
  else if (policy.autoApproveMinScore === null) run.skipped.push("approval: auto-approval is off in the global policy");
  else {
    const ready = await db.contentItem.findMany({
      where: { creatorId: creator.id, createdById: by.id, status: "READY", qualityScore: { gte: policy.autoApproveMinScore } },
      select: { id: true, campaignId: true, qualityScore: true },
    });
    for (const item of ready) {
      // Campaign policies can only raise the bar or require a person.
      const scoped = item.campaignId ? await effectivePolicy({ creatorId: creator.id, campaignId: item.campaignId }) : policy;
      if (scoped.requireHumanApproval || scoped.autoApproveMinScore === null) continue;
      if ((item.qualityScore ?? -1) < scoped.autoApproveMinScore) continue;
      try {
        await approveContent(by, item.id);
        run.approved++;
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        run.skipped.push(err.message);
      }
    }
  }

  // 3. Schedule its approved items into the next free slots of a connected account.
  if (await findActivePause({ chain: "publishing", creatorId: creator.id })) {
    run.skipped.push("publishing is paused");
    return run;
  }
  const approved = await db.contentItem.findMany({
    where: { creatorId: creator.id, createdById: by.id, status: "APPROVED", publishingJobs: { none: {} } },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
  });
  if (approved.length === 0) return run;
  const accounts = await db.socialAccount.findMany({ where: { creatorId: creator.id, status: "CONNECTED" }, include: { creator: true }, orderBy: { connectedAt: "asc" } });
  if (accounts.length === 0) {
    run.skipped.push("scheduling: no connected account");
    return run;
  }
  const account = accounts[0]!;
  let slots: Date[];
  try {
    slots = await nextFreeSlots(account, approved.length, now);
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    run.skipped.push(err.message);
    return run;
  }
  for (const [i, item] of approved.entries()) {
    if (!slots[i]) break;
    try {
      await schedulePublication(by, { contentItemId: item.id, socialAccountId: account.id, scheduledFor: slots[i] }, now);
      run.scheduled++;
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      run.skipped.push(err.message);
    }
  }
  return run;
}

/** One planning round over every creator that is not in manual mode. */
export async function runAutopilot(opts: { creatorIds?: string[]; now?: Date } = {}): Promise<AutopilotRun> {
  const now = opts.now ?? new Date();
  const by = await autopilotUser();
  const result: AutopilotRun = { at: now.toISOString(), paused: null, creators: [] };
  const farm = await findActivePause({ chain: "generation" });
  if (farm) result.paused = farm.reason;
  else {
    const creators = await db.creator.findMany({ where: { status: "ACTIVE", isDemo: false, autonomyMode: { not: "MANUAL" }, ...(opts.creatorIds ? { id: { in: opts.creatorIds } } : {}) }, orderBy: { createdAt: "asc" } });
    for (const creator of creators) result.creators.push(await planCreator(by, creator, now));
  }
  await recordAudit(by.actor, {
    action: "autopilot.run",
    metadata: {
      paused: result.paused,
      created: result.creators.reduce((s, c) => s + c.created, 0),
      approved: result.creators.reduce((s, c) => s + c.approved, 0),
      scheduled: result.creators.reduce((s, c) => s + c.scheduled, 0),
      creators: result.creators.map((c) => ({ id: c.creatorId, name: c.name, mode: c.mode, created: c.created, approved: c.approved, scheduled: c.scheduled, skipped: c.skipped.slice(0, 5), planning: c.planning.slice(0, 5) })),
    },
  });
  return result;
}

/** Latest planning rounds for the status card. */
export async function recentAutopilotRuns(limit = 5) {
  return db.auditLog.findMany({ where: { action: "autopilot.run" }, orderBy: { occurredAt: "desc" }, take: limit, select: { occurredAt: true, metadata: true } });
}
