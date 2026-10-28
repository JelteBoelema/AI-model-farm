// OpenAI Images adapter. Built against the documented REST format (POST /v1/images/generations,
// /v1/images/edits with image[] reference parts, base64 output, token usage). Model names change
// over time, so the model is configuration; a provider is only used after a successful live
// connection test (see registry readiness).

import type { Usage } from "../pricing";
import { ProviderError, type CostEstimate, type GenerationRequest, type GenerationResult, type ModelCapability, type ProviderAdapter } from "../types";

export const OPENAI_IMAGE_DEFAULT_MODEL = "gpt-image-2";
export const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
const MAX_REFERENCES = 8;
const MAX_PROMPT_CHARS = 30_000;

export interface OpenAiImagesOptions {
  apiKey: string;
  timeoutMs: number;
  baseURL?: string;
  fetch?: typeof fetch;
}

interface OpenAiError {
  error?: { message?: string; code?: string | null; type?: string };
}

export async function mapOpenAiResponseError(res: Response): Promise<ProviderError> {
  let body: OpenAiError = {};
  try {
    body = (await res.json()) as OpenAiError;
  } catch {
    /* non-JSON error body */
  }
  const code = body.error?.code ?? body.error?.type ?? undefined;
  const message = body.error?.message ?? res.statusText;
  if (res.status === 401) return new ProviderError("auth", "OpenAI rejected the API key", { status: 401, providerCode: code });
  if (res.status === 403) return new ProviderError("auth", `OpenAI denied access: ${message}`, { status: 403, providerCode: code });
  if (res.status === 429) {
    if (code === "insufficient_quota" || code === "billing_hard_limit_reached")
      return new ProviderError("quota_exceeded", "OpenAI quota or billing limit reached", { status: 429, providerCode: code });
    const seconds = Number(res.headers.get("retry-after"));
    return new ProviderError("rate_limited", "OpenAI rate limit reached", { status: 429, providerCode: code, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000 });
  }
  if (res.status === 400 && /moderation|safety|content_policy/i.test(`${code} ${message}`))
    return new ProviderError("content_policy", `OpenAI declined this prompt: ${message}`, { status: 400, providerCode: code });
  if (res.status >= 400 && res.status < 500) return new ProviderError("invalid_input", `OpenAI rejected the request: ${message}`, { status: res.status, providerCode: code });
  return new ProviderError("transient", `OpenAI service error (${res.status})`, { status: res.status, providerCode: code });
}

function mapThrown(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError")
    return new ProviderError("timeout", "Image request timed out; the provider may have billed it");
  return new ProviderError("transient", `Could not reach OpenAI: ${(err as Error)?.message ?? "network error"}`);
}

interface ImageResponse {
  created?: number;
  data?: { b64_json?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };
}

export class OpenAiImagesAdapter implements ProviderAdapter {
  readonly key = "openai-images";
  readonly isMock = false;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiImagesOptions) {
    this.base = (options.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  private signal(outer: AbortSignal) {
    return AbortSignal.any([outer, AbortSignal.timeout(this.options.timeoutMs)]);
  }

  private headers(json: boolean): Record<string, string> {
    return { authorization: `Bearer ${this.options.apiKey}`, ...(json ? { "content-type": "application/json" } : {}) };
  }

  async discoverCapabilities(signal: AbortSignal): Promise<ModelCapability[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/models`, { headers: this.headers(false), signal: this.signal(signal) });
    } catch (err) {
      throw mapThrown(err);
    }
    if (!res.ok) throw await mapOpenAiResponseError(res);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? [])
      .filter((m) => /image/i.test(m.id))
      .map((m) => ({ capability: "IMAGE" as const, model: m.id, supportsReferenceImages: true, maxReferenceImages: MAX_REFERENCES, commercialUseAllowed: true }));
  }

  validate(req: GenerationRequest): void {
    if (req.capability !== "IMAGE") throw new ProviderError("invalid_input", "OpenAI Images adapter only handles images");
    if (!req.model) throw new ProviderError("invalid_input", "No model configured");
    if (!req.prompt.trim()) throw new ProviderError("invalid_input", "Empty prompt");
    if (req.prompt.length > MAX_PROMPT_CHARS) throw new ProviderError("invalid_input", "Prompt too long");
    const size = req.params.size ?? "1024x1536";
    if (!(IMAGE_SIZES as readonly unknown[]).includes(size)) throw new ProviderError("invalid_input", `Unsupported size ${String(size)}`);
    const quality = req.params.quality ?? "medium";
    if (!(IMAGE_QUALITIES as readonly unknown[]).includes(quality)) throw new ProviderError("invalid_input", `Unsupported quality ${String(quality)}`);
    if ((req.referenceImages?.length ?? 0) > MAX_REFERENCES) throw new ProviderError("invalid_input", `At most ${MAX_REFERENCES} reference images`);
  }

  estimate(): CostEstimate {
    return { maxUsage: { per_image: 1 }, uncertaintyNote: "Estimated with the configured per-image price; actual cost follows reported token usage" };
  }

  async generate(req: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
    this.validate(req);
    const size = String(req.params.size ?? "1024x1536");
    const quality = String(req.params.quality ?? "medium");
    let res: Response;
    try {
      if (req.referenceImages?.length) {
        const form = new FormData();
        form.set("model", req.model);
        form.set("prompt", req.prompt);
        form.set("size", size);
        form.set("quality", quality);
        form.set("n", "1");
        req.referenceImages.forEach((img, i) =>
          form.append("image[]", new Blob([new Uint8Array(img.bytes)], { type: img.mimeType }), `reference-${i}.${img.mimeType.split("/")[1] ?? "png"}`),
        );
        res = await this.fetchImpl(`${this.base}/images/edits`, { method: "POST", headers: this.headers(false), body: form, signal: this.signal(signal) });
      } else {
        res = await this.fetchImpl(`${this.base}/images/generations`, {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ model: req.model, prompt: req.prompt, size, quality, n: 1 }),
          signal: this.signal(signal),
        });
      }
    } catch (err) {
      throw mapThrown(err);
    }
    if (!res.ok) throw await mapOpenAiResponseError(res);
    const body = (await res.json()) as ImageResponse;
    const b64 = body.data?.[0]?.b64_json;
    if (!b64) throw new ProviderError("transient", "OpenAI returned no image data");
    const u = body.usage;
    const usage: Usage = u
      ? {
          text_input_mtok: u.input_tokens_details?.text_tokens ?? (u.input_tokens_details ? 0 : u.input_tokens ?? 0),
          image_input_mtok: u.input_tokens_details?.image_tokens ?? 0,
          image_output_mtok: u.output_tokens ?? 0,
        }
      : { per_image: 1 };
    return {
      outputs: [{ kind: "image", bytes: Buffer.from(b64, "base64"), mimeType: "image/png" }],
      attempts: [{ model: req.model, usage }],
      servedBy: req.model,
      notes: u ? [] : ["Provider reported no token usage; priced per image"],
    };
  }
}
