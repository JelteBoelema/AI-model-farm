// Single execution path for provider calls: pause check → validation → estimate → budget guard →
// rate limit → call → cost booking. Real costs go to the append-only ledger exactly once per
// ledger key; mock calls cost a known zero and are never booked as spend.

import type { AiProvider, CostBasis, CostCategory } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { assertNotPaused } from "../controls";
import { computeCost, parsePricing } from "../providers/pricing";
import { acquireRateLimit, autoPauseProvider, createAdapter, type ProviderConfig } from "../providers/registry";
import { ProviderError, type AttemptUsage, type GenerationRequest, type GenerationResult, type ProviderAdapter } from "../providers/types";
import { assertSpendAllowed } from "./spend-guard";

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
}

export interface ExecuteResult {
  result: GenerationResult;
  costMicros: bigint;
  basis: CostBasis;
  note?: string;
}

const CATEGORY: Partial<Record<GenerationRequest["capability"], CostCategory>> = { TEXT: "TOKENS", MODERATION: "TOKENS", IMAGE: "IMAGE" };

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

async function book(input: ExecuteInput, amountMicros: bigint, basis: CostBasis, note: string | undefined, extra: Record<string, unknown>) {
  if (input.provider.isMock) return;
  const units = input.request.capability === "IMAGE" ? 1 : null;
  // skipDuplicates: the same ledger key twice (a retried bookkeeping step) keeps the first booking.
  await db.costLedger.createMany({
    skipDuplicates: true,
    data: [
      {
        entryType: "CHARGE",
        category: CATEGORY[input.request.capability] ?? "OTHER",
        basis,
        amountMicros,
        units: units === null ? null : new Prisma.Decimal(units),
        unitType: units === null ? null : "image",
        uncertaintyNote: basis === "ESTIMATED" ? (note ?? "Estimated") : null,
        providerId: input.provider.id,
        creatorId: input.attribution.creatorId ?? null,
        campaignId: input.attribution.campaignId ?? null,
        contentItemId: input.attribution.contentItemId ?? null,
        generationJobId: input.attribution.generationJobId ?? null,
        idempotencyKey: input.ledgerKey,
        metadata: { purpose: input.purpose, model: input.request.model, ...extra } as Prisma.InputJsonValue,
      },
    ],
  });
}

export async function executeGeneration(input: ExecuteInput): Promise<ExecuteResult> {
  const { provider, config, request } = input;
  await assertNotPaused({ chain: "generation", providerId: provider.id, campaignId: input.attribution.campaignId ?? null });

  const adapter = input.adapter ?? (await createAdapter(provider));
  adapter.validate(request);
  const estimate = adapter.estimate(request);
  const estimateMicros = computeCost(parsePricing(provider.pricing), request.model, estimate.maxUsage).eurMicros;
  if (!provider.isMock) {
    await assertSpendAllowed({ estimateMicros, providerId: provider.id, creatorId: input.attribution.creatorId, campaignId: input.attribution.campaignId });
  }
  await acquireRateLimit(provider.id, config.maxRequestsPerMinute);

  let result: GenerationResult;
  try {
    result = await adapter.generate(request, input.signal);
  } catch (raw) {
    const err = raw instanceof ProviderError ? raw : new ProviderError("transient", (raw as Error)?.message ?? "Provider call failed");
    if (err.pausesProvider) await autoPauseProvider(provider.id, err);
    if (provider.isMock) throw err;
    if (err.kind === "timeout" && estimateMicros !== null) {
      // The outcome is unknown and the provider may have billed: book the conservative estimate.
      const note = `Timed out; outcome unknown. ${estimate.uncertaintyNote}`;
      await book(input, estimateMicros, "ESTIMATED", note, { error: err.kind });
      throw new ChargedProviderError(err, estimateMicros, "ESTIMATED");
    }
    const attempts = (raw as { attempts?: AttemptUsage[] }).attempts;
    if (attempts?.length) {
      // e.g. a refusal after output: those tokens are billed.
      const priced = priceAttempts(provider, attempts);
      const amount = priced.missing.length ? estimateMicros : priced.total;
      if (amount !== null) {
        const basis: CostBasis = priced.missing.length ? "ESTIMATED" : "MEASURED";
        await book(input, amount, basis, priced.missing.length ? `Price missing for ${priced.missing.join("; ")}` : undefined, { error: err.kind, attempts });
        throw new ChargedProviderError(err, amount, basis);
      }
    }
    throw err;
  }

  if (provider.isMock) return { result, costMicros: 0n, basis: "MEASURED", note: "Mock provider" };

  const priced = priceAttempts(provider, result.attempts);
  if (priced.missing.length) {
    const note = `Price missing for ${priced.missing.join("; ")}; booked the conservative estimate. ${estimate.uncertaintyNote}`;
    await book(input, estimateMicros!, "ESTIMATED", note, { attempts: result.attempts, servedBy: result.servedBy });
    return { result, costMicros: estimateMicros!, basis: "ESTIMATED", note };
  }
  await book(input, priced.total, "MEASURED", undefined, { attempts: result.attempts, servedBy: result.servedBy, requestId: result.providerRequestId });
  return { result, costMicros: priced.total, basis: "MEASURED", note: result.notes.join("; ") || undefined };
}
