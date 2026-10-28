// Provider registry: configuration, readiness, selection, verification and automatic pausing.
// A real provider is used only when its adapter exists, its credential resolves, a model is set,
// a price list covers that model, and a live connection test confirmed the model is available.
// Outside mock mode there is never a silent fallback to a mock provider.

import type { AiProvider, Prisma, ProviderCapability, ProviderStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { env } from "../env";
import { recordAudit, SYSTEM_ACTOR, type Actor } from "../audit";
import { findActivePause, setControlSwitch } from "../controls";
import { DomainError } from "../errors";
import { redis } from "../redis";
import { isSecretConfigured, requireSecret } from "../secrets";
import { AnthropicAdapter } from "./adapters/anthropic";
import { ElevenLabsAdapter } from "./adapters/elevenlabs";
import { VeoAdapter } from "./adapters/google-veo";
import { MockImageAdapter, MockTextAdapter, MockVideoAdapter } from "./adapters/mock";
import { IMAGE_QUALITIES, IMAGE_SIZES, OpenAiImagesAdapter } from "./adapters/openai-images";
import { PROVIDER_CATALOG, type CatalogEntry } from "./catalog";
import { assertHuman } from "../services/policy";
import { hasPrice, parsePricing, type PriceUnit } from "./pricing";
import { ProviderError, type ProviderAdapter } from "./types";

export const providerConfigSchema = z.object({
  model: z.string().trim().min(1).max(100).optional(),
  bulkModel: z.string().trim().min(1).max(100).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  imageSize: z.enum(IMAGE_SIZES).optional(),
  imageQuality: z.enum(IMAGE_QUALITIES).optional(),
  /** Default synthetic voice (speech providers); a creator may override it in prompt settings. */
  voiceId: z.string().trim().regex(/^[A-Za-z0-9]{8,64}$/, "Voice ids are 8–64 letters and digits").optional(),
  maxRequestsPerMinute: z.number().int().min(1).max(10_000).default(30),
  timeoutMs: z.number().int().min(5_000).max(600_000).default(120_000),
  verifiedAt: z.string().datetime().optional(),
  verifiedModels: z.array(z.string()).max(200).optional(),
  verificationError: z.string().max(500).optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export function parseConfig(stored: unknown): ProviderConfig {
  const r = providerConfigSchema.safeParse(stored ?? {});
  return r.success ? r.data : providerConfigSchema.parse({});
}

/** Units a price list must contain before the provider may run paid jobs. */
export const REQUIRED_PRICE_UNITS: Partial<Record<ProviderCapability, PriceUnit[]>> = {
  TEXT: ["input_mtok", "output_mtok"],
  IMAGE: ["per_image"],
  VIDEO: ["video_second"],
  SPEECH: ["speech_kchar"],
};

const MOCK_FOR: Partial<Record<ProviderCapability, string>> = { TEXT: "mock-text", MODERATION: "mock-text", IMAGE: "mock-image", VIDEO: "mock-video", SPEECH: "mock-video" };

type AdapterFactory = (row: AiProvider, config: ProviderConfig) => Promise<ProviderAdapter>;

const FACTORIES: Record<string, AdapterFactory> = {
  "mock-text": async () => new MockTextAdapter(),
  "mock-image": async () => new MockImageAdapter(),
  "mock-video": async () => new MockVideoAdapter(),
  "google-veo": async (row, config) => new VeoAdapter({ apiKey: await requireSecret(row.credentialRef!), timeoutMs: config.timeoutMs }),
  elevenlabs: async (row, config) => new ElevenLabsAdapter({ apiKey: await requireSecret(row.credentialRef!), timeoutMs: config.timeoutMs }),
  anthropic: async (row, config) => new AnthropicAdapter({ apiKey: await requireSecret(row.credentialRef!), timeoutMs: config.timeoutMs, effort: config.effort }),
  "openai-images": async (row, config) => new OpenAiImagesAdapter({ apiKey: await requireSecret(row.credentialRef!), timeoutMs: config.timeoutMs }),
};

// Tests may register stand-in adapters for a provider key.
const overrides = new Map<string, AdapterFactory>();
export function registerAdapterOverride(key: string, factory: AdapterFactory | null) {
  if (factory) overrides.set(key, factory);
  else overrides.delete(key);
}

export async function createAdapter(row: AiProvider): Promise<ProviderAdapter> {
  const factory = overrides.get(row.key) ?? FACTORIES[row.key];
  if (!factory) throw new DomainError(`No adapter is implemented for ${row.displayName}`);
  return factory(row, parseConfig(row.config));
}

export interface ReadinessCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface Readiness {
  ready: boolean;
  checks: ReadinessCheck[];
}

export async function evaluateReadiness(row: AiProvider): Promise<Readiness> {
  const entry = PROVIDER_CATALOG.find((c) => c.key === row.key);
  const config = parseConfig(row.config);
  const pricing = parsePricing(row.pricing);
  const checks: ReadinessCheck[] = [];
  const implemented = (entry !== undefined && entry.adapterPhase === null) || overrides.has(row.key);
  checks.push({ label: "Adapter", ok: implemented, detail: implemented ? undefined : entry?.adapterPhase ? `Planned for phase ${entry.adapterPhase}` : "Not implemented" });
  if (!implemented) return { ready: false, checks };
  checks.push({ label: "Enabled", ok: row.status !== "DISABLED", detail: row.status === "DISABLED" ? "Disabled by an admin" : undefined });
  checks.push({ label: "Model", ok: !!config.model, detail: config.model ?? "No model configured" });
  if (!row.isMock && row.capabilities.includes("SPEECH")) checks.push({ label: "Voice", ok: !!config.voiceId, detail: config.voiceId ?? "Choose a designed (synthetic) voice id" });
  if (!row.isMock) {
    const credential = await isSecretConfigured(row.credentialRef);
    checks.push({ label: "Credential", ok: credential, detail: credential ? row.credentialRef! : `${row.credentialRef} is not set` });
    const units = row.capabilities.flatMap((c) => REQUIRED_PRICE_UNITS[c] ?? []);
    const priced = !!config.model && hasPrice(pricing, config.model, units);
    checks.push({ label: "Price list", ok: priced, detail: priced ? `Source: ${pricing!.source}` : `Needs ${units.join(", ")} for ${config.model ?? "the model"}` });
    const verified = !!config.verifiedAt && !!config.model && (config.verifiedModels ?? []).includes(config.model);
    checks.push({
      label: "Connection test",
      ok: verified,
      detail: verified ? `Verified ${config.verifiedAt}` : (config.verificationError ?? "Run a connection test with a real key"),
    });
  }
  return { ready: checks.every((c) => c.ok), checks };
}

async function statusFor(row: AiProvider): Promise<ProviderStatus> {
  if (row.status === "DISABLED") return "DISABLED";
  return (await evaluateReadiness(row)).ready ? "ACTIVE" : "NOT_CONFIGURED";
}

async function refreshStatus(id: string) {
  const row = await db.aiProvider.findUniqueOrThrow({ where: { id } });
  const status = await statusFor(row);
  if (status !== row.status) await db.aiProvider.update({ where: { id }, data: { status } });
  return status;
}

/** Upserts catalog rows (new rows get default config; mocks get an explicit zero price) and recomputes status. */
export async function syncProviderRegistry(): Promise<void> {
  for (const entry of PROVIDER_CATALOG) {
    const existing = await db.aiProvider.findUnique({ where: { key: entry.key } });
    const config = { ...(entry.defaultConfig ?? {}), ...((existing?.config as object) ?? {}) } as Prisma.InputJsonValue;
    const mockPricing = entry.isMock ? { currency: "EUR", source: "urn:creator-farm:mock", updatedAt: new Date(0).toISOString(), free: true, models: {} } : undefined;
    const row = await db.aiProvider.upsert({
      where: { key: entry.key },
      create: {
        key: entry.key,
        displayName: entry.displayName,
        capabilities: entry.capabilities,
        credentialRef: entry.credentialRef,
        isMock: entry.isMock,
        priority: entry.priority,
        config,
        ...(mockPricing ? { pricing: mockPricing } : {}),
      },
      update: { displayName: entry.displayName, capabilities: entry.capabilities, credentialRef: entry.credentialRef, isMock: entry.isMock, config, ...(mockPricing ? { pricing: mockPricing } : {}) },
    });
    await refreshStatus(row.id);
  }
}

/**
 * Picks the provider for a capability. Mock mode always uses the mock provider. Otherwise the
 * highest-priority ready, non-paused real provider; none available is an error, never a mock.
 */
export async function selectProvider(capability: ProviderCapability): Promise<{ row: AiProvider; config: ProviderConfig }> {
  if (env().MOCK_MODE) {
    const key = MOCK_FOR[capability];
    const row = key ? await db.aiProvider.findUnique({ where: { key } }) : null;
    if (!row || !(await evaluateReadiness(row)).ready) throw new DomainError(`Mock mode is on but no mock provider handles ${capability.toLowerCase()}`);
    return { row, config: parseConfig(row.config) };
  }
  const candidates = await db.aiProvider.findMany({ where: { capabilities: { has: capability }, isMock: false, status: { not: "DISABLED" } }, orderBy: { priority: "asc" } });
  for (const row of candidates) {
    if (!(await evaluateReadiness(row)).ready) continue;
    if (await findActivePause({ chain: "generation", providerId: row.id })) continue;
    return { row, config: parseConfig(row.config) };
  }
  throw new DomainError(`No ready ${capability.toLowerCase()} provider. Configure one under AI Providers (key, model, price list, connection test).`);
}

export interface VerificationResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/** Live connection test: lists the provider's models and checks the configured model is among them. */
export async function verifyProvider(actor: Actor, providerId: string): Promise<VerificationResult> {
  const row = await db.aiProvider.findUnique({ where: { id: providerId } });
  if (!row) throw new DomainError("Provider not found");
  const config = parseConfig(row.config);
  let result: VerificationResult;
  try {
    const adapter = await createAdapter(row);
    const caps = await adapter.discoverCapabilities(AbortSignal.timeout(15_000));
    const models = [...new Set(caps.map((c) => c.model))].slice(0, 200);
    const ok = !!config.model && models.includes(config.model);
    result = { ok, models, error: ok ? undefined : `Model "${config.model ?? "(none)"}" is not available to this account` };
  } catch (err) {
    const message = err instanceof ProviderError || err instanceof DomainError ? err.message : "Connection test failed";
    result = { ok: false, models: [], error: message };
  }
  const next: ProviderConfig = {
    ...config,
    verifiedAt: result.ok ? new Date().toISOString() : undefined,
    verifiedModels: result.models.length ? result.models : config.verifiedModels,
    verificationError: result.error,
  };
  await db.aiProvider.update({ where: { id: providerId }, data: { config: next as Prisma.InputJsonValue } });
  await refreshStatus(providerId);
  await recordAudit(actor, { action: result.ok ? "provider.verified" : "provider.verification_failed", entityType: "ai_provider", entityId: providerId, metadata: { model: config.model, error: result.error } });
  return result;
}

/** Changing the model clears the previous verification: a new model needs its own connection test. */
export async function updateProviderConfig(actor: Actor, providerId: string, patch: Partial<Pick<ProviderConfig, "model" | "bulkModel" | "effort" | "imageSize" | "imageQuality" | "voiceId" | "maxRequestsPerMinute" | "timeoutMs">>) {
  assertHuman(actor); // rate limits and prices are limits too
  const row = await db.aiProvider.findUnique({ where: { id: providerId } });
  if (!row) throw new DomainError("Provider not found");
  const current = parseConfig(row.config);
  const next = providerConfigSchema.parse({ ...current, ...patch });
  if (next.model !== current.model) {
    next.verifiedAt = undefined;
    next.verificationError = undefined;
  }
  await db.aiProvider.update({ where: { id: providerId }, data: { config: next as Prisma.InputJsonValue } });
  await refreshStatus(providerId);
  await recordAudit(actor, { action: "provider.config_changed", entityType: "ai_provider", entityId: providerId, metadata: { before: current, after: next } });
}

export async function setProviderPricing(actor: Actor, providerId: string, pricing: unknown) {
  assertHuman(actor); // rate limits and prices are limits too
  const row = await db.aiProvider.findUnique({ where: { id: providerId } });
  if (!row) throw new DomainError("Provider not found");
  if (row.isMock) throw new DomainError("Mock providers have a fixed zero price");
  const parsed = parsePricing(pricing);
  if (!parsed) throw new DomainError("Invalid price list");
  if (parsed.free) throw new DomainError("Only mock providers can be free");
  await db.aiProvider.update({ where: { id: providerId }, data: { pricing: parsed as Prisma.InputJsonValue } });
  await refreshStatus(providerId);
  await recordAudit(actor, { action: "provider.pricing_changed", entityType: "ai_provider", entityId: providerId, metadata: { before: row.pricing, after: parsed } });
}

export async function setProviderEnabled(actor: Actor, providerId: string, enabled: boolean) {
  assertHuman(actor); // rate limits and prices are limits too
  const row = await db.aiProvider.findUnique({ where: { id: providerId } });
  if (!row) throw new DomainError("Provider not found");
  await db.aiProvider.update({ where: { id: providerId }, data: { status: enabled ? "NOT_CONFIGURED" : "DISABLED" } });
  if (enabled) await refreshStatus(providerId);
  await recordAudit(actor, { action: enabled ? "provider.enabled" : "provider.disabled", entityType: "ai_provider", entityId: providerId });
}

/** Credential or billing failures pause the provider until an admin resumes it. */
export async function autoPauseProvider(providerId: string, err: ProviderError) {
  const existing = await findActivePause({ chain: "generation", providerId });
  if (existing?.scope === "PROVIDER") return;
  await setControlSwitch(SYSTEM_ACTOR, { scope: "PROVIDER", targetId: providerId, paused: true, reason: `Automatic: ${err.message}` });
  await db.notification.create({
    data: { severity: "CRITICAL", type: "provider.auto_paused", title: "AI provider paused automatically", body: err.message, link: "/providers" },
  });
}

/** Our own per-provider request limit was reached: nothing was sent to the provider or billed. */
export class LocalRateLimitError extends ProviderError {
  constructor(message: string, retryAfterMs: number) {
    super("rate_limited", message, { retryAfterMs });
    this.name = "LocalRateLimitError";
  }
}

// Fixed one-minute window per provider in Redis.
export async function acquireRateLimit(providerId: string, maxPerMinute: number, now = Date.now()): Promise<void> {
  const minute = Math.floor(now / 60_000);
  const key = `cf:rl:provider:${providerId}:${minute}`;
  const count = await redis().incr(key);
  if (count === 1) await redis().expire(key, 70);
  if (count > maxPerMinute) {
    throw new LocalRateLimitError(`Provider limit of ${maxPerMinute} requests per minute reached`, (minute + 1) * 60_000 - now + 250);
  }
}

export function catalogEntry(key: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((c) => c.key === key);
}
