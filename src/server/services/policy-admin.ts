// Changing hard limits (budgets and autonomy policies). Only people change limits; agents never do
// (assertHuman). Tightening a limit is an admin decision and applies at once; loosening one (raising,
// removing, allowing more autonomy) is the owner's: the owner applies it directly, anyone else files
// a request that the owner approves or rejects. Approved requests are applied only if the limit did
// not change in the meantime.

import type { Approval, BudgetPeriod, BudgetScope, PolicyScope, Prisma } from "@prisma/client";
import { z } from "zod";
import { formatMoney, toMicros } from "@/lib/money";
import { can } from "@/lib/rbac";
import { recordAudit } from "../audit";
import { db } from "../db";
import { DomainError } from "../errors";
import { assertHuman, BAR_FIELDS, LIMIT_FIELDS, type BarField, type LimitField } from "./policy";
import { decideConnection } from "./social";
import type { ActingUser } from "./users";

// ─────────────────────────────── Budgets ───────────────────────────────

export const budgetChangeSchema = z
  .object({
    scope: z.enum(["GLOBAL", "CREATOR", "CAMPAIGN", "PROVIDER"]),
    targetId: z.string().uuid().nullable().default(null),
    period: z.enum(["DAY", "MONTH"]),
    /** EUR as a decimal string, or null to remove the cap. */
    limitEur: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, "Use an amount such as 250 or 99.50").nullable(),
    reason: z.string().trim().max(500).default(""),
  })
  .refine((b) => (b.scope === "GLOBAL") === (b.targetId === null), { message: "Farm-wide budgets take no target; others need one", path: ["targetId"] })
  .refine((b) => !(b.scope === "GLOBAL" && b.period === "MONTH" && b.limitEur === null), { message: "The farm-wide monthly budget cannot be removed", path: ["limitEur"] });

type BudgetChange = z.output<typeof budgetChangeSchema>;

async function currentBudget(c: Pick<BudgetChange, "scope" | "targetId" | "period">) {
  return db.budgetPolicy.findFirst({ where: { scope: c.scope as BudgetScope, targetId: c.targetId, period: c.period as BudgetPeriod } });
}

function loosens(from: bigint | null, to: bigint | null) {
  // No cap is the loosest; creating a cap tightens.
  return to === null ? from !== null : from !== null && to > from;
}

async function applyBudget(by: ActingUser, c: BudgetChange, approvalId: string | null, tx: Prisma.TransactionClient) {
  const existing = await tx.budgetPolicy.findFirst({ where: { scope: c.scope as BudgetScope, targetId: c.targetId, period: c.period as BudgetPeriod } });
  const to = c.limitEur === null ? null : toMicros(c.limitEur);
  if (to === null) {
    if (existing) await tx.budgetPolicy.delete({ where: { id: existing.id } });
  } else if (existing) await tx.budgetPolicy.update({ where: { id: existing.id }, data: { limitMicros: to, updatedById: by.id } });
  else await tx.budgetPolicy.create({ data: { scope: c.scope as BudgetScope, targetId: c.targetId, period: c.period as BudgetPeriod, limitMicros: to, updatedById: by.id } });
  await recordAudit(
    by.actor,
    { action: loosens(existing?.limitMicros ?? null, to) ? "budget.raised" : "budget.lowered", entityType: "budget_policy", entityId: existing?.id, metadata: { scope: c.scope, targetId: c.targetId, period: c.period, fromMicros: existing?.limitMicros ?? null, toMicros: to, approvalId } },
    tx,
  );
}

export type ChangeResult = { applied: true } | { applied: false; approvalId: string };

/** Applies a budget change, or files it for the owner's approval when it loosens a limit. */
export async function changeBudget(by: ActingUser, raw: z.input<typeof budgetChangeSchema>): Promise<ChangeResult> {
  assertHuman(by.actor);
  const c = budgetChangeSchema.parse(raw);
  const existing = await currentBudget(c);
  const to = c.limitEur === null ? null : toMicros(c.limitEur);
  const from = existing?.limitMicros ?? null;
  if (from === to) return { applied: true };
  if (!loosens(from, to)) {
    if (!can(by.role, "budgets:lower")) throw new DomainError("You do not have permission for this action.");
    await db.$transaction((tx) => applyBudget(by, c, null, tx));
    return { applied: true };
  }
  if (can(by.role, "budgets:raise")) {
    await db.$transaction(async (tx) => {
      const a = await tx.approval.create({ data: { subjectType: "BUDGET_INCREASE", subjectId: existing?.id ?? c.targetId ?? "00000000-0000-0000-0000-000000000000", requestedBy: "USER", requestedById: by.id, payload: { ...c, fromMicros: from?.toString() ?? null, summary: budgetSummary(c, from, to) }, decision: "APPROVED", decidedById: by.id, decidedAt: new Date(), reason: c.reason || "Changed by the owner" } });
      await applyBudget(by, c, a.id, tx);
    });
    return { applied: true };
  }
  return { applied: false, approvalId: (await fileRequest(by, "BUDGET_INCREASE", existing?.id ?? c.targetId, { ...c, fromMicros: from?.toString() ?? null }, budgetSummary(c, from, to))).id };
}

function budgetSummary(c: Pick<BudgetChange, "scope" | "period">, from: bigint | null, to: bigint | null) {
  return `${budgetText(c)}: ${from === null ? "no cap" : formatMoney(from)} → ${to === null ? "no cap" : formatMoney(to)}`;
}

function budgetText(c: Pick<BudgetChange, "scope" | "period">) {
  return `${c.scope === "GLOBAL" ? "Farm-wide" : c.scope.charAt(0) + c.scope.slice(1).toLowerCase()} ${c.period === "DAY" ? "daily" : "monthly"} budget`;
}

// ─────────────────────────────── Autonomy policies ───────────────────────────────

const intOrNull = (min: number, max: number) => z.coerce.number().int().min(min).max(max).nullable();

export const policyChangeSchema = z
  .object({
    scope: z.enum(["GLOBAL", "CREATOR", "CAMPAIGN"]),
    targetId: z.string().uuid().nullable().default(null),
    values: z.object({
      maxCostPerJobEur: z.string().trim().regex(/^\d{1,5}(\.\d{1,2})?$/, "Use an amount such as 5 or 2.50").nullable(),
      maxGenerationsPerItem: intOrNull(1, 100),
      maxConcurrentJobs: intOrNull(1, 500),
      maxPostsPerDay: intOrNull(1, 50),
      maxWorkflowMinutes: intOrNull(5, 10_080),
      maxRetries: intOrNull(0, 10),
      maxNewItemsPerDay: intOrNull(0, 100),
      autoApproveMinScore: intOrNull(0, 100),
      analyticsMinSample: intOrNull(5, 10_000).default(null),
      requireHumanApproval: z.boolean(),
    }),
    reason: z.string().trim().max(500).default(""),
  })
  .refine((p) => (p.scope === "GLOBAL") === (p.targetId === null), { message: "Farm-wide policies take no target; others need one", path: ["targetId"] });

type PolicyChange = z.output<typeof policyChangeSchema>;
type PolicyValues = Record<LimitField, number | bigint | null> & Record<BarField, number | null> & { requireHumanApproval: boolean };

function toValues(v: PolicyChange["values"]): PolicyValues {
  return {
    maxCostPerJobMicros: v.maxCostPerJobEur === null ? null : toMicros(v.maxCostPerJobEur),
    maxGenerationsPerItem: v.maxGenerationsPerItem,
    maxConcurrentJobs: v.maxConcurrentJobs,
    maxPostsPerDay: v.maxPostsPerDay,
    maxWorkflowMinutes: v.maxWorkflowMinutes,
    maxRetries: v.maxRetries,
    maxNewItemsPerDay: v.maxNewItemsPerDay,
    autoApproveMinScore: v.autoApproveMinScore,
    analyticsMinSample: v.analyticsMinSample,
    requireHumanApproval: v.requireHumanApproval,
  };
}

/** Fields whose new value gives the system more room than before. */
export function loosenedFields(before: PolicyValues | null, after: PolicyValues, scope: "GLOBAL" | "CREATOR" | "CAMPAIGN" = "GLOBAL"): string[] {
  const out: string[] = [];
  for (const f of LIMIT_FIELDS) {
    const a = before?.[f] ?? null;
    const b = after[f];
    if ((b === null && a !== null) || (a !== null && b !== null && b > a)) out.push(f);
  }
  // Bars (self-approval score, analytics sample): at farm level null means "never" (strictest) and a
  // lower value is looser. A scoped value can only raise the farm's bar, so only lowering or removing it loosens.
  for (const f of BAR_FIELDS) {
    const sa = before?.[f] ?? null;
    const sb = after[f];
    if (scope === "GLOBAL" ? (sa === null && sb !== null) || (sa !== null && sb !== null && sb < sa) : sa !== null && (sb === null || sb < sa)) out.push(f);
  }
  if ((before?.requireHumanApproval ?? false) && !after.requireHumanApproval) out.push("requireHumanApproval");
  return out;
}

async function applyPolicy(by: ActingUser, c: PolicyChange, approvalId: string | null, tx: Prisma.TransactionClient) {
  const values = toValues(c.values);
  const existing = await tx.autonomyPolicy.findFirst({ where: { scope: c.scope as PolicyScope, targetId: c.targetId } });
  const data = { ...values, maxCostPerJobMicros: values.maxCostPerJobMicros as bigint | null, updatedById: by.id } as Prisma.AutonomyPolicyUncheckedUpdateInput;
  const saved = existing
    ? await tx.autonomyPolicy.update({ where: { id: existing.id }, data })
    : await tx.autonomyPolicy.create({ data: { ...(data as Prisma.AutonomyPolicyUncheckedCreateInput), scope: c.scope as PolicyScope, targetId: c.targetId } });
  await recordAudit(by.actor, { action: "policy.changed", entityType: "autonomy_policy", entityId: saved.id, metadata: { scope: c.scope, targetId: c.targetId, before: existing, after: values, approvalId } }, tx);
}

function currentValues(row: Awaited<ReturnType<typeof db.autonomyPolicy.findFirst>>): PolicyValues | null {
  if (!row) return null;
  return {
    maxCostPerJobMicros: row.maxCostPerJobMicros,
    maxGenerationsPerItem: row.maxGenerationsPerItem,
    maxConcurrentJobs: row.maxConcurrentJobs,
    maxPostsPerDay: row.maxPostsPerDay,
    maxWorkflowMinutes: row.maxWorkflowMinutes,
    maxRetries: row.maxRetries,
    maxNewItemsPerDay: row.maxNewItemsPerDay,
    autoApproveMinScore: row.autoApproveMinScore,
    analyticsMinSample: row.analyticsMinSample,
    requireHumanApproval: row.requireHumanApproval,
  };
}

/** Applies a policy change, or files it for the owner's approval when it loosens any limit. */
export async function changePolicy(by: ActingUser, raw: z.input<typeof policyChangeSchema>): Promise<ChangeResult> {
  assertHuman(by.actor);
  const c = policyChangeSchema.parse(raw);
  if (c.scope !== "GLOBAL") {
    const exists = c.scope === "CREATOR" ? await db.creator.findUnique({ where: { id: c.targetId! }, select: { id: true } }) : await db.campaign.findUnique({ where: { id: c.targetId! }, select: { id: true } });
    if (!exists) throw new DomainError(`${c.scope === "CREATOR" ? "Creator" : "Campaign"} not found`);
  }
  const existing = await db.autonomyPolicy.findFirst({ where: { scope: c.scope as PolicyScope, targetId: c.targetId } });
  const loosened = loosenedFields(currentValues(existing), toValues(c.values), c.scope);
  if (loosened.length === 0) {
    if (!can(by.role, "autonomy:raise")) throw new DomainError("You do not have permission for this action.");
    await db.$transaction((tx) => applyPolicy(by, c, null, tx));
    return { applied: true };
  }
  const payload = { ...c, loosened, before: existing ? JSON.parse(JSON.stringify(existing, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) : null };
  const summary = `${c.scope === "GLOBAL" ? "Farm-wide" : c.scope.toLowerCase()} autonomy limits: loosens ${loosened.join(", ")}`;
  if (can(by.role, "policies:manage")) {
    await db.$transaction(async (tx) => {
      const a = await tx.approval.create({ data: { subjectType: "POLICY_CHANGE", subjectId: existing?.id ?? c.targetId ?? "00000000-0000-0000-0000-000000000000", requestedBy: "USER", requestedById: by.id, payload: { ...payload, summary }, decision: "APPROVED", decidedById: by.id, decidedAt: new Date(), reason: c.reason || "Changed by the owner" } });
      await applyPolicy(by, c, a.id, tx);
    });
    return { applied: true };
  }
  return { applied: false, approvalId: (await fileRequest(by, "POLICY_CHANGE", existing?.id ?? c.targetId, payload, summary)).id };
}

// ─────────────────────────────── Requests and decisions ───────────────────────────────

async function fileRequest(by: ActingUser, subjectType: "BUDGET_INCREASE" | "POLICY_CHANGE", subjectId: string | null, payload: object, summary: string) {
  const stored = { ...payload, summary } as Prisma.InputJsonValue;
  // The same request twice (double click, repeated form) stays one request.
  const pending = await db.approval.findFirst({ where: { subjectType, decision: "PENDING", requestedById: by.id, payload: { equals: stored } } });
  if (pending) return pending;
  const a = await db.approval.create({
    data: { subjectType, subjectId: subjectId ?? "00000000-0000-0000-0000-000000000000", requestedBy: "USER", requestedById: by.id, payload: stored },
  });
  await db.notification.create({ data: { severity: "WARNING", type: "approval.requested", title: "Approval needed", body: `${by.actor.label} asks: ${summary}`.slice(0, 500), link: "/settings/approvals" } });
  await recordAudit(by.actor, { action: "approval.requested", entityType: "approval", entityId: a.id, metadata: { subjectType, summary } });
  return a;
}

/** The owner decides a pending request; approved changes are applied unless the limit changed since. */
export async function decideApproval(by: ActingUser, approvalId: string, approve: boolean, reasonRaw = "") {
  assertHuman(by.actor);
  if (!can(by.role, "policies:manage")) throw new DomainError("Only the owner decides on these requests.");
  const reason = z.string().trim().max(500).parse(reasonRaw);
  const a = await db.approval.findUnique({ where: { id: approvalId } });
  if (!a || a.decision !== "PENDING") throw new DomainError("This request is not pending");
  if (a.subjectType === "SOCIAL_ACCOUNT_LINK") return decideConnection(by, a.subjectId, approve, reason);
  if (a.subjectType !== "BUDGET_INCREASE" && a.subjectType !== "POLICY_CHANGE") throw new DomainError("This kind of request is decided elsewhere");
  await db.$transaction(async (tx) => {
    const { count } = await tx.approval.updateMany({ where: { id: a.id, decision: "PENDING" }, data: { decision: approve ? "APPROVED" : "REJECTED", decidedById: by.id, decidedAt: new Date(), reason: reason || null } });
    if (count !== 1) throw new DomainError("This request was decided meanwhile");
    if (approve) {
      if (a.subjectType === "BUDGET_INCREASE") {
        const c = budgetChangeSchema.parse(a.payload);
        const now = await tx.budgetPolicy.findFirst({ where: { scope: c.scope as BudgetScope, targetId: c.targetId, period: c.period as BudgetPeriod } });
        if ((now?.limitMicros?.toString() ?? null) !== ((a.payload as { fromMicros?: string | null }).fromMicros ?? null)) throw new DomainError("The budget changed after this request; ask for a new one");
        await applyBudget(by, c, a.id, tx);
      } else {
        const c = policyChangeSchema.parse(a.payload);
        const before = (a.payload as { before?: { updatedAt?: string } | null }).before;
        const now = await tx.autonomyPolicy.findFirst({ where: { scope: c.scope as PolicyScope, targetId: c.targetId } });
        if ((now?.updatedAt.toISOString() ?? null) !== (before?.updatedAt ?? null)) throw new DomainError("The limits changed after this request; ask for a new one");
        await applyPolicy(by, c, a.id, tx);
      }
    }
    await recordAudit(by.actor, { action: approve ? "approval.approved" : "approval.rejected", entityType: "approval", entityId: a.id, metadata: { subjectType: a.subjectType, reason } }, tx);
  });
}

export type PendingApproval = Approval & { summary: string };

/** Requests waiting for the owner, newest first, with a readable summary. */
export async function listApprovals(opts: { pending: boolean; take?: number }): Promise<(PendingApproval & { requestedByName: string | null; decidedByName: string | null })[]> {
  const rows = await db.approval.findMany({
    where: { subjectType: { in: ["BUDGET_INCREASE", "POLICY_CHANGE", "SOCIAL_ACCOUNT_LINK"] }, decision: opts.pending ? "PENDING" : { not: "PENDING" } },
    orderBy: opts.pending ? { createdAt: "desc" } : { decidedAt: "desc" },
    take: opts.take ?? 50,
  });
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter((x): x is string => !!x))];
  const users = new Map((await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const accounts = new Map(
    (await db.socialAccount.findMany({ where: { id: { in: rows.filter((r) => r.subjectType === "SOCIAL_ACCOUNT_LINK").map((r) => r.subjectId) } }, select: { id: true, handle: true, platform: true, creator: { select: { name: true } } } })).map((a) => [
      a.id,
      `Link ${a.platform.toLowerCase()} account @${a.handle} to ${a.creator.name}`,
    ]),
  );
  return rows.map((r) => ({
    ...r,
    summary: r.subjectType === "SOCIAL_ACCOUNT_LINK" ? (accounts.get(r.subjectId) ?? "Link a social account") : String((r.payload as { summary?: string } | null)?.summary ?? r.subjectType),
    requestedByName: r.requestedById ? (users.get(r.requestedById) ?? null) : null,
    decidedByName: r.decidedById ? (users.get(r.decidedById) ?? null) : null,
  }));
}
