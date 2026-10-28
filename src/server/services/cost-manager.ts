// Cost manager: estimate → reservation → settlement → release. A paid provider call first holds its
// conservative estimate against every applicable budget (under a lock, so two jobs cannot both fit
// into the last euro), then the hold is consumed by the ledger charge or released when nothing was
// billed. Holds that never settle (crashed worker) expire through the maintenance queue.

import type { CostBasis, Prisma } from "@prisma/client";
import { db } from "../db";
import { assertSpendAllowed, type SpendContext } from "./spend-guard";

// Arbitrary constant key for the transaction-scoped advisory lock that serialises reservations.
const BUDGET_LOCK_KEY = 727_001;

export interface ReserveInput extends SpendContext {
  estimateMicros: bigint | null;
  contentItemId?: string | null;
  generationJobId?: string | null;
  /** How long the hold may stay open before maintenance releases it. */
  ttlMs: number;
}

export async function reserveBudget(input: ReserveInput): Promise<{ id: string; amountMicros: bigint }> {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`;
    await assertSpendAllowed(input, tx);
    return tx.budgetReservation.create({
      data: {
        providerId: input.providerId,
        creatorId: input.creatorId ?? null,
        campaignId: input.campaignId ?? null,
        contentItemId: input.contentItemId ?? null,
        generationJobId: input.generationJobId ?? null,
        amountMicros: input.estimateMicros!,
        basis: "ESTIMATED",
        expiresAt: new Date(now.getTime() + input.ttlMs),
      },
      select: { id: true, amountMicros: true },
    });
  });
}

type Tx = Prisma.TransactionClient;

/** Marks a hold as used up by the charge booked in the same transaction. No-op if already settled. */
export function consumeReservation(tx: Tx, id: string) {
  return tx.budgetReservation.updateMany({ where: { id, status: "HELD" }, data: { status: "CONSUMED", settledAt: new Date() } });
}

/** Frees a hold when the call was not billed (blocked, rejected before work, rate limited). */
export async function releaseReservation(id: string) {
  await db.budgetReservation.updateMany({ where: { id, status: "HELD" }, data: { status: "RELEASED", settledAt: new Date() } });
}

export interface LedgerCharge {
  amountMicros: bigint;
  basis: CostBasis;
  data: Omit<Prisma.CostLedgerCreateManyInput, "amountMicros" | "basis">;
}

/**
 * Books a charge and settles its hold atomically. The ledger's idempotency key makes a repeated
 * settlement (retried bookkeeping) a no-op.
 */
export async function settleCharge(charge: LedgerCharge, reservationId: string | null) {
  await db.$transaction(async (tx) => {
    await tx.costLedger.createMany({ skipDuplicates: true, data: [{ ...charge.data, amountMicros: charge.amountMicros, basis: charge.basis }] });
    if (reservationId) await consumeReservation(tx, reservationId);
  });
}
