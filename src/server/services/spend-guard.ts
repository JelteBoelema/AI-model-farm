// Pre-flight budget check for paid provider calls. Every applicable hard limit must leave room for
// the conservative estimate: farm-wide month/day, creator, campaign and provider budgets, plus the
// autonomy policy's maximum cost per job. (Phase 5 adds reservations on top of this check.)

import type { BudgetPeriod, BudgetScope, Prisma } from "@prisma/client";
import { formatMoney } from "@/lib/money";
import { db } from "../db";
import { DomainError } from "../errors";

export class BudgetBlockedError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "BudgetBlockedError";
  }
}

export interface SpendContext {
  estimateMicros: bigint | null;
  providerId: string;
  creatorId?: string | null;
  campaignId?: string | null;
  now?: Date;
}

function periodStart(period: BudgetPeriod, now: Date) {
  return period === "MONTH" ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const SCOPE_FILTER: Record<BudgetScope, (id: string | null) => Prisma.CostLedgerWhereInput> = {
  GLOBAL: () => ({}),
  CREATOR: (id) => ({ creatorId: id }),
  CAMPAIGN: (id) => ({ campaignId: id }),
  PROVIDER: (id) => ({ providerId: id }),
};

export async function assertSpendAllowed(ctx: SpendContext): Promise<void> {
  const now = ctx.now ?? new Date();
  if (ctx.estimateMicros === null) throw new BudgetBlockedError("The cost of this call cannot be estimated (missing price). Add the price under AI Providers.");

  const globalMonth = await db.budgetPolicy.findFirst({ where: { scope: "GLOBAL", period: "MONTH" } });
  if (!globalMonth) throw new BudgetBlockedError("No farm-wide monthly budget is set; paid generation stays blocked until an owner sets one.");

  const autonomy = await db.autonomyPolicy.findFirst({ where: { scope: "GLOBAL" } });
  if (autonomy?.maxCostPerJobMicros != null && ctx.estimateMicros > autonomy.maxCostPerJobMicros)
    throw new BudgetBlockedError(`Estimated cost ${formatMoney(ctx.estimateMicros, "EUR", 4)} exceeds the maximum per job (${formatMoney(autonomy.maxCostPerJobMicros)}).`);

  const targets: { scope: BudgetScope; id: string | null }[] = [
    { scope: "GLOBAL", id: null },
    { scope: "PROVIDER", id: ctx.providerId },
    ...(ctx.creatorId ? [{ scope: "CREATOR" as const, id: ctx.creatorId }] : []),
    ...(ctx.campaignId ? [{ scope: "CAMPAIGN" as const, id: ctx.campaignId }] : []),
  ];
  const policies = await db.budgetPolicy.findMany({ where: { OR: targets.map((t) => ({ scope: t.scope, targetId: t.id })) } });

  for (const p of policies) {
    const since = periodStart(p.period, now);
    const scoped = SCOPE_FILTER[p.scope](p.targetId);
    const [spent, held] = await Promise.all([
      db.costLedger.aggregate({ where: { ...scoped, isMock: false, occurredAt: { gte: since } }, _sum: { amountMicros: true } }),
      db.budgetReservation.aggregate({
        where: { status: "HELD", ...(p.scope === "GLOBAL" ? {} : p.scope === "CREATOR" ? { creatorId: p.targetId } : p.scope === "CAMPAIGN" ? { campaignId: p.targetId } : { providerId: p.targetId }) },
        _sum: { amountMicros: true },
      }),
    ]);
    const used = (spent._sum.amountMicros ?? 0n) + (held._sum.amountMicros ?? 0n);
    if (used + ctx.estimateMicros > p.limitMicros) {
      const label = p.scope === "GLOBAL" ? "farm-wide" : p.scope.toLowerCase();
      const period = p.period === "DAY" ? "daily" : "monthly";
      throw new BudgetBlockedError(
        `The ${label} ${period} budget of ${formatMoney(p.limitMicros)} would be exceeded (used ${formatMoney(used)}, this call up to ${formatMoney(ctx.estimateMicros, "EUR", 4)}).`,
      );
    }
  }
}
