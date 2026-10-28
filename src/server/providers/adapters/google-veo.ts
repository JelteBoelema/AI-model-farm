// Google Veo through the Gemini API (long-running). Confirmed from Google's published REST example:
// POST models/{model}:predictLongRunning returns an operation name; GET {name} until done; the clip
// URI is response.generateVideoResponse.generatedSamples[0].video.uri and is downloaded with the key.
// The request parameters (aspect ratio, duration, reference images) follow the documented Vertex/Gemini
// shape but could not be verified against the live docs from the build environment: the provider is
// only used after a successful connection test, and `pnpm test:live` exercises a real call.

import { ProviderError, type CostEstimate, type GenerationRequest, type GenerationResult, type ModelCapability, type PollResult, type ProviderAdapter } from "../types";

export const VEO_DEFAULT_MODEL = "veo-3.1-generate-preview";
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const DURATIONS = [4, 6, 8] as const;
const MAX_REFERENCES = 3;

export interface VeoOptions {
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

interface GoogleError {
  error?: { code?: number; message?: string; status?: string };
}

export async function mapGoogleResponseError(res: Response): Promise<ProviderError> {
  let body: GoogleError = {};
  try {
    body = (await res.json()) as GoogleError;
  } catch {
    /* non-JSON error body */
  }
  const status = body.error?.status;
  const message = body.error?.message ?? res.statusText;
  if (res.status === 401 || res.status === 403) return new ProviderError("auth", `Google rejected the API key or access: ${message}`, { status: res.status, providerCode: status });
  if (res.status === 429) {
    if (/quota|billing/i.test(message)) return new ProviderError("quota_exceeded", `Google quota reached: ${message}`, { status: 429, providerCode: status });
    return new ProviderError("rate_limited", "Google rate limit reached", { status: 429, providerCode: status, retryAfterMs: 60_000 });
  }
  if (res.status >= 400 && res.status < 500) return new ProviderError("invalid_input", `Google rejected the request: ${message}`, { status: res.status, providerCode: status });
  return new ProviderError("transient", `Google service error (${res.status})`, { status: res.status, providerCode: status });
}

function mapThrown(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") return new ProviderError("timeout", "Request to Google timed out");
  return new ProviderError("transient", `Could not reach Google: ${(err as Error)?.message ?? "network error"}`);
}

interface Operation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; raiMediaFilteredReasons?: string[]; raiMediaFilteredCount?: number } };
}

export class VeoAdapter implements ProviderAdapter {
  readonly key = "google-veo";
  readonly isMock = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: VeoOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private signal(outer: AbortSignal) {
    return AbortSignal.any([outer, AbortSignal.timeout(this.options.timeoutMs)]);
  }

  private headers(json = false): Record<string, string> {
    return { "x-goog-api-key": this.options.apiKey, ...(json ? { "content-type": "application/json" } : {}) };
  }

  async discoverCapabilities(signal: AbortSignal): Promise<ModelCapability[]> {
    try {
      const res = await this.fetchImpl(`${BASE}/models?pageSize=1000`, { headers: this.headers(), signal: this.signal(signal) });
      if (!res.ok) throw await mapGoogleResponseError(res);
      const body = (await res.json()) as { models?: { name?: string }[] };
      return (body.models ?? [])
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter((n) => /^veo/i.test(n))
        .map((model) => ({ capability: "VIDEO" as const, model, supportsReferenceImages: true, maxReferenceImages: MAX_REFERENCES, commercialUseAllowed: true }));
    } catch (err) {
      throw mapThrown(err);
    }
  }

  validate(req: GenerationRequest): void {
    if (req.capability !== "VIDEO") throw new ProviderError("invalid_input", "Veo adapter only handles video");
    if (!req.model) throw new ProviderError("invalid_input", "No model configured");
    if (!req.prompt.trim()) throw new ProviderError("invalid_input", "Empty prompt");
    if (!(DURATIONS as readonly number[]).includes(Number(req.params.durationSeconds))) throw new ProviderError("invalid_input", `Veo clips last ${DURATIONS.join(", ")} seconds`);
    if ((req.referenceImages?.length ?? 0) > MAX_REFERENCES) throw new ProviderError("invalid_input", `At most ${MAX_REFERENCES} reference images`);
  }

  estimate(req: GenerationRequest): CostEstimate {
    return { maxUsage: { video_second: Number(req.params.durationSeconds) || 8 }, uncertaintyNote: "Billed per second of generated video" };
  }

  /** Clip lengths Veo accepts; the storyboard is planned with these. */
  static readonly durations = DURATIONS;

  async generate(): Promise<GenerationResult> {
    throw new ProviderError("invalid_input", "Veo is asynchronous; use submit and poll");
  }

  async submit(req: GenerationRequest, signal: AbortSignal): Promise<{ providerJobId: string }> {
    this.validate(req);
    const instance: Record<string, unknown> = { prompt: req.prompt };
    if (req.referenceImages?.length)
      instance.referenceImages = req.referenceImages.map((r) => ({ image: { bytesBase64Encoded: r.bytes.toString("base64"), mimeType: r.mimeType }, referenceType: "asset" }));
    const parameters: Record<string, unknown> = { aspectRatio: req.params.aspectRatio ?? "9:16", durationSeconds: Number(req.params.durationSeconds) };
    if (typeof req.params.negativePrompt === "string" && req.params.negativePrompt) parameters.negativePrompt = req.params.negativePrompt;
    try {
      const res = await this.fetchImpl(`${BASE}/models/${encodeURIComponent(req.model)}:predictLongRunning`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ instances: [instance], parameters }),
        signal: this.signal(signal),
      });
      if (!res.ok) throw await mapGoogleResponseError(res);
      const op = (await res.json()) as Operation;
      if (!op.name) throw new ProviderError("transient", "Google returned no operation name");
      return { providerJobId: op.name };
    } catch (err) {
      throw mapThrown(err);
    }
  }

  async poll(providerJobId: string, req: GenerationRequest, signal: AbortSignal): Promise<PollResult> {
    if (!/^[A-Za-z0-9/_.-]+$/.test(providerJobId)) throw new ProviderError("invalid_input", "Unexpected operation name");
    try {
      const res = await this.fetchImpl(`${BASE}/${providerJobId}`, { headers: this.headers(), signal: this.signal(signal) });
      if (!res.ok) throw await mapGoogleResponseError(res);
      const op = (await res.json()) as Operation;
      if (!op.done) return { done: false };
      if (op.error) throw new ProviderError(op.error.code === 3 ? "invalid_input" : "transient", `Veo failed: ${op.error.message ?? "unknown error"}`);
      const result = op.response?.generateVideoResponse;
      if (result?.raiMediaFilteredReasons?.length || result?.raiMediaFilteredCount)
        throw new ProviderError("content_policy", `Veo filtered the output: ${(result.raiMediaFilteredReasons ?? []).join("; ") || "safety filter"}`);
      const uri = result?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new ProviderError("transient", "Veo finished without a video");
      const host = new URL(uri).hostname;
      if (!host.endsWith(".googleapis.com") && !host.endsWith(".google.com") && !host.endsWith(".googleusercontent.com")) throw new ProviderError("transient", "Unexpected video host");
      const file = await this.fetchImpl(uri, { headers: this.headers(), redirect: "follow", signal: this.signal(signal) });
      if (!file.ok) throw await mapGoogleResponseError(file);
      const bytes = Buffer.from(await file.arrayBuffer());
      const seconds = Number(req.params.durationSeconds);
      return {
        done: true,
        result: {
          outputs: [{ kind: "video", bytes, mimeType: "video/mp4", durationMs: seconds * 1000 }],
          attempts: [{ model: req.model, usage: { video_second: seconds } }],
          servedBy: req.model,
          providerRequestId: providerJobId,
          notes: [],
        },
      };
    } catch (err) {
      throw mapThrown(err);
    }
  }
}
