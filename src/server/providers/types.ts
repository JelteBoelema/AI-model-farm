// Provider adapter contract. Every AI provider, real or mock, sits behind this interface so the
// content factory never depends on a vendor SDK directly.

import type { ProviderCapability } from "@prisma/client";
import type { Usage } from "./pricing";

export type ProviderErrorKind =
  | "invalid_input" // never retried
  | "content_policy" // provider refused; never retried, surfaces for review
  | "auth" // credential missing/revoked/not permitted; pauses the provider
  | "rate_limited" // retried after retryAfterMs
  | "transient" // 5xx/network; retried with backoff
  | "timeout" // outcome unknown: the provider may have charged
  | "quota_exceeded"; // billing/quota; pauses the provider

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: { retryAfterMs?: number; providerCode?: string; status?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient";
  }

  /** The provider stays unusable until a human fixes credentials or billing. */
  get pausesProvider(): boolean {
    return this.kind === "auth" || this.kind === "quota_exceeded";
  }
}

export interface ModelCapability {
  capability: ProviderCapability;
  model: string;
  supportsReferenceImages?: boolean;
  maxReferenceImages?: number;
  commercialUseAllowed: boolean;
}

export interface ReferenceImage {
  bytes: Buffer;
  mimeType: string;
}

export interface GenerationRequest {
  capability: ProviderCapability;
  model: string;
  prompt: string;
  /** Instructions kept separate from the user prompt (e.g. safety rules) where the provider supports it. */
  system?: string;
  maxOutputTokens?: number;
  /** Ask a text model for JSON that matches this JSON Schema. */
  jsonSchema?: Record<string, unknown>;
  referenceImages?: ReferenceImage[];
  params: Record<string, unknown>;
}

/** Usage of one billed attempt; refusal fallbacks can produce several attempts on different models. */
export interface AttemptUsage {
  model: string;
  usage: Usage;
}

export interface GenerationOutput {
  kind: "text" | "image";
  text?: string;
  bytes?: Buffer;
  mimeType?: string;
}

export interface GenerationResult {
  outputs: GenerationOutput[];
  attempts: AttemptUsage[];
  /** Model that produced the returned output. */
  servedBy: string;
  providerRequestId?: string;
  notes: string[];
}

export interface CostEstimate {
  /** Usage at the upper bound; priced with the provider's table by the caller. */
  maxUsage: Usage;
  uncertaintyNote: string;
}

export interface ProviderAdapter {
  readonly key: string;
  readonly isMock: boolean;
  /** What this adapter can do with the configured credential (queries the provider). */
  discoverCapabilities(signal: AbortSignal): Promise<ModelCapability[]>;
  /** Throws ProviderError("invalid_input") before any money is spent. */
  validate(request: GenerationRequest): void;
  estimate(request: GenerationRequest): CostEstimate;
  /**
   * Runs the generation. Both current real providers answer synchronously; asynchronous providers
   * (video, phase 6) will add submit/poll methods to this contract.
   */
  generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationResult>;
}
