// Anthropic Claude adapter (text). Uses the official SDK. Retries are owned by the job queue, so the
// SDK's own retries are disabled to keep every billed attempt visible.

import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "../pricing";
import { ProviderError, type AttemptUsage, type CostEstimate, type GenerationRequest, type GenerationResult, type ModelCapability, type ProviderAdapter } from "../types";

export const ANTHROPIC_API_URL = "https://api.anthropic.com";
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_BULK_MODEL = "claude-haiku-5-5";
const DEFAULT_MAX_TOKENS = 16_000;
const MAX_PROMPT_CHARS = 400_000;
// Claude Haiku 5.5 bills prompts above 100K input tokens at a higher rate.
const LONG_CONTEXT_MODELS: Record<string, number> = { "claude-haiku-5-5": 100_000 };
// Server-side refusal fallback ("default" routing). Not offered for Haiku models.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const supportsFallback = (model: string) => !model.startsWith("claude-haiku");
// Images (e.g. for visual quality control). The estimate assumes a generous per-image token count
// because the exact figure depends on the resolution the API resizes to.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TOKEN_ESTIMATE = 6_000;

export interface AnthropicAdapterOptions {
  apiKey: string;
  timeoutMs: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Injected in tests. */
  fetch?: typeof fetch;
  baseURL?: string;
}

function usageUnits(model: string, u: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): Usage {
  const prompt = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const threshold = LONG_CONTEXT_MODELS[model];
  if (threshold !== undefined && prompt > threshold) {
    // Priced under the long-context units; a missing price makes the cost an explicit estimate.
    return { long_input_mtok: prompt, long_output_mtok: u.output_tokens };
  }
  return {
    input_mtok: u.input_tokens,
    output_mtok: u.output_tokens,
    cache_write_mtok: u.cache_creation_input_tokens ?? 0,
    cache_read_mtok: u.cache_read_input_tokens ?? 0,
  };
}

export function mapAnthropicError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("timeout", "Request aborted (time limit); the provider may have billed it");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("timeout", "Request timed out; the provider may have billed it");
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError("transient", "Could not reach the Anthropic API");
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError("auth", "Anthropic rejected the API key", { status: 401 });
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError("auth", "The API key is not allowed to use this model or feature", { status: 403 });
  if (err instanceof Anthropic.NotFoundError) return new ProviderError("invalid_input", "Model not found or not available to this organization", { status: 404 });
  if (err instanceof Anthropic.RateLimitError) {
    const seconds = Number(err.headers?.get("retry-after"));
    return new ProviderError("rate_limited", "Anthropic rate limit reached", { status: 429, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000 });
  }
  if (err instanceof Anthropic.BadRequestError) return new ProviderError("invalid_input", `Request rejected: ${err.message}`, { status: 400 });
  if (err instanceof Anthropic.InternalServerError) return new ProviderError("transient", `Anthropic service error (${err.status})`, { status: err.status });
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) return new ProviderError("quota_exceeded", "Anthropic billing problem: check the account's credit", { status: 402 });
    if (err.status === 413) return new ProviderError("invalid_input", "Request too large", { status: 413 });
    return new ProviderError("transient", `Anthropic API error ${err.status ?? ""}`.trim(), { status: err.status });
  }
  return new ProviderError("transient", (err as Error)?.message ?? "Unknown error");
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly key = "anthropic";
  readonly isMock = false;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicAdapterOptions) {
    // The base URL is pinned: the SDK would otherwise honour ANTHROPIC_BASE_URL from the environment,
    // which could send the API key to another host.
    this.client = new Anthropic({ apiKey: options.apiKey, maxRetries: 0, timeout: options.timeoutMs, fetch: options.fetch, baseURL: options.baseURL ?? ANTHROPIC_API_URL });
  }

  async discoverCapabilities(signal: AbortSignal): Promise<ModelCapability[]> {
    try {
      const models: ModelCapability[] = [];
      for await (const m of this.client.models.list({ limit: 100 }, { signal })) {
        models.push({ capability: "TEXT", model: m.id, commercialUseAllowed: true });
      }
      return models;
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }

  validate(req: GenerationRequest): void {
    if (req.capability !== "TEXT") throw new ProviderError("invalid_input", "Anthropic adapter only handles text generation");
    if (!req.model) throw new ProviderError("invalid_input", "No model configured");
    if (!req.prompt.trim()) throw new ProviderError("invalid_input", "Empty prompt");
    if (req.prompt.length + (req.system?.length ?? 0) > MAX_PROMPT_CHARS) throw new ProviderError("invalid_input", "Prompt too long");
    const max = req.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
    if (!Number.isInteger(max) || max < 1 || max > 64_000) throw new ProviderError("invalid_input", "maxOutputTokens must be 1–64000");
    const images = req.referenceImages ?? [];
    if (images.length > MAX_IMAGES) throw new ProviderError("invalid_input", `At most ${MAX_IMAGES} images per request`);
    for (const img of images) {
      if (!(IMAGE_TYPES as readonly string[]).includes(img.mimeType)) throw new ProviderError("invalid_input", `Unsupported image type ${img.mimeType}`);
      if (img.bytes.length > MAX_IMAGE_BYTES) throw new ProviderError("invalid_input", "Image larger than 5 MB");
    }
  }

  estimate(req: GenerationRequest): CostEstimate {
    // Conservative: ~3 characters per token (real text is usually closer to 4), and the full
    // max_tokens of output, which includes thinking tokens on current models.
    const inputTokens = Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 3) + 50 + (req.referenceImages?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
    const outputTokens = req.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
    return {
      maxUsage: usageUnits(req.model, { input_tokens: inputTokens, output_tokens: outputTokens }),
      uncertaintyNote: `Upper bound: ~${inputTokens} input tokens (chars/3) and ${outputTokens} output tokens (max_tokens incl. thinking)`,
    };
  }

  async generate(req: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
    this.validate(req);
    const fallback = supportsFallback(req.model);
    let response;
    try {
      response = await this.client.beta.messages.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
          ...(req.system ? { system: req.system } : {}),
          messages: [
            {
              role: "user",
              content: req.referenceImages?.length
                ? [
                    ...req.referenceImages.map((img) => ({
                      type: "image" as const,
                      source: { type: "base64" as const, media_type: img.mimeType as (typeof IMAGE_TYPES)[number], data: img.bytes.toString("base64") },
                    })),
                    { type: "text" as const, text: req.prompt },
                  ]
                : req.prompt,
            },
          ],
          output_config: {
            effort: (req.params.effort as AnthropicAdapterOptions["effort"]) ?? this.options.effort ?? "medium",
            ...(req.jsonSchema ? { format: { type: "json_schema" as const, schema: req.jsonSchema } } : {}),
          },
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
        },
        { signal },
      );
    } catch (err) {
      throw mapAnthropicError(err);
    }

    // Billing: usage.iterations lists every attempt (a declined attempt plus the fallback that served).
    const attempts: AttemptUsage[] = [];
    for (const it of response.usage.iterations ?? []) {
      if (it.type === "fallback_message") attempts.push({ model: it.model, usage: usageUnits(it.model, it) });
      else if (it.type === "message") attempts.push({ model: req.model, usage: usageUnits(req.model, it) });
    }
    if (attempts.length === 0) attempts.push({ model: response.model, usage: usageUnits(response.model, response.usage) });

    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unspecified";
      throw Object.assign(new ProviderError("content_policy", `Claude declined this request (category: ${category})`), { attempts });
    }
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const notes: string[] = [];
    if (response.stop_reason === "max_tokens") notes.push("Output truncated at max_tokens");
    if (response.model !== req.model) notes.push(`Served by fallback model ${response.model}`);
    return { outputs: [{ kind: "text", text }], attempts, servedBy: response.model, providerRequestId: response.id, notes };
  }
}
