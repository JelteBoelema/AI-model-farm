// Autonomy policy engine. Hard limits come from autonomy_policies at three scopes (global, creator,
// campaign); the effective limit for a piece of work is the strictest of the applicable ones, so a
// scoped policy can only tighten what the farm allows. Policies are changed by humans only (see
// policy-admin.ts); nothing here writes them.

import type { AutonomyPolicy, Prisma, PrismaClient } from "@prisma/client";
import { db } from "../db";
import type { Actor } from "../audit";
import { DomainError } from "../errors";

export const LIMIT_FIELDS = [
  "maxCostPerJobMicros",
  "maxGenerationsPerItem",
  "maxConcurrentJobs",
  "maxPostsPerDay",
  "maxWorkflowMinutes",
  "maxRetries",
  "maxNewItemsPerDay",
] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];

export interface EffectivePolicy {
  maxCostPerJobMicros: bigint | null;
  maxGenerationsPerItem: number | null;
  maxConcurrentJobs: number | null;
  maxPostsPerDay: number | null;
  maxWorkflowMinutes: number | null;
  maxRetries: number | null;
  maxNewItemsPerDay: number | null;
  /** Higher is stricter; null means the autopilot never approves content itself. */
  autoApproveMinScore: number | null;
  requireHumanApproval: boolean;
  /** Which scope set each binding limit (for explanations in the UI and in errors). */
  source: Partial<Record<LimitField | "autoApproveMinScore" | "requireHumanApproval", "GLOBAL" | "CREATOR" | "CAMPAIGN">>;
}

type Client = Prisma.TransactionClient | PrismaClient;

function stricter<T extends number | bigint>(a: T | null, b: T | null): T | null {
  if (a === null) return b;
  if (b === null) return a;
  return b < a ? b : a;
}

export function mergePolicies(rows: Pick<AutonomyPolicy, "scope" | LimitField | "autoApproveMinScore" | "requireHumanApproval">[]): EffectivePolicy {
  const eff: EffectivePolicy = {
    maxCostPerJobMicros: null,
    maxGenerationsPerItem: null,
    maxConcurrentJobs: null,
    maxPostsPerDay: null,
    maxWorkflowMinutes: null,
    maxRetries: null,
    maxNewItemsPerDay: null,
    autoApproveMinScore: null,
    requireHumanApproval: false,
    source: {},
  };
  // GLOBAL first so that ties keep the global source.
  const ordered = [...rows].sort((a, b) => (a.scope === "GLOBAL" ? -1 : b.scope === "GLOBAL" ? 1 : 0));
  // Auto-approval exists only when the farm-wide policy allows it; scopes can only raise the bar.
  const globalAllows = ordered.some((r) => r.scope === "GLOBAL" && r.autoApproveMinScore !== null);
  for (const r of ordered) {
    const scope = r.scope as "GLOBAL" | "CREATOR" | "CAMPAIGN";
    for (const f of LIMIT_FIELDS) {
      const next = stricter(eff[f] as never, r[f] as never);
      if (next !== eff[f]) {
        (eff as unknown as Record<string, unknown>)[f] = next;
        eff.source[f] = scope;
      }
    }
    if (r.autoApproveMinScore !== null && (eff.autoApproveMinScore === null || r.autoApproveMinScore > eff.autoApproveMinScore)) {
      eff.autoApproveMinScore = r.autoApproveMinScore;
      eff.source.autoApproveMinScore = scope;
    }
    if (r.requireHumanApproval && !eff.requireHumanApproval) {
      eff.requireHumanApproval = true;
      eff.source.requireHumanApproval = scope;
    }
  }
  if (!globalAllows) {
    eff.autoApproveMinScore = null;
    delete eff.source.autoApproveMinScore;
  }
  return eff;
}

export async function effectivePolicy(ctx: { creatorId?: string | null; campaignId?: string | null } = {}, client: Client = db): Promise<EffectivePolicy> {
  const rows = await client.autonomyPolicy.findMany({
    where: {
      OR: [
        { scope: "GLOBAL" },
        ...(ctx.creatorId ? [{ scope: "CREATOR" as const, targetId: ctx.creatorId }] : []),
        ...(ctx.campaignId ? [{ scope: "CAMPAIGN" as const, targetId: ctx.campaignId }] : []),
      ],
    },
  });
  return mergePolicies(rows);
}

/** BullMQ attempts for a step: the queue's default, capped by the policy's retry limit. */
export function attemptsFor(queueAttempts: number, policy: Pick<EffectivePolicy, "maxRetries">) {
  return policy.maxRetries === null ? queueAttempts : Math.max(1, Math.min(queueAttempts, policy.maxRetries + 1));
}

/**
 * Limits, budgets, kill-switch resumes, autonomy modes and account approvals are decisions for
 * people. Every function that changes them calls this first, whatever role the caller claims.
 */
export function assertHuman(actor: Actor) {
  if (actor.type !== "USER") throw new DomainError("Limits and approvals can only be changed by a person, never by the autopilot or another automated actor.");
}
