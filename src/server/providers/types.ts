// Provider adapter contract (implemented from phase 4). Every AI provider, real or mock, sits behind
// this interface so the content factory never depends on a vendor SDK directly.

import type { ProviderCapability } from "@prisma/client";

export type ProviderErrorKind =
  | "invalid_input" // never retried
  | "content_policy" // provider refused; never retried, surfaces for review
  | "auth" // credential missing/revoked; pauses the provider
  | "rate_limited" // retried after retryAfterMs
  | "transient" // 5xx/network; retried with backoff
  | "timeout" // outcome unknown: poll status before any retry
  | "quota_exceeded"; // provider-side quota; pauses the provider

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: { retryAfterMs?: number; providerCode?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient" || this.kind === "timeout";
  }
}

/** One billable quantity, e.g. 1_200 input tokens or 8 video seconds. */
export interface UsageUnit {
  unitType: "input_token" | "output_token" | "image" | "video_second" | "audio_character" | "audio_second" | "request";
  quantity: number;
}

export interface CostEstimate {
  /** Conservative upper bound in micro-EUR; null means "price unknown" and blocks paid execution. */
  maxMicros: bigint | null;
  basis: "PROVIDER_REPORTED" | "ESTIMATED";
  uncertaintyNote?: string;
  usage: UsageUnit[];
}

export interface ModelCapability {
  capability: ProviderCapability;
  model: string;
  /** e.g. ["1:1", "4:5", "9:16"] for images/video */
  aspectRatios?: string[];
  maxDurationSeconds?: number;
  supportsReferenceImages?: boolean;
  maxReferenceImages?: number;
  supportsSeed?: boolean;
  supportsAudio?: boolean;
  commercialUseAllowed: boolean;
}

export interface GenerationRequest {
  capability: ProviderCapability;
  model: string;
  /** Stable key; adapters pass it to providers that support idempotent submission. */
  idempotencyKey: string;
  prompt: string;
  negativePrompt?: string;
  /** Storage keys of approved reference media (character conditioning, image-to-video). */
  referenceAssetKeys?: string[];
  params: Record<string, unknown>;
}

export type GenerationStatus =
  | { state: "pending" | "running"; providerJobId: string; progress?: number }
  | { state: "succeeded"; providerJobId: string; outputs: GenerationOutput[]; usage: UsageUnit[]; reportedCostMicros?: bigint; modelVersion?: string }
  | { state: "failed"; providerJobId: string; error: ProviderError };

export interface GenerationOutput {
  kind: "text" | "image" | "video" | "audio";
  /** Text output inline; binary outputs as a temporary provider URL or bytes to be copied to storage. */
  text?: string;
  url?: string;
  bytes?: Buffer;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly key: string;
  readonly isMock: boolean;
  /** What this adapter can do with the configured credential (may query the provider). */
  discoverCapabilities(signal: AbortSignal): Promise<ModelCapability[]>;
  /** Throws ProviderError("invalid_input") before any money is spent. */
  validate(request: GenerationRequest): void;
  estimateCost(request: GenerationRequest): Promise<CostEstimate>;
  /** Starts work. Synchronous providers may return a terminal status immediately. */
  submit(request: GenerationRequest, signal: AbortSignal): Promise<GenerationStatus>;
  /** Polls a submitted job; used for async providers and for resolving timeouts. */
  getStatus(providerJobId: string, signal: AbortSignal): Promise<GenerationStatus>;
  cancel?(providerJobId: string): Promise<void>;
}
