// Kill switches. Workers call assertNotPaused() before any paid generation or publication;
// operators can pause instantly, resuming needs ADMIN. Every change is audited.

import type { ControlScope } from "@prisma/client";
import { db } from "./db";
import { recordAudit, type Actor } from "./audit";

export interface PauseContext {
  chain: "generation" | "publishing";
  creatorId?: string | null;
  campaignId?: string | null;
  providerId?: string | null;
}

export interface ActivePause {
  scope: ControlScope;
  targetId: string | null;
  reason: string;
}

export class PausedError extends Error {
  constructor(readonly pause: ActivePause) {
    super(`Paused by control switch ${pause.scope}${pause.targetId ? `:${pause.targetId}` : ""}: ${pause.reason}`);
    this.name = "PausedError";
  }
}

export async function findActivePause(ctx: PauseContext): Promise<ActivePause | null> {
  const chainScope: ControlScope = ctx.chain === "generation" ? "ALL_GENERATION" : "ALL_PUBLISHING";
  const targets: { scope: ControlScope; targetId: string | null }[] = [{ scope: chainScope, targetId: null }];
  if (ctx.creatorId) targets.push({ scope: "CREATOR", targetId: ctx.creatorId });
  if (ctx.campaignId) targets.push({ scope: "CAMPAIGN", targetId: ctx.campaignId });
  if (ctx.providerId) targets.push({ scope: "PROVIDER", targetId: ctx.providerId });

  if (ctx.creatorId) {
    const creator = await db.creator.findUnique({ where: { id: ctx.creatorId }, select: { status: true } });
    if (!creator) return { scope: "CREATOR", targetId: ctx.creatorId, reason: "Creator not found" };
    if (creator.status !== "ACTIVE")
      return { scope: "CREATOR", targetId: ctx.creatorId, reason: `Creator is ${creator.status.toLowerCase()}` };
  }

  const hit = await db.controlSwitch.findFirst({
    where: { paused: true, OR: targets.map((t) => ({ scope: t.scope, targetId: t.targetId })) },
    select: { scope: true, targetId: true, reason: true },
  });
  return hit;
}

export async function assertNotPaused(ctx: PauseContext): Promise<void> {
  const pause = await findActivePause(ctx);
  if (pause) throw new PausedError(pause);
}

export async function setControlSwitch(
  actor: Actor,
  input: { scope: ControlScope; targetId?: string | null; paused: boolean; reason: string },
): Promise<void> {
  const targetId = input.targetId ?? null;
  const global = input.scope === "ALL_GENERATION" || input.scope === "ALL_PUBLISHING";
  if (global !== (targetId === null)) throw new Error("Global switches take no target; scoped switches require one");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new Error("A reason is required");

  await db.$transaction(async (tx) => {
    const existing = await tx.controlSwitch.findFirst({ where: { scope: input.scope, targetId } });
    if (existing) {
      await tx.controlSwitch.update({
        where: { id: existing.id },
        data: { paused: input.paused, reason, changedById: actor.id ?? null },
      });
    } else {
      await tx.controlSwitch.create({
        data: { scope: input.scope, targetId, paused: input.paused, reason, changedById: actor.id ?? null },
      });
    }
    await recordAudit(
      actor,
      {
        action: input.paused ? "control.paused" : "control.resumed",
        entityType: "control_switch",
        entityId: targetId ?? input.scope,
        metadata: { scope: input.scope, reason },
      },
      tx,
    );
  });
}

export async function listPausedSwitches() {
  return db.controlSwitch.findMany({ where: { paused: true }, orderBy: { updatedAt: "desc" } });
}
