// Budget watch: warns when a budget passes its warning threshold and pauses the matching scope when
// a hard limit is reached (budget policies with auto-pause). The pause uses the kill switches, so it
// takes effect before the next step anywhere in the farm; resuming is an admin decision, raising the
// limit an owner decision.

import type { BudgetPolicy, ControlScope } from "@prisma/client";
import { formatMoney } from "@/lib/money";
import { SYSTEM_ACTOR } from "../audit";
import { setControlSwitch } from "../controls";
import { db } from "../db";
import { logger } from "../logger";
import { periodStart, SCOPE_FILTER } from "./spend-guard";

const PAUSE_SCOPE: Record<BudgetPolicy["scope"], ControlScope> = { GLOBAL: "ALL_GENERATION", CREATOR: "CREATOR", CAMPAIGN: "CAMPAIGN", PROVIDER: "PROVIDER" };

function periodKey(p: BudgetPolicy, now: Date) {
  return periodStart(p.period, now).toISOString().slice(0, p.period === "DAY" ? 10 : 7);
}

async function label(p: BudgetPolicy) {
  const period = p.period === "DAY" ? "daily" : "monthly";
  if (p.scope === "GLOBAL") return `farm-wide ${period} budget`;
  const name =
    p.scope === "CREATOR"
      ? (await db.creator.findUnique({ where: { id: p.targetId! }, select: { name: true } }))?.name
      : p.scope === "CAMPAIGN"
        ? (await db.campaign.findUnique({ where: { id: p.targetId! }, select: { name: true } }))?.name
        : (await db.aiProvider.findUnique({ where: { id: p.targetId! }, select: { displayName: true } }))?.displayName;
  return `${period} budget of ${p.scope.toLowerCase()} ${name ?? p.targetId}`;
}

/** Stores a notification once per dedupe key (e.g. once per budget per period). */
async function notifyOnce(dedupeKey: string, data: { severity: "WARNING" | "CRITICAL"; type: string; title: string; body: string; link: string }) {
  await db.notification.createMany({ data: [{ ...data, dedupeKey }], skipDuplicates: true });
}

/** Pauses the scope of a budget policy (if it auto-pauses and is not paused yet). */
export async function pauseForBudget(p: BudgetPolicy, why: string, now = new Date()) {
  if (!p.autoPause) return false;
  const scope = PAUSE_SCOPE[p.scope];
  const existing = await db.controlSwitch.findFirst({ where: { scope, targetId: p.scope === "GLOBAL" ? null : p.targetId, paused: true } });
  if (existing) return false;
  const what = await label(p);
  const reason = `Budget limit reached: ${what} (${formatMoney(p.limitMicros)}). ${why}`.slice(0, 300);
  await setControlSwitch(SYSTEM_ACTOR, { scope, targetId: p.scope === "GLOBAL" ? null : p.targetId, paused: true, reason });
  await notifyOnce(`budget-pause:${p.id}:${periodKey(p, now)}`, {
    severity: "CRITICAL",
    type: "budget.auto_paused",
    title: `Paused: ${what} reached`,
    body: `${reason} An admin can resume under Settings → Controls; raising the limit needs the owner.`,
    link: "/settings",
  });
  logger.warn({ scope, targetId: p.targetId, policyId: p.id }, "budget limit reached; scope paused");
  return true;
}

/**
 * After a charge: warn at the threshold, pause at the limit. Looks at every budget that the charge
 * counts towards (farm-wide, provider, creator, campaign).
 */
export async function checkBudgetsAfterCharge(scopes: { providerId?: string | null; creatorId?: string | null; campaignId?: string | null }, now = new Date()) {
  const targets = [
    { scope: "GLOBAL" as const, targetId: null },
    ...(scopes.providerId ? [{ scope: "PROVIDER" as const, targetId: scopes.providerId }] : []),
    ...(scopes.creatorId ? [{ scope: "CREATOR" as const, targetId: scopes.creatorId }] : []),
    ...(scopes.campaignId ? [{ scope: "CAMPAIGN" as const, targetId: scopes.campaignId }] : []),
  ];
  const policies = await db.budgetPolicy.findMany({ where: { OR: targets } });
  const paused: BudgetPolicy[] = [];
  for (const p of policies) {
    const spent = (await db.costLedger.aggregate({ where: { ...SCOPE_FILTER[p.scope](p.targetId), isMock: false, occurredAt: { gte: periodStart(p.period, now) } }, _sum: { amountMicros: true } }))._sum.amountMicros ?? 0n;
    if (p.limitMicros > 0n && spent * 100n >= p.limitMicros * BigInt(p.warnAtPercent) && spent < p.limitMicros)
      await notifyOnce(`budget-warn:${p.id}:${periodKey(p, now)}`, {
        severity: "WARNING",
        type: "budget.warning",
        title: `${Number((spent * 100n) / p.limitMicros)}% of the ${await label(p)} used`,
        body: `${formatMoney(spent)} of ${formatMoney(p.limitMicros)} spent this ${p.period === "DAY" ? "day" : "month"}.`,
        link: "/costs",
      });
    if (spent >= p.limitMicros && (await pauseForBudget(p, `Spent ${formatMoney(spent)} this ${p.period === "DAY" ? "day" : "month"}.`, now))) paused.push(p);
  }
  return paused;
}
