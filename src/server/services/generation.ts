// Single execution path for provider calls: pause check → validation → estimate → budget
// reservation → rate limit → call → settlement. Long-running providers (video) split the call into
// submit and poll; their hold stays open in between. Real costs go to the append-only ledger exactly once
// per ledger key and consume the reservation; a call that was not billed releases it. Mock calls
// cost a known zero and are never booked as spend.

import type { AiProvider, CostBasis, CostCategory } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { assertNotPaused } from "../controls";
import { computeCost, parsePricing } from "../providers/pricing";
import { acquireRateLimit, autoPauseProvider, createAdapter, type ProviderConfig } from "../providers/registry";
import { ProviderError, type AttemptUsage, type GenerationRequest, type GenerationResult, type ProviderAdapter } from "../providers/types";
import { db } from "../db";
import { releaseReservation, reserveBudget, settleCharge } from "./cost-manager";

export interface Attribution {
  creatorId?: string | null;
  campaignId?: string | null;
  contentItemId?: string | null;
  generationJobId?: string | null;
}

export interface ExecuteInput {
  provider: AiProvider;
  config: ProviderConfig;
  request: GenerationRequest;
  attribution: Attribution;
  /** Idempotency key of the ledger entry for this attempt. */
  ledgerKey: string;
  purpose: string;
  signal: AbortSignal;
  adapter?: ProviderAdapter;
  /** Production work stops when its creator is paused; prompt tests and the wizard do not need an active creator. */
  checkCreatorPause?: boolean;
}

export interface ExecuteResult {
  result: GenerationResult;
  costMicros: bigint;
  basis: CostBasis;
  note?: string;
}

const CATEGORY: Partial<Record<GenerationRequest["capability"], CostCategory>> = { TEXT: "TOKENS", MODERATION: "TOKENS", IMAGE: "IMAGE", VIDEO: "VIDEO_SECONDS", SPEECH: "AUDIO" };

function billedUnits(req: GenerationRequest): { units: number; unitType: string } | null {
  if (req.capability === "IMAGE") return { units: 1, unitType: "image" };
  if (req.capability === "VIDEO") return { units: Number(req.params.durationSeconds) || 0, unitType: "video_second" };
  if (req.capability === "SPEECH") return { units: req.prompt.length, unitType: "character" };
  return null;
}

export class ChargedProviderError extends ProviderError {
  constructor(
    base: ProviderError,
    readonly costMicros: bigint | null,
    readonly basis: CostBasis | null,
  ) {
    super(base.kind, base.message, base.options);
  }
}

function priceAttempts(provider: AiProvider, attempts: AttemptUsage[]) {
  const pricing = parsePricing(provider.pricing);
  let total = 0n;
  const missing: string[] = [];
  for (const a of attempts) {
    const c = computeCost(pricing, a.model, a.usage);
    if (c.eurMicros === null) missing.push(`${a.model} (${c.missing.join(", ")})`);
    else total += c.eurMicros;
  }
  return { total, missing };
}

async function book(input: ExecuteInput, reservationId: string | null, amountMicros: bigint, basis: CostBasis, note: string | undefined, extra: Record<string, unknown>) {
  if (input.provider.isMock) return;
  const units = billedUnits(input.request);
  await settleCharge(
    {
      amountMicros,
      basis,
      data: {
        entryType: "CHARGE",
        category: CATEGORY[input.request.capability] ?? "OTHER",
        units: units === null ? null : new Prisma.Decimal(units.units),
        unitType: units?.unitType ?? null,
        uncertaintyNote: basis === "ESTIMATED" ? (note ?? "Estimated") : null,
        providerId: input.provider.id,
        creatorId: input.attribution.creatorId ?? null,
        campaignId: input.attribution.campaignId ?? null,
        contentItemId: input.attribution.contentItemId ?? null,
        generationJobId: input.attribution.generationJobId ?? null,
        idempotencyKey: input.ledgerKey,
        metadata: { purpose: input.purpose, model: input.request.model, ...extra } as Prisma.InputJsonValue,
      },
    },
    reservationId,
  );
}

interface Prepared {
  adapter: ProviderAdapter;
  estimateMicros: bigint | null;
  uncertaintyNote: string;
}

async function prepare(input: ExecuteInput): Promise<Prepared> {
  const { provider, request } = input;
  await assertNotPaused({ chain: "generation", providerId: provider.id, campaignId: input.attribution.campaignId ?? null, creatorId: input.checkCreatorPause ? input.attribution.creatorId : null });
  const adapter = input.adapter ?? (await createAdapter(provider));
  adapter.validate(request);
  const estimate = adapter.estimate(request);
  const estimateMicros = computeCost(parsePricing(provider.pricing), request.model, estimate.maxUsage).eurMicros;
  return { adapter, estimateMicros, uncertaintyNote: estimate.uncertaintyNote };
}

async function reserve(input: ExecuteInput, estimateMicros: bigint | null, ttlMs: number): Promise<string | null> {
  if (input.provider.isMock) return null;
  const held = await reserveBudget({
    estimateMicros,
    providerId: input.provider.id,
    creatorId: input.attribution.creatorId,
    campaignId: input.attribution.campaignId,
    contentItemId: input.attribution.contentItemId,
    generationJobId: input.attribution.generationJobId,
    ttlMs,
  });
  return held.id;
}

export async function executeGeneration(input: ExecuteInput): Promise<ExecuteResult> {
  const prepared = await prepare(input);
  const reservationId = await reserve(input, prepared.estimateMicros, input.config.timeoutMs * 2 + 5 * 60_000);
  try {
    await acquireRateLimit(input.provider.id, input.config.maxRequestsPerMinute);
    let result: GenerationResult;
    try {
      result = await prepared.adapter.generate(input.request, input.signal);
    } catch (raw) {
      throw await chargeFailure(input, raw, prepared, reservationId);
    }
    return await settleSuccess(input, result, prepared, reservationId);
  } finally {
    // Every path that billed has consumed the hold already; anything still held was not billed.
    if (reservationId) await releaseReservation(reservationId);
  }
}

/** How long a long-running job may take before it is given up (and its estimate booked). */
export const ASYNC_RESERVATION_TTL_MS = 2 * 60 * 60_000;

/**
 * Starts a long-running generation. The budget hold stays open until pollGeneration settles it (or
 * maintenance releases it after ASYNC_RESERVATION_TTL_MS). Requires `attribution.generationJobId`.
 */
export async function submitGeneration(input: ExecuteInput): Promise<{ providerJobId: string }> {
  if (!input.attribution.generationJobId) throw new Error("submitGeneration needs a generation job");
  const prepared = await prepare(input);
  if (!prepared.adapter.submit) throw new ProviderError("invalid_input", `${input.provider.displayName} does not run long jobs`);
  const reservationId = await reserve(input, prepared.estimateMicros, ASYNC_RESERVATION_TTL_MS);
  try {
    await acquireRateLimit(input.provider.id, input.config.maxRequestsPerMinute);
    return await prepared.adapter.submit(input.request, input.signal);
  } catch (raw) {
    const err = await chargeFailure(input, raw, prepared, reservationId);
    if (reservationId) await releaseReservation(reservationId);
    throw err;
  }
}

/** Checks a long-running generation. Null while it is still running; settles cost when it is done. */
export async function pollGeneration(input: ExecuteInput & { providerJobId: string }): Promise<ExecuteResult | null> {
  const prepared = await prepare({ ...input, checkCreatorPause: false }); // a paid job that already runs is collected even when paused
  if (!prepared.adapter.poll) throw new ProviderError("invalid_input", `${input.provider.displayName} does not run long jobs`);
  const hold = input.provider.isMock ? null : await db.budgetReservation.findFirst({ where: { generationJobId: input.attribution.generationJobId, status: "HELD" }, select: { id: true } });
  let polled;
  try {
    polled = await prepared.adapter.poll(input.providerJobId, input.request, input.signal);
  } catch (raw) {
    const err = raw instanceof ProviderError ? raw : new ProviderError("transient", (raw as Error)?.message ?? "Provider call failed");
    if (err.pausesProvider) await autoPauseProvider(input.provider.id, err);
    // A failed or filtered long job is not billed by the video providers we use; the hold is freed.
    if (!err.retryable && err.kind !== "timeout" && hold) await releaseReservation(hold.id);
    throw err;
  }
  if (!polled.done) return null;
  return settleSuccess(input, polled.result, prepared, hold?.id ?? null);
}

/** Gives up on a long job that never finished: the provider may still bill it, so the estimate is booked. */
export async function abandonGeneration(input: ExecuteInput, reason: string): Promise<{ costMicros: bigint | null }> {
  const prepared = await prepare({ ...input, checkCreatorPause: false });
  if (input.provider.isMock || prepared.estimateMicros === null) return { costMicros: input.provider.isMock ? 0n : null };
  const hold = await db.budgetReservation.findFirst({ where: { generationJobId: input.attribution.generationJobId, status: { in: ["HELD", "RELEASED"] } }, select: { id: true, status: true } });
  await book(input, hold?.status === "HELD" ? hold.id : null, prepared.estimateMicros, "ESTIMATED", `${reason}; outcome unknown. ${prepared.uncertaintyNote}`, { error: "abandoned" });
  return { costMicros: prepared.estimateMicros };
}

async function chargeFailure(input: ExecuteInput, raw: unknown, prepared: Prepared, reservationId: string | null): Promise<ProviderError> {
  const { provider } = input;
  const err = raw instanceof ProviderError ? raw : new ProviderError("transient", (raw as Error)?.message ?? "Provider call failed");
  if (err.pausesProvider) await autoPauseProvider(provider.id, err);
  if (provider.isMock) return err;
  if (err.kind === "timeout" && prepared.estimateMicros !== null) {
    // The outcome is unknown and the provider may have billed: book the conservative estimate.
    const note = `Timed out; outcome unknown. ${prepared.uncertaintyNote}`;
    await book(input, reservationId, prepared.estimateMicros, "ESTIMATED", note, { error: err.kind });
    return new ChargedProviderError(err, prepared.estimateMicros, "ESTIMATED");
  }
  const attempts = (raw as { attempts?: AttemptUsage[] }).attempts;
  if (attempts?.length) {
    // e.g. a refusal after output: those tokens are billed.
    const priced = priceAttempts(provider, attempts);
    const amount = priced.missing.length ? prepared.estimateMicros : priced.total;
    if (amount !== null) {
      const basis: CostBasis = priced.missing.length ? "ESTIMATED" : "MEASURED";
      await book(input, reservationId, amount, basis, priced.missing.length ? `Price missing for ${priced.missing.join("; ")}` : undefined, { error: err.kind, attempts });
      return new ChargedProviderError(err, amount, basis);
    }
  }
  return err;
}

async function settleSuccess(input: ExecuteInput, result: GenerationResult, prepared: Prepared, reservationId: string | null): Promise<ExecuteResult> {
  const { provider } = input;
  if (provider.isMock) return { result, costMicros: 0n, basis: "MEASURED", note: "Mock provider" };
  const priced = priceAttempts(provider, result.attempts);
  if (priced.missing.length) {
    const note = `Price missing for ${priced.missing.join("; ")}; booked the conservative estimate. ${prepared.uncertaintyNote}`;
    await book(input, reservationId, prepared.estimateMicros!, "ESTIMATED", note, { attempts: result.attempts, servedBy: result.servedBy });
    return { result, costMicros: prepared.estimateMicros!, basis: "ESTIMATED", note };
  }
  await book(input, reservationId, priced.total, "MEASURED", undefined, { attempts: result.attempts, servedBy: result.servedBy, requestId: result.providerRequestId });
  return { result, costMicros: priced.total, basis: "MEASURED", note: result.notes.join("; ") || undefined };
}
