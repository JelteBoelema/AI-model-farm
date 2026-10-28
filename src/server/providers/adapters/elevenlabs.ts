// ElevenLabs text-to-speech for voice-overs. Only designed/synthetic voices are configured (no
// cloning without written consent of the voice owner). REST: POST /v1/text-to-speech/{voice_id}
// with the xi-api-key header returns audio bytes. Built from the provider's public API format; it
// could not be checked against the live docs from the build environment, so the provider is only
// used after a successful connection test and `pnpm test:live` exercises a real call.

import { ProviderError, type CostEstimate, type GenerationRequest, type GenerationResult, type ModelCapability, type ProviderAdapter } from "../types";

export const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";
const BASE = "https://api.elevenlabs.io/v1";
const MAX_CHARS = 5_000;

export interface ElevenLabsOptions {
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

async function mapError(res: Response): Promise<ProviderError> {
  let message = res.statusText;
  try {
    const body = (await res.json()) as { detail?: { message?: string; status?: string } | string };
    message = typeof body.detail === "string" ? body.detail : (body.detail?.message ?? message);
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401) return new ProviderError("auth", "ElevenLabs rejected the API key", { status: 401 });
  if (res.status === 403) return new ProviderError("auth", `ElevenLabs denied access: ${message}`, { status: 403 });
  if (res.status === 402 || /quota|credits/i.test(message)) return new ProviderError("quota_exceeded", `ElevenLabs quota reached: ${message}`, { status: res.status });
  if (res.status === 429) return new ProviderError("rate_limited", "ElevenLabs rate limit reached", { status: 429, retryAfterMs: 30_000 });
  if (res.status >= 400 && res.status < 500) return new ProviderError("invalid_input", `ElevenLabs rejected the request: ${message}`, { status: res.status });
  return new ProviderError("transient", `ElevenLabs service error (${res.status})`, { status: res.status });
}

function mapThrown(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") return new ProviderError("timeout", "Speech request timed out; the provider may have billed it");
  return new ProviderError("transient", `Could not reach ElevenLabs: ${(err as Error)?.message ?? "network error"}`);
}

export class ElevenLabsAdapter implements ProviderAdapter {
  readonly key = "elevenlabs";
  readonly isMock = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ElevenLabsOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private signal(outer: AbortSignal) {
    return AbortSignal.any([outer, AbortSignal.timeout(this.options.timeoutMs)]);
  }

  async discoverCapabilities(signal: AbortSignal): Promise<ModelCapability[]> {
    try {
      const res = await this.fetchImpl(`${BASE}/models`, { headers: { "xi-api-key": this.options.apiKey }, signal: this.signal(signal) });
      if (!res.ok) throw await mapError(res);
      const models = (await res.json()) as { model_id?: string; can_do_text_to_speech?: boolean }[];
      return models.filter((m) => m.model_id && m.can_do_text_to_speech !== false).map((m) => ({ capability: "SPEECH" as const, model: m.model_id!, commercialUseAllowed: true }));
    } catch (err) {
      throw mapThrown(err);
    }
  }

  validate(req: GenerationRequest): void {
    if (req.capability !== "SPEECH") throw new ProviderError("invalid_input", "ElevenLabs adapter only handles speech");
    if (!req.model) throw new ProviderError("invalid_input", "No model configured");
    if (!req.prompt.trim()) throw new ProviderError("invalid_input", "Empty text");
    if (req.prompt.length > MAX_CHARS) throw new ProviderError("invalid_input", `At most ${MAX_CHARS} characters per request`);
    if (typeof req.params.voiceId !== "string" || !/^[A-Za-z0-9]{8,64}$/.test(req.params.voiceId)) throw new ProviderError("invalid_input", "No valid voice configured for this creator or provider");
  }

  estimate(req: GenerationRequest): CostEstimate {
    return { maxUsage: { speech_kchar: req.prompt.length }, uncertaintyNote: "Billed per character of input text" };
  }

  async generate(req: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
    this.validate(req);
    try {
      const res = await this.fetchImpl(`${BASE}/text-to-speech/${encodeURIComponent(String(req.params.voiceId))}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": this.options.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: req.prompt, model_id: req.model }),
        signal: this.signal(signal),
      });
      if (!res.ok) throw await mapError(res);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) throw new ProviderError("transient", "ElevenLabs returned no audio");
      return {
        outputs: [{ kind: "audio", bytes, mimeType: "audio/mpeg" }],
        attempts: [{ model: req.model, usage: { speech_kchar: req.prompt.length } }],
        servedBy: req.model,
        providerRequestId: res.headers.get("request-id") ?? undefined,
        notes: [],
      };
    } catch (err) {
      throw mapThrown(err);
    }
  }
}
